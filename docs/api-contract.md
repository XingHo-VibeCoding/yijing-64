# API 契约（第 3 周的建表与写接口依据）

> **项目**：易经六十四卦学习 ｜ **英文名**：`yijing-64`
> **状态**：⚠️ **契约占位 —— 今天只登记，不实现。** 除 `GET /api/health`（已上线）外，本文所有接口均为「待实现」。
> **依据**：第 2 周前端页面（总表 / 详情 / 起卦结果 / 记录与收藏 / 测验 / 终局仪式）的实际数据诉求。
> **来源**：字段与语义取自 `src/storage.js`、`src/mockApi.js`、`data/64卦.json`、`db/migrations/`，不是凭空设计。

---

## 一、这份契约怎么用

| 用途 | 说明 |
| --- | --- |
| **第 3 周建表** | 第五节「表 ↔ 接口对照」是**建表的唯一依据**；表名、主键、字段名以此为准 |
| **第 3 周写接口** | 第四节每个接口的「请求参数 / 响应 JSON / 错误返回」逐字照做，前端不再改口径 |
| **前端接入** | 只替换 `src/storage.js` 这一层（它的接口早按云端形状设计），组件层不动 |
| **明确不做的** | 跨域 / 网关安全域名、前端联调、任何业务逻辑实现 —— 本阶段都不碰 |

⚠️ **两条红线不变**（PRD §7.3）：① 起卦记录只存 `date / hexagramId / changingLines`，**不存精确时刻**；② **不采集任何身份信息**（无手机号 / 邮箱 / IP / 设备指纹，不做埋点）。`uid` 由平台匿名登录生成，**仅用于行级隔离**。

---

## 二、通用约定

| 项 | 约定 |
| --- | --- |
| **基础路径** | `/api`（网关路径路由前缀） |
| **域名** | `https://yijing-64-d1g9uvmlkf13c8f77-1498185256.ap-shanghai.app.tcloudbase.com` |
| **传输** | 仅 HTTPS，`Content-Type: application/json; charset=utf-8` |
| **认证** | CloudBase **匿名登录**会话（`Authorization: Bearer <session>`）。除 `GET /api/health` 与 `GET /api/hexagrams*` 外，全部需要会话 |
| **身份来源** | 服务端从会话取 `uid`，**客户端不得传 uid**（传了也忽略）—— 这是行级隔离的根 |
| **日期** | 一律 `YYYY-MM-DD`，按**服务器本地日**（不存时刻、不存时区偏移） |
| **字段命名** | 响应统一 **camelCase**（数据库列是 snake_case，转换在服务端做） |
| **成功响应** | `200 / 201 / 204`，主体 `{ "ok": true, "data": … }`；列表为 `{ "ok": true, "items": […], "meta": { … } }` |
| **失败响应** | `4xx / 5xx`，主体 `{ "ok": false, "error": { "code": "…", "message": "…" } }` |
| **幂等** | 写接口一律幂等（重复调用不产生重复数据、不报错），详情见各接口 |
| **跨域** | **本阶段不处理**（接口还没接）；将来按网关安全域名 + `Access-Control-Allow-Origin` 处理 |

> **`GET /api/health` 是唯一例外**：它刻意只返回 `{ "ok": true, "service": "yijing-64" }`，不套 `data` 信封 —— 健康检查要的就是「一眼看穿」，包一层反而妨碍探活。已实现，不随本契约改动。

### 错误码表

| HTTP | code | 什么时候出现 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 路径参数格式不对（如 `:id` 不是数字） |
| 401 | `UNAUTHENTICATED` | 没有会话 / 会话过期 |
| 403 | `FORBIDDEN` | 会话有效但无权访问该行（RLS 拒绝） |
| 404 | `NOT_FOUND` | 目标不存在（如 `hexagrams/99`） |
| 405 | `METHOD_NOT_ALLOWED` | 路径对、方法不对 |
| 409 | `CONFLICT` | 唯一键冲突且该接口**不**做幂等时（本项目基本用不到） |
| 422 | `VALIDATION_FAILED` | 参数越界（如 `hexagramId = 65`） |
| 429 | `RATE_LIMITED` | 触发频控 |
| 500 | `INTERNAL` | 服务端未预期错误 |
| 503 | `UPSTREAM_UNAVAILABLE` | 数据库等下游不可用 |


### 身份的两条通道（Day 17 已核实并落地）

原先「认证」那一行只写了「服务端从会话取 uid」，但没写清**会话怎么到函数手里**。Day 17 查实了官方链路
（`docs.cloudbase.net/authentication-v2/auth/auth-pg`）并按它实现：

