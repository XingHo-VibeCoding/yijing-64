/**
 * 共享工具：身份与业务日期
 *
 * ⚠️ 本文件承载**两条最容易踩坑的逻辑**，重构时一字未改，只是搬位置：
 *
 * 1. `uidFromToken` —— 只有**写**接口才需要自己从 token 取 uid（读接口由 RLS 自动过滤）。
 *    ⭐ 安全性论证（为什么这不是「自己拼 uid 过滤」那个反模式）：
 *      ① JWT payload 只是 base64url 编码、**未加密**，本模块解它只为拿 `sub`；
 *      ② 真正的把关在下游 —— 同一个 token 会被转发给 PostgREST，**PostgREST 验签**，
 *         签名无效则整个请求 401，压根写不进去；
 *      ③ 就算签名有效，RLS 的 `with check (uid = current_uid())` 会再校验一次，
 *         填错 uid 直接被数据库拒（42501）。
 *      三层里任何一层不通过都写不进去，所以「解 payload」这个动作本身开不出越权入口。
 *
 * 2. `shanghaiToday` —— 两个踩过的点：
 *      ① 云函数运行时**默认 UTC**，直接 `toISOString()` 会在每天 08:00 前算成前一天，
 *         所以必须显式带时区；
 *      ② **不能用 `Intl.DateTimeFormat('en-CA', …).format()`** —— 输出格式取决于运行时 ICU 版本：
 *         本机 Node 22 返回 `2026-10-04`，云函数（Node 18）实测返回美式 `10/04/2026`。
 *         改用 `formatToParts()` 逐字段取、**自己拼字符串**，结果与 ICU 无关。
 */

/** 从会话 token 里取出 uid（sub），供写入接口填 `uid` 列 */
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

/** 业务日：按 Asia/Shanghai 取「今天」，返回 YYYY-MM-DD */
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

module.exports = { uidFromToken, shanghaiToday }