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

/**
 * CORS 预检响应。
 *
 * ⚠️ 为什么必须处理 OPTIONS：静态托管与 HTTP 访问服务是**两个不同域名**
 *    （…tcloudbaseapp.com 与 …ap-shanghai.app.tcloudbase.com），所以前端 fetch 本接口是跨域的。
 *    而通道 A 必须带 `Authorization` 头 —— 带自定义头的跨域请求**一定会先发预检**，
 *    预检不过就根本发不出真正的请求（表现为浏览器控制台报错、请求根本没到函数）。
 *
 * 网关会自动回显 `Access-Control-Allow-Origin`（实测带 Origin 头时它就返回了），
 * 但 `Access-Control-Allow-Headers` / `-Methods` 得自己给 —— 网关不代劳。
 * 既然本函数只接受 GET，预检一律回 204（OPTIONS 不算「非 GET 业务请求」，
 * 它是浏览器问「我能不能发这个请求」，不是用户发来的读请求）。
 */
function preflight(headers) {
  const origin = headers.origin || '*'
  return {
    statusCode: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
    body: '',
  }
}

const json = (statusCode, obj, headers) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    // 显式带上：不能只依赖网关回显，函数自己保证一份（含 Vary，避免被缓存串味）
    'Access-Control-Allow-Origin': (headers && headers.origin) || '*',
    Vary: 'Origin',
  },
  body: JSON.stringify(obj),
})
const ok = (items, meta, headers) => json(200, { ok: true, items, meta }, headers)
const fail = (statusCode, code, message, headers) =>
  json(statusCode, { ok: false, error: { code, message } }, headers)

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
 * 取请求体里的业务字段（POST 用）。
 *
 * ⚠️ 网关可能把 body 做成 base64（`isBase64Encoded: true`），也可能已经是对象或 JSON 串 ——
 *    三种都兜住。任何一种解不出来都返回 null，由调用方报 400（而不是当成「空 body」蒙过去）。
 */
function readJsonBody(event) {
  if (!event) return null
  let raw = event.body
  if (raw == null) return null
  if (event.isBase64Encoded) {
    try {
      raw = Buffer.from(String(raw), 'base64').toString('utf8')
    } catch (e) {
      return null
    }
  }
  if (typeof raw === 'object') return raw
  const text = String(raw).trim()
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    return null
  }
}

/**
 * 业务日：按 Asia/Shanghai 取「今天」，返回 YYYY-MM-DD。
 *
 * ⚠️ 两个踩过的点：
 *   ① 云函数运行时**默认 UTC**，直接 `toISOString()` 会在每天 08:00 前算成前一天 ——
 *      契约 §一 要求「服务器本地日」，所以必须显式带时区。
 *   ② **不能用 `Intl.DateTimeFormat('en-CA', …).format()`** —— 它的输出格式**取决于运行时的 ICU 版本**：
 *      本机 Node 22 返回 `2026-10-04`，而云函数（Node 18）实测返回 `10/04/2026`（美式）。
 *      `en-CA` 并不是 everywhere 都输出 ISO 格式。改用 `formatToParts()` 逐字段取，
 *      **自己拼字符串**，结果就与 ICU 无关了。
 */
function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const g = {}
  for (const p of parts) g[p.type] = p.value
  return g.year + '-' + g.month + '-' + g.day
}

/**
 * 从会话 token 里取出 uid（sub），供**写入**接口填 `uid` 列。
 *
 * ⚠️ 为什么只有写接口才需要「自己拼 uid」：读接口由 RLS 的 `uid = current_uid()` 自动过滤，
 *    查询里完全不带 uid（契约 §二）。而写入必须**显式提供** uid —— 否则 PostgREST 无从得知这行是谁的。
 *
 * ⭐ 安全性论证（为什么这不是「自己拼 uid 过滤」那个反模式）：
 *   ① JWT payload 只是 base64url 编码、**未加密**，本函数解它只是为了拿到 `sub`；
 *   ② 真正的把关在下游 —— 同一个 token 会被转发给 PostgREST，**PostgREST 验签**，
 *      签名无效则整个请求 401，压根写不进去；
 *   ③ 就算签名有效，RLS 的 `with check (uid = current_uid())` 会再校验一次，
 *      填错 uid 直接被数据库拒（42501）。
 *   三层里任何一层不通过都写不进去，所以「解 payload」这个动作本身开不出越权入口。
 */
function uidFromToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload.sub === 'string' ? payload.sub : ''
  } catch (e) {
    return ''
  }
}

/** 极简服务日志：只记「谁在什么时候做了什么、结果如何」，**绝不记 token / 完整请求体** */
function logEvent(level, event, detail) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    detail: detail || {},
  })
  try {
    if (level === 'error') console.error(line)
    else console.log(line)
  } catch (e) {
    /* 日志失败绝不能影响业务 */
  }
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

/* ============================================================================
 * 写接口：POST /api/favorites（契约 3.2）
 * ==========================================================================*/

/**
 * POST /api/favorites —— 添加收藏
 *
 * 契约 3.2 原文：
 *   请求   body：{ "hexagramId": 12 }
 *   响应   201（新建）/ 200（已收藏）→ { ok: true, data: { hexagramId, createdAt } }
 *   错误   401、422（hexagramId 不在 1–64）
 *
 * ── 防重复：按契约「幂等」处理，**不返回 409** ──
 *   契约 §一「幂等」一节写明「写接口一律幂等（重复调用不产生重复数据、不报错）」，
 *   且 3.2 明确区分 201 / 200 两种成功码 —— 所以重复收藏**照常成功**，只是状态码 200。
 *   落库靠主键 `(uid, hexagram_id)` + `Prefer: resolution=merge-duplicates`（upsert 语义），
 *   唯一的保证来自数据库主键，**不靠「先查后写」**（那样有并发竞态）。
 *
 * ── 校验顺序（错了要说清缺什么，所以逐项检查并给出中文原因）──
 *   ① body 能否解析成 JSON      → 400「请求体不是合法的 JSON」
 *   ② hexagramId 是否存在        → 422「缺少必填字段 hexagramId（要收藏的卦序号）」
 *   ③ 是否为整数                 → 422「hexagramId 必须是整数」
 *   ④ 是否在 1–64                → 422「hexagramId 必须在 1 – 64 之间」
 */
