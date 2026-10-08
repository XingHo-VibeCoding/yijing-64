/**
 * 接口层：业务接口云函数（第 3 周）
 *
 * 实现契约里登记的三个**已上线**接口（docs/api-contract.md §四）：
 *   GET  /api/records    起卦记录列表（表 divination_records）—— 契约 2.1
 *   GET  /api/favorites  收藏列表（表 favorites）            —— 契约 3.1
 *   POST /api/favorites  添加收藏（表 favorites）            —— 契约 3.2
 *
 * 形态：**事件型云函数（Event）** + HTTP 访问服务的路径路由。
 * 返回值含 statusCode → 平台识别为「集成响应」，所以 401 / 405 / 422 能真正发出去。
 *
 * ── 响应形状（严格照契约 §二，严格照 Day 18 上线版本）────────────
 *   成功：{ "ok": true, "items": [...], "meta": { ... } }
 *   失败：{ "ok": false, "error": { "code": "...", "message": "..." } }
 *   （health 是契约里刻意的例外，不套这个信封，本函数不碰它）
 *
 * ============================================================================
 * 分层结构（Day 19 重构后）—— 本文件现在只做三件事：接请求、调函数、返响应
 * ============================================================================
 *
 *   cloudfunctions/api/
 *     ├── index.js                      ← 你在这里：路由 + 校验 + 响应
 *     ├── lib/
 *     │   ├── http.js                   响应信封 / CORS 预检 / 日志
 *     │   ├── request.js                网关事件解析（path / qs / headers / body）
 *     │   └── identity.js               uidFromToken / shanghaiToday
 *     └── repositories/
 *         ├── recordsRepository.js      起卦记录表的全部查询
 *         └── favoritesRepository.js    收藏表的全部查询
 *
 * ⭐ **「查数据库」的代码从哪移到了哪**（今天要回答的问题）：
 *   重构前：全部写在下面 `exports.main`（第 495–527 行）与 `postFavorites`
 *   （第 334–395 行）、`readOneFavorite`（第 408–425 行）里。
 *   重构后：搬到了 `repositories/*.js`，本文件**一行 SQL 都不再出现**。
 *   搬走的是：`select` / `order` / `limit+1` 的查询串组装、`fetch` 调用、
 *   JSON 解析、行 → camelCase 的映射、INSERT 语句拼装。
 *   留在本文件的是：路由分派、身份判定、参数校验（该 404 还是 422）、响应码映射。
 *
 * ── 身份与数据隔离（重构未改动，这是本项目最要紧的部分）────────────
 * 官方链路（已核实，见 docs/api-contract.md §二与 TECH_DESIGN v2.64）：
 *   客户端 Authorization: Bearer <JWT> → 网关解析 JWT → 注入数据库会话变量
 *   request.jwt.claims → PostgREST 以 anon/authenticated 角色执行 → GRANT + RLS 双重校验
 *   而 auth.uid() 就是 auth.jwt()->>'sub'，所以 **RLS 自己就能按 uid 隔离**。
 *
 * 因此本模块**从不自己拼 uid 过滤条件**（除非是明确放行的示例数据通道）：
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
 * 不拼 SQL 字符串：查询走 PostgREST 的过滤语法（已在 repository 内），
 * 值一律 encodeURIComponent 后传，数值与日期先**格式校验再拼**。
 * PostgREST 服务端会把它们绑定成参数化查询，不存在注入面。
 */

const { preflight, json, ok, fail, logEvent } = require('./lib/http')
const { readRequest, readJsonBody } = require('./lib/request')
const { uidFromToken, shanghaiToday } = require('./lib/identity')
const recordsRepo = require('./repositories/recordsRepository')
const favoritesRepo = require('./repositories/favoritesRepository')

const DEMO_UID_RE = /^demo-yijing64-user-[a-z]$/ // 通道 B 只放行这五个假 uid

// ── 读接口的注册表：只声明「这个接口读哪张表、用什么默认值」──
// ⚠️ 表名与列清单在 repository 里，这里只保留契约层的默认值与 meta 计算。
const READS = {
  records: {
    defaultLimit: recordsRepo.DEFAULT_LIMIT,
    maxLimit: recordsRepo.MAX_LIMIT,
    list: (token, opts) => recordsRepo.listRecords(token, opts),
    // ⚠️ hasMore 必须用「取回来的原始条数」判断，不能用截断后的 items ——
    //    截断后再比就永远等于 limit，hasMore 会永远是 false（踩过一次）
    meta: (rawCount, count) => ({ count, hasMore: rawCount > count }),
  },
  favorites: {
    defaultLimit: favoritesRepo.DEFAULT_LIMIT,
    maxLimit: favoritesRepo.MAX_LIMIT,
    list: (token, opts) => favoritesRepo.listFavorites(token, opts),
    meta: (rawCount, count) => ({ count }),
  },
}

/* ============================================================================
 * 读接口：GET /api/records、GET /api/favorites
 * ==========================================================================*/

/**
 * 校验 limit / before（先校验、再拼查询串）。
 * @returns {{ok:true, limit:number, before:string}|{ok:false, response:object}}
 */
