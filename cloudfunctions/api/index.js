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
/* Day 24：契约里其余 12 个接口的实现（此前只有 4 个经过云函数，前端其余直连 rdb） */
const hexagramsRepo = require('./repositories/hexagramsRepository')
const quizRepo = require('./repositories/quizRepository')
const gildedRepo = require('./repositories/gildedRepository')
const meRepo = require('./repositories/meRepository')

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

/**
 * 单对象响应：`{ ok: true, data: {...} }`
 *
 * ⚠️ 为什么需要它：`ok()` 的签名是 `ok(items, meta, headers)` —— 第一个参数会被
 * 序列化成 **items**。而契约 1.2 / 4.3 / 5.1 要的是 **data**（`{ok, data:{…}}`）。
 * 误用 `ok(data, headers)` 的后果有三重：键名错（items 而非 data）、
 * **headers 被当成 meta**（于是 CORS 头直接丢失）、以及多出一个 items 字段。
 * 三个都在实际调用时踩到了，故单独给契约的 data 形状一个明确助手。
 */
const data200 = (data, headers) => json(200, { ok: true, data }, headers)

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
 * Day 24 新增：契约里此前只有 4 个接口经过云函数，其余 12 个是设计稿
 * （前端此前直连 rdb）。本区块把它们全部落地。
 *
 * ⚠️ **为什么新路由表与旧的分派并存**：
 *   旧的 `handleRead` / `handleFavoritesPost` 已经过「同进程逐条比对 44/44 +
 *   线上真实会话」的双重回归。为了整洁去重写它们，等于拿**已验证的**换**未验证的**。
 *   所以新表**先匹配、未命中才回落旧逻辑** —— 现有 4 个接口的行为逐字节不变。
 * ==========================================================================*/

/**
 * 判定调用方通道（读接口用）：通道 A 真实会话 / 通道 B 示例数据 uid
 * 规则与旧 `handleRead` 内部**逐字一致**，抽出来只是避免重复写。
 * @returns {{ok:true, token:string, demoUid:string}|{ok:false, response:object}}
 */
function callerForRead(headers, qs) {
  const caller = headers.authorization || ''
  if (/^Bearer\s+\S+/i.test(caller)) {
    return { ok: true, token: caller.replace(/^Bearer\s+/i, '').trim(), demoUid: '' }
  }
  if (qs.uid) {
    if (!DEMO_UID_RE.test(String(qs.uid))) {
      return {
        ok: false,
        response: fail(403, 'FORBIDDEN', 'uid 参数只接受示例数据（demo-yijing64-user-*）', headers),
      }
    }
    const pk = process.env.PUBLISHABLE_KEY || ''
    if (!pk) {
      return {
        ok: false,
        response: fail(503, 'UPSTREAM_UNAVAILABLE', '未配置 PUBLISHABLE_KEY，无法读取示例数据', headers),
      }
    }
    return { ok: true, token: pk, demoUid: String(qs.uid) }
  }
  return {
    ok: false,
    response: fail(401, 'UNAUTHENTICATED',
      '缺少会话：请带 Authorization 头，或用 ?uid=demo-yijing64-user-a 读示例数据', headers),
  }
}

/**
 * 判定写接口通道：只走通道 A（必须带真实会话凭证）。
 *
 * ⭐⭐ **Day 24 实测后改的关键一条**：这里**不再要求能从 token 里解析出 uid**。
 *   实测（用真实匿名会话的 token）：token 的 payload 里只有
 *   `{ sub: "anon", is_anonymous: true }`，**根本不含 uid** ——
 *   而前端用的正是 `signInAnonymously()`，uid 只存在于 SDK 的 session 对象里，
 *   不在凭证里。于是早前「uid 为空或为 anon 就 401」的写法会让**所有写接口
 *   在生产环境必然 401**（连 Day 18 就存在的 POST /api/favorites 也是如此）。
 *
 *   但同一个 token 读接口完全正常 —— 说明**数据库侧的 `auth.uid()` 能正确
 *   解析这个身份**，隔离照常生效。所以身份判定应当**交给数据库与 RLS**，
 *   云函数只负责「有没有带凭证」，这与项目既定原则一致：
 *   「RLS 自己就能按 uid 隔离，后端不要自己拼 uid 过滤」。
 *
 *   ⚠️ 由此带来一条前置条件：写入时**不能显式写 uid 列**，必须让数据库的
 *      `default auth.uid()` 填（uid 列 not null 且原先没有默认值）。
 *      见 db/schema.sql 的 Day 24 变更记录。
 */