async function postFavorites(event, headers) {
  // ── 身份：写入只走通道 A（必须真实会话）──
  // ⚠️ 刻意**不**支持 ?uid=demo-* 写入 —— 示例数据是给人看的，
  //    让公开凭证能往库里写行，等于开一个匿名写入口。契约 §二也写明「客户端不得传 uid」。
  const caller = headers.authorization || ''
  if (!/^Bearer\s+\S+/i.test(caller)) {
    logEvent('warn', 'favorites.post', { reason: 'missing_session' })
    return fail(401, 'UNAUTHENTICATED', '请先登录后再收藏（需要带上会话）', headers)
  }
  const token = caller.replace(/^Bearer\s+/i, '').trim()
  const uid = uidFromToken(token)
  if (!uid || uid === 'anon') {
    logEvent('warn', 'favorites.post', { reason: 'no_uid_in_token' })
    return fail(401, 'UNAUTHENTICATED', '会话里没有身份信息，无法收藏', headers)
  }

  // ── 校验 body ──
  const body = readJsonBody(event)
  if (body === null) {
    return fail(400, 'BAD_REQUEST', '请求体不是合法的 JSON（应形如 {"hexagramId": 12}）', headers)
  }
  if (body.hexagramId === undefined || body.hexagramId === null || body.hexagramId === '') {
    return fail(422, 'VALIDATION_FAILED', '缺少必填字段 hexagramId（要收藏的卦序号，1 – 64）', headers)
  }
  const raw = body.hexagramId
  const hexagramId = typeof raw === 'string' ? Number(raw.trim()) : raw
  if (!Number.isInteger(hexagramId)) {
    return fail(422, 'VALIDATION_FAILED',
      'hexagramId 必须是整数，收到的是「' + String(raw).slice(0, 20) + '」', headers)
  }
  if (hexagramId < 1 || hexagramId > 64) {
    return fail(422, 'VALIDATION_FAILED',
      'hexagramId 必须在 1 – 64 之间，收到的是 ' + hexagramId, headers)
  }

  // ── 判定是否已存在 ──
  // ⚠️ 这里用「先查 → 已存在就短路返回 / 不存在才 INSERT」，**不用 upsert**。
  //    原因（实测踩到）：`Prefer: resolution=merge-duplicates`（ON CONFLICT DO UPDATE）
  //    在有 RLS 的表上会先读现有行，于是 SELECT 策略也参与了判定 ——
  //    报错 `new row violates row-level security policy (USING expression)`，HTTP 401。
  //    第一次 POST（无冲突、只走 INSERT）成功，**重复 POST 必然失败**，正好与目标相反。
  //    正确做法：已存在 → 直接返回 200 且**不写库**（契约要的就是「不产生重复数据、不报错」，
  //    而且不改动原有的 createdAt 更符合「收藏时间就是第一次收藏的时间」）。
  //    唯一性仍由主键 `(uid, hexagram_id)` 兜底；万一并发下撞了，409 分支会重读一次按 200 返回。
  const before = await readOneFavorite(token, hexagramId)
  if (before) {
    logEvent('info', 'favorites.post', { uid: uid, hexagramId: hexagramId, result: 'already_exists' })
    return json(200, { ok: true, data: before }, headers)
  }

  // ── 写入（纯 INSERT，不带 on_conflict）──
  const url = REST_BASE + '/v1/rdb/rest/favorites'
  const payloadRow = {
    uid: uid,
    hexagram_id: hexagramId,
    // ⚠️ 契约 §一「不存时刻」：表里有 created_at（下游只截断到日），
    //    但**显式按 Asia/Shanghai 写**当天零点，不让服务器 UTC 时区决定是几号。
    created_at: shanghaiToday() + 'T00:00:00+08:00',
  }
  let res, text, back
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=utf-8',
        // ⚠️ 刻意**不加** return=representation —— 那会让 PostgREST 对新行再跑一次
        //    `USING` 校验，而策略的 `USING` 是给「已存在的行」写的，对刚插入的行会判不通过。
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payloadRow),
    })
    text = await res.text()
  } catch (e) {
    logEvent('error', 'favorites.post', { hexagramId: hexagramId, error: String((e && e.message) || e) })
    return fail(503, 'UPSTREAM_UNAVAILABLE',
      '连不上数据库，写入没有完成（本地已生效，可稍后重试）', headers)
  }
  try {
    back = text ? JSON.parse(text) : null
  } catch (e) {
    back = null
  }

  if (!res.ok) {
    const message = (back && back.message) || '写入失败'
    logEvent('error', 'favorites.post', { hexagramId: hexagramId, upstream: res.status, message: message })
    if (res.status === 401) {
      // ⚠️ 不要把上游错误体吞掉：同一个 401 有两种完全不同的情况 ——
      //    「token 真的失效」与「token 有效但这个请求不被接受」（如 on_conflict 参数不被支持）。
      //    笼统说「会话已过期」会把后者误导成前者，排查时会走错方向。
      //    这里给用户一句可理解的话，但把上游原文放进 detail 便于定位。
      const upstream = String((back && back.message) || '').slice(0, 200)
      logEvent('error', 'favorites.post', { hexagramId: hexagramId, upstream: 401, upstreamMsg: upstream })
      return json(401, {
        ok: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: '写入被数据库拒绝：会话无法通过校验。若刚登录过就重试一次；仍不行请看服务端日志。',
          detail: upstream,
        },
      }, headers)
    }
    // 403 / 42501：RLS 的 with check 没通过 —— 说明填的 uid 与会话不符
    if (res.status === 403) return fail(403, 'FORBIDDEN', '没有权限写入这一行', headers)
    if (res.status === 409) {
      // 并发下两个人同时收藏同一卦：主键挡住了重复。重读一次按「已存在」返回 200（仍是幂等成功）
      const again = await readOneFavorite(token, hexagramId)
      if (again) return json(200, { ok: true, data: again }, headers)
      return fail(409, 'CONFLICT', '这一卦已在收藏里', headers)
    }
    return fail(500, 'INTERNAL', message, headers)
  }

  const data = { hexagramId: hexagramId, createdAt: shanghaiToday() }
  logEvent('info', 'favorites.post', { uid: uid, hexagramId: hexagramId, result: 'created' })
  return json(201, { ok: true, data: data }, headers)
}

/**
 * 读单条收藏，用于判定「是否已存在」。
 * ⚠️ 查询**不带 uid 条件** —— RLS 的 `uid = current_uid()` 自动只返回自己的行，
 *    这也顺带证明了「不会把别人的收藏算成自己的」。
 * 任何异常都当 null（读不到不影响主流程，写入的成败由 upsert 的响应决定）。
 */
