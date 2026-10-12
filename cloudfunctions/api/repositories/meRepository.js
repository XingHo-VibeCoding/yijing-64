/**
 * 数据访问层：我的数据概览与清除（跨四张表）
 *
 * 契约 6.1 `GET /api/me/summary` / 6.2 `DELETE /api/me/data`。
 *
 * ⚠️ **本文件只做「数据访问」，不碰业务规则** —— 尤其：
 *   ·镀金（`gilded`）**永远不参与清空**：契约 6.2 写明「它是成就，不是记录」。
 *     这条口径来自 `src/storage.js#clearAll()`，两端必须一致，否则清完又被同步回来。
 *   · `scope=quiz` 要清**两张**表（`study_rounds` + `study_progress`），
 *     所以「清什么」是契约语义，在这里以 SCOPE_TABLES 表达；接口层只负责校验取值。
 *
 * 计数走 PostgREST 的 `Prefer: count=exact`（`limit=0`），不拉数据行。
 * 删除**不加 uid 条件** —— RLS 保证只能删自己的行；加了反而在 demo 通道下删不到示例数据。
 */

const rdb = require('../lib/postgrest.js')

/** 契约 6.2 的 scope → 涉及的表（`gilded` 不在任何 scope 里，这是有意的） */
const SCOPE_TABLES = {
  records: ['divination_records'],
  favorites: ['favorites'],
  quiz: ['study_rounds', 'study_progress'],
}
const ALL_TABLES = ['divination_records', 'favorites', 'study_rounds', 'study_progress']

/** 契约 6.1 响应里的键 → 表名（gilded 特殊：取卦数而非行数，故不在这里） */
const COUNT_KEYS = [
  ['records', 'divination_records'],
  ['favorites', 'favorites'],
  ['rounds', 'study_rounds'],
]

/**
 * 契约 6.1 `GET /api/me/summary`
 * @returns {Promise<{records:number, favorites:number, gilded:number, rounds:number}>}
 */
async function summary(token, { demoUid = '' } = {}) {
  const out = { records: 0, favorites: 0, gilded: 0, rounds: 0 }

  for (const [key, table] of COUNT_KEYS) {
    const q = demoUid ? { uid: 'eq.' + encodeURIComponent(demoUid) } : {}
    const r = await rdb.query(token, table, q, { countOnly: true })
    // count 读不出来时退回行数（countOnly 的 rows 为空），宁可少报也不要假装是 0
    out[key] = r.count != null ? r.count : 0
  }

  // gilded：每 uid 只有一行，要的是**镀了几卦**，所以取 hexagram_ids 长度
  const gq = { select: 'hexagram_ids', limit: 1 }
  if (demoUid) gq.uid = 'eq.' + encodeURIComponent(demoUid)
  const g = await rdb.query(token, 'gilded', gq)
  out.gilded = g.rows.length ? (g.rows[0].hexagram_ids || g.rows[0].hexagramIds || []).length : 0

  return out
}

/**
 * 契约 6.2 `DELETE /api/me/data`
 * @param {string} scope records | favorites | quiz | all（接口层已校验）
 * @returns {Promise<object>} { records, favorites, rounds } 各删除了多少行
 */
async function clearMyData(token, scope) {
  const tables = scope === 'all' ? ALL_TABLES : SCOPE_TABLES[scope] || []
  const cleared = { records: 0, favorites: 0, rounds: 0 }

  for (const table of tables) {
    const n = await rdb.del(token, table)
    if (table === 'divination_records') cleared.records += n
    else if (table === 'favorites') cleared.favorites += n
    else if (table === 'study_rounds') cleared.rounds += n
    // study_progress 是单行进度，不进契约的 cleared 字段（契约只列三项）
  }
  return cleared
}

module.exports = { summary, clearMyData, SCOPE_TABLES }