```
客户端 Authorization: Bearer <JWT> → 网关解析 JWT、注入数据库会话变量 request.jwt.claims
  → PostgREST 以对应角色执行 → 表级 GRANT + 行级 RLS 双重校验
  而 auth.uid() 就是 auth.jwt()->>'sub'
```

**关键结论：RLS 自己就能完成按 uid 隔离，接口不需要自己拼 uid 过滤条件。**
所以本项目的读接口有两条通道：

| 通道 | 怎么调 | 服务端拿什么身份 | 能读到 |
| --- | --- | --- | --- |
| **A · 会话**（契约口径，默认） | 带 `Authorization: Bearer <access_token>` | 头里的 token **原样透传**给 PostgREST | 调用者自己的行（RLS 过滤，函数不手工传 uid） |
| **B · 示例数据**（无会话时） | `?uid=demo-yijing64-user-a` | 函数环境变量里的 `PUBLISHABLE_KEY`（`role=anon`、`sub='anon'`） | **仅 `demo-yijing64-user-%` 前缀的行** |

**通道 B 的安全边界是数据库兜的，不是只靠函数判断**：
RLS 策略 `read demo records` / `read demo favorites` 只放行
`uid like 'demo-yijing64-user-%'` **且** `auth.uid() is null or auth.uid() = 'anon'`
（迁移 `20261004221126` 建立，`20261004230153` 收紧）。
第二个条件是关键：Publishable Key 的 `sub` 恒为 `'anon'`，而真实会话的 `sub` 是 UUID ——
**所以已登录用户即使匹配了前缀也读不到 demo 行**。
函数层也再挡一道 —— `?uid=` 传非 demo 前缀一律 `403 FORBIDDEN`（对应契约「客户端不得传 uid」）。

> ⚠️ **为什么必须有第二个条件**：`20261004221126` 最初只写了 `to anon, authenticated` + 前缀匹配，
> 结果**任何已登录用户都匹配上了这条策略** —— 实测一个库里 0 行的真实匿名用户，
> 通过通道 A 读到了全部 9 条 demo 记录。收紧后复测：该用户 `visible=0 / demo_leaked=0`，
> 而 demo 通道仍返回 5 条记录 / 3 条收藏（**没有修过头**）。
> 教训：**`to authenticated` 不等于「只给服务用」—— 加上它就等于对所有登录用户开放。**

> ⚠️ `PUBLISHABLE_KEY` 是**设计上就公开**的凭证（`role=anon`，只能读 RLS 放行的行），
> 本项目前端本来就在用它；它只作为云函数环境变量注入，**不写进代码、不进仓库**。

---

## 三、数据模型（第 3 周要建的表）

> **可执行脚本**（本节是它们的逐字来源，两边必须一致）：
> `db/schema.sql`（建表 + 约束 + 行级权限 + 授权，**幂等**）｜ `db/seed.sql`（示例数据，**幂等**）
> 两个脚本都**不含 `drop table`、不删任何已有数据**，可反复执行；执行步骤见 §三.6。

### 三.1 表总览

| 表 | 主键 | 关键列 | 说明 |
| --- | --- | --- | --- |
| `divination_records` | `(uid, date)` | `hexagram_id smallint`、`changing_lines smallint[]` | 每日第一卦存档。**主键强制「一天一条」**，不靠应用层查重 |
| `favorites` | `(uid, hexagram_id)` | `created_at timestamptz` | 收藏。主键保证同一卦不会重复收藏 |
| `study_progress` | `uid` | `answered_total`、`correct_total`、`wrong_ids smallint[]`、`updated_at` | 累计进度，**一人一行**，是唯一允许 UPDATE 的表 |
| `study_rounds` | `id bigserial` | `uid`、`score`、`total`、`created_at` | 每轮成绩流水，**只增不改** |
| `gilded` | `uid` | `hexagram_ids smallint[]`、`updated_at` | 镀金成就（一人一行，取并集） |

> 以上 5 张表在 Day 12 已经建好（`db/migrations/`），**第 3 周沿用，不重建**。
> 卦象主数据（64 卦 + 384 爻辞）是**只读素材**，来自仓库 `data/*.json`，**不入库**。

### 三.2 字段级结构

以下与线上库逐列核对过（Day 14 只读实测，23 列全部一致）。

#### `divination_records` — 起卦记录（接口 2.1 / 2.2）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `uid` | `text` | NOT NULL，主键之一 | 无 | 匿名登录标识，仅用于行级隔离 |
| `date` | `date` | NOT NULL，主键之一 | 无 | 业务日期，一天一条；服务端按 Asia/Shanghai 取 |
| `hexagram_id` | `smallint` | NOT NULL，CHECK 取值 1–64 | 无 | 卦序号 |
| `changing_lines` | `smallint[]` | NOT NULL，CHECK 元素属于 1–6 | `'{}'` | 变爻位置，可为空数组 |
| `created_at` | `timestamptz` | NOT NULL | `now()` | 写库时间，**不是**用户行为时刻 |

