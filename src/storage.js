/**
 * 本地存储层 —— F8 起卦记录与收藏
 *
 * 本期先落 localStorage。等 CloudBase 云环境开通后，**只替换这一层的实现**，
 * 上层组件不用改（读写接口保持不变）。这对应 PRD §6 F6 的「服务端不可用时降级本地」。
 *
 * ⚠️ 两条硬约束（PRD §7.3 / §6 F8）：
 *   ① 起卦记录**只存** date / hexagramId / changingLines —— **不存精确到分的时刻**
 *   ② 不采集任何身份信息（没有 uid、没有 IP、没有设备指纹）
 *
 * 「每日第一卦」的判定放在这一层：靠 date 是否已存在，不靠应用层判断。
 */

const K_RECORDS = 'yijing.records.v1'
const K_FAVORITES = 'yijing.favorites.v1'

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
  list.push({ date: t, hexagramId, changingLines: normChanging(changingLines) })
  write(K_RECORDS, list)
  return true
}

/** 收藏：只存 hexagramId 与日期（无精确时刻） */
export function loadFavorites() {
  return read(K_FAVORITES, []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function isFavorited(hexagramId) {
  return loadFavorites().some((f) => f.hexagramId === hexagramId)
}

/** @returns {boolean} 操作后的收藏状态 */
export function toggleFavorite(hexagramId) {
  const list = loadFavorites()
  const i = list.findIndex((f) => f.hexagramId === hexagramId)
  if (i >= 0) {
    list.splice(i, 1)
    write(K_FAVORITES, list)
    return false
  }
  list.push({ hexagramId, date: todayKey() })
  write(K_FAVORITES, list)
  return true
}

/**
 * F3 记忆测验的进度 —— 本期**唯一的「写入」功能**（PRD F3）
 *
 * 每轮存一条流水：{ date, score, total, answeredIds, wrongIds }
 * 与起卦记录同一条红线：**只存卦序号与数字，不存精确时刻、不存任何身份信息**。
 * 错题本以「最后一次答到它」的结果为准 —— 答对过一次就移出。
 */
const K_QUIZ = 'yijing.quiz.v1'

const normIds = (arr) =>
  Array.from(new Set((arr || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 64))).sort(
    (a, b) => a - b
  )

/** 每轮成绩：按日期倒序 */
export function loadQuizRounds() {
  return read(K_QUIZ, []).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function saveQuizRound({ score, total, answeredIds, wrongIds }) {
  const list = read(K_QUIZ, [])
  list.push({
    date: todayKey(),
    score,
    total,
    answeredIds: normIds(answeredIds),
    wrongIds: normIds(wrongIds),
  })
  write(K_QUIZ, list)
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

/** 「清空我的记录」：记录与收藏一起清（PRD §6 F8） */
export function clearAll() {
  try {
    window.localStorage.removeItem(K_RECORDS)
    window.localStorage.removeItem(K_FAVORITES)
    window.localStorage.removeItem(K_QUIZ)
  } catch {
    /* 静默 */
  }
}

/** 首页入口上的计数 */
export function counts() {
  return { records: loadRecords().length, favorites: loadFavorites().length }
}
