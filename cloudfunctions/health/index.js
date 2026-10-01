/**
 * 健康检查云函数 —— 第 3 周 · 任务①（本项目第一个 CloudBase 云函数）
 *
 * 职责刻意极小：只回答「这个服务还在不在」，**不连数据库、不写任何业务逻辑**。
 * 表结构与业务接口都还没建 —— 见 `docs/api-contract.md`（今天只登记占位）。
 *
 * 形态：**事件型云函数（Event Function）**，入口 `exports.main(event, context)`。
 * 对外通过「HTTP 访问服务」的路径路由暴露成 `GET /api/health`。
 *
 * 返回格式（已核实 CloudBase 官方文档）：
 *   返回值里**含 `statusCode` 字段时**，平台会识别为「集成响应」，
 *   于是 statusCode / headers / body 直接决定 HTTP 响应的状态码、响应头与响应体。
 *   用这个格式，非 GET 才能真正返回 405，而不是被统一包成 200。
 *
 * 安全：不返回 event / context / process.env —— 网关可能向 event 里注入
 *   `x-cloudbase-context`（临时凭证），原样透出等于泄露凭据。
 */

const SERVICE = 'yijing-64' // 项目英文名（与 package.json 的 name、GitHub 仓库名一致）

exports.main = async (event) => {
  // 经 HTTP 访问服务进来时，event 里带 httpMethod；
  // 用云函数 SDK 直接调用时没有该方法字段 —— 视作一次正常的 GET。
  const method = String((event && (event.httpMethod || event.method)) || 'GET').toUpperCase()

  if (method !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }),
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ok: true, service: SERVICE }),
  }
}
