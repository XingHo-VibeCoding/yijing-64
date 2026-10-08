/**
 * 共享工具：响应信封 + CORS 预检 + 日志
 *
 * 抽出来的理由：这些与「查哪张表」无关，两个接口都要用，放在 index.js 里会
 * 让接口层混进基础设施细节。
 *
 * ⚠️ 本文件的行为必须与 Day 18 上线版本**逐字节一致**（响应形状、CORS 头、
 *    状态码都是回归清单要核对的对象）。重构不改这里的行为。
 */

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
 * 预检一律回 204（OPTIONS 是浏览器问「我能不能发这个请求」，不是用户发来的读请求）。
 */
function preflight(headers) {
  const origin = (headers && headers.origin) || '*'
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

/** 统一响应信封（契约 §二）。Vary: Origin 避免被缓存串味。 */
const json = (statusCode, obj, headers) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    // 显式带上：不能只依赖网关回显，函数自己保证一份
    'Access-Control-Allow-Origin': (headers && headers.origin) || '*',
    Vary: 'Origin',
  },
  body: JSON.stringify(obj),
})

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

module.exports = { preflight, json, ok, fail, logEvent }