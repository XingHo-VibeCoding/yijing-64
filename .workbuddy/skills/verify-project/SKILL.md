---
name: verify-project
description: 易经六十四卦项目的发布前检查 Skill。把历史踩坑（密钥泄露、.env 未忽略、环境变量缺占位、裸报错、RLS upsert 401、return=representation、删除带 uid、timestamptz 塞裸日期、en-CA 日期、时区缺失、禁词、plain 白话层、繁体越界、z-index 层级、文档表格/加粗规范、内嵌 mermaid、mmd/png 不成对、构建失败、公网不可达）固化为逐项 PASS/FAIL/WARN 检查。当用户要求「发布前检查」「跑一遍 verify」「上线前自检」「确认项目能不能发」时使用。
agent_created: true
---

# verify-project · 发布前检查

把项目踩坑记录固化为可复用的发布前检查。**每条检查都对应一次真实事故**，不是泛泛的最佳实践。

## 怎么跑

```bash
python .workbuddy/skills/verify-project/scripts/verify.py
```

- 纯标准库，无需装依赖；从仓库任何位置运行都能自动定位项目根（向上找含 `AGENTS.md` + `src/` 的目录）。
- 退出码：**有 FAIL → 1**；否则 0。可直接串进发布流程。
- 输出：逐项 `[编号 状态] 检查名  证据`，末尾合计。证据里带**执行命令或命中明细**，可复核。

## 判定三态

| 状态 | 含义 | 是否阻塞发布 |
| --- | --- | --- |
| PASS | 符合通过标准 | 否 |
| FAIL | 不符合通过标准 | **是**（退出码 1） |
| WARN | 检查器无法静态判定的灰区，需人工确认 | 否 |

## 检查项总表（每条附命令与通过标准）

### A. 密钥与配置（上线红线，来源：Day 23 安全审计）

| 编号 | 检查 | 执行命令 / 方法 | 通过标准 |
| --- | --- | --- | --- |
| A1 | 当前树无密钥特征值 | `git grep -nE '<密钥特征集>' HEAD` | 0 命中 |
| A2 | 全 Git 历史无密钥特征值 | `git grep -nE '<特征集>' $(git rev-list --all)` | 0 命中 |
| A3 | .env 不入库且被忽略 | `git ls-files` + `git check-ignore .env` | .env 未被跟踪、被忽略、.env.example 被跟踪 |
| A4 | .env.example 仅占位 | 读文件匹配 `=\s*['\"]?[A-Za-z0-9._-]{16,}` | 0 行赋长值 |

密钥特征集：`AKID[0-9A-Za-z]{10,}`（腾讯云 SecretId）、`AKIA[0-9A-Z]{16}`（AWS）、`eyJhbGci`（JWT）、`-----BEGIN (RSA \|EC \|OPENSSH \|DSA )?PRIVATE KEY-----`、`(secret_key\|client_secret\|access_token)\s*[=:]\s*['\"]?[A-Za-z0-9._-]{16,}`（赋了真实长度值）。
⚠️ 只搜**值特征**不搜宽泛词（`SecretKey` 会命中文档里的「不要贴密钥」提示句，Day 23 踩过）；私钥模式不匹配文档里的省略号示例（`-----BEGIN … KEY-----`），否则自查文档会自匹配。

### B. 环境变量（来源：Day 17/23 配置坑）

| 编号 | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| B1 | src 用的 VITE_ 变量都有占位 | 提取 `import.meta.env.VITE_\w+` 对 `.env.example` | 无缺失 |
| B2 | src 无硬编码密钥回退 | 搜 `(PUB_KEY\|API_BASE\|SECRET\|TOKEN)\s*=\s*['\"][A-Za-z0-9._-]{16,}` | 0 处 |

### C. 错误处理（来源：Day 23 三类错误统一）

| 编号 | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| C1 | errorText 三类中文 + 三组件引用 | 读 `src/errorText.js` 与三个组件 | `input/network/server` 齐全且 App/Records/RestoreNotice 都引用 friendlyError |
| C2 | 用户可见位置无裸 `(e\|err).message` | 搜 `setXxx(...e.message...)`；try 块含 `importBackupCode/exportBackupCode` 的**契约中文源豁免** | 无非豁免直展点（有则 FAIL）；仅剩豁免点时 PASS 但 evidence 列出供核对 |