function validateQuery(qs, spec) {
  let limit = spec.defaultLimit
  if (qs.limit !== undefined && qs.limit !== '') {
    if (!/^\d{1,4}$/.test(String(qs.limit))) {
      return { ok: false, code: 'limit 必须是正整数' }
    }
    limit = Number(qs.limit)
    if (limit < 1 || limit > spec.maxLimit) {
      return { ok: false, code: 'limit 必须在 1 – ' + spec.maxLimit + ' 之间' }
    }
  }
  let before = ''
  if (qs.before !== undefined && qs.before !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(qs.before))) {
      return { ok: false, code: 'before 必须是 YYYY-MM-DD' }
    }
    before = String(qs.before)
  }
  return { ok: true, limit, before }
}

/** 把 repository 抛出的异常映射成与重构前一致的响应码 */
function mapRepoError(e) {
  if (e && e.kind === 'upstream_status') {
    // PostgREST 的错误体是 { code, details, hint, message }
    return e.status === 401
      ? fail(401, 'UNAUTHENTICATED', (e.payload && e.payload.message) || '数据库查询失败', null)
      : fail(500, 'INTERNAL', (e.payload && e.payload.message) || '数据库查询失败', null)
  }
  if (e && e.kind === 'not_json') {
    return fail(503, 'UPSTREAM_UNAVAILABLE', '数据库返回的不是 JSON', null)
  }
  if (e && e.kind === 'bad_shape') {
    return fail(500, 'INTERNAL', '数据库返回形状异常', null)
  }
  // fetch 本身抛错（连不上）
  return fail(503, 'UPSTREAM_UNAVAILABLE', '连不上数据库 HTTP 接口', null)
}

async function handleRead(name, spec, qs, headers) {
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

  // ── 2. 参数校验 ──
  const v = validateQuery(qs, spec)
  if (!v.ok) return fail(422, 'VALIDATION_FAILED', v.code, headers)

  // ── 3. 交给 repository 查库 ──
  let rows
  try {
    rows = await spec.list(token, { limit: v.limit, before: v.before, demoUid })
  } catch (e) {
    return mapRepoError(e)
  }

  // rows 是「多取一条」的原始结果：条数先留着，截断后再算 meta
  const rawCount = rows.length
  const items = rows.slice(0, v.limit)
  return ok(items, spec.meta(rawCount, items.length), headers)
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
 *
 * ── 校验顺序（错了要说清缺什么，所以逐项检查并给出中文原因）──
 *   ① body 能否解析成 JSON      → 400「请求体不是合法的 JSON」
 *   ② hexagramId 是否存在        → 422「缺少必填字段 hexagramId（要收藏的卦序号）」
 *   ③ 是否为整数                 → 422「hexagramId 必须是整数」
 *   ④ 是否在 1–64                → 422「hexagramId 必须在 1 – 64 之间」
 */
async function handleFavoritesPost(event, headers) {
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
  const before = await favoritesRepo.findFavoriteByHexagramId(token, hexagramId)
  if (before) {
    logEvent('info', 'favorites.post', { uid: uid, hexagramId: hexagramId, result: 'already_exists' })
    return json(200, { ok: true, data: before }, headers)
  }

  // ── 交给 repository 写入（纯 INSERT）──
  let res
  try {
    res = await favoritesRepo.insertFavorite(token, {
      uid: uid, hexagramId: hexagramId, createdAt: shanghaiToday(),
    })
  } catch (e) {
    logEvent('error', 'favorites.post', { hexagramId: hexagramId, error: String((e && e.message) || e) })
    return fail(503, 'UPSTREAM_UNAVAILABLE',
      '连不上数据库，写入没有完成（本地已生效，可稍后重试）', headers)
  }

  if (res.status !== 200 && res.status !== 201) {
    const message = (res.payload && res.payload.message) || '写入失败'
    logEvent('error', 'favorites.post', { hexagramId: hexagramId, upstream: res.status, message: message })
    if (res.status === 401) {
      // ⚠️ 不要把上游错误体吞掉：同一个 401 有两种完全不同的情况 ——
      //    「token 真的失效」与「token 有效但这个请求不被接受」。
      //    笼统说「会话已过期」会把后者误导成前者，排查时会走错方向。
      //    这里给用户一句可理解的话，但把上游原文放进 detail 便于定位。
      const upstream = String((res.payload && res.payload.message) || '').slice(0, 200)
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
      const again = await favoritesRepo.findFavoriteByHexagramId(token, hexagramId)
      if (again) return json(200, { ok: true, data: again }, headers)
      return fail(409, 'CONFLICT', '这一卦已在收藏里', headers)
    }
    return fail(500, 'INTERNAL', message, headers)
  }

  const data = { hexagramId: hexagramId, createdAt: shanghaiToday() }
  logEvent('info', 'favorites.post', { uid: uid, hexagramId: hexagramId, result: 'created' })
  return json(201, { ok: true, data: data }, headers)
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
    return handleFavoritesPost(event, headers)
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
  return handleRead(name, spec, qs, headers)
}