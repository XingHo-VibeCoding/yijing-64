/**
 * 身份层（Day 19）—— 「本地 UID」在这里落地
 *
 * ## 要解决的问题
 * Day 18 排查「用户二次打开网页记录概率性清零」，根因是：
 *   匿名 uid 由 CloudBase SDK 维护，写在它自己的 `credentials_*` 里；
 *   与本项目的 `yijing.*` 是**两套独立存储**。任何一侧失效（无痕模式 /
 *   清站点数据 / 隐私策略拦截 / 换浏览器），云端按 uid 隔离就查不到旧行，
 *   页面看着像「记录被清零」。
 *
 * ## 设计：本地 UID 是**身份锚点**，不是请求凭证
 *
 * ⚠️ 这条边界必须说清，否则以后有人照着改代码会踩到数据库：
 *   数据库的行级权限（RLS 策略 `uid = current_uid()`）认的是 **JWT 里的 uid**，
 *   也就是平台匿名会话签发的那一串。它由平台签名，**客户端伪造不了**。
 *   所以「把本地存的 uid 直接塞进请求头/查询参数」这条路是**走不通的** ——
 *   会被 RLS 当成越权拒掉（表现为读到 0 条或 401）。
 *
 *   因此本地 UID 的作用是**对账**：
 *     · 每次成功拿到云端 uid，就把它记下来（`yijing.uid.v1`）
 *     · 下次打开时先比一次：对得上 = 一切正常，静默进首页
 *     · 对不上 = 会话换了人 → 这时才去问用户「要不要把本机进度恢复到新身份」
 *   这样既保住了 RLS 这道闸门，也把「静默断链」变成「可解释、可选择」。
 *
 * ## 状态机（`identityState()` 返回的就是它）
 *
 *   读取本地 UID ─┬─ 无 ──→ 生成本地 UID 并存下 → 云端就绪后比对
 *                 └─ 有 ──→ 云端就绪后比对
 *                                        │
 *              ┌─────────────────────────┼─────────────────────────┐
 *              │                         │                         │
 *        两边一致                  本地无数据              本地有数据且不一致
 *            │                         │                         │
 *         fresh                    fresh                    recoverable
 *      （直接进首页）          （新用户，直接进）        （弹轻提示问用户）
 *
 * ⭐ 为什么 recoverable 时**绝不自动合并**：
 *   合并 = 把「本机的数据」写进「当前的新身份」。如果 uid 其实没变、只是云端
 *   写入失败过一次，自动合并就会把同一份数据重复上传。
 *   判据已经过实测（见 storage.js 的 judgeOrphan），宁可多问一次，也不要
 *   悄悄让用户的记录翻倍。
 *
 * ## 边界（沿用项目既有约束，不是新加的）
 *   · 不采集手机号 / 邮箱 / IP / 设备指纹，不做埋点
 *   · 本地 UID 是**本机随机生成**的，不是身份信息，只用于行级隔离与对账
 *   · 用户点「暂不处理」后本机不再反复提示（`yijing.uid.declined.v1`）
 */

const K_UID = 'yijing.uid.v1'        // 本地锚点：{ uid, createdAt }
const K_DECLINED = 'yijing.uid.declined.v1' // 用户点过「暂不处理」的 uid

/* localStorage 在隐私模式 / 存储禁用时会抛 —— 一律静默降级，绝不阻断进应用 */
function readRaw(key) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function writeRaw(key, val) {
  try {
    window.localStorage.setItem(key, JSON.stringify(val))
    return true
  } catch {
    return false
  }
}

/**
 * 生成一个本地 UID。
 * 格式 `yj-` + 13 位时间（base36） + 10 位随机（base36）——
 * 只是为了「两台机器几乎不可能撞上」并方便肉眼分辨，不承担安全职责。
 */
function genUid() {
  const t = Date.now().toString(36)
  let r = ''
  const bytes = new Uint8Array(10)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < 10; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  for (const b of bytes) r += (b % 36).toString(36)
  return `yj-${t}${r}`
}