async function readOneFavorite(token, hexagramId) {
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

/* ============================================================================
 * 入口：解析请求 → 分派（GET 读 / POST 写）
 * ==========================================================================*/
exports.main = async (event) => {
  const method = String((event && (event.httpMethod || event.method)) || 'GET').toUpperCase()
  const { path, qs, headers } = readRequest(event || {})

  // 网关默认不透传路径前缀（EnablePathTransmission=false），所以 /api/records 会变成 /records。
  // 两种都认：取最后一段，避免前缀差异导致路由不到。
  const name = path.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''

  // 预检先答（跨域 + 带 Authorization 头时浏览器必发），不算业务请求
  if (method === 'OPTIONS') return preflight(headers)

  /* ── 写：POST /api/favorites ── */
  if (name === 'favorites' && method === 'POST') {
    return postFavorites(event, headers)
  }

  /* ── 读：GET /api/records、GET /api/favorites ── */
  if (method !== 'GET') {
    return fail(405, 'METHOD_NOT_ALLOWED',
      name === 'favorites' ? '这个接口用 POST 访问（提交 body）' : '这个接口只接受 GET', headers)
  }
  const spec = READS[name]
  if (!spec) {
    return fail(404, 'NOT_FOUND', '没有这个接口：' + path, headers)
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
      return fail(403, 'FORBIDDEN', 'uid 参数只接受示例数据（demo-yijing64-user-*）', headers)
    }
    demoUid = String(qs.uid)
    token = process.env.PUBLISHABLE_KEY || ''
    if (!token) {
      return fail(503, 'UPSTREAM_UNAVAILABLE', '未配置 PUBLISHABLE_KEY，无法读取示例数据', headers)
    }
  } else {
    return fail(401, 'UNAUTHENTICATED',
      '缺少会话：请带 Authorization 头，或用 ?uid=demo-yijing64-user-a 读示例数据', headers)
  }

  // ── 2. 参数校验（先校验、再拼查询串）──
  let limit = spec.defaultLimit
  if (qs.limit !== undefined && qs.limit !== '') {
    if (!/^\d{1,4}$/.test(String(qs.limit))) {
      return fail(422, 'VALIDATION_FAILED', 'limit 必须是正整数', headers)
    }
    limit = Number(qs.limit)
    if (limit < 1 || limit > spec.maxLimit) {
      return fail(422, 'VALIDATION_FAILED', 'limit 必须在 1 – ' + spec.maxLimit + ' 之间', headers)
    }
  }
  if (qs.before !== undefined && qs.before !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(qs.before))) {
      return fail(422, 'VALIDATION_FAILED', 'before 必须是 YYYY-MM-DD', headers)
    }
  }

  // ── 3. 组装 PostgREST 查询（值全部编码，不做字符串拼接 SQL）──
  const q = [
    'select=' + encodeURIComponent(spec.select),
    'order=' + encodeURIComponent(spec.order),
    'limit=' + (limit + 1),              // 多取一条，用来判断 hasMore
  ]
  if (demoUid) q.push('uid=eq.' + encodeURIComponent(demoUid))
  // 通道 A 不加任何 uid 条件：RLS 的 `uid = current_uid()` 会自动只返回自己的行
  if (qs.before) q.push('date=lt.' + encodeURIComponent(String(qs.before)))

  const url = REST_BASE + '/v1/rdb/rest/' + spec.table + '?' + q.join('&')

  let res, payload
  try {
    res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
  } catch (e) {
    return fail(503, 'UPSTREAM_UNAVAILABLE', '连不上数据库 HTTP 接口', headers)
  }
  const text = await res.text()
  try {
    payload = JSON.parse(text)
  } catch (e) {
    return fail(503, 'UPSTREAM_UNAVAILABLE', '数据库返回的不是 JSON', headers)
  }
  if (!res.ok) {
    // PostgREST 的错误体是 { code, details, hint, message }
    return fail(res.status === 401 ? 401 : 500,
      res.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL',
      (payload && payload.message) || '数据库查询失败', headers)
  }
  if (!Array.isArray(payload)) {
    return fail(500, 'INTERNAL', '数据库返回形状异常', headers)
  }

  // payload 是「多取一条」的原始结果：条数先留着，截断后再算 meta
  const rawCount = payload.length
  const items = payload.slice(0, limit).map(spec.map)
  return ok(items, spec.meta(rawCount, items.length), headers)
}
