/**
 * 本地优先 + 云端备份的数据层（Day 12 · F6 第 6 步接入）
 *
 * 设计（TECH_DESIGN §11「云端是备份，不是依赖」）：
 *   - **读写永远先走 localStorage**（同步、零延迟、离线可用）——上层组件的用法与语义完全不变
 *   - 云端（CloudBase PG，匿名登录 + RLS）是**异步备份通道**：启动时拉取合并、写入后静默上推
 *   - 云端任何异常（超时/失败/未登录）都只静默跳过，绝不阻断用户动作、绝不弹窗
 *   - 「清空我的记录」会连云端一起清（否则清完又被云同步回来）
 *
 * ⚠️ 两条硬约束（PRD §7.3 / §6 F8）不变：
 *   ① 起卦记录只存 date / hexagramId / changingLines —— 不存精确到分的时刻
 *   ② 不采集任何身份信息（无 uid 采集——uid 由平台匿名登录生成，仅作行级权限隔离）
 */

import cloudbase from '@cloudbase/js-sdk'

const K_RECORDS = 'yijing.records.v1'
const K_FAVORITES = 'yijing.favorites.v1'
const K_QUIZ = 'yijing.quiz.v1'
const K_WRONG_CLOUD = 'yijing.wrongcloud.v1' // 云端累计进度的错题集合镜像（换设备时补回错题本）
const K_GILDED = 'yijing.gilded.v1'

/* localStorage 在隐私模式 / 存储禁用时会抛异常 —— 一律静默降级，绝不阻断起卦 */
function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const val = JSON.parse(raw)
    return Array.isArray(val) ? val : fallback
  } catch {
    return fallback
  }
}

function write(key, val) {
  try {
    window.localStorage.setItem(key, JSON.stringify(val))
    return true
  } catch {
    return false
  }
}

/** 本地日期 YYYY-MM-DD（不用 UTC —— 用户心里的「今天」是本地的今天） */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const normChanging = (arr) =>
  Array.from(new Set((arr || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 6))).sort(
    (a, b) => a - b
  )

/* ============================================================================
 * 云端备份通道（匿名登录 + app.rdb()；§11：超时 + 静默失败）
 * ========================================================================== */

const ENV_ID = import.meta.env.VITE_TCB_ENV_ID || ''
const REGION = import.meta.env.VITE_TCB_REGION || 'ap-shanghai'
const PUB_KEY = import.meta.env.VITE_PUBLISHABLE_KEY || ''
/* 云函数读接口的网关域名（Day 17）。与静态托管不同域，所以是跨域调用 ——
   网关会自动回显 Origin，预检由函数自己应答（OPTIONS → 204）。 */
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

const CLOUD_TIMEOUT_MS = 8000
const withTimeout = (p) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('云端超时')), CLOUD_TIMEOUT_MS)),
  ])

const cloud = { app: null, auth: null, db: null, uid: null, ready: null, lastError: null }

/* 最近一次「读」走的是哪条路、拿到多少条 —— 记录页要显示它，用户才看得见数据真的来自接口 */
const cloudRead = { via: 'none', at: 0, records: 0, favorites: 0, detail: '' }

/**
 * 调 Day 17 的读接口（GET /api/records、GET /api/favorites）。
 *
 * 走「通道 A」：把当前匿名会话的 accessToken 作为 `Authorization: Bearer` 交给云函数，
 * 函数**原样透传**给 PostgREST，由 RLS 按 uid 过滤 —— 前端不传 uid，也不该传。
 * 身份取自 `auth.getAccessToken()`（SDK v3 的凭证接口）。
 *
 * @param {'records'|'favorites'} name
 * @param {{limit?:number, before?:string}} [params] 值一律 encodeURIComponent，不拼 SQL
 * @returns {Promise<{items:Array, meta:Object}>} 契约形状；非 2xx 或 ok:false 一律抛错（上层静默回退）
 */
