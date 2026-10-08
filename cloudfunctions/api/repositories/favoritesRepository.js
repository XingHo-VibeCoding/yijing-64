/**
 * 数据访问层：收藏表 `favorites`
 *
 * ============================ 本次重构（Day 19）============================
 * 原本两处数据库操作都写在 `index.js` 里：
 *   ① 列表查询（GET）在 `exports.main` 第 495–527 行 → 移至 `listFavorites()`
 *   ② 单条判定 + 插入（POST）在 `postFavorites` 第 334–395 行与 `readOneFavorite` 第 408–425 行
 *      → 移至 `insertFavorite()` 与 `findFavoriteByHexagramId()`
 *
 * 分层约定同上：repository 只发查询、只抛异常，不认识 statusCode。
 *
 * ⚠️ 三条行为必须原样保留（都是实测踩出来的）：
 *  ① **插入不带 `on_conflict`**。`Prefer: resolution=merge-duplicates`（ON CONFLICT DO UPDATE）
 *     在有 RLS 的表上会先读现有行 → SELECT 策略也参与判定 → 报
 *     `new row violates row-level security policy (USING expression)` → HTTP 401。
 *     症状是「第一次成功、重复必 401」，正好与目标相反。防重复靠**先查后短路**。
 *  ② **不带 `return=representation`**。那会让 PostgREST 对新行再跑一次 `USING` 校验，
 *     而策略的 `USING` 是给「已存在的行」写的，对刚插入的行判不通过。
 *     所以用 `return=minimal`。
 *  ③ `findFavoriteByHexagramId` 的查询**不带 uid 条件** —— RLS 自动只返回自己的行，
 *     这顺带证明了「不会把别人的收藏算成自己的」。
 */

const ENV_ID = 'yijing-64-d1g9uvmlkf13c8f77' // 环境 ID：非密钥
const REST_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`

/** 契约 3.1 的列清单与排序 */
const SELECT = 'hexagram_id,created_at'
const ORDER = 'created_at.desc'
const DEFAULT_LIMIT = 60
const MAX_LIMIT = 365

const mapRow = (r) => ({
  hexagramId: r.hexagramId != null ? r.hexagramId : r.hexagram_id,
  // 只到日 —— 与契约 §一「不存时刻」同口径
  createdAt: String(r.createdAt || r.created_at || '').slice(0, 10),
})

/**
 * 列出收藏。
 * @returns {Promise<Array>} 原始行数组（多取了一条）
 */
async function listFavorites(token, { limit = DEFAULT_LIMIT, before = '', demoUid = '' } = {}) {
  const q = [
    'select=' + encodeURIComponent(SELECT),
    'order=' + encodeURIComponent(ORDER),
    'limit=' + (limit + 1),
  ]
  if (demoUid) q.push('uid=eq.' + encodeURIComponent(demoUid))
  // ⚠️ 收藏表**没有 date 列**，`before` 语义是 created_at，
  //    与重构前一致：主程序只对 records 传 before，favorites 忽略它。
  if (before) q.push('created_at=lt.' + encodeURIComponent(String(before)))

  const url = REST_BASE + '/v1/rdb/rest/favorites?' + q.join('&')
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
  const text = await res.text()

  let payload
  try {
    payload = JSON.parse(text)
  } catch (e) {
    const err = new Error('数据库返回的不是 JSON')
    err.kind = 'not_json'
    throw err
  }
  if (!res.ok) {
    const err = new Error((payload && payload.message) || '数据库查询失败')
    err.kind = 'upstream_status'
    err.status = res.status
    err.payload = payload
    throw err
  }
  if (!Array.isArray(payload)) {
    const err = new Error('数据库返回形状异常')
    err.kind = 'bad_shape'
    throw err
  }
  return payload.map(mapRow)
}

/**
 * 查单条收藏（判定是否已存在）。
 * ⚠️ 任何异常都当 null —— 读不到不影响主流程，写入的成败由插入的响应决定。
 *    这与重构前 `readOneFavorite` 的「catch 后 return null」完全一致。
 * @returns {Promise<{hexagramId:number, createdAt:string}|null>}
 */
async function findFavoriteByHexagramId(token, hexagramId) {
  try {
    const url = REST_BASE + '/v1/rdb/rest/favorites?select='
      + encodeURIComponent('hexagram_id,created_at')
      + '&hexagram_id=eq.' + encodeURIComponent(String(hexagramId))
      + '&limit=1'
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    if (!res.ok) return null
    const rows = await res.json()
    if (!Array.isArray(rows) || !rows.length) return null
    const r = rows[0]
    return {
      hexagramId: r.hexagram_id != null ? r.hexagram_id : hexagramId,
      createdAt: String(r.created_at || '').slice(0, 10),
    }
  } catch (e) {
    return null
  }
}

/**
 * 插入一行收藏（**纯 INSERT**）。
 *
 * @param {string} token 透传给 PostgREST 的 Bearer
 * @param {object} row   { uid, hexagramId, createdAt } —— createdAt 形如 '2026-10-06'
 * @returns {Promise<{status:number, payload:any}>} 原始 status 与已解析的错误体
 *          （**不抛异常**：上层要按 status 分别映射 401 / 403 / 409 / 500，各不相同）
 */
async function insertFavorite(token, { uid, hexagramId, createdAt }) {
  const url = REST_BASE + '/v1/rdb/rest/favorites'
  const payloadRow = {
    uid: uid,
    hexagram_id: hexagramId,
    // ⚠️ 契约 §一「不存时刻」：表里有 created_at（下游只截断到日），
    //    但显式按 Asia/Shanghai 写当天零点，不让服务器 UTC 时区决定是几号。
    created_at: createdAt + 'T00:00:00+08:00',
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=utf-8',
      // ⚠️ 不加 return=representation（见文件头 ②）
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payloadRow),
  })
  const text = await res.text()
  let back = null
  try {
    back = text ? JSON.parse(text) : null
  } catch (e) {
    back = null
  }
  return { status: res.status, payload: back }
}

module.exports = {
  listFavorites, findFavoriteByHexagramId, insertFavorite,
  DEFAULT_LIMIT, MAX_LIMIT,
}