### D. 云端写入与 RLS（来源：Day 19–24 四个真实事故）

| 编号 | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| D1 | 云无非注释行无 upsert | 搜 `resolution=merge-duplicates\|on_conflict`（排除注释行） | 0 处 |
| D2 | favorites 插入用 `return=minimal` | 读 favoritesRepository | 有 `Prefer: 'return=minimal'` 且 insertFavorite 内无 `return=representation` |
| D3 | 删除不带 uid 条件 | 读 favoritesRepository 注释 | 明示「删除不加 uid 条件 / RLS 保证只能删自己的行」 |
| D4 | timestamptz 写完整 ISO | 搜 `+ 'T00:00:00+08:00'` | ≥1 处（证明不塞裸 YYYY-MM-DD） |
| D5 | 不用 `Intl 'en-CA'` 格式化日期 | 搜 `en-CA` | 0 处 |
| D6 | 云函数时区显式 Asia/Shanghai | 搜 `Asia/Shanghai` | ≥1 处 |

### E. 前端规则（来源：R2/R4/R5 + Day 22 层级事故）

| 编号 | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| E1 | 禁词零命中 | 非注释行搜 `你会(?!发现)\|建议你\|不宜\|运势\|命定\|注定\|天机\|必然` | 0 处 |
| E2 | 无 plain 白话层 | 搜 `kind="plain"\|=== 'plain'` 等 | 0 处 |
| E3 | 繁体仅限仪式两句 | 搜 `運隨時變\|靜神定心` | 只出现在 QuizCeremony.jsx |
| E4 | `.qi-stage` 层级 > `.cast-root` | 解析两个 CSS 的 z-index | 260 > 200（全屏浮层不被起卦动画盖住） |

### F. 文档规范（来源：doc-check 纪律 + Mermaid 渲染坑）

| 编号 | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| F1 | doc-check.py 全过 | 运行 `.workbuddy/doc-check.py` 解析输出 | 加粗 0 / 表格问题 0 / 标题问题 0 / 悬空引用 无 |
| F2 | docs 无内嵌 mermaid | 搜 ` ```mermaid ` | 0 处（配图必须导出 PNG） |
| F3 | .mmd 与 .png 成对 | 扫 `docs/img/*.mmd` | 每个都有同名 .png |

### G. 构建

| 编号 | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| G1 | vite build 通过 | `npx vite build --outDir .workbuddy/dist-verify-<时间戳> --emptyOutDir` | exit 0 且输出含 `built in` |

⚠️ 两个必须：① `--outDir` **每次换新目录**——本机沙箱删不掉已存在目录（safe-delete 失败 closed），vite 的 `--emptyOutDir` 撞上残留目录会整构建失败（Day 25 实测）；② Windows 上 npx 是 `npx.cmd`，Python subprocess 必须 `shell=True`，否则 WinError 2。

### H. 公网（最小版本必含两项）

| 编号 | 检查 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| H1 | 静态托管首页 200 | GET 托管域名 | HTTP 200 |
| H2 | 健康接口 200 且 ok:true | GET `{网关}/api/health` | HTTP 200 且 body.ok === true |

## 检查器的边界（用前必读，避免误信）

1. **注释行启发式**：禁词/模式扫描会跳过行首为 `* // /* */ #` 的行。规则注释里出现禁词（如 CastResult.jsx 的「不得出现你会……」）**不算违规**；但行内尾注释不受影响 —— 极端情况可能漏判，WARN/FAIL 的证据行请人工瞄一眼。
2. **契约中文豁免（C2）**：`importBackupCode/exportBackupCode` 按契约抛中文错误，UI 直展 `e.message` 是**设计而非裸报错**，已豁免；其他位置的直展会 FAIL。
3. **渐变不查**：本项目自 Day 8 起明确使用渐变做「宣纸/竹简/鎏金」做旧质感（用户批准的美术语言），**不做「无渐变」检查** —— 早期「无渐变背景」的偏好已被做旧体系取代，别把它写回检查项。
4. **WARN 不阻塞**：C2 这类静态不可判定的灰区只提示不 FAIL，发布决策留给人。
5. **公网检查依赖网络**：代理/网络不通时 H1/H2 会 FAIL —— 那是「此刻无法验证发布」的真实状态，不是误报。
6. **A1/A2 两处排除**：① `docs/security-checklist.md` 里 content 以 `-e ` 开头的扫描命令示例行（教人怎么搜，必然含特征词字面量，但不是密钥；**不排除整个文件**——文档里出现真实密钥赋值行照样 FAIL）；② **检查器自身目录** `.workbuddy/skills/verify-project/`（KEY_PATTERNS 的定义处，必然含特征词字面量——Day 25 实跑时Skill 刚入库就自己命中自己，据此加排除）。
7. **A1 查已提交树、A4 查工作区文件**：往 `.env.example` 加了东西但没提交时，A1（`git grep HEAD`）看不到、A4（读工作区）看得到 —— 两者互补，别怪某个「漏报」。

