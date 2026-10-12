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

/**
 * ⚠️ `study_rounds` **没有 `date` 列**（正本 `db/schema.sql` §1.4 只有
 *    `id / uid / score / total / created_at`）—— 以前这里 select 了 `date`、
 *    order by `date`、insert 也塞 `date`，线上实测三个接口全 500：
 *    `column study_rounds.date does not exist`。
 *    契约要的是**业务日**（Asia/Shanghai 的「今天」），所以改成读 `created_at` 再折算，
 *    排序直接用 `created_at.desc`（timestamptz 本身有序，与业务日排序不冲突）。
 */
const ROUNDS_SELECT = 'id,created_at,score,total'
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** timestamptz 字符串 → Asia/Shanghai 的 YYYY-MM-DD（读库回显用，避免 08:00 前差一天） */
const toBusinessDate = (ts) => {
  if (!ts) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ts))
  const g = {}
  for (const p of parts) g[p.type] = p.value
  return g.year + '-' + g.month + '-' + g.day
}

/** 数据库列 → 契约 camelCase */
const mapRound = (r) => ({
  id: r.id,
  date: toBusinessDate(r.created_at || r.createdAt),
  score: r.score,
  total: r.total,
})

/** 契约 4.3 的 updatedAt 是「日期」，但库里是 timestamptz —— 回显时折算业务日 */
const mapProgress = (r) => {
  const raw = r.updated_at || r.updatedAt || null
  return {
    answeredTotal: r.answered_total != null ? r.answered_total : r.answeredTotal,
    correctTotal: r.correct_total != null ? r.correct_total : r.correctTotal,
    wrongIds: r.wrong_ids || r.wrongIds || [],
    // 只有纯日期串（YYYY-MM-DD）原样透传；timestamptz 才折算，避免二次折算
    updatedAt: typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : toBusinessDate(raw),
  }
}

/**
 * 契约 4.1 `GET /api/quiz/rounds` —— 按 date 倒序
 * @param {string} token
 * @param {object} opts
 * @param {number} opts.limit
 * @param {string} [opts.demoUid] 示例数据通道；通道 A 不传，靠 RLS 过滤
 */
async function listRounds(token, { limit = DEFAULT_LIMIT, demoUid = '' } = {}) {
  const q = { select: ROUNDS_SELECT, order: 'created_at.desc' }
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
  // ⚠️ 不写 date —— 表里没这一列（见文件头）；契约的 date 由 created_at 折算回显
  const body = { score, total }
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
    // ⚠️ 写**完整时间戳**而不是 'YYYY-MM-DD'：列是 timestamptz，
    //    塞纯日期会被 PG 按会话时区补成当天零点，回显折算时区可能差一天
    updated_at: new Date().toISOString(),
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