/**
 * 请求日志（Day 23 余力加练）
 *
 * 记录云端请求的三要素：时间 / 路径 / 结果。
 *
 * ⚠️ 只记「路径段」（如 /api/records），**绝不**记以下敏感字段：
 *    · Authorization token（在请求头，不进日志）
 *    · 请求体 / 响应体
 *    · uid（按 uid 隔离是 RLS 服务端的事，请求路径里不含 uid）
 *  —— PRD §6 F8 明确「不采集任何身份信息」，这些字段一律不进日志（也不落屏）。
 *    用途：在控制台与调试出口里快速看「哪次请求成功 / 哪次失败」，便于排查云端同步问题。
 */

const MAX_REQUEST_LOG = 50
const log = []

/**
 * 记录一次云端请求的结果。
 * @param {string} method  GET / POST / PUT / DELETE
 * @param {string} path    路径段，如 /api/records（不含 host、不含 token）
 * @param {boolean} ok     是否成功（2xx 且契约 ok:true）
 * @param {string} [result] 简短结果：'ok' / 'HTTP 500' / '超时' / '无凭证'，不含敏感信息
 * @returns {{t:string, method:string, path:string, ok:boolean, result:string}}
 */
export function logRequest(method, path, ok, result) {
  const entry = {
    t: new Date().toISOString(),
    method,
    path,
    ok: !!ok,
    result: String(result != null ? result : ok ? 'ok' : 'fail'),
  }
  log.push(entry)
  if (log.length > MAX_REQUEST_LOG) log.splice(0, log.length - MAX_REQUEST_LOG)
  try {
    // 控制台仅作开发期可见；生产构建里也是 debug 级，不影响性能
    // eslint-disable-next-line no-console
    console.debug('[req]', entry.t, method, path, ok ? 'OK' : 'FAIL', entry.result)
  } catch {
    /* 某些环境 console 被禁用，忽略 */
  }
  return entry
}

/** 调试出口：返回最近 N 条请求记录（不含任何敏感字段） */
export function getRequestLog() {
  return log.slice()
}