> 变爻的 CHECK 用数组包含判断（`changing_lines <@ '{1,2,3,4,5,6}'`），空数组同样满足 ——
> 正合「可以没有变爻」。这条把接口 2.2 的 422 规则下沉到了数据库层，服务端仍要自己校验。

#### `favorites` — 收藏（接口 3.1 / 3.2 / 3.3）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `uid` | `text` | NOT NULL，主键之一 | 无 | 同 `divination_records.uid` |
| `hexagram_id` | `smallint` | NOT NULL，主键之一，CHECK 取值 1–64 | 无 | 收藏的卦序号 |
| `created_at` | `timestamptz` | NOT NULL | `now()` | 接口只返回它的**日期部分**，与「不存精确时刻」同口径 |

#### `study_progress` — 学习进度（接口 4.3 / 4.4）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `uid` | `text` | NOT NULL，主键 | 无 | 一人一行 |
| `answered_total` | `integer` | NOT NULL，CHECK 非负 | `0` | 累计作答数 |
| `correct_total` | `integer` | NOT NULL，CHECK 非负且不超过作答数 | `0` | 累计正确数 |
| `wrong_ids` | `smallint[]` | NOT NULL | `'{}'` | 错题本（卦序号） |
| `created_at` | `timestamptz` | NOT NULL | `now()` | 首次写入时间 |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | 最近写入时间，接口返回其日期部分 |

> `correct_total <= answered_total` 这条 CHECK 把接口 4.4 的 422 规则下沉到了数据库层。

#### `study_rounds` — 每轮成绩流水（接口 4.1 / 4.2）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `bigserial` | NOT NULL，主键 | 序列分配 | 流水号；接口返回它给客户端做去重 |
| `uid` | `text` | NOT NULL | 无 | 同 `divination_records.uid` |
| `score` | `smallint` | NOT NULL，CHECK 非负且不超过题数 | 无 | 本轮答对数 |
| `total` | `smallint` | NOT NULL，CHECK 为正 | `8` | 一轮题数（Day 11 由 20 定为 8） |
| `created_at` | `timestamptz` | NOT NULL | `now()` | 交卷时间，倒序取即为成绩曲线 |

#### `gilded` — 镀金成就（接口 5.1 / 5.2）

| 列 | 类型 | 约束 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `uid` | `text` | NOT NULL，主键 | 无 | 一人一行 |
| `hexagram_ids` | `smallint[]` | NOT NULL，CHECK 元素属于 1–64 | `'{}'` | 已镀金的卦序号，写接口取并集 |
| `created_at` | `timestamptz` | NOT NULL | `now()` | 首次写入时间 |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | 最近一次并集写入时间 |

### 三.3 为什么本库没有外键

五张表之间**没有任何外键**，这不是遗漏，是结构决定的：

| 可能的外键 | 为什么不建 |
| --- | --- |
| `*.uid` → 用户表 | **库里没有用户表**。uid 来自平台匿名登录，服务端只把它当隔离键用 |
| `hexagram_id` → 卦象表 | 卦象主数据**不入库**（见本节开头），留在仓库 `data/*.json` 由前端加载 |
| `study_rounds.id` → 其它表 | 没有表引用流水号 |

替代手段：`hexagram_id` 与 `hexagram_ids` 的取值边界由 **CHECK 约束**保证（见三.2），
效果等价于「外键 + 参照表」中最要紧的那一半，且不必把只读素材复制进数据库。

> 若课程明确要求必须出现外键，`db/schema.sql` 的**附录 B** 给了一份可选方案
> （加一张只存 64 个序号的 `hexagrams` 参照表，再挂两条外键）。**默认不启用** ——
> 启用就等于库里多了一张表，需要先改本节，否则契约与数据库就不一致了。

### 三.4 行级权限一览

每张表的策略**故意不对称**，「缺哪一条」是设计的一部分：

| 表 | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `divination_records` | 有 | 有 | **无**（记录不可事后编辑） | 有 |
| `favorites` | 有 | 有 | 无 | 有 |
| `study_progress` | 有 | 有 | 有（进度要累加） | 无 |
| `study_rounds` | 有 | 有 | 无 | 无（流水只增） |
| `gilded` | 有 | 有 | 有（并集写回） | **无**（成就不参与清空） |

所有策略的条件都是 `uid = current_uid()`，共 14 条。

### 三.5 索引

| 索引 | 表 | 用途 |
| --- | --- | --- |
| `idx_records_uid_date` | `divination_records` | 记录列表按 `date` 倒序（接口 2.1） |
| `idx_rounds_uid_time` | `study_rounds` | 成绩流水按时间倒序（接口 4.1） |