async function apiGet(name, params = {}) {
  if (!API_BASE) throw new Error('未配置 VITE_API_BASE')
  const c = await cloudReady()
  if (!c) throw new Error('云端未就绪')
  const { accessToken } = await withTimeout(c.auth.getAccessToken())
  if (!accessToken) throw new Error('取不到访问凭证')

  const qs = new URLSearchParams()
  if (Number.isInteger(params.limit)) qs.set('limit', String(params.limit))
  if (params.before) qs.set('before', String(params.before))
  const url = `${API_BASE}/api/${name}${qs.toString() ? '?' + qs.toString() : ''}`

  const res = await withTimeout(fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }))
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || body.ok !== true) {
    const msg = (body && body.error && body.error.message) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return { items: body.items || [], meta: body.meta || {} }
}


/** 懒初始化：匿名登录一次；任何失败都置 ready=null（本次会话退化为纯本地模式） */
function cloudReady() {
  if (cloud.ready) return cloud.ready
  if (!ENV_ID || !PUB_KEY) return Promise.resolve(null)
  cloud.ready = (async () => {
    const app = cloudbase.init({
      env: ENV_ID,
      region: REGION,
      accessKey: PUB_KEY,
      auth: { detectSessionInUrl: true },
    })
    const auth = app.auth
    // 已有会话就直接用（匿名身份持久在本机；没有才匿名登录一次）
    const { data } = await withTimeout(auth.getSession())
    if (!data?.session) {
      const r = await withTimeout(auth.signInAnonymously())
      if (r?.error) throw new Error(r.error.message || '匿名登录失败')
    }
    const session = await withTimeout(auth.getSession())
    const uid = session?.data?.session?.user?.id || null
    if (!uid) throw new Error('匿名会话无 uid')
    cloud.app = app
    cloud.auth = auth
    cloud.db = app.rdb()
    cloud.uid = uid
    return cloud
  })()
  cloud.ready.catch((e) => {
    cloud.lastError = String((e && e.message) || e)
    cloud.ready = null // 失败允许下次动作时重试
  })
  return cloud.ready
}

/** 云端写完/拉完合并进本地后，通知 App 重读（App 里挂一个监听器 bump 即可） */
function notifySynced() {
  try {
    window.dispatchEvent(new CustomEvent('yijing:cloud-synced'))
  } catch {
    /* 忽略 */
  }
}

/* 启动时拉取云端 → 合并进本地（只增不删；本地已有的键以本地为准）
 *
 * Day 17 起：**记录与收藏优先走云函数读接口**（GET /api/records、/api/favorites）——
 * 那是契约里登记的口径，身份由 RLS 判定。接口不可用（未配置 / 预检失败 / 网络不通）时
 * **静默回退**到直连 rdb()，所以离线与降级行为和 Day 12 完全一致，用户无感。
 */
