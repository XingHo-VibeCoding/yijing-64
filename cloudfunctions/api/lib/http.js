/**
 * 共享工具：响应信封 + CORS 预检 + 日志
 *
 * 抽出来的理由：这些与「查哪张表」无关，两个接口都要用，放在 index.js 里会
 * 让接口层混进基础设施细节。
 *
 * ⚠️ Day 19 分层重构时本文件**一字未改**（响应形状、CORS 头、状态码都是回归清单的对象）。
 *    Day 20 只改了 CORS 的**允许范围**（见下），响应形状与状态码未变。
 */

/* ============================================================================
 * CORS 白名单（Day 20）
 *
 * ⚠️⚠️ **修的是什么**：早先这里写的是
 *     `'Access-Control-Allow-Origin': (headers && headers.origin) || '*'`
 *     —— 把**调用方传来的 Origin 原样回显**。那只在「调用方就是我自己」时成立；
 *     对任何第三方站点，它同样会把那个域名的Origin 原样回显，
 *     于是**任何域名都能读到这个接口**（实测：`evil.example.com`、`null` 全部放行）。
 *     这是 CORS 里最常见的写法错误 —— 它看起来「限制了」，实际等于没限制。
 *
 * ✅ **现在的规则**（顺序不能颠倒）：
 *   ① 请求**没带 Origin** → 放行，且**不回显** Allow-Origin。
 *      这类请求不是浏览器发起的跨域（curl / 服务端调用 / 监控探针），管它没有意义。
 *   ② Origin **命中白名单** → 回显**那个具体的 Origin**（不能写 *，
 *      因为还要带 Authorization 头，那是「非简单请求」，* 与凭据不兼容）。
 *   ③ Origin **不在白名单** → **不回** CORS 头（浏览器自己会拦），
 *      业务上仍按契约返回正常响应，不泄露数据形状。
 *
 * ⭐ 白名单**只从环境变量读**，不写死、不进仓库。缺省值是本项目的静态托管域名，
 *    外加本地开发用的 localhost 端口 —— **绝不退化成 `*`**（宁可线上调不通，也不要开成通配）。
 * ======================================================================== */

/** 本项目静态托管域名（非密钥，可公开） */
const SITE_ORIGIN = 'https://yijing-64-d1g9uvmlkf13c8f77-1498185256.tcloudbaseapp.com'

/**
 * 计算允许的 Origin 列表。
 * 优先读环境变量 `ALLOWED_ORIGINS`（逗号分隔）；没配就用上面的缺省集合。
 * @returns {string[]}
 */
function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS
  if (raw && String(raw).trim()) {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
  }
  // 缺省：本项目托管 + 本地开发（Vite 默认端口与本机历史用过的端口）
  return [
    SITE_ORIGIN,
    'http://localhost:5173',
    'http://localhost:5177',
    'http://localhost:5199',
    'http://localhost:5201',
    'http://localhost:5202',
    'http://127.0.0.1:5173',
  ]
}

/**
 * 这个 Origin 能不能读本接口。
 * @param {string|undefined} origin 请求头里的 Origin
 * @returns {{allow:boolean, origin:string}} allow=false 时 origin 为空串（表示别回这个头）
 */
function checkOrigin(origin) {
  if (!origin) return { allow: true, origin: '' }   // 非浏览器请求，不设 CORS 头
  const list = allowedOrigins()
  const hit = list.includes(origin)
  return { allow: hit, origin: hit ? origin : '' }
}

/**
 * CORS 预检响应。
 *
 * ⚠️ 为什么必须处理 OPTIONS：静态托管与 HTTP 访问服务是**两个不同域名**
 *    （…tcloudbaseapp.com 与 …ap-shanghai.app.tcloudbase.com），所以前端 fetch 本接口是跨域的。
 *    而通道 A 必须带 `Authorization` 头 —— 带自定义头的跨域请求**一定会先发预检**，
 *    预检不过就根本发不出真正的请求（表现为浏览器控制台报错、请求根本没到函数）。
 *
 * ⚠️ **只放行白名单里的域名**（Day 20 修）：原先是无条件回显调用方的 Origin，
 *    等于对所有域名开放。命中才回显；未命中**不放**这个头，浏览器会自己拦。
 *
 * 预检一律回 204（OPTIONS 是浏览器问「我能不能发这个请求」，不是用户发来的读请求）。
 */
function preflight(headers) {
  const h = headers || {}
  const chk = checkOrigin(h.origin)
  const out = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
  if (chk.origin) out['Access-Control-Allow-Origin'] = chk.origin
  return { statusCode: 204, headers: out, body: '' }
}

/**
 * 统一响应信封（契约 §二）。Vary: Origin 避免被缓存串味。
 *
 * ⚠️ Day 20：CORS 头按**同一个白名单**判定，未命中时**不带** Allow-Origin
 *    （早先这里是 `(headers && headers.origin) || '*'` —— 无 Origin 时回 `*`，
 *    正是任务要求里点明要禁掉的那种通配）。
 */
const json = (statusCode, obj, headers) => {
  const h = headers || {}
  const chk = checkOrigin(h.origin)
  const out = {
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  }
  if (chk.origin) out['Access-Control-Allow-Origin'] = chk.origin
  return { statusCode, headers: out, body: JSON.stringify(obj) }
}

/** 成功：{ ok: true, items, meta } */
const ok = (items, meta, headers) => json(200, { ok: true, items, meta }, headers)

/** 失败：{ ok: false, error: { code, message } } */
const fail = (statusCode, code, message, headers) =>
  json(statusCode, { ok: false, error: { code, message } }, headers)

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

module.exports = {
  preflight, json, ok, fail, logEvent,
  // Day 20 新增导出：给测试与将来可能的诊断用（白名单判定是安全边界，不该藏着）
  checkOrigin, allowedOrigins,
}