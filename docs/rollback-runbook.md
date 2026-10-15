# 回滚手册（Day 26）

> 配套：[发布清单](release-checklist.md)｜演练记录（含真实耗时）：[rollback-drill-record.md](rollback-drill-record.md)
> 前提：静态托管上传**非破坏性**——只新增/覆盖同名文件，不删旧文件。所以回滚 = **重传上一版产物目录**，无需平台侧「撤销」功能。

## 1. 什么情况必须回滚（判断表）

| 现象 | 怎么确认 | 动作 |
| --- | --- | --- |
| 托管首页 5xx / 白屏 / 一直「读取中」 | `curl -s -o NUL -w "%{http_code}" <托管域名>/` 非 200；或无头 Edge 截图是空白 | **立刻回滚静态托管**（§2） |
| 线上 `index.html` 引用的 hash 在托管里不存在 | 拉线上 index.html 取 hash → `listFiles` 里查不到 | **立刻回滚**（多半是上传只传了一半） |
| 关键路径功能坏：起卦 / 记录 / 收藏 / 测验 / 仪式 | 真机会话复现（不只是看代码） | 回滚，并记录复现步骤 |
| 新版才有的功能报错，但主流程正常 | 截图 + 判断影响面 | 可**先不回滚**，登记问题；影响主流程则回滚 |
| **数据层问题**：记录丢失 / 串号 / 计数不对 | 只读核对数据库（`managePgDatabase` execute） | ⚠️ **不要回滚前端**——前端回滚修不了数据，走「写新迁移修复」 |
| 云函数 5xx 或接口行为变了 | `curl <网关域名>/api/health` 非 200 / 响应异常 | 回滚云函数（§3） |
| 文档/注释类问题 | — | 不回滚 |

**判断的第一原则**：先分清「**前端产物问题**」还是「**云函数/数据问题**」——
本项目的静态托管与网关是两个独立部署单元，前者回滚不会影响后者，反之亦然。

## 2. 静态托管回退步骤（今日已实操演练）

```bash
# ① 找目标版本的产物目录（回滚的唯一凭据）
ls .workbuddy/release/            # 每个目录含 dist/ + manifest.json
# ② 确认产物完整：manifest 里的文件数/字节与 dist 实际一致
# ③ 上传目标版本（覆盖同名文件；旧 hash 资源保留，不会被删）
```
```
manageHosting({ action: "upload", cloudPath: "/",
                localPath: "E:/Workbuddy文件夹/.workbuddy/release/<目标版本>/dist" })
```
④ **不信 `successCount`** → `listFiles` 确认 `index.html` 的 `lastModified` 已更新。
⑤ 拉线上 `index.html`，确认引用的 JS hash **等于目标版本的 hash**（这一步才算回滚成功）。

⚠️ **不要顺手删旧 hash 文件**：删除要走 `confirm=true` 且有 20 次/秒 QPS 限流；更重要的是**删错当前
正在用的那个 hash 会直接把线上打成白屏**，而验证成本（默认域名首访确认页）远高于留着几个旧文件的成本。
本项目托管里已堆了多组历史 hash，属于已知且可接受的状态。

## 3. 云函数回退步骤（备查，**今日不实操**）

1. 取旧代码：`git show <旧tag>:cloudfunctions/api/index.js > .workbuddy/rollback/api-index.js`
   （或 `git checkout <旧tag> -- cloudfunctions/` 后重新部署）。
2. `manageFunctions({ action: "updateFunctionCode", functionName: "api", ... })` 上传旧代码。
3. 验证：`manageFunctions(action="invokeFunction", functionName="api")` 看原始返回（毫秒级，先分清是代码错还是网关错），
   再 `curl <网关域名>/api/health` 与一个真实读接口。

⚠️ 三个不能忘的点：
- **`runtime` 建后不可改**——回滚代码不涉及 runtime，但建函数时选错就换不回来。
- **环境变量不回滚**：`ALLOWED_ORIGINS` / `PUBLISHABLE_KEY` 在函数配置里，改代码不影响它们；
  反过来在控制台改了环境变量也不会因为回滚代码而还原。
- **数据层不回滚**：已执行的 DDL 不回退（`db/schema.sql` 幂等正本），出问题写新迁移。

## 4. 回滚后验证（与发布后验证同一套）

| # | 检查 | 通过标准 |
| --- | --- | --- |
| R1 | 托管首页 HTTP 状态 | 200 |
| R2 | 线上 `index.html` 引用的 hash | 等于**回滚目标版本**的 hash（不是当前版） |
| R3 | 健康接口 | `{"ok":true,...}` |
| R4 | 页面渲染 | 无头 Edge 截图：总表页正常 |
| R5 | 记录 | 动作 / 耗时 / 结果进 [演练记录](rollback-drill-record.md) |

## 5. 恢复（把新版本再传回去）

回滚验证通过后若要恢复新版本，步骤与 §2 完全相同——**上传 v1.0 的产物目录即可**，
再跑一遍 §4 的验证。演练记录里要有「恢复后再次验证」这一段，否则不算完整闭环。