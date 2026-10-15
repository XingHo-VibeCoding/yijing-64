# 发布清单 · v1.0（Day 26）

> 适用范围：纯静态前端（CloudBase 静态托管）+ 云函数 `health`/`api`（本次发布**不动**云函数与数据库）。
> 配套文档：[回滚手册](rollback-runbook.md)｜演练记录：[rollback-drill-record.md](rollback-drill-record.md)

## 1. 版本标记（三层，缺一层就没法回退）

| 层 | 标记物 | 本次 v1.0 的值 |
| --- | --- | --- |
| 代码 | Git tag（**轻量 tag 即可**，指向发布那一提交的 SHA） | `v1.0` → `a84d022` |
| 产物 | 版本化目录：`.workbuddy/release/<版本>/dist` + `manifest.json` | `.workbuddy/release/v1.0/` |
| 线上 | 托管 `index.html` 里引用的 JS hash（**唯一能从公网认出版本号的指纹**） | `assets/index-C0WYrcYV.js` |

`manifest.json` 记录：版本号、commit SHA、构建时间、文件数与总字节、**每个文件的 sha256 前 12 位**。
⚠️ 托管上传是**非破坏性**的（只新增/覆盖同名文件，不删旧文件），所以旧版本产物一旦构建出来就长期有效——
**产物目录就是回滚的唯一凭据**，构建完不许删。

## 2. 发布前验证项（任一不过就不许发）

| # | 检查 | 命令 / 方法 | 通过标准 |
| --- | --- | --- | --- |
| P1 | 发布门（项目自建） | `python .workbuddy/skills/verify-project/scripts/verify.py` | 24 项全 PASS、退出码 0 |
| P2 | 工作区干净 | `git status --short` | 无输出（有未提交改动就不发） |
| P3 | 远端已同步 | `git ls-remote --heads origin main` | SHA 与本地 `git rev-parse HEAD` 一致（**只认 ls-remote**，本机 `git status` 的 ahead 不可信） |
| P4 | 文档自检 | `python .workbuddy/doc-check.py` | 加粗/表格/标题/悬空引用全 0 问题 |
| P5 | 构建产物与 manifest 一致 | 读 `manifest.json` 比对文件数与 hash | 一致（本次 v1.0：4 文件 / 1,697.5 KB） |

## 3. 发布步骤

```bash
# ① 构建（必须换新目录：本机沙箱删不掉已存在目录，vite 的 --emptyOutDir 会失败）
npx vite build --outDir .workbuddy/release/v1.0/dist --emptyOutDir
```
② 写 `manifest.json`（版本 / commit / 构建时间 / 文件清单 + sha256 前 12 位）。
③ 上传托管：
```
manageHosting({ action: "upload", cloudPath: "/",
                localPath: "E:/Workbuddy文件夹/.workbuddy/release/v1.0/dist" })
```
④ **不信工具的 `successCount`**（本项目两次实测它失真）→ `queryHosting(action="listFiles")` 实查：
`index.html` 的 `lastModified` 是刚才，且 `assets/index-<新hash>.js` 已出现。
⑤ 打 tag：`git tag v1.0 <sha>`（`git push origin v1.0` 推标签）。

## 4. 发布后验证（4 条，全过才算发完）

| # | 检查 | 命令 | 通过标准 |
| --- | --- | --- | --- |
| A1 | 托管首页可开 | `curl -s -o NUL -w "%{http_code}" <托管域名>/` | 200 |
| A2 | **线上确实是新版本** | 拉线上 `index.html`，看引用的 JS hash | 等于本次产物的 hash（v1.0 = `index-C0WYrcYV.js`） |
| A3 | 云函数健康 | `curl -s <网关域名>/api/health` | `{"ok":true,...}` |
| A4 | 页面真能渲染 | 无头 Edge 打开首页截图 | 总表页正常渲染（不是白屏、不是平台确认页） |

⚠️ A4 的坑：默认测试域名**每浏览器首次访问**会先弹「访问确认」页，**那不是部署失败**——
要么先过这一关再截图，要么用 `?` 参数或本地托管同一份 dist 验证渲染。

## 5. 代码与数据备份方式

**代码**
- 远端 GitHub 是唯一可靠备份；每次发布打 tag，tag 即回滚锚点。
- 本机另存版本化产物 `.workbuddy/release/<版本>/dist` + `manifest.json`（托管不删旧文件，产物留着随时能重传）。
- ⚠️ 本机 `git stash` 会清空 `.git`，A/B 对照一律用 `cp` 备份或 `git show <sha>:<path>`。

**数据（本项目最需要认清的一层）**
- ⚠️ **数据层没有回滚能力**：本项目没有数据库快照/时间点恢复机制，DDL 走迁移且 `db/schema.sql` 是幂等正本。
  出问题时**只能写新迁移修复，不能回退**——回滚静态托管不会修任何数据问题。
- 库里有真实数据，**任何情况下不得 drop**；动脚本前先只读核对（`managePgDatabase(action="execute", role="anon", sql=…)`）。
- 演示数据在 `db/seed.sql`（幂等，36 行，五个示例 uid），需要时重跑即可，不影响真实行。

**云函数**
- 代码随 git 版本化 → 回退 = 切回旧 tag 的 `cloudfunctions/` 再 `updateFunctionCode` 重传（步骤见回滚手册 §3）。
- ⚠️ `runtime` 建后不可改；环境变量（`ALLOWED_ORIGINS`、`PUBLISHABLE_KEY`）不在代码里，回滚代码不会动它们。