/**
 * 数据访问层：测验（`study_rounds` 轮次流水 + `study_progress` 累计进度）
 *
 * 契约 4.1 / 4.2 / 4.3 / 4.4。这两张表以前**前端直连rdb**，现在统一走本函数。
 *
 * 分层约定：与 recordsRepository 一致 —— 只发查询、只抛异常，状态码留给接口层；
 * 行 → 契约字段的映射留在这里（贴着列名）。
 *
 * ⚠️ **不使用 upsert**（Day 17 踩过）：PG + RLS 下
 *    `Prefer: resolution=merge-duplicates` 会先读现有行、让 SELECT 策略参与判定，
 *    报 `new row violates row-level security policy`（表现为「第一次成功、重复必 401」）。
 *    所以 progress 一律**先 GET 查 → 命中就PATCH，未命中才 INSERT**。
 */

const rdb = require('../lib/postgrest.js')

const ROUNDS_SELECT = 'id,date,score,total'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** 数据库列 → 契约 camelCase */
const mapRound = (r) => ({
  id: r.id,
  date: r.date,
  score: r.score,
  total: r.total,
})

const mapProgress = (r) => ({
  answeredTotal: r.answered_total != null ? r.answered_total : r.answeredTotal,
  correctTotal: r.correct_total != null ? r.correct_total : r.correctTotal,
  wrongIds: r.wrong_ids || r.wrongIds || [],
  updatedAt: r.updated_at || r.updatedAt || null,
})

/**
 * 契约 4.1 `GET /api/quiz/rounds` —— 按 date 倒序
 * @param {string} token
 * @param {object} opts
 * @param {number} opts.limit
 * @param {string} [opts.demoUid] 示例数据通道；通道 A 不传，靠 RLS 过滤
 */
async function listRounds(token, { limit = DEFAULT_LIMIT, demoUid = '' } = {}) {
  const q = { select: ROUNDS_SELECT, order: 'date.desc' }
  if (limit) q.limit = limit
  if (demoUid) q.uid = 'eq.' + encodeURIComponent(demoUid)
  const { rows } = await rdb.query(token, 'study_rounds', q)
  return rows.map(mapRound)
}

/**
 * 契约 4.2 `POST /api/quiz/rounds` —— 只写流水
 * @param {string} token
 * @param {object} body { score, total }（已由接口层校验）
 * @param {string} [uid] 显式指定 uid（demo 通道）；通道 A 传空，靠 RLS 的 default
 */
async function insertRound(token, { score, total }, uid = '') {
  const body = { score, total, date: new Date().toISOString().slice(0, 10) }
  // ⚠️ uid 交给数据库 RLS 的 default(auth.uid()) —— 通道 A 不显式写 uid
  const row = await rdb.insert(token, 'study_rounds', uid ? { ...body, uid } : body)
  return mapRound(row || {})
}

/**
 * 契约 4.3 `GET /api/quiz/progress` —— 没有记录时返回 null（不是 404）
 */
async function getProgress(token, { demoUid = '' } = {}) {
  const q = { select: 'answered_total,correct_total,wrong_ids,updated_at', limit: 1 }
  if (demoUid) q.uid = 'eq.' + encodeURIComponent(demoUid)
  const { rows } = await rdb.query(token, 'study_progress', q)
  return rows.length ? mapProgress(rows[0]) : null
}

/**
 * 契约 4.4 `PUT /api/quiz/progress` —— 覆盖写回
 * 先查后写：命中就 PATCH，未命中才 INSERT（避开 RLS 下的 upsert 陷阱）。
 */
async function putProgress(token, { answeredTotal, correctTotal, wrongIds }, uid = '') {
  const q = { select: 'uid', limit: 1 }
  if (uid) q.uid = 'eq.' + encodeURIComponent(uid)
  const { rows } = await rdb.query(token, 'study_progress', q)

  const body = {
    answered_total: answeredTotal,
    correct_total: correctTotal,
    wrong_ids: wrongIds,
    updated_at: new Date().toISOString().slice(0, 10),
  }

  if (rows.length) {
    const eq = rows[0].uid ? { uid: 'eq.' + encodeURIComponent(rows[0].uid) } : {}
    const row = await rdb.update(token, 'study_progress', body, eq)
    return mapProgress(row || { ...body, updated_at: body.updated_at })
  }
  const row = await rdb.insert(token, 'study_progress', uid ? { ...body, uid } : body)
  return mapProgress(row || { ...body, updated_at: body.updated_at })
}

module.exports = {
  listRounds,
  insertRound,
  getProgress,
  putProgress,
  DEFAULT_LIMIT,
  MAX_LIMIT,
}