async function pullAndMerge() {
  const c = await cloudReady()
  if (!c) return
  // 起卦记录：云上有、本地没有的日期 → 落进本地
  let recRows = null
  try {
    const r = await apiGet('records')
    recRows = r.items
    cloudRead.via = 'api'
    cloudRead.records = recRows.length
    cloudRead.detail = `${API_BASE}/api/records`
  } catch (e) {
    const { data, error } = await withTimeout(
      c.db.from('divination_records').select('date, hexagram_id, changing_lines').eq('uid', c.uid)
    )
    if (error) throw e
    recRows = data
    cloudRead.via = cloudRead.via === 'api' ? 'api' : 'rdb'
    cloudRead.records = Array.isArray(recRows) ? recRows.length : 0
    cloudRead.detail = '直连数据库（接口不可用，已回退）'
  }
  cloudRead.at = Date.now()
  if (Array.isArray(recRows)) {
    const local = read(K_RECORDS, [])
    const dates = new Set(local.map((r) => r.date))
    const merged = [...local]
    let dirty = false
    for (const row of recRows) {
      if (!dates.has(row.date)) {
        merged.push({
          date: row.date,
          hexagramId: row.hexagramId != null ? row.hexagramId : row.hexagram_id,
          changingLines: normChanging(row.changingLines || row.changing_lines),
        })
        dirty = true
      }
    }
    if (dirty) {
      merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      write(K_RECORDS, merged)
      notifySynced()
    }
  }
  // 收藏：云上有、本地没有的 → 并进本地
  let favRows = null
  try {
    const r = await apiGet('favorites')
    favRows = r.items
    if (cloudRead.via !== 'api') cloudRead.via = 'api'
    cloudRead.favorites = favRows.length
  } catch (e) {
    const { data, error } = await withTimeout(
      c.db.from('favorites').select('hexagram_id, created_at').eq('uid', c.uid)
    )
    if (error) throw e
    favRows = data
    cloudRead.favorites = Array.isArray(favRows) ? favRows.length : 0
  }
  if (Array.isArray(favRows)) {
    const local = read(K_FAVORITES, [])
    const ids = new Set(local.map((f) => f.hexagramId))
    const merged = [...local]
    let dirty = false
    for (const row of favRows) {
      const hid = row.hexagramId != null ? row.hexagramId : row.hexagram_id
      if (!ids.has(hid)) {
        const at = row.createdAt || row.created_at || ''
        merged.push({ hexagramId: hid, date: String(at).slice(0, 10) || todayKey() })
        dirty = true
      }
    }
    if (dirty) {
      merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      write(K_FAVORITES, merged)
      notifySynced()
    }
  }

  /* 测验成绩流水：云上有、本地没有的轮次 → 补进本地（按 日期+得分+题数 去重）。
     之前只上推不下拉，所以同一账号的进度读不回来（「每次进入重置」的成因之一）。 */
  const { data: roundRows, error: roundErr } = await withTimeout(
    c.db.from('study_rounds').select('score, total, created_at').eq('uid', c.uid)
  )
  if (!roundErr && Array.isArray(roundRows)) {
    const local = read(K_QUIZ, [])
    const seen = new Set(local.map((r) => `${r.date}|${r.score}|${r.total}`))
    const merged = [...local]
    let dirty = false
    for (const row of roundRows) {
      const date = (row.created_at || '').slice(0, 10) || todayKey()
      const key = `${date}|${row.score}|${row.total}`
      if (seen.has(key)) continue
      seen.add(key)
      // 云端流水不含每轮答了哪些卦，故 answeredIds/wrongIds 留空（错题由 study_progress 补）
      merged.push({ date, score: row.score || 0, total: row.total || 0, answeredIds: [], wrongIds: [] })
      dirty = true
    }
    if (dirty) {
      merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      write(K_QUIZ, merged)
      notifySynced()
    }
  }

  /* 镀金成就：云上有的并进本地（一人一行；换设备时把金字补回来） */
  const { data: gildRows, error: gildErr } = await withTimeout(
    c.db.from('gilded').select('hexagram_ids').eq('uid', c.uid)
  )
  if (!gildErr && Array.isArray(gildRows) && gildRows.length) {
    const local = normIds(read(K_GILDED, []))
    const merged = normIds([...local, ...(gildRows[0].hexagram_ids || [])])
    if (JSON.stringify(merged) !== JSON.stringify(local)) {
      write(K_GILDED, merged)
      notifySynced()
    }
  }

  /* 累计进度里的错题集合：单独存一份本地镜像，作为错题本的补充来源 */
  const { data: progRows, error: progErr } = await withTimeout(
    c.db.from('study_progress').select('wrong_ids').eq('uid', c.uid)
  )
  if (!progErr && Array.isArray(progRows) && progRows.length) {
    const ids = normIds(progRows[0].wrong_ids)
    const cur = JSON.stringify(normIds(read(K_WRONG_CLOUD, [])))
    if (JSON.stringify(ids) !== cur) {
      write(K_WRONG_CLOUD, ids)
      notifySynced()
    }
  }
}

