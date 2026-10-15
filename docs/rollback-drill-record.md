# 回滚演练记录（Day 26 · 静态托管路径）

> 配套：[发布清单](release-checklist.md)｜[回滚手册](rollback-runbook.md)
> 本次为**真实执行**（非演练脚本）：真的改了线上静态托管，又真的恢复回来了。线上现为 **v1.0**。

## 一、演练记录模板（每次回滚演练照此填）

| 字段 | 填法 |
| --- | --- |
| 演练日期 / 执行人 | |
| 目标版本（要回滚到的） | 版本号 + git tag + 产物目录路径 |
| 基线指纹 | 演练前线上 `index.html` 引用的 JS hash + lastModified |
| 步骤 | 逐步写：做了什么、命令/工具、耗时、结果（PASS/FAIL）、证据（hash / 截图 / listFiles） |
| 总耗时 | 从第一条命令到最后一次验证通过 |
| 结论 | 回滚是否可用 + 真出事敢不敢用这套流程 |

## 二、本次真实记录（2026-10-15）

### 步骤 0｜确认可回退历史（演练前准备）

| 做了什么 | 结果 |
| --- | --- |
| `git log --oneline -5 -- src/` 查最后改过 `src/` 的提交 | **d8ef7eb**（Day 24 竞态修复） |
| 对比 HEAD 与 HEAD~1 的 `src/` | **完全相同** → 两者构建产物一致，**不能拿它们当回滚目标** |
| 构建 v1.0（HEAD=a84d022） | `.workbuddy/release/v1.0/dist`，16s，JS hash `index-C0WYrcYV.js` |
| 构建 prev（换入 d8ef7eb 的 storage.js，构建后 `git checkout` 还原） | `.workbuddy/release/prev-d8ef7eb/dist`，15s，JS hash `index-Cz2OSwZ0.js` |
| 写 manifest.json（版本/commit/时间/文件数/每文件 sha256 前 12 位） | v1.0：4 文件 1,697.5 KB；prev：4 文件 1,697.3 KB |
| 打版本标记 | `git tag v1.0 a84d022` |

> ⚠️ **这一步是整个流程最容易出错的地方**：版本标记随手打在 HEAD 上看着对，但若 HEAD 与上一版的源码相同，
> 「回滚」会传上一份**一模一样**的产物，演练结论是假的。**发布时必须归档「上一版的产物目录」，而不只是记住上一个 commit 号。**

### 步骤 1｜发布 v1.0（23:39:06 → 23:39:29，**23 秒**）

| 做了什么 | 结果 |
| --- | --- |
| `manageHosting(upload, cloudPath="/", localPath=.workbuddy/release/v1.0/dist)` | 工具返回 `successCount:1 / totalFiles:1` —— **失真**（实传 4 文件），按技能坑 #1 不采信 |
| 拉线上 `index.html` 看引用 | `assets/index-C0WYrcYV.js` → **A2 PASS** |
| 依次取新 JS / CSS / 仪式图 | 200 / 200 / 200（JS 1,265,746 字节）→ **A1 PASS** |
| `curl <网关>/api/health` | 200 `{"ok":true,"service":"yijing-64"}` → **A3 PASS** |
| 无头 Edge 打开公网首页 | 首次命中「风险提醒」确认页（**不是部署失败**，坑 #4）；点 `button.redirect-page__operate-submit` 后页面正常渲染 |

### 步骤 2｜回滚到 prev（23:39:58 → 23:40:20，**22 秒**）

| 做了什么 | 结果 |
| --- | --- |
| `manageHosting(upload, localPath=.workbuddy/release/prev-d8ef7eb/dist)` | 返回成功（同样 `successCount` 失真） |
| 拉线上 `index.html` | `assets/index-Cz2OSwZ0.js` → **R2 PASS（确实切走了）** |
| 顺手取 v1.0 的 JS | **仍 200** → 实证上传非破坏性，两版资源并存 |
| 健康接口 | 200 ok:true → **R3 PASS** |
| 抓页面截图 | 渲染正常（rootLen 25,376）→ **R4 PASS**，即 `docs/img/day26-rollback-page.png` |

### 步骤 3｜恢复 v1.0（23:42:28 → 23:42:48，**20 秒**）

| 做了什么 | 结果 |
| --- | --- |
| `manageHosting(upload, localPath=.workbuddy/release/v1.0/dist)` | 返回成功 |
| 拉线上 `index.html` | `assets/index-C0WYrcYV.js` → **切回成功** |
| prev 的 JS | 仍 200（再次印证非破坏性） |
| 健康接口 + 页面截图 | 200 ok:true；页面正常渲染 → `docs/img/day26-v1-live.png` |

### 耗时汇总

| 阶段 | 耗时 |
| --- | --- |
| 构建两版产物（发布前一次性） | 16s + 15s |
| **发布 v1.0（含 4 项验证）** | **23s** |
| **回滚到 prev（含 3 项验证）** | **22s** |
| **恢复 v1.0（含验证）** | **20s** |
| **真出事时的回滚耗时（上传+验证）** | **约 22 秒** |
| 本次演练总跨度（含诊断与截图） | 3 分 42 秒 |

## 三、结论（今天要掌握的两个问题）

**① 回滚演练花了多久？** —— **纯回滚 22 秒**（含验证）；恢复 20 秒；连同准备好的产物，现场决策到线上生效在一分钟内。

**② 真出事你敢不敢用这套流程？——敢，三条理由**：
1. 回滚动作是「重传一个已归档、已验证过的产物目录」，不依赖任何平台侧撤销能力，也没有半成品状态；
2. 托管上传非破坏性，实测两版资源可同时存在，切错了再切回来即可（本次已经来回切了一轮）；
3. 唯一**不敢**依赖回滚的是**数据层**——本项目没有数据库快照，数据出问题只能写新迁移修复。
   所以真出事时第一件事是分清「前端产物问题」还是「数据/云函数问题」，前者 22 秒回滚，后者回滚没用。

## 四、本次踩到/验证的坑（已并入手册与技能）

| # | 现象 | 结论 |
| --- | --- | --- |
| 1 | 上传工具报 `successCount:1`，实传 4 文件 | **第三次实测确认失真**，一律 `listFiles` / 拉线上 index.html 实查 |
| 2 | 测试域名首访是「风险提醒」确认页，截图全白 | 坑 #4 再次命中；按钮选择器 `button.redirect-page__operate-submit`，点过即可见真页面 |
| 3 | HEAD 与 HEAD~1 的 `src/` 相同 | **回滚目标必须按「最后改过 src/ 的提交」选**，否则演练是假的 |
| 4 | 托管里堆着多组历史 hash（本次 listFiles 60 个文件） | 已知可接受；**不要顺手删**（QPS 限流 + 删错当前 hash 直接白屏） |