function callerForWrite(headers, what) {
  const caller = headers.authorization || ''
  if (!/^Bearer\s+\S+/i.test(caller)) {
    logEvent('warn', what, { reason: 'missing_session' })
    return { ok: false, response: fail(401, 'UNAUTHENTICATED', '请先登录后再操作（需要带上会话）', headers) }
  }
  const token = caller.replace(/^Bearer\s+/i, '').trim()
  // uid 只在 token 里真的带时才有（自定义登录）；匿名登录时留空 → 交给数据库填
  const uid = uidFromToken(token)
  return { ok: true, token, uid: uid && uid !== 'anon' ? uid : '' }
}

/** 校验一个 1–64 的整数（hexagramId / :id 通用） */
function intInRange(raw, label) {
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw
  if (!Number.isInteger(n)) {
    return { ok: false, code: label + ' 必须是整数，收到的是「' + String(raw).slice(0, 20) + '」' }
  }
  if (n < 1 || n > 64) {
    return { ok: false, code: label + ' 必须在 1 – 64 之间，收到的是 ' + n }
  }
  return { ok: true, value: n }
}

/** 校验卦序号数组（1–64，去重升序）—— 契约 4.2 / 4.4 / 5.2 共用 */
function hexagramIdList(raw, label) {
  if (!Array.isArray(raw)) return { ok: false, code: label + ' 必须是数组' }
  for (const x of raw) {
    if (!Number.isInteger(x) || x < 1 || x > 64) {
      return { ok: false, code: label + ' 里含非法卦序号：' + String(x).slice(0, 20) + '（应为 1 – 64 的整数）' }
    }
  }
  return { ok: true, value: Array.from(new Set(raw)).sort((a, b) => a - b) }
}

/* ---------- 一、卦象主数据（静态，不查库；契约 1.1 / 1.2） ---------- */