/* 写入后静默上推（§11 E2：失败不告知，本地已成功；最后错误存 cloud.lastError 供诊断） */
function pushSilent(fn) {
  cloudReady()
    .then((c) => withTimeout(fn(c)))
    .catch((e) => {
      cloud.lastError = String((e && e.message) || e)
    })
}

const pushRecord = (rec) =>
  pushSilent((c) =>
    c.db
      .from('divination_records')
      .upsert(
        { uid: c.uid, date: rec.date, hexagram_id: rec.hexagramId, changing_lines: normChanging(rec.changingLines) },
        { onConflict: 'uid,date' }
      )
  )

const pushFavoriteAdd = (hexagramId) =>
  pushSilent((c) =>
    c.db.from('favorites').upsert(
      { uid: c.uid, hexagram_id: hexagramId, created_at: new Date().toISOString() },
      { onConflict: 'uid,hexagram_id' }
    )
  )

const pushFavoriteRemove = (hexagramId) =>
  pushSilent((c) => c.db.from('favorites').delete().eq('uid', c.uid).eq('hexagram_id', hexagramId))

/** 镀金上推：整列 upsert（本地并集为准；云端无则建行） */
const pushGilded = () =>
  pushSilent((c) =>
    c.db.from('gilded').upsert(
      { uid: c.uid, hexagram_ids: normIds(read(K_GILDED, [])), updated_at: new Date().toISOString() },
      { onConflict: 'uid' }
    )
  )

const pushRound = (round) =>
  pushSilent((c) => c.db.from('study_rounds').insert({ uid: c.uid, score: round.score, total: round.total }))

/** 进度上推：本地累计值 upsert（云端同名键覆盖为本地口径） */
const pushProgress = () =>
  pushSilent((c) => {
    const rounds = read(K_QUIZ, [])
    const answered = rounds.reduce((s, r) => s + (r.total || 0), 0)
    const correct = rounds.reduce((s, r) => s + (r.score || 0), 0)
    const wrong = new Set()
    for (const r of [...rounds].reverse()) {
      for (const id of r.answeredIds || []) {
        if ((r.wrongIds || []).includes(id)) wrong.add(id)
      }
    }
    return c.db.from('study_progress').upsert(
      {
        uid: c.uid,
        answered_total: answered,
        correct_total: correct,
        wrong_ids: [...wrong].sort((a, b) => a - b),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'uid' }
    )
  })

/* 启动即后台拉取（不 await，不阻塞首屏） */
if (typeof window !== 'undefined') {
  pullAndMerge()
  try {
    window.__cloudDiag = () => ({ uid: cloud.uid, lastError: cloud.lastError, ready: !!cloud.ready })
    // 调试出口：绕过「本地为准」的合并，直接看接口返回什么（验证「改库数据 → 接口跟着变」）
    window.__apiRead = (name, params) => debugApiRead(name, params)
    // 调试出口：带真实会话发 POST（Day 18 写入接口验证）
    window.__apiWrite = (name, body) => debugApiWrite(name, body)
  } catch {
    /* 忽略 */
  }
}

/**
 * 本次会话的云端读取状态（记录页显示它 —— 用户要能看见「数据是从接口读到的」）。
 * @returns {{via:string, at:number, records:number, favorites:number, detail:string, uid:string|null}}
 */
export function cloudReadStatus() {
  return { ...cloudRead, uid: cloud.uid }
}

/**
 * 手动重新拉一次云端（记录页的「重新读取」按钮用）。
 * @returns {Promise<{via:string, records:number, favorites:number}>}
 */
export async function refreshFromCloud() {
  await pullAndMerge()
  return { via: cloudRead.via, records: cloudRead.records, favorites: cloudRead.favorites }
}

