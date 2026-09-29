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

const CLOUD_TIMEOUT_MS = 8000
const withTimeout = (p) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('云端超时')), CLOUD_TIMEOUT_MS)),
  ])

const cloud = { app: null, auth: null, db: null, uid: null, ready: null, lastError: null }

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

/* 启动时拉取云端 → 合并进本地（只增不删；本地已有的键以本地为准） */
async function pullAndMerge() {
  const c = await cloudReady()
  if (!c) return
  // 起卦记录：云上有、本地没有的日期 → 落进本地
  const { data: recRows, error: recErr } = await withTimeout(
    c.db.from('divination_records').select('date, hexagram_id, changing_lines').eq('uid', c.uid)
  )
  if (!recErr && Array.isArray(recRows)) {
    const local = read(K_RECORDS, [])
    const dates = new Set(local.map((r) => r.date))
    const merged = [...local]
    let dirty = false
    for (const row of recRows) {
      if (!dates.has(row.date)) {
        merged.push({
          date: row.date,
          hexagramId: row.hexagram_id,
          changingLines: normChanging(row.changing_lines),
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
  const { data: favRows, error: favErr } = await withTimeout(
    c.db.from('favorites').select('hexagram_id, created_at').eq('uid', c.uid)
  )
  if (!favErr && Array.isArray(favRows)) {
    const local = read(K_FAVORITES, [])
    const ids = new Set(local.map((f) => f.hexagram_id))
    const merged = [...local]
    let dirty = false
    for (const row of favRows) {
      if (!ids.has(row.hexagram_id)) {
        merged.push({ hexagramId: row.hexagram_id, date: (row.created_at || '').slice(0, 10) || todayKey() })
        dirty = true
      }
    }
    if (dirty) {
      merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      write(K_FAVORITES, merged)
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
  } catch {
    /* 忽略 */
  }
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
  return write(K_GILDED, [...list, hexagramId])
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
  return [...latest.entries()]
    .filter(([, wrong]) => wrong)
    .map(([id]) => id)
    .sort((a, b) => a - b)
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
