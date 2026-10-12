/**
 * 数据访问层：镀金成就（表 `gilded`）
 *
 * 契约 5.1 / 5.2。这张表以前前端直连rdb，现在统一走本函数。
 *
 * ⭐ **语义特殊：成就只增不减**。契约 5.2 明确写的是「并集写回」——
 * 服务端取「云端已有 ∪ 本次提交」，**不接受删除**，所以是 PUT（合并）而不是覆盖。
 * 若哪天真要支持「取消镀金」，那是另一个接口，不要往这里加。
 *
 * 分层约定：与 recordsRepository 一致 —— 只发查询、只抛异常，状态码留给接口层。
 * ⚠️ 同 quizRepository：**不用 upsert**（PG + RLS 下会报策略冲突），先查后写。
 */

const rdb = require('../lib/postgrest.js')

const SELECT = 'hexagram_ids,updated_at'

const mapRow = (r) => ({
  hexagramIds: r.hexagram_ids || r.hexagramIds || [],
  updatedAt: r.updated_at || r.updatedAt || null,
})

/** 契约 5.1 `GET /api/gilded` —— 没有记录时返回空列表而不是 404 */
async function getGilded(token, { demoUid = '' } = {}) {
  const q = { select: SELECT, limit: 1 }
  if (demoUid) q.uid = 'eq.' + encodeURIComponent(demoUid)
  const { rows } = await rdb.query(token, 'gilded', q)
  return rows.length ? mapRow(rows[0]) : { hexagramIds: [], updatedAt: null }
}

/**
 * 契约 5.2 `PUT /api/gilded` —— 并集写回，返回**并集后**的完整列表
 * @param {number[]} incoming 已由接口层校验（1–64、去重、升序）
 */
async function putGilded(token, incoming, uid = '') {
  const q = { select: SELECT, limit: 1 }
  if (uid) q.uid = 'eq.' + encodeURIComponent(uid)
  const { rows } = await rdb.query(token, 'gilded', q)

  const merged = rows.length
    ? Array.from(new Set([...(rows[0].hexagram_ids || rows[0].hexagramIds || []), ...incoming]))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 64)
        .sort((a, b) => a - b)
    : incoming.slice().sort((a, b) => a - b)

  const body = { hexagram_ids: merged, updated_at: new Date().toISOString().slice(0, 10) }

  if (rows.length) {
    const eq = rows[0].uid ? { uid: 'eq.' + encodeURIComponent(rows[0].uid) } : {}
    const row = await rdb.update(token, 'gilded', body, eq)
    return mapRow(row || { ...body, updated_at: body.updated_at })
  }
  const row = await rdb.insert(token, 'gilded', uid ? { ...body, uid } : body)
  return mapRow(row || { ...body, updated_at: body.updated_at })
}

module.exports = { getGilded, putGilded }