/**
 * 调试用：用当前会话的真实凭证直接打一次读接口，**原样返回接口的响应**。
 *
 * 用途是「改一条数据库数据 → 确认接口跟着变」这类验证：页面上的列表是
 * 「本地为准、只增不删」的合并结果（记录不可事后改写，PRD F8），所以库里改了之后
 * 页面**故意**不变 —— 要证明接口本身跟着变，就得绕过合并直接看接口返回。
 *
 * ⚠️ token 只在本机内存里用一次，不写 localStorage、不打日志、不外传。
 * @returns {Promise<{status:number, body:any}>}
 */
export async function debugApiRead(name, params = {}) {
  const r = await apiGet(name, params)
  return { status: 200, body: { ok: true, items: r.items, meta: r.meta } }
}

/**
 * 调试用：带当前会话的真实凭证发一次 POST（Day 18 验收「真实写入 + 读回」用）。
 * ⚠️ 只在浏览器控制台 / 自动化里手动调用，不参与任何业务路径。
 * @param {'favorites'} name
 * @param {object} body 请求体（如 { hexagramId: 12 }）
 * @returns {Promise<{status:number, body:any}>} 原样返回接口响应，便于核对状态码与信封
 */
export async function debugApiWrite(name, body) {
  if (!API_BASE) throw new Error('未配置 VITE_API_BASE')
  const c = await cloudReady()
  if (!c) throw new Error('云端未就绪')
  const { accessToken } = await withTimeout(c.auth.getAccessToken())
  if (!accessToken) throw new Error('取不到访问凭证')
  const res = await withTimeout(
    fetch(`${API_BASE}/api/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  const parsed = await res.json().catch(() => null)
  return { status: res.status, body: parsed }
}


/* ============================================================================
 * 本地读写（与 Day 12 之前完全一致 —— 上层组件的用法与语义不变）
 * ========================================================================== */

const normIds = (arr) =>
  Array.from(new Set((arr || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 64))).sort(
    (a, b) => a - b
  )

/** 起卦记录：按日期倒序 */
export function loadRecords() {
  return read(K_RECORDS, []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function todayRecord() {
  const t = todayKey()
  return loadRecords().find((r) => r.date === t) || null
}

/**
 * 存档「每日第一卦」。
 * @returns {boolean} true = 这一卦已入档（今天第一卦）；false = 今天已有记录，本卦仅作娱乐
 */
export function archiveFirstOfToday(hexagramId, changingLines) {
  const t = todayKey()
  const list = loadRecords()
  if (list.some((r) => r.date === t)) return false
  const rec = { date: t, hexagramId, changingLines: normChanging(changingLines) }
  list.push(rec)
  write(K_RECORDS, list)
  pushRecord(rec) // 云端备份（静默）
  return true
}

/** 收藏：只存 hexagramId 与日期（无精确时刻） */
export function loadFavorites() {
  return read(K_FAVORITES, []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function isFavorited(hexagramId) {
  return loadFavorites().some((f) => f.hexagramId === hexagramId)
}

/**
 * @returns {boolean} 操作后的收藏状态
 * @throws {Error} 写入失败时抛出（调用方负责给出可理解的提示）——
 *                 收藏是用户主动动作，静默失败会让人以为存上了
 */
export function toggleFavorite(hexagramId) {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('storeFail')) {
    throw new Error('本地存储写入失败（?storeFail=1 调试模拟）')
  }
  const list = loadFavorites()
  const i = list.findIndex((f) => f.hexagramId === hexagramId)
  let next
  let on
  if (i >= 0) {
    next = list.filter((f) => f.hexagramId !== hexagramId)
    on = false
  } else {
    next = [...list, { hexagramId, date: todayKey() }]
    on = true
  }
  if (!write(K_FAVORITES, next)) throw new Error('本地存储写入失败')
  // 云端备份（静默；失败不影响本地已生效的状态）
  if (on) pushFavoriteAdd(hexagramId)
  else pushFavoriteRemove(hexagramId)
  return on
}

/* 镀金：测验答对 6 题以上的奖励 —— 被镀金的卦在总表上金字显示（本地成就；云端表待后续迁移） */
export function loadGilded() {
  return read(K_GILDED, [])
}

/** @returns {boolean} true = 这次真的镀上了；false = 早就镀过（幂等） */
export function addGilded(hexagramId) {
  const list = read(K_GILDED, [])
  if (list.includes(hexagramId)) return false
  const ok = write(K_GILDED, [...list, hexagramId])
  if (ok) pushGilded() // 云端备份（静默；成就换设备也能带回来）
  return ok
}

/** F3 记忆测验的进度 —— 本期**唯一的「写入」功能**（PRD F3） */
export function loadQuizRounds() {
  return read(K_QUIZ, []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function saveQuizRound({ score, total, answeredIds, wrongIds }) {
  const list = read(K_QUIZ, [])
  const round = {
    date: todayKey(),
    score,
    total,
    answeredIds: normIds(answeredIds),
    wrongIds: normIds(wrongIds),
  }
  list.push(round)
  write(K_QUIZ, list)
  pushRound(round) // 流水上推
  pushProgress() // 累计进度上推
}

/** 累计：轮数 / 答题数 / 正确数 / 正确率 / 单轮最好成绩 */
export function quizSummary() {
  const rounds = loadQuizRounds()
  const answered = rounds.reduce((s, r) => s + (r.total || 0), 0)
  const correct = rounds.reduce((s, r) => s + (r.score || 0), 0)
  const best = rounds.reduce((m, r) => Math.max(m, r.score || 0), 0)
  return {
    rounds: rounds.length,
    answered,
    correct,
    accuracy: answered ? correct / answered : 0,
    best,
  }
}

/** 错题本：卦序号数组（答对过就移出） */
export function quizWrongBook() {
  const latest = new Map()
  for (const r of [...loadQuizRounds()].reverse()) {
    for (const id of r.answeredIds || []) latest.set(id, (r.wrongIds || []).includes(id))
  }
  const ids = [...latest.entries()]
    .filter(([, wrong]) => wrong)
    .map(([id]) => id)
  // 并入云端镜像（换设备后本地轮次里没有 answeredIds，靠它把错题本补回来）
  return normIds([...ids, ...read(K_WRONG_CLOUD, [])])
}

/**
 * 「清空我的记录」：本地与**云端**一起清 —— 否则清完又被云同步回来。
 * 镀金（yijing.gilded.v1）是成就，刻意不清。
 */
export function clearAll() {
  try {
    window.localStorage.removeItem(K_RECORDS)
    window.localStorage.removeItem(K_FAVORITES)
    window.localStorage.removeItem(K_QUIZ)
    window.localStorage.removeItem(K_WRONG_CLOUD)
  } catch {
    /* 静默 */
  }
  // 云端同步清（静默；失败则残留数据会在下次拉取时回流 —— 可再清一次）
  pushSilent(async (c) => {
    for (const table of ['divination_records', 'favorites', 'study_rounds', 'study_progress']) {
      await withTimeout(c.db.from(table).delete().eq('uid', c.uid))
    }
  })
}

/** 首页入口上的计数 */
export function counts() {
  return { records: loadRecords().length, favorites: loadFavorites().length }
}

/* ============================================================================
 * 进度码（换设备带走进度）—— 方案 A′：不采身份信息、不经服务器、纯前端
 * 导出：记录 / 收藏 / 镀金 / 成绩 → 紧凑 JSON → base64url，前缀 YJ64-
 * 导入：解析后**并集**进本地（只增不覆盖），随后照常静默上云
 * ========================================================================== */

const BACKUP_PREFIX = 'YJ64-'

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
  const bin = atob(b64 + pad)
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** @returns {string} 进度码（YJ64-…） */
export function exportBackupCode() {
  const payload = {
    v: 1,
    r: loadRecords().map((x) => [x.date, x.hexagramId, (x.changingLines || []).join('')]),
    f: normIds(loadFavorites().map((x) => x.hexagramId)),
    g: normIds(loadGilded()),
    q: loadQuizRounds().map((x) => [
      x.date,
      x.score,
      x.total,
      (x.answeredIds || []).join('.'),
      (x.wrongIds || []).join('.'),
    ]),
  }
  return BACKUP_PREFIX + b64urlEncode(JSON.stringify(payload))
}

/**
 * 导入进度码并与本地合并（只增不覆盖，本地已有的键以本地为准）
 * @throws {Error} 码不认识 / 解析失败时抛出可理解的中文错误
 * @returns {{records:number, favorites:number, gilded:number, rounds:number}} 各类新增条数
 */
export function importBackupCode(code) {
  const raw = String(code || '').trim()
  if (!raw) throw new Error('请先粘贴进度码')
  if (!raw.startsWith(BACKUP_PREFIX)) throw new Error('这不像本项目的进度码（应以 YJ64- 开头）')

  let payload
  try {
    payload = JSON.parse(b64urlDecode(raw.slice(BACKUP_PREFIX.length)))
  } catch {
    throw new Error('进度码无法解析，多半是复制时缺了一段——请重新完整复制一次')
  }
  if (!payload || payload.v !== 1) throw new Error('这个进度码的版本不认识')

  // 起卦记录：按日期补缺（一天一条，本地已有则保留本地）
  const recs = loadRecords()
  const byDate = new Map(recs.map((r) => [r.date, r]))
  let addR = 0
  for (const row of payload.r || []) {
    const [date, hid, lines] = row || []
    if (!date || !Number.isInteger(hid) || hid < 1 || hid > 64 || byDate.has(date)) continue
    byDate.set(date, {
      date,
      hexagramId: hid,
      changingLines: normChanging(String(lines || '').split('').map(Number)), // split 出来是字符串，必须转数字否则被 normChanging 过滤掉
    })
    addR += 1
  }
  if (addR) {
    const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    write(K_RECORDS, merged)
  }

  // 收藏：补缺
  const favs = loadFavorites()
  const favIds = new Set(favs.map((f) => f.hexagramId))
  let addF = 0
  for (const id of normIds(payload.f)) {
    if (favIds.has(id)) continue
    favs.push({ hexagramId: id, date: todayKey() })
    favIds.add(id)
    addF += 1
  }
  if (addF) write(K_FAVORITES, favs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)))

  // 镀金：并集（成就只增不减）
  const gilded = normIds(loadGilded())
  const mergedG = normIds([...gilded, ...normIds(payload.g)])
  const addG = mergedG.length - gilded.length
  if (addG) write(K_GILDED, mergedG)

  // 成绩流水：按 日期+得分+题数 去重补缺
  const rounds = loadQuizRounds()
  const seen = new Set(rounds.map((r) => `${r.date}|${r.score}|${r.total}`))
  let addQ = 0
  for (const row of payload.q || []) {
    const [date, score, total, a, w] = row || []
    if (!date) continue
    const key = `${date}|${score}|${total}`
    if (seen.has(key)) continue
    seen.add(key)
    rounds.push({
      date,
      score: score || 0,
      total: total || 0,
      answeredIds: normIds(String(a || '').split('.').map(Number)),
      wrongIds: normIds(String(w || '').split('.').map(Number)),
    })
    addQ += 1
  }
  if (addQ) write(K_QUIZ, rounds.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)))

  // 导入的内容也照常备份上云（记录/收藏/镀金 upsert 幂等；成绩流水是只增表，不重复推）
  try {
    for (const r of byDate.values()) pushRecord(r)
    for (const id of favIds) pushFavoriteAdd(id)
    pushGilded()
    pushProgress()
  } catch {
    /* 静默：本地已生效 */
  }

  notifySynced() // 让页面立刻重读
  return { records: addR, favorites: addF, gilded: addG, rounds: addQ }
}
