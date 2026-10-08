/**
 * 共享工具：请求解析（路径 / 查询串 / 头 / body）
 *
 * 抽出来的理由：这些是**协议层**的事，与业务无关。留在接口层会让「路由」与
 * 「怎么读网关事件」缠在一起。
 *
 * ⚠️ 行为必须与 Day 18 上线版本一致 —— 不同网关版本 / 不同触发方式下
 *    字段位置不一样，所以所有可能来源都要兜住：少兜一个就可能取不到
 *    ?uid= 而误报 401（踩过一次）。
 */

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
 * 从网关事件里取出路径、查询串、请求头（头名统一小写）。
 */
function readRequest(event) {
  const headers = event.headers || event.header || {}
  const lower = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]

  // 路径候选：网关默认不透传前缀（EnablePathTransmission=false），/api/records 会变成 /records
  const rawPath = String(
    event.path || event.rawPath || event.url || event.httpPath || (event.requestContext && event.requestContext.path) || ''
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
        if (b.path && !pathOnly) return readRequest(Object.assign({}, event, { path: b.path }))
        if (b.queryString) Object.assign(qs, parseQs(b.queryString))
        if (b.headers) {
          for (const k of Object.keys(b.headers)) lower[k.toLowerCase()] = b.headers[k]
        }
      }
    } catch (e) { /* 不是 JSON 就忽略 */ }
  }

  return { path: pathOnly, qs, headers: lower }
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

module.exports = { parseQs, readRequest, readJsonBody }