function handleHexagramsList(event, headers) {
  const { qs } = readRequest(event || {})
  // 契约 1.1 的错误只有 500 —— 这是公开静态数据，不要求会话（故不走 callerForRead）
  const volume = String(qs.volume || '')
  if (volume && volume !== '上经' && volume !== '下经') {
    return fail(422, 'VALIDATION_FAILED', 'volume 只接受「上经」或「下经」', headers)
  }
  try {
    const items = hexagramsRepo.listHexagrams({ volume, q: String(qs.q || '') })
    return ok(items, { count: items.length, total: 64 }, headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

function handleHexagramDetail(event, headers, match) {
  const raw = match[1]
  if (!/^\d{1,3}$/.test(String(raw))) {
    return fail(400, 'BAD_REQUEST', 'id 必须是数字，收到的是「' + String(raw).slice(0, 20) + '」', headers)
  }
  const v = intInRange(raw, 'id')
  if (!v.ok) return fail(400, 'BAD_REQUEST', v.code, headers) // 契约 1.2：越界是 400
  try {
    return data200(hexagramsRepo.getHexagram(v.value), headers)
  } catch (e) {
    if (e && e.kind === 'not_found') return fail(404, 'NOT_FOUND', '没有这一卦：' + v.value, headers)
    return mapRepoError(e)
  }
}

/* ---------- 二、起卦记录存档（契约 2.2） ---------- */

async function handleRecordsPost(event, headers) {
  const w = callerForWrite(headers, 'records.post')
  if (!w.ok) return w.response

  const body = readJsonBody(event)
  if (body === null) {
    return fail(400, 'BAD_REQUEST', '请求体不是合法的 JSON（应形如 {"hexagramId": 1, "changingLines": [3]}）', headers)
  }
  const v = intInRange(body.hexagramId === undefined ? '' : body.hexagramId, 'hexagramId')
  if (!v.ok) return fail(422, 'VALIDATION_FAILED', v.code, headers)

  // changingLines：契约要求「去重、升序、过滤非法值后入库」
  const clRaw = body.changingLines === undefined || body.changingLines === null ? [] : body.changingLines
  if (!Array.isArray(clRaw)) return fail(422, 'VALIDATION_FAILED', 'changingLines 必须是数组', headers)
  const changingLines = Array.from(
    new Set(clRaw.filter((x) => Number.isInteger(x) && x >= 1 && x <= 6))
  ).sort((a, b) => a - b)

  const today = shanghaiToday() // ⚠️ date 由服务端取，客户端传了也忽略（契约 2.2 约定）

  // 幂等：当天已有记录 → 200 且**不覆盖**（契约 2.2）
  try {
    const existed = await recordsRepo.findRecordByDate
      ? await recordsRepo.findRecordByDate(w.token, today)
      : null
    if (existed) {
      return json(200, {
        ok: true,
        data: { date: today, hexagramId: existed.hexagramId, changingLines: existed.changingLines },
        created: false,
      }, headers)
    }
    // ⚠️ 不传 uid：让数据库的 default auth.uid() 填（token 里没有 uid，见 callerForWrite 注释）
    const row = await recordsRepo.insertRecord(
      w.token, { uid: w.uid, hexagramId: v.value, changingLines, date: today }
    )
    return json(201, {
      ok: true,
      data: { date: today, hexagramId: v.value, changingLines },
      created: true,
      row: row || undefined,
    }, headers)
  } catch (e) {
    logEvent('error', 'records.post', { error: String((e && e.message) || e) })
    return mapRepoError(e)
  }
}

/* ---------- 三、取消收藏（契约 3.3，幂等 204） ---------- */

async function handleFavoritesDelete(event, headers, match) {
  const w = callerForWrite(headers, 'favorites.delete')
  if (!w.ok) return w.response
  const raw = match[1]
  if (!/^\d{1,3}$/.test(String(raw))) {
    return fail(400, 'BAD_REQUEST', 'hexagramId 必须是数字，收到的是「' + String(raw).slice(0, 20) + '」', headers)
  }
  const v = intInRange(raw, 'hexagramId')
  if (!v.ok) return fail(400, 'BAD_REQUEST', v.code, headers)
  try {
    await favoritesRepo.deleteFavorite(w.token, v.value)
    // 契约：本来没收藏也返回 204（幂等）
    return { statusCode: 204, headers: json(200, {}, headers).headers, body: '' }
  } catch (e) {
    return mapRepoError(e)
  }
}

/* ---------- 四、测验（契约 4.1 / 4.2 / 4.3 / 4.4） ---------- */

async function handleQuizRoundsGet(event, headers) {
  const { qs } = readRequest(event || {})
  const c = callerForRead(headers, qs)
  if (!c.ok) return c.response
  let limit = quizRepo.DEFAULT_LIMIT
  if (qs.limit !== undefined && qs.limit !== '') {
    if (!/^\d{1,4}$/.test(String(qs.limit))) {
      return fail(422, 'VALIDATION_FAILED', 'limit 必须是正整数', headers)
    }
    limit = Number(qs.limit)
    if (limit < 1 || limit > quizRepo.MAX_LIMIT) {
      return fail(422, 'VALIDATION_FAILED', 'limit 必须在 1 – ' + quizRepo.MAX_LIMIT + ' 之间', headers)
    }
  }
  try {
    const rows = await quizRepo.listRounds(c.token, { limit, demoUid: c.demoUid })
    return ok(rows, { count: rows.length }, headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

async function handleQuizRoundsPost(event, headers) {
  const w = callerForWrite(headers, 'quiz.rounds.post')
  if (!w.ok) return w.response
  const body = readJsonBody(event)
  if (body === null) return fail(400, 'BAD_REQUEST', '请求体不是合法的 JSON', headers)

  const score = typeof body.score === 'string' ? Number(body.score) : body.score
  const total = typeof body.total === 'string' ? Number(body.total) : body.total
  if (!Number.isInteger(total) || total < 1) {
    return fail(422, 'VALIDATION_FAILED', 'total 必须是正整数', headers)
  }
  if (!Number.isInteger(score) || score < 0) {
    return fail(422, 'VALIDATION_FAILED', 'score 必须是非负整数', headers)
  }
  if (score > total) {
    return fail(422, 'VALIDATION_FAILED', 'score 不能大于 total（收到 ' + score + ' / ' + total + '）', headers)
  }
  try {
    const row = await quizRepo.insertRound(w.token, { score, total })
    return json(201, { ok: true, data: row }, headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

async function handleQuizProgressGet(event, headers) {
  const { qs } = readRequest(event || {})
  const c = callerForRead(headers, qs)
  if (!c.ok) return c.response
  try {
    const row = await quizRepo.getProgress(c.token, { demoUid: c.demoUid })
    return data200(row || { answeredTotal: 0, correctTotal: 0, wrongIds: [], updatedAt: null }, headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

async function handleQuizProgressPut(event, headers) {
  const w = callerForWrite(headers, 'quiz.progress.put')
  if (!w.ok) return w.response
  const body = readJsonBody(event)
  if (body === null) return fail(400, 'BAD_REQUEST', '请求体不是合法的 JSON', headers)

  const a = typeof body.answeredTotal === 'string' ? Number(body.answeredTotal) : body.answeredTotal
  const c2 = typeof body.correctTotal === 'string' ? Number(body.correctTotal) : body.correctTotal
  if (!Number.isInteger(a) || a < 0) return fail(422, 'VALIDATION_FAILED', 'answeredTotal 必须是非负整数', headers)
  if (!Number.isInteger(c2) || c2 < 0) return fail(422, 'VALIDATION_FAILED', 'correctTotal 必须是非负整数', headers)
  if (c2 > a) return fail(422, 'VALIDATION_FAILED', 'correctTotal 不能大于 answeredTotal', headers)
  const wrong = body.wrongIds === undefined || body.wrongIds === null ? [] : body.wrongIds
  const wl = hexagramIdList(wrong, 'wrongIds')
  if (!wl.ok) return fail(422, 'VALIDATION_FAILED', wl.code, headers)

  try {
    const row = await quizRepo.putProgress(w.token, {
      answeredTotal: a, correctTotal: c2, wrongIds: wl.value,
    })
    return json(200, { ok: true, data: row }, headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

/* ---------- 五、镀金（契约 5.1 / 5.2，并集语义） ---------- */

async function handleGildedGet(event, headers) {
  const { qs } = readRequest(event || {})
  const c = callerForRead(headers, qs)
  if (!c.ok) return c.response
  try {
    return data200(await gildedRepo.getGilded(c.token, { demoUid: c.demoUid }), headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

async function handleGildedPut(event, headers) {
  const w = callerForWrite(headers, 'gilded.put')
  if (!w.ok) return w.response
  const body = readJsonBody(event)
  if (body === null) return fail(400, 'BAD_REQUEST', '请求体不是合法的 JSON', headers)
  const raw = body.hexagramIds === undefined ? [] : body.hexagramIds
  const list = hexagramIdList(raw, 'hexagramIds')
  if (!list.ok) return fail(422, 'VALIDATION_FAILED', list.code, headers)
  try {
    // 契约 5.2：**并集**写回，成就只增不减
    return json(200, { ok: true, data: await gildedRepo.putGilded(w.token, list.value) }, headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

/* ---------- 六、概览与清除（契约 6.1 / 6.2） ---------- */

async function handleSummary(event, headers) {
  const { qs } = readRequest(event || {})
  const c = callerForRead(headers, qs)
  if (!c.ok) return c.response
  try {
    return data200(await meRepo.summary(c.token, { demoUid: c.demoUid }), headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

async function handleClearData(event, headers) {
  const w = callerForWrite(headers, 'me.clear')
  if (!w.ok) return w.response
  const { qs } = readRequest(event || {})
  const scope = String(qs.scope || 'all')
  if (!['records', 'favorites', 'quiz', 'all'].includes(scope)) {
    return fail(422, 'VALIDATION_FAILED',
      'scope 只接受 records / favorites / quiz / all，收到的是「' + scope.slice(0, 20) + '」', headers)
  }
  try {
    const cleared = await meRepo.clearMyData(w.token, scope)
    logEvent('info', 'me.clear', { uid: w.uid, scope, cleared })
    return json(200, { ok: true, data: { cleared } }, headers)
  } catch (e) {
    return mapRepoError(e)
  }
}

/* ============================================================================
 * 新路由表：按「method + 去掉 /api 前缀的相对路径」匹配
 * ⚠️ 兼容网关透传前缀与不透传两种形态（EnablePathTransmission 两种状态都遇到过）
 * ==========================================================================*/
const NEW_ROUTES = [
  { m: 'GET', re: /^\/hexagrams$/, h: handleHexagramsList },
  { m: 'GET', re: /^\/hexagrams\/([^/]+)$/, h: handleHexagramDetail },
  { m: 'POST', re: /^\/records$/, h: handleRecordsPost },
  { m: 'DELETE', re: /^\/favorites\/([^/]+)$/, h: handleFavoritesDelete },
  { m: 'GET', re: /^\/quiz\/rounds$/, h: handleQuizRoundsGet },
  { m: 'POST', re: /^\/quiz\/rounds$/, h: handleQuizRoundsPost },
  { m: 'GET', re: /^\/quiz\/progress$/, h: handleQuizProgressGet },
  { m: 'PUT', re: /^\/quiz\/progress$/, h: handleQuizProgressPut },
  { m: 'GET', re: /^\/gilded$/, h: handleGildedGet },
  { m: 'PUT', re: /^\/gilded$/, h: handleGildedPut },
  { m: 'GET', re: /^\/me\/summary$/, h: handleSummary },
  { m: 'DELETE', re: /^\/me\/data$/, h: handleClearData },
]

/** 把网关给的 path 归一成相对路径（两种前缀形态都认） */
function relPath(path) {
  // 去掉末尾斜杠 → 去掉可选的 /api 前缀 → 保证以 / 开头
  const rel = String(path || '')
    .replace(/\/+$/, '')
    .replace(/^\/?(api\b)?\/?/, '/')
  return rel === '' ? '/' : rel
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

  /* ── Day 24 新路由：12 个新接口（其余走下面的旧分派）── */
  const rel = relPath(path)
  for (const r of NEW_ROUTES) {
    if (r.m !== method) continue
    const m = rel.match(r.re)
    if (m) return r.h(event, headers, m)
  }

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