### 三.6 建表与灌数的执行步骤

1. CloudBase 控制台 → 数据库 → PostgreSQL → SQL 编辑器
2. 整份粘贴执行 `db/schema.sql`（全是 DDL，几秒完成；末尾会自动打印四条自检结果）
3. 核对自检输出：表 5 张且 RLS 全为 true、约束 5 主键 + 6 检查、策略 14 条、违规扫描 5 项全 0
   （注：这个库**已经处于该状态** —— 结构与示例数据于 2026-10-02 落库，见下方变更记录）
4. 可选：粘贴执行 `db/seed.sql` 灌 **36 行**示例数据（只写五个示例 uid，不碰真实用户；**每张表 ≥ 5 行**）
5. 想清掉示例数据：`db/seed.sql` 末尾有一段**注释掉的**清理语句，取消注释执行即可

> ⚠️ `db/schema.sql` 会**新增 4 条 CHECK 约束**，这是相对 Day 12 线上结构的唯一变化。
> 执行前它末尾的「违规扫描」应为 0 行 —— Day 14 已在真库实测为 0，可以安全添加。

---

## 四、接口清单

### 0. 健康检查

#### `GET /api/health` ✅ 已实现

| | |
| --- | --- |
| **请求参数** | 无 |
| **响应 200** | `{ "ok": true, "service": "yijing-64" }` |
| **错误** | `405` → `{ "ok": false, "error": "Method Not Allowed" }` |
| **认证** | 不需要（公开） |

---

### 一、卦象主数据（只读，公开）

#### 1.1 `GET /api/hexagrams` — 卦象列表（总表页）

| | |
| --- | --- |
| **请求参数** | `volume`（可选，`上经` \| `下经`）、`q`（可选，按卦名或拼音模糊） |
| **响应 200** | 见下方 |
| **错误** | `500` |

```json
{
  "ok": true,
  "items": [
    {
      "id": 1,
      "name": "乾",
      "symbol": "☰☰",
      "pinyin": "qián",
      "volume": "上经",
      "upper": { "name": "乾", "symbol": "☰" },
      "lower": { "name": "乾", "symbol": "☰" },
      "fortune": "吉"
    }
  ],
  "meta": { "count": 64, "total": 64 }
}
```

> 对应现有 `src/mockApi.js#fetchHexagrams()` 的返回形状（`{ items, meta }`）—— 将来只换实现，状态机与组件不动。

#### 1.2 `GET /api/hexagrams/:id` — 单卦详情（详情页）