## 校准记录（Day 25 两轮实跑 + 故意弄坏）

Skill 不是写完就信的——首轮实跑 **20 PASS / 4 FAIL**，逐条校准过：

| 首轮 FAIL | 性质 | 处理 |
| --- | --- | --- |
| F1 doc-check | **真阳性**：当天追加的 v2.95  changelog 把报错原文 `(arr \|\| [])` 写进表格 → 裸竖线撑爆列数 | 改文档（转义 `\|`）——skill 当场抓住一个真问题 |
| A2 历史 8 命中 | 误报：全是 security-checklist.md 旧提交里的扫描命令示例 | 排除 `-e ` 示例行（见边界 6） |
| D2 return=minimal | 误报：注释里「提及」return=representation 打败了判定 | insertFavorite 段先剥注释行再判 |
| G1 build | 误报：Windows 上 npx 是 npx.cmd，subprocess 不用 shell → WinError 2 | `shell=True` |

第二轮 **24/24 PASS**。随后**故意弄坏验证**（往 `.env.example` 追加假 JWT，当场还原）：

- 第一次故意跑：A4 准确 FAIL（证据含假值整行）✓，但同時暴露 G1 的新误报——沙箱删不掉残留的 `dist-verify`，vite `--emptyOutDir` 整构建失败 → 改为每次换新目录（见 G1 行注释）。
- 修复后第二次故意跑：**23 PASS / 1 FAIL，唯一的 FAIL 就是故意留的 A4**—— Skill 不虚报通过。
- 还原后最终跑：**24/24 PASS，exit 0**。

> 结论：这个 Skill 抓过真问题（v2.95 裸竖线）、被校准过 5 处误报、也被故意弄坏验证过。可以信，但边界仍以上一节为准。

**第三轮校准（2026-10-15 晚，Skill 入库后首次当发布门用）**：Skill 自己的文件进了版本库 → A1/A2 **自己命中自己**（SKILL.md 的模式集定义、verify.py 的 KEY_PATTERNS 源码必然含特征词字面量）。这正是 Day 23「自查文档匹配自己」的同类。处理：A1/A2 排除检查器自身目录 `.workbuddy/skills/verify-project/`（见边界 6）。修后发布门 **24/24**。教训：**检查器自己的源码也是被扫描范围的一部分——写检查时就要想好「它自己会不会命中自己」。**

## 维护方式（新增检查项）

在 `scripts/verify.py` 里加一段：算判定 → `report('编号', '名称', ok, '证据（含命令）')`。命名规范：字母=分组，数字=组内序号。**新检查项必须对应一次真实事故**，并在本表补一行（命令 + 通过标准）。改完先跑一遍确认不误报，再提交。

## 相关

- 文档自检：`.workbuddy/doc-check.py`（F1 直接复用它，不重复造）
- 安全自查清单：`docs/security-checklist.md`（A 组的手动版，含每项验证方法）
- 测试清单：`docs/checktai-core-flow-checklist.md`（检查台 CRUD 真实验证）
