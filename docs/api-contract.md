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

---

## 三、数据模型（第 3 周要建的表）

| 表 | 主键 | 关键列 | 说明 |
| --- | --- | --- | --- |
| `divination_records` | `(uid, date)` | `hexagram_id smallint`、`changing_lines smallint[]` | 每日第一卦存档。**主键强制「一天一条」**，不靠应用层查重 |
| `favorites` | `(uid, hexagram_id)` | `created_at timestamptz` | 收藏。主键保证同一卦不会重复收藏 |
| `study_progress` | `uid` | `answered_total`、`correct_total`、`wrong_ids smallint[]`、`updated_at` | 累计进度，**一人一行**，是唯一允许 UPDATE 的表 |
| `study_rounds` | `id bigserial` | `uid`、`score`、`total`、`created_at` | 每轮成绩流水，**只增不改** |
| `gilded` | `uid` | `hexagram_ids smallint[]`、`updated_at` | 镀金成就（一人一行，取并集） |

> 以上 5 张表在 Day 12 已经建好（`db/migrations/`），**第 3 周沿用，不重建**。
> 卦象主数据（64 卦 + 384 爻辞）是**只读素材**，来自仓库 `data/*.json`，**不入库**。

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

#### 2.1 `GET /api/records` — 记录列表（记录页 / 每日首卦银边）

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

#### 3.1 `GET /api/favorites` — 收藏列表（记录页 / 收藏钉状态）

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

#### 3.2 `POST /api/favorites` — 添加收藏

| | |
| --- | --- |
| **请求参数** | body：`{ "hexagramId": 12 }` |
| **响应 201**（新建）/ **200**（已收藏） | `{ "ok": true, "data": { "hexagramId": 12, "createdAt": "2026-10-02" } }` |
| **错误** | `401`、`422`（`hexagramId` 不在 1–64） |

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
| v1 | 2026-10-02 | 首版：登记全部接口占位（第 3 周依据）。共 16 个接口，`GET /api/health` 已实现并验证，其余 15 个待实现 |