| | |
| --- | --- |
| **请求参数** | path `id`：整数 `1–64` |
| **响应 200** | 见下方 |
| **错误** | `400` `BAD_REQUEST`（id 非数字）、`404` `NOT_FOUND`（越界）、`500` |

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "name": "乾",
    "symbol": "☰☰",
    "pinyin": "qián",
    "volume": "上经",
    "upper": { "name": "乾", "symbol": "☰" },
    "lower": { "name": "乾", "symbol": "☰" },
    "judgment": "乾：元，亨，利，贞。",
    "image": "象曰：天行健，君子以自强不息。",
    "fortune": "吉",
    "fortuneBasis": "……",
    "lines": [
      { "position": 1, "name": "初九", "text": "潜龙勿用。" }
    ]
  }
}
```

> **不返回白话译文** —— 白话解读整层已被拿掉（AGENTS.md R4）。
> `lines` 只在详情请求时下发；列表接口不下发，避免首屏体积翻 6 倍。

---

### 二、起卦记录（表 `divination_records`）

#### 2.1 `GET /api/records` — 记录列表（记录页 / 每日首卦银边） ✅ 已实现（2026-10-04）

| | |
| --- | --- |
| **请求参数** | `limit`（可选，默认 `60`，上限 `365`）、`before`（可选，`YYYY-MM-DD` 游标，取该日**之前**的记录） |
| **响应 200** | 见下方（按 `date` **倒序**） |
| **错误** | `401` `UNAUTHENTICATED`、`422`（limit 越界）、`500` |

```json
{
  "ok": true,
  "items": [
    { "date": "2026-10-02", "hexagramId": 1, "changingLines": [3, 5] },
    { "date": "2026-10-01", "hexagramId": 63, "changingLines": [] }
  ],
  "meta": { "count": 2, "hasMore": false }
}
```

> **总表上「每日首卦」的银边依赖这个接口的**全量 id 集合 —— 前端据此算 `dailyIds`，所以 `limit` 默认给足 60 天。

#### 2.2 `POST /api/records` — 存档今日第一卦

| | |
| --- | --- |
| **请求参数** | body：`{ "hexagramId": 1, "changingLines": [3, 5] }` |
| **响应 201**（首次）/ **200**（当天已有） | 见下方 |
| **错误** | `401`、`422` `VALIDATION_FAILED`（`hexagramId` 不在 1–64、`changingLines` 含非 1–6 的整数） |

```json
{
  "ok": true,
  "data": { "date": "2026-10-02", "hexagramId": 1, "changingLines": [3, 5] },
  "created": true
}
```

**约定**：
- `date` **由服务端取当天**，客户端传了也忽略（防篡改、防时区漂移）
- **幂等**：当天已有记录时返回 `200` + `created: false`，**不覆盖**原有那一卦
- `changingLines` 去重、升序、过滤非法值后入库

---

### 三、收藏（表 `favorites`）

#### 3.1 `GET /api/favorites` — 收藏列表（记录页 / 收藏钉状态） ✅ 已实现（2026-10-04）

| | |
| --- | --- |
| **请求参数** | 无 |
| **响应 200** | 见下方（按 `createdAt` 倒序） |
| **错误** | `401`、`500` |

```json
{
  "ok": true,
  "items": [
    { "hexagramId": 12, "createdAt": "2026-10-02" }
  ],
  "meta": { "count": 1 }
}
```

> `createdAt` 只到**日**（下游把 `timestamptz` 截断为 `YYYY-MM-DD`）—— 与「不存精确时刻」的口径一致。

#### 3.2 `POST /api/favorites` — 添加收藏 ✅ 已实现（2026-10-04）

| | |
| --- | --- |
| **请求参数** | body：`{ "hexagramId": 12 }` |
| **响应 201**（新建）/ **200**（已收藏） | `{ "ok": true, "data": { "hexagramId": 12, "createdAt": "2026-10-02" } }` |
| **错误** | `401`、`422`（`hexagramId` 不在 1–64） |

> **实现要点（Day 18 实测）**：
> ① **防重复按契约的「幂等」口径**：已存在 → 返回 **200** 且**不写库**（保留最初的 `createdAt`），
>    唯一性由主键 `(uid, hexagram_id)` 兜底。⚠️ 这里**刻意不用** `Prefer: resolution=merge-duplicates`（upsert）——
>    在有 RLS 的表上它会先读现有行，触发 `new row violates row-level security policy (USING expression)`，
>    导致「第一次成功、重复必然 401」，正好与目标相反。
> ② **写入只接受真实会话**（通道 A），**不支持** `?uid=demo-*` 写入 —— 公开凭证能写行等于开匿名写入口。
> ③ `created_at` 显式按 **`Asia/Shanghai` 当天零点**写入（云函数运行时是 UTC）。
>    ⚠️ 日期格式化**不能**用 `Intl.DateTimeFormat('en-CA').format()`：它的输出取决于运行时 ICU 版本，
>    云函数（Node 18）实测返回美式 `10/04/2026`。改用 `formatToParts()` 逐字段取再自己拼。
> ④ 校验分四步、逐条给中文原因：body 非法 JSON → 400；缺 `hexagramId` / 非整数 / 越界 → 422。

#### 3.3 `DELETE /api/favorites/:hexagramId` — 取消收藏

| | |
| --- | --- |
| **请求参数** | path `hexagramId`：整数 `1–64` |
| **响应 204** | 无正文（**幂等**：本来就没收藏也返回 204） |
| **错误** | `401`、`400` `BAD_REQUEST` |

> 前端是「一个按钮切换收藏」，所以 3.2 / 3.3 由 `toggleFavorite()` 按当前状态二选一调用。

---

### 四、测验（表 `study_rounds` + `study_progress`）

#### 4.1 `GET /api/quiz/rounds` — 轮次流水（进度码导出 / 成绩曲线）

| | |
| --- | --- |
| **请求参数** | `limit`（可选，默认 `50`，上限 `200`） |
| **响应 200** | 见下方（按 `date` 倒序） |
| **错误** | `401`、`422`、`500` |

```json
{
  "ok": true,
  "items": [
    { "id": 12, "date": "2026-10-02", "score": 6, "total": 8 }
  ],
  "meta": { "count": 1 }
}
```

> ⚠️ 流水**不含**每轮答了哪些卦（`answeredIds` / `wrongIds`）—— 那是本地才有的信息，云端只存分数。错题本靠 `study_progress.wrong_ids` 补（见 4.3 / 4.4）。

#### 4.2 `POST /api/quiz/rounds` — 提交一轮成绩

| | |
| --- | --- |
| **请求参数** | body：`{ "score": 6, "total": 8, "answeredIds": [1,2,3], "wrongIds": [3] }` |
| **响应 201** | `{ "ok": true, "data": { "id": 13, "date": "2026-10-02", "score": 6, "total": 8 } }` |
| **错误** | `401`、`422`（`score > total`、`total` 非正、id 数组含越界值） |

**副作用**：服务端在**同一事务**里更新 `study_progress` 的累计值 —— 前端因此不需要再单独调一次 4.4。

#### 4.3 `GET /api/quiz/progress` — 读取累计进度

| | |
| --- | --- |
| **请求参数** | 无 |
| **响应 200** | `{ "ok": true, "data": { "answeredTotal": 24, "correctTotal": 18, "wrongIds": [3, 7], "updatedAt": "2026-10-02" } }` |
| **错误** | `401`、`500` |

#### 4.4 `PUT /api/quiz/progress` — 写回累计进度

| | |
| --- | --- |
| **请求参数** | body：`{ "answeredTotal": 24, "correctTotal": 18, "wrongIds": [3, 7] }` |
| **响应 200** | 同 4.3 的 `data` |
| **错误** | `401`、`422`（负数、`correctTotal > answeredTotal`） |

> **用途**：导入进度码（换设备）后把并集结果写回云端。**以本地为准**，直接覆盖云端同名键。

---

### 五、镀金成就（表 `gilded`）

#### 5.1 `GET /api/gilded` — 读取镀金列表

| | |
| --- | --- |
| **请求参数** | 无 |
| **响应 200** | `{ "ok": true, "data": { "hexagramIds": [1, 12], "updatedAt": "2026-10-02" } }` |
| **错误** | `401`、`500` |

#### 5.2 `PUT /api/gilded` — 并集写回

| | |
| --- | --- |
| **请求参数** | body：`{ "hexagramIds": [1, 12] }` |
| **响应 200** | 同 5.1 的 `data`（返回**并集后**的完整列表） |
| **错误** | `401`、`422` |

> **成就只增不减**：服务端取「云端已有 ∪ 本次提交」，不接受删除。所以这个接口是 `PUT`（合并语义）而不是覆盖。

---

### 六、账号与数据清除

#### 6.1 `GET /api/me/summary` — 我的数据概览（首页入口计数）

| | |
| --- | --- |
| **请求参数** | 无 |
| **响应 200** | `{ "ok": true, "data": { "records": 5, "favorites": 3, "gilded": 2, "rounds": 9 } }` |
| **错误** | `401`、`500` |

#### 6.2 `DELETE /api/me/data` — 清空我的记录

| | |
| --- | --- |
| **请求参数** | query `scope`：`records` \| `favorites` \| `quiz` \| `all`（默认 `all`） |
| **响应 200** | `{ "ok": true, "data": { "cleared": { "records": 5, "favorites": 3, "rounds": 9 } } }` |
| **错误** | `401`、`422`（scope 取值非法）、`500` |

**约定**：
- `scope=quiz` 清 `study_rounds` + `study_progress`；`all` = 前三类全清
- ⚠️ **镀金（`gilded`）永远不参与清空** —— 它是成就，不是记录（`src/storage.js#clearAll()` 同口径）
- 必须**云端与本地一起清**，否则清完又被同步回来