/** @returns {{uid:string, createdAt:string}|null} 本地锚点 */
export function readLocalUid() {
  const v = readRaw(K_UID)
  if (!v || typeof v.uid !== 'string' || !v.uid) return null
  return { uid: v.uid, createdAt: v.createdAt || '' }
}

/**
 * 取本地 UID；没有就生成一个**并存下**（对应流程图「生成新 UID 并存本地」）。
 * @returns {{uid:string, createdAt:string, isNew:boolean}}
 */
export function ensureLocalUid() {
  const cur = readLocalUid()
  if (cur) return { ...cur, isNew: false }
  const rec = { uid: genUid(), createdAt: new Date().toISOString().slice(0, 10) }
  writeRaw(K_UID, rec)
  return { ...rec, isNew: true }
}

/** 云端 uid 拿到后写回锚点 —— 「下次打开时好对账」的那一步 */
export function rememberCloudUid(uid) {
  if (!uid) return
  const cur = readLocalUid()
  // 同一个 uid 就不重写（避免每次启动都动一次存储）
  if (cur && cur.uid === uid) return
  writeRaw(K_UID, { uid, createdAt: cur ? cur.createdAt : new Date().toISOString().slice(0, 10) })
}

export function isDeclined(uid) {
  const d = readRaw(K_DECLINED)
  return !!(d && d.uid && d.uid === uid)
}
export function markDeclined(uid) {
  writeRaw(K_DECLINED, { uid, at: new Date().toISOString() })
}
/** 恢复成功后调用：清掉「暂不处理」，让下次真断链时还能再问 */
export function clearDeclined() {
  try {
    window.localStorage.removeItem(K_DECLINED)
  } catch {
    /* 静默 */
  }
}

/**
 * 身份状态（组件里只读这个，别自己去读 localStorage）。
 *
 * ⚠️ 「可恢复」的判据是**两个数**，不猜：
 *   本地有数据（记录/收藏/测验任一非零）**且** 本次云端读取确实成功但读到 0 条
 *   **且** 两边 uid 对不上。
 *   云端拉取失败时**一律判 fresh** —— 那时云端条数是未知不是 0，
 *   误报「可恢复」会教用户不信任这个提示（Day 18 已踩过）。
 *
 * @param {{cloudUid:string|null, localCounts:{records:number,favorites:number,rounds:number}, cloudReadOk:boolean, cloudRecordCount:number}} input
 * @returns {{status:'fresh'|'recoverable'|'checking', localUid:string, cloudUid:string|null, localTotal:number, cloudTotal:number}}
 */
export function identityState({ cloudUid = null, localCounts = {}, cloudReadOk = false, cloudRecordCount = 0 } = {}) {
  const localUid = ensureLocalUid()
  const localTotal =
    (localCounts.records || 0) + (localCounts.favorites || 0) + (localCounts.rounds || 0)

  if (!cloudUid || !cloudReadOk) {
    return { status: 'checking', localUid: localUid.uid, cloudUid: null, localTotal, cloudTotal: 0 }
  }
  if (localUid.uid === cloudUid) {
    return { status: 'fresh', localUid: localUid.uid, cloudUid, localTotal, cloudTotal: cloudRecordCount }
  }
  // uid 变了：只有「本机确实有东西可恢复」才提示
  if (localTotal > 0 && cloudRecordCount === 0 && !isDeclined(cloudUid)) {
    return { status: 'recoverable', localUid: localUid.uid, cloudUid, localTotal, cloudTotal: 0 }
  }
  // uid 变了但本机没数据（或云端本来就有数据）→ 认新身份，把锚点换成它
  rememberCloudUid(cloudUid)
  return { status: 'fresh', localUid: cloudUid, cloudUid, localTotal, cloudTotal: cloudRecordCount }
}

/** 调试出口：`?resetUid=1` 打开时清掉锚点（演练「换设备 / 清站点数据」） */
if (typeof window !== 'undefined') {
  try {
    if (new URLSearchParams(window.location.search).has('resetUid')) {
      window.localStorage.removeItem(K_UID)
      window.localStorage.removeItem(K_DECLINED)
    }
    window.__identity = () => ({
      local: readLocalUid(),
      declined: readRaw(K_DECLINED),
    })
  } catch {
    /* 忽略 */
  }
}
