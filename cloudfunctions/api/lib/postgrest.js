/**
 * PostgREST 请求助手（Day 24 新增）
 *
 * 为新增的 4 个 repository（hexagrams / quiz / gilded / me）共用，
 * 目的是**不把同一段 fetch + 错误分类写四遍**。
 *
 * ⚠️ 为什么没有回头改造 recordsRepository / favoritesRepository：
 *   那两个文件已经过了「同进程逐条比对 44/44 + 线上真实会话」的双重回归。
 *   为了「代码整洁」去动它们，等于用**已验证的东西**换**未验证的东西**。
 *   保持分层清晰的同时，把改动面控制在新增文件内 —— 这是本项目的取舍原则。
 *
 * ============================================================
 * 分层约定（与 Day 19 一致，见 recordsRepository 文件头）
 *   · 本模块只发请求、只把失败**分类**并抛出，不认识任何 HTTP 状态码
 *   · 状态码与错误码由接口层（index.js）决定
 * ============================================================
 */

const ENV_ID = 'yijing-64-d1g9uvmlkf13c8f77' // 环境 ID：非密钥
const REST_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`

/** 组装查询串：params 里 _order / _limit / 其它键按名字直出 */
function buildQuery(table, params = {}) {
  const q = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    q.push(k + '=' + encodeURIComponent(String(v)))
  }
  const qs = q.join('&')
  return REST_BASE + '/v1/rdb/rest/' + table + (qs ? '?' + qs : '')
}

/** 把 PostgREST 的失败响应归类并抛出（kind 供接口层映射状态码） */
function fail(res, text) {
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch (e) {
    /* 非 JSON 错误体：留给下面的 kind='not_json' */
  }
  if (!res.ok) {
    const err = new Error((payload && payload.message) || `数据库返回 ${res.status}`)
    err.kind = 'upstream_status'
    err.status = res.status
    err.payload = payload
    throw err
  }
  const err = new Error('数据库返回的不是 JSON')
  err.kind = 'not_json'
  throw err
}

// 解析 Content-Range 响应头里的总行数（形如 0-23/456，末尾斜杠后是总数）
function totalFromRange(res) {
  const cr = res.headers.get('content-range') || ''
  const m = cr.match(/\/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}

/**
 * 查（SELECT）
 * @param {string} token
 * @param {string} table
 * @param {object} [params] 形如 { select, order, limit, 'uid': 'eq.xxx' }
 * @param {object} [opts]
 * @param {boolean} [opts.countOnly] 只取总行数（发 limit=0 并带 Prefer: count=exact）
 * @returns {Promise<{rows:Array, count:number|null}>}
 */
async function query(token, table, params = {}, { countOnly = false } = {}) {
  // ⚠️ countOnly 的 select 列**必须每张表都有**。以前硬编码 'id'，但库里
  //    只有 study_rounds 有 id，另外四张（divination_records / favorites /
 //    study_progress / gilded）的主键是 uid → 6.1 概览线上 500
  //    `column divination_records.id does not exist`。
  //    'uid' 是五张表**唯一都有**的列（RLS 也按它过滤），选它最安全。
  const p = countOnly ? { ...params, select: params.select || 'uid', limit: 0 } : params
  const res = await fetch(buildQuery(table, p), {
    headers: {
      Authorization: 'Bearer ' + token,
      ...(countOnly ? { Prefer: 'count=exact' } : {}),
    },
  })
  const text = await res.text()
  if (!res.ok || !text) {
    // countOnly 时空 body 也可能带 Content-Range，先看能不能直接取总数
    if (countOnly && res.ok) return { rows: [], count: totalFromRange(res) }
    fail(res, text)
  }
  let rows
  try {
    rows = JSON.parse(text)
  } catch (e) {
    const err = new Error('数据库返回形状异常')
    err.kind = 'bad_shape'
    throw err
  }
  if (!Array.isArray(rows)) {
    const err = new Error('数据库返回形状异常')
    err.kind = 'bad_shape'
    throw err
  }
  return { rows, count: countOnly ? totalFromRange(res) : rows.length }
}

/**
 * 插入（INSERT）
 * ⚠️ 只在**确定没有该行**时调用 —— PG + RLS 下 `Prefer: resolution=merge-duplicates`
 *    的 upsert 会先读现有行、让 SELECT 策略参与判定，报 `new row violates row-level
 *    security policy`（表现为「第一次成功、重复必 401」）。先查后插就不会踩。
 */
async function insert(token, table, body) {
  const res = await fetch(REST_BASE + '/v1/rdb/rest/' + table, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) fail(res, text)
  try {
    const rows = JSON.parse(text)
    return Array.isArray(rows) ? rows[0] : rows
  } catch (e) {
    const err = new Error('插入后返回不是 JSON')
    err.kind = 'not_json'
    throw err
  }
}

/**
 * 更新（UPDATE）—— 按 eq 条件精确命中一行
 * @param {object} eq 形如 { uid: 'eq.xxx' }（查询串键）
 */
async function update(token, table, body, eq) {
  const res = await fetch(buildQuery(table, eq), {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) fail(res, text)
  try {
    const rows = JSON.parse(text)
    return Array.isArray(rows) ? rows[0] : rows
  } catch (e) {
    return null
  }
}

/**
 * 删除（DELETE）—— 返回被删的行（用来回报 cleared 计数）
 * ⚠️ RLS 作用域内删除：**不加 uid 条件**，RLS 保证只能删自己的行。
 *    加了反而在 demo 通道下删不到示例数据。
 */
async function del(token, table, eq) {
  const res = await fetch(buildQuery(table, eq), {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer ' + token,
      Prefer: 'return=representation',
    },
  })
  const text = await res.text()
  if (!res.ok || !text) {
    if (res.ok) return 0
    fail(res, text)
  }
  try {
    const rows = JSON.parse(text)
    return Array.isArray(rows) ? rows.length : 0
  } catch (e) {
    return 0
  }
}

module.exports = { query, insert, update, del, ENV_ID, REST_BASE }