---

## 五、表 ↔ 接口对照（建表照着这张表建）

| 表 | 读 | 写 | 删 |
| --- | --- | --- | --- |
| `divination_records` | `GET /api/records` | `POST /api/records` | `DELETE /api/me/data?scope=records` |
| `favorites` | `GET /api/favorites` | `POST /api/favorites` | `DELETE /api/favorites/:hexagramId`、`DELETE /api/me/data?scope=favorites` |
| `study_rounds` | `GET /api/quiz/rounds` | `POST /api/quiz/rounds` | `DELETE /api/me/data?scope=quiz` |
| `study_progress` | `GET /api/quiz/progress` | `PUT /api/quiz/progress`（4.2 会事务内自动更新） | `DELETE /api/me/data?scope=quiz` |
| `gilded` | `GET /api/gilded` | `PUT /api/gilded` | **无**（成就不可删） |
| 卦象主数据 | `GET /api/hexagrams`、`GET /api/hexagrams/:id` | — | — |

---

## 六、页面 → 接口对照（前端哪一屏用哪些）

| 页面 / 功能 | 用到的接口 |
| --- | --- |
| 总表页（列表 + 加载/空/错误三态） | `GET /api/hexagrams` |
| 总表页 · 每日首卦银边 | `GET /api/records` |
| 总表页 · 收藏钉 / 镀金金环 | `GET /api/favorites`、`GET /api/gilded` |
| 首页入口计数 | `GET /api/me/summary` |
| 详情页（原文 / 象辞 / 三层解读） | `GET /api/hexagrams/:id` |
| 起卦 → 每日第一卦自动存档 | `POST /api/records` |
| 详情页 → 收藏按钮 | `POST /api/favorites` / `DELETE /api/favorites/:hexagramId` |
| 测验 → 交卷 | `POST /api/quiz/rounds` |
| 测验 → 错题本 / 正确率 | `GET /api/quiz/progress` |
| 终局仪式 → 镀金 | `PUT /api/gilded` |
| 记录页 → 清空我的记录 | `DELETE /api/me/data` |
| 记录页 → 进度码导出 | `GET /api/records` + `GET /api/favorites` + `GET /api/gilded` + `GET /api/quiz/rounds` |
| 记录页 → 进度码导入 | 上述四个读 + `PUT /api/gilded` + `PUT /api/quiz/progress` + `POST /api/records` + `POST /api/favorites` |
| 探活 | `GET /api/health` |

