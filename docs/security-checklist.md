# 安全自查清单（Day 23）

> 本清单随 Day 23 审计产生。每项给出「查什么」「怎么查」「当前结果」。
> 验证脚本可直接复制到 Bash / Git Bash 中复跑。

## 1. 硬编码密钥排查（红线）

- **查什么**：代码 / 文档 / 配置里是否有真实的 Publishable Key / SecretId / SecretKey / 私钥 / 访问令牌等。
- **验证方法**：只在「已跟踪文件」里搜**值特征**，不搜单词（避免把提示句误判为密钥）。

```bash
cd "E:/Workbuddy文件夹"
git grep -I -n \
  -e "eyJhbG（JWT 头前缀，如 eyJhbG… 的完整形式）" \
  -e "AKID[0-9A-Za-z]{10,}" \
  -e "AKIA[0-9A-Z]{16}" \
  -e "-----BEGIN … KEY-----（含 RSA/PRIVATE/OPENSSH/EC 等）" \
  -e "(secretkey|secret_key|client_secret|access_token)\s*[=:]"
```

- **当前结果**：`0 条命中`（截图 `docs/img/audit-secret.png`）。
- **说明**：`docs/CLOUD_SETUP.md` 中有「不要贴密钥」提示句，含单词 `SecretId / SecretKey / Token`，但非真实值。

## 2. `.env` 与忽略规则完整性

- **查什么**：真实密钥 `.env` 不进仓库；`.env.example` 仅占位；`.gitignore` 覆盖密钥/证书/敏感目录。
- **验证方法**：

```bash
git ls-files --error-unmatch .env 2>/dev/null && echo "FAIL: .env 被跟踪" || echo "OK: .env 不在仓库"
cat .env.example
grep -E "^\.env|secret|credential|\.key|\.pem" .gitignore
```

- **当前结果**：
  - `.env` 从未被 Git 跟踪（`git log --all -- .env` 也为空）。
  - `.env.example` 只有空值占位注释。
  - `.gitignore` 已包含 `.env .env.* !.env.example`、`*.key *.pem *.p12 *.pfx`、`secrets/ credentials*`。

## 3. Git 历史密钥泄露扫描

- **查什么**：历史上是否曾提交过真实密钥（即使后来删除也可能留在 blob 里）。
- **验证方法**：

```bash
git grep -I -n \
  -e "eyJhbG（JWT 头前缀，如 eyJhbG… 的完整形式）" \
  -e "AKID[0-9A-Za-z]{10,}" \
  -e "-----BEGIN … KEY-----（含 RSA/PRIVATE/OPENSSH/EC 等）" \
  $(git rev-list --all)
```

- **当前结果**：`0 条命中`。因此无需作废/重生成密钥。

## 4. 三类错误统一中文提示

- **查什么**：用户可见的错误提示不出现英文 / HTTP 状态号 / 原始异常；统一归到「输入错 / 网络错 / 服务端错」。
- **三类文案**：

| 类型 | 用户提示 |
|---|---|
| 输入错 | 输入有误，请检查后重试（服务端已给具体中文校验原因时优先用其文案） |
| 网络错 | 网络连接异常，请检查网络后重试 |
| 服务端错 | 服务暂时不可用，请稍后再试 |

- **验证方法**：

```bash
# 1) 确认新增 src/errorText.js
grep -n "friendlyError\|ERR_TEXT" src/errorText.js

# 2) 确认用户可见 catch 不再直接拼 err.message
grep -rn "(err\.message\|e\.message).? \|\| ?'未知错误'" src --include=*.jsx --include=*.js

# 3) 构建通过
node node_modules/vite/bin/vite.js build
```

- **当前结果**：
  - 新增 `src/errorText.js`：含 `classifyError()` + `friendlyError()`。
  - 已修改 `src/App.jsx`、`src/Records.jsx`、`src/RestoreNotice.jsx` 的用户可见 catch。
  - `vite build` 通过。
  - 截图 `docs/img/audit-errors.png` 可见三类中文提示与改前改后对照。

## 5. 非法输入校验

- **查什么**：用户非法输入是否在本地或服务端给出中文提示，而不是裸异常。
- **验证方法**：

```bash
# 本地校验：Records.jsx 检查台输入 1–64
grep -n "卦序号要填 1 – 64" src/Records.jsx

# 本地备份码校验：前缀 / 解析 / 版本
grep -n "YJ64-\|请先粘贴进度码\|这不像本项目的进度码\|版本不认识" src/storage.js

# 服务端校验：契约 422 中文原因
grep -n "缺少必填\|必须是整数\|必须在 1" cloudfunctions/api/index.js
```

- **当前结果**：本地与服务端非法输入均已给出中文提示。

## 6. 请求日志（余力加练，本次未做）

- **查什么**：是否记录请求时间 / 路径 / 结果，且绝不记录 token / 完整请求体。
- **验证方法**：检查 `cloudfunctions/api/index.js` 已有 `logEvent()`（Day 18 已加），服务端日志满足需求；前端本次未单独再加。
- **当前结果**：本次未做；服务端已有日志，前端依赖统一错误提示，足够支持排障。

---

**结论**：Day 23 主线「密钥排查 + 三类错误中文提示」全部完成，.env 安全、Git 历史无泄露、用户可见错误全走中文映射。
