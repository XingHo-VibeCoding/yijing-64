/**
 * 数据访问层：起卦记录表 `divination_records`
 *
 * ============================ 本次重构（Day 19）============================
 * 原本这段查询 SQL 组装与 fetch 全写在 `index.js` 的 `exports.main` 里（第 495–527 行），
 * 和路由、参数校验、响应拼装混在同一个函数中。现在**全部搬到这里**。
 *
 * 回答今天要回答的问题 ——「查数据库」这段代码从哪移到了哪」：
 *   从 `cloudfunctions/api/index.js` 的 `exports.main`（第 495–527 行）
 *   移到了 `cloudfunctions/api/repositories/recordsRepository.js` 的 `listRecords()`
 *
 * 分层约定：
 *   · repository **只管发查询与拿原始行**，不含任何 HTTP 状态码 / 响应信封
 *   · 行 → 契约字段的映射（mapRow）也放在这里：它贴着列名，是数据访问的一部分
 *   · 上层的 `hasMore` 判断留在接口层，因为它是**响应形状**的一部分（契约 meta）
 *   · 任何异常都**抛出**而不是转成响应码 —— 由接口层决定「这是 503 还是 500」
 *
 * ⚠️ 行为与重构前逐字节一致：查询串的顺序、`limit+1` 多取一条、
 *    `date=lt.` 过滤、列的顺序都保持原样（回归清单会核对）。
 */

const ENV_ID = 'yijing-64-d1g9uvmlkf13c8f77' // 环境 ID：非密钥
const REST_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`

/** 契约 2.1 的列清单与排序 */
const SELECT = 'date,hexagram_id,changing_lines'
const ORDER = 'date.desc'
const DEFAULT_LIMIT = 60
const MAX_LIMIT = 365

/** 数据库列 → 契约里的 camelCase 字段（贴着列名，所以留在数据访问层） */
const mapRow = (r) => ({
  date: r.date,
  hexagramId: r.hexagramId != null ? r.hexagramId : r.hexagram_id,
  changingLines: r.changing_lines || [],
})

/**
 * 列出起卦记录。
 *
 * @param {string} token     透传给 PostgREST 的 Bearer（不拼进查询串）
 * @param {object} opts
 * @param {number} opts.limit      已校验过的条数上限
 * @param {string} [opts.before]   YYYY-MM-DD，只取该日期之前的
 * @param {string} [opts.demoUid]  示例数据通道用；**通道 A 不传**，靠 RLS 过滤
 * @returns {Promise<Array>} 原始行数组（**多取了一条**，供上层判断 hasMore）
 */
async function listRecords(token, { limit = DEFAULT_LIMIT, before = '', demoUid = '' } = {}) {
  const q = [
    'select=' + encodeURIComponent(SELECT),
    'order=' + encodeURIComponent(ORDER),
    // ⚠️ 多取一条，用来判断 hasMore（踩过一次：按截断后的条数判断，hasMore 永远是 false）
    'limit=' + (limit + 1),
  ]
  if (demoUid) q.push('uid=eq.' + encodeURIComponent(demoUid))
  // 通道 A 不加任何 uid 条件：RLS 的 `uid = current_uid()` 会自动只返回自己的行
  if (before) q.push('date=lt.' + encodeURIComponent(String(before)))

  const url = REST_BASE + '/v1/rdb/rest/divination_records?' + q.join('&')
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
    // PostgREST 的错误体是 { code, details, hint, message }
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

module.exports = { listRecords, DEFAULT_LIMIT, MAX_LIMIT }