> **进度码本身不需要服务端接口** —— 它是纯前端的 base64url 编码（`src/storage.js`），服务端只在导入后接收并集结果。

---

## 七、待核实 / 明确不做

| # | 事项 | 状态 |
| --- | --- | --- |
| V1 | CloudBase **匿名登录**在 PG 环境下是否默认可用 | 待核实（Day 12 实测 v3 注册必须邮箱/手机，故前端不做登录） |
| V2 | 云函数读取会话 uid 的具体 API（`auth.uid()` 之外的函数侧取法） | 待核实 |
| V3 | 日期「服务器本地日」在云函数里的时区 | ⚠️ 云函数默认 UTC —— 落地时必须显式按 `Asia/Shanghai` 取日，否则跨零点会错一天 |
| V4 | 列表分页在数据量上来后的性能（`study_rounds` 索引已建 `idx_rounds_uid_time`） | 待观察 |

**本阶段明确不做**：跨域配置、网关安全域名、接口实现、前端联调、任何业务逻辑。

---

## 八、变更记录

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| v1.8 | 2026-10-06 | **Day 19：身份层（本地 UID 作对账锚点）+ 游客数据恢复流程；接口与数据库结构均未改动。** 需求是「做账号体系保存用户数据」，实现时**明确否决了「客户端自造 uid 直接当身份」**：`current_uid()` 认的是平台签名的 JWT `sub`，把 localStorage 里的 uid 塞进请求会被 RLS 判成越权；要改成真身份得重写 14 条策略、并把安全性从「平台签名」降为「凭据不外泄」，属高风险写操作，已向用户说明并**留待拍板**，故本次一行策略未动。落地为**纯前端身份层** `src/identity.js`：启动先 `ensureLocalUid()`（没有就生成并存 `yijing.uid.v1`），拿到云端 uid 后 `rememberCloudUid()` 写回锚点；判定由 `identityState()` 给出 `fresh` / `recoverable` / `checking` 三态。⭐ **判据是三个数而不是一个**：本机有数据 **且** 云端**确实读到** 0 条 **且** 两边 uid 对不上 —— 云端拉取失败时一律判 `fresh`（那时条数是「未知」不是 0，误报会教用户不信任这个提示，v1.7 已踩过）。合并动作复用 v1.7 之外的 Day 18 已验证实现 `rebindLocalToCloud()`（逐条 await + 核对返回值 + 失败如实报），**用户点确认才执行，绝不自动重绑**；恢复完成后把锚点认下新 uid 并清「暂不处理」标记。另派新事件 `yijing:identity-resolved`（不能只靠 `yijing:cloud-synced` —— 那次可能没有新数据合并，提示会关不掉）。**契约零改动**：没有新增接口，五张表结构与 14 条策略一字未动 |
| v1.9 | 2026-10-08 | **Day 19（第 3 周）：云函数分层重构。数据库操作从接口层搬进 repository，接口只留「接请求、调函数、返响应」。** 新增 `repositories/recordsRepository.js`（`listRecords`）与 `repositories/favoritesRepository.js`（`listFavorites` / `findFavoriteByHexagramId` / `insertFavorite`），另加 `lib/` 三个共享模块（`http.js` 响应信封与 CORS、`request.js` 网关事件解析、`identity.js` uid 与业务日）。搬走的是查询串组装、`fetch`、JSON 解析、行→camelCase 映射、INSERT 拼装；留在接口层的是路由分派、身份判定、参数校验、状态码映射。⚠️ **只有实际查到的两张表拆了** —— `study_progress` / `study_rounds` / `gilded` 由前端直连 rdb、不经本函数，为它们建 repository 是死代码。⭐ **契约零改动**：三个已上线接口的路径、方法、请求体、响应信封、状态码、错误码与错误文案**逐字未变**，14 条 RLS 策略与五张表结构也未动。验证：重构前后基线在同一进程内注入同一 mock fetch 逐条比对，**44/44 一致**（含状态码 + 响应头 + 响应体 + 实际发出的查询串）；公网真实匿名会话再验 **28/28**，含真实写入 201、重复 200 幂等、连发两次库中仍 1 行、读回命中，且回查数据库确认只落 1 行。另多验 demo 通道、`limit` / `before` 四种越界、`OPTIONS` 预检 204、无会话 401、非 demo 前缀 403、未知接口 404、非 GET 405。详见 TECH_DESIGN v2.69 与 `docs/img/layering.png` |
| v1 | 2026-10-02 | 首版：登记全部接口占位（第 3 周依据）。共 16 个接口，`GET /api/health` 已实现并验证，其余 15 个待实现 |
| v1.7 | 2026-10-04 | **`POST /api/favorites`（3.2）已实现并上线。** 防重复按契约的**幂等**口径：已存在返回 200 且不写库，唯一性由主键兜底；校验分四步并逐条给中文原因（缺字段 / 非整数 / 越界 / body 非法）；`created_at` 显式按 Asia/Shanghai 当天零点写入。实测：正常 201、重复 200（连发 3 次库里仍 1 行）、缺字段 422、越界 422、非整数 422、无会话 401、demo 身份写入 401；写入后 `GET /api/favorites` 能读出新增行。详见 §三.3 的实现要点 |
| v1.6 | 2026-10-04 | **前端接入读接口（Day 17 收尾），并修一处越权读取。** ① 前端 `storage.js` 的记录与收藏**优先走云函数读接口**（`apiGet()`，用 `auth.getAccessToken()` 的真实凭证；接口不可用时**静默回退**直连 rdb，离线行为与 Day 12 一致）；记录页新增「云端读取」面板，把接口地址、读到的条数与读取时间显示出来（验收要求「页面上显示的真实数据」）。② 函数补 **CORS 预检**（`OPTIONS → 204` + `allow-headers: Authorization`）—— 静态托管与网关是不同域名，而通道 A 必须带 `Authorization` 头，**带自定义头的跨域请求一定先发预检**，不处理就根本发不出真正的请求。③ ⚠️ **修一处越权读取**（迁移 `20261004230153`）：`20261004221126` 的 demo 读策略对 `authenticated` 也生效，导致已登录用户能读到全部 demo 行（实测库里 0 行的用户读到 9 条）。收紧为「前缀匹配 **且** `auth.uid()` 为空或等于 `'anon'`」，复测登录用户 `demo_leaked=0`、demo 通道仍正常。详见 §二「身份的两条通道」 |
| v1.5 | 2026-10-04 | **两个 GET 读接口已实现并上线**：`GET /api/records`（2.1）与 `GET /api/favorites`（3.1），实现在 `cloudfunctions/api/`（事件型函数，与 health 同族），经网关路由暴露。同时新增「身份的两条通道」一节（见 §二末）——**RLS 自己就能按 uid 隔离，函数不手工拼 uid**；并新增示例数据读通道（`?uid=demo-yijing64-user-*`，由迁移 `20261004221126` 的 RLS 策略在数据库层兜底）。实测：两个接口返回真实数据；错误分支 401 / 403 / 404 / 405 / 422 全部按契约返回；`limit` / `before` 两个查询参数生效；改一行库数据后接口返回随之改变 |
| v1.4 | 2026-10-04 | `db/schema.full.sql` **归并为 `db/schema.sql`**（唯一权威建表脚本），Day 12 的 4 表草稿改名为 `db/schema.day12-draft.sql` 留档 —— 因为验收清单第 4 条指向的是 `db/schema.sql`，而它当时是旧草稿。本节四处指引性引用已同步；变更记录里的历史引用保留 |
| v1.3 | 2026-10-04 | 按课程验收清单检测后修订：示例数据由 15 行扩到 **36 行**（五个示例用户 a~e，**每张表 ≥ 5 行** —— 原先 `study_progress` 与 `gilded` 只有 2 行、`favorites` 3 行，不满足验收要求）；并新增**契约一致性三方比对**（本节 §三.2 ↔ `db/schema.full.sql` ↔ 线上实测，**79 项全一致、0 项不一致**） |
| v1.2 | 2026-10-02 | 第三节的执行步骤补注：本节描述的结构与示例数据**已于 2026-10-02 落库**（迁移 `20261002234609_add_check_constraints_and_index` + `db/seed.sql` 的 15 行示例），并更正约束总数 —— 真库实测为 5 条主键 + **6 条** CHECK（此前误写为 5） |
| v1.1 | 2026-10-02 | 第三节由「5 行概览」升级为**字段级数据模型**（列 / 类型 / 约束 / 默认值 / 说明），并补：无外键的理由、行级权限一览、索引、建表执行步骤。配套脚本 `db/schema.full.sql` 与 `db/seed.sql`（二者幂等、不含 drop table）。核对方式：只读查询线上库的 `information_schema` / `pg_constraint` / `pg_policies` / `pg_class`，23 列、14 条策略逐项比对一致 |
