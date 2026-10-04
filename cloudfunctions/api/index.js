/**
 * 读取接口云函数 —— 第 3 周 · 任务「第一个 GET 读接口」
 *
 * 实现契约里登记的两个**读**接口（docs/api-contract.md §四）：
 *   GET /api/records    起卦记录列表（表 divination_records）—— 契约 2.1
 *   GET /api/favorites  收藏列表（表 favorites）           —— 契约 3.1
 *
 * 形态与 health 同一族：**事件型云函数（Event）** + HTTP 访问服务的路径路由。
 * 返回值含 statusCode → 平台识别为「集成响应」，所以 401 / 405 / 422 能真正发出去。
 *
 * ── 响应形状（严格照契约 §二）────────────────────────────────
 *   成功：{ "ok": true, "items": [...], "meta": { ... } }
 *   失败：{ "ok": false, "error": { "code": "...", "message": "..." } }
 *   （health 是契约里刻意的例外，不套这个信封，本函数不碰它）
 *
 * ── 身份与数据隔离（这是本文件最要紧的部分）────────────────────
 * 官方链路（已核实，见 docs/api-contract.md §二与 TECH_DESIGN v2.64）：
 *   客户端 Authorization: Bearer <JWT> → 网关解析 JWT → 注入数据库会话变量
 *   request.jwt.claims → PostgREST 以 anon/authenticated 角色执行 → GRANT + RLS 双重校验
 *   而 auth.uid() 就是 auth.jwt()->>'sub'，所以 **RLS 自己就能按 uid 隔离**。
 *
 * 因此本函数**从不自己拼 uid 过滤条件**（除非是下面明确放行的示例数据通道）：
 *   通道 A（契约口径，默认）：把调用方的 Authorization 头**原样透传**给 PostgREST，
 *          查询里不带任何 uid 条件 → RLS 策略 `uid = current_uid()` 自动只返回自己的行。
 *          客户端不传 uid、服务端也不手工传 uid —— 身份伪造在源头就没有入口。
 *   通道 B（示例数据读，无会话时）：?uid=demo-yijing64-user-*
 *          用 PUBLISHABLE_KEY（role=anon、sub 恒为 'anon'）访问，**只允许 demo 前缀**。
 *          这里的「只允许 demo」由**数据库 RLS 策略**兜底
 *          （迁移 add_demo_read_policy，见 db/migrations/），不是只靠函数里判断。
 *
 * ⚠️ 关于 PUBLISHABLE_KEY：它设计上就是给前端公开嵌入的凭证（role=anon，
 *    只能读 RLS 放行的行），不是服务端密钥。它只从环境变量读，**不写进代码、不进仓库**。
 *
 * ── 参数化 ────────────────────────────────────────────────
 * 本函数不拼 SQL 字符串：查询走 PostgREST 的过滤语法，值一律 encodeURIComponent 后传，
 * 数值与日期先做**格式校验再拼**（limit 限整数与上限、before 限 YYYY-MM-DD）。
 * PostgREST 服务端会把它们绑定成参数化查询，不存在注入面。
 */

const ENV_ID = 'yijing-64-d1g9uvmlkf13c8f77' // 环境 ID：非密钥
const REST_BASE = `https://${ENV_ID}.api.tcloudbasegateway.com`
const DEMO_UID_RE = /^demo-yijing64-user-[a-z]$/ // 通道 B 只放行这五个假 uid

// ── 两个读接口的定义（与契约一一对应）──
const READS = {
  records: {
    table: 'divination_records',
    select: 'date,hexagram_id,changing_lines',
    order: 'date.desc',
    defaultLimit: 60,
    maxLimit: 365,
    // 数据库列 → 契约里的 camelCase 字段
    map: (r) => ({ date: r.date, hexagramId: r.hexagram_id, changingLines: r.changing_lines || [] }),
    // ⚠️ hasMore 必须用「取回来的原始条数」判断，不能用截断后的 items ——
    //    截断后再比就永远等于 limit，hasMore 会永远是 false（踩过一次）
    meta: (rawCount, count) => ({ count, hasMore: rawCount > count }),
  },
  favorites: {
    table: 'favorites',
    select: 'hexagram_id,created_at',
    order: 'created_at.desc',
    defaultLimit: 60,
    maxLimit: 365,
    map: (r) => ({ hexagramId: r.hexagram_id, createdAt: String(r.created_at || '').slice(0, 10) }),
    meta: (rawCount, count) => ({ count }),
  },
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(obj),
})
const ok = (items, meta) => json(200, { ok: true, items, meta })
const fail = (statusCode, code, message) => json(statusCode, { ok: false, error: { code, message } })

/** 把 "a=1&b=2" 或 "?a=1&b=2" 解析成对象 */
function parseQs(str) {
  const out = {}
  for (const seg of String(str).replace(/^\?/, '').split('&').filter(Boolean)) {
    const i = seg.indexOf('=')
    if (i <= 0) continue
    try {
      out[decodeURIComponent(seg.slice(0, i))] = decodeURIComponent(seg.slice(i + 1).replace(/\+/g, ' '))
    } catch (e) { /* 参数编码坏了就当没传，不猜 */ }
  }
  return out
}

/**
 * 从网关事件里取出路径、查询串、请求头。
 * ⚠️ 不同网关版本 / 不同触发方式下字段位置不一样（health 只用到 httpMethod），
 *    所以这里把已知的所有可能来源都兜住 —— 少兜一个就可能取不到 ?uid= 而误报 401。
 */
function readRequest(event) {
  const headers = event.headers || event.header || {}
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]

  // 路径候选：网关默认不透传前缀（EnablePathTransmission=false），/api/records 会变成 /records
  const rawPath = String(
    event.path || event.rawPath || event.url || event.httpPath || event.requestContext?.path || ''
  )
  const [pathOnly, qsInPath] = rawPath.split('?')

  // 查询串候选：对象或字符串都认，再合并 path 里带的
  let qs = {}
  for (const src of [event.queryString, event.queryStringParameters, event.query, event.queryStringObject]) {
    if (!src) continue
    if (typeof src === 'string') Object.assign(qs, parseQs(src))
    else if (typeof src === 'object') Object.assign(qs, src)
  }
  if (qsInPath) Object.assign(qs, parseQs(qsInPath))

  // 少数网关把请求体当成 JSON 串传过来，里面可能有 path / query
  if (typeof event.body === 'string' && event.body.startsWith('{')) {
    try {
      const b = JSON.parse(event.body)
      if (b && typeof b === 'object') {
        if (b.path && !pathOnly) return readRequest({ ...event, path: b.path })
        if (b.queryString) Object.assign(qs, parseQs(b.queryString))
        if (b.headers) {
          for (const k of Object.keys(b.headers)) lower[k.toLowerCase()] = b.headers[k]
        }
      }
    } catch (e) { /* 不是 JSON 就忽略 */ }
  }

  return { path: pathOnly, qs, headers: lower }
}

exports.main = async (event) => {
  const method = String((event && (event.httpMethod || event.method)) || 'GET').toUpperCase()
  const { path, qs, headers } = readRequest(event || {})

  // 网关默认不透传路径前缀（EnablePathTransmission=false），所以 /api/records 会变成 /records。
  // 两种都认：取最后一段，避免前缀差异导致路由不到。
  const name = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''

  if (method !== 'GET') {
    return fail(405, 'METHOD_NOT_ALLOWED', '这个接口只接受 GET')
  }
  const spec = READS[name]
  if (!spec) {
    return fail(404, 'NOT_FOUND', `没有这个接口：${path}`)
  }

  // ── 1. 决定用哪条通道拿数据 ──
  const caller = headers.authorization || ''
  let token = ''
  let demoUid = ''
  if (/^Bearer\s+\S+/i.test(caller)) {
    token = caller.replace(/^Bearer\s+/i, '').trim()   // 通道 A：透传调用方身份
  } else if (qs.uid) {
    if (!DEMO_UID_RE.test(String(qs.uid))) {
      // 明确拒绝「用 uid 参数读别人的数据」——这是契约 §二「客户端不得传 uid」的兜底
      return fail(403, 'FORBIDDEN', 'uid 参数只接受示例数据（demo-yijing64-user-*）')
    }
    demoUid = String(qs.uid)
    token = process.env.PUBLISHABLE_KEY || ''
    if (!token) {
      return fail(503, 'UPSTREAM_UNAVAILABLE', '未配置 PUBLISHABLE_KEY，无法读取示例数据')
    }
  } else {
    return fail(401, 'UNAUTHENTICATED', '缺少会话：请带 Authorization 头，或用 ?uid=demo-yijing64-user-a 读示例数据')
  }

  // ── 2. 参数校验（先校验、再拼查询串）──
  let limit = spec.defaultLimit
  if (qs.limit !== undefined && qs.limit !== '') {
    if (!/^\d{1,4}$/.test(String(qs.limit))) {
      return fail(422, 'VALIDATION_FAILED', 'limit 必须是正整数')
    }
    limit = Number(qs.limit)
    if (limit < 1 || limit > spec.maxLimit) {
      return fail(422, 'VALIDATION_FAILED', `limit 必须在 1 – ${spec.maxLimit} 之间`)
    }
  }
  if (qs.before !== undefined && qs.before !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(qs.before))) {
      return fail(422, 'VALIDATION_FAILED', 'before 必须是 YYYY-MM-DD')
    }
  }

  // ── 3. 组装 PostgREST 查询（值全部编码，不做字符串拼接 SQL）──
  const q = [
    `select=${encodeURIComponent(spec.select)}`,
    `order=${encodeURIComponent(spec.order)}`,
    `limit=${limit + 1}`,              // 多取一条，用来判断 hasMore
  ]
  if (demoUid) q.push(`uid=eq.${encodeURIComponent(demoUid)}`)
  // 通道 A 不加任何 uid 条件：RLS 的 `uid = current_uid()` 会自动只返回自己的行
  if (qs.before) q.push(`date=lt.${encodeURIComponent(String(qs.before))}`)

  const url = `${REST_BASE}/v1/rdb/rest/${spec.table}?${q.join('&')}`

  let res, payload
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  } catch (e) {
    return fail(503, 'UPSTREAM_UNAVAILABLE', '连不上数据库 HTTP 接口')
  }
  const text = await res.text()
  try {
    payload = JSON.parse(text)
  } catch (e) {
    return fail(503, 'UPSTREAM_UNAVAILABLE', '数据库返回的不是 JSON')
  }
  if (!res.ok) {
    // PostgREST 的错误体是 { code, details, hint, message }
    return fail(res.status === 401 ? 401 : 500,
      res.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL',
      (payload && payload.message) || '数据库查询失败')
  }
  if (!Array.isArray(payload)) {
    return fail(500, 'INTERNAL', '数据库返回形状异常')
  }

  // payload 是「多取一条」的原始结果：条数先留着，截断后再算 meta
  const rawCount = payload.length
  const items = payload.slice(0, limit).map(spec.map)
  return ok(items, spec.meta(rawCount, items.length))
}
