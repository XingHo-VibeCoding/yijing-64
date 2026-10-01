import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildGateLayer, buildLandscapeLayer } from './inkBrush.js'
import {
  primeCeremonyAudio,
  isMuted,
  toggleMuted,
  sfxMotto,
  sfxDoor,
  sfxReward,
  sfxExit,
  windOn,
  windOff,
} from './ceremonyAudio.js'
import landscapeUrl from './assets/ceremony-landscape.jpg'

/**
 * 测验终局仪式（Day 12 · 用户分镜；2026-10-01 美术返工；同日「门庭改水墨画 + 音效」）
 *
 * fail（未达容错）：淡墨云海遮屏、持续翻涌 → 白色毛笔行书「運隨時變，切勿焦躁」
 *                   → 点击 → 云散 → 回总表
 * pass（达成）    ：白云遮屏 → 砂金毛笔行书「靜神定心，自有所得」
 *                   → 点击 → 云散 → 水墨门庭 → 秒余后**运镜进门**（穿过门洞）
 *                   → 云雾中的水墨楼阁推近 → 浮现镀金卦象 → 点击 → 白云遮屏 → 散开回总表
 *
 * 美术要求（用户指定）：飘渺神秘优先 —— 云雾第一目的是「雾」不是「黑」；
 * 黑云去纯黑改雾灰调；题字本身随烟雾流动；题字用**繁体**
 * （这是用户对仪式两句话的明确要求，项目其余界面文案仍为简体，见 AGENTS.md R5）。
 *
 * 2026-10-01 二次返工（用户：**「门和楼阁做好看一些，不要简笔矢量图形拼接，要水墨画」**）
 *   ① 远景楼阁：原 `pagoda()` 用矩形+三角形拼三层塔 → 换成生成的水墨山水画（`assets/ceremony-landscape.jpg`），
 *      预渲染时做四边羽化，门前低透明度当「雾中楼阁」，进门后推近聚焦主楼。
 *   ② 门：原 `brush()+fillRect()` 拼立柱/楣梁/檐 → 换成 `inkBrush.js` 的「一笔墨」重画
 *      （弧长重采样 + 笔宽包络 + 边缘抖动 + 飞白 + 洇边），仍是两柱一梁一飞檐，
 *      但每一处都是笔画，且全部**离屏预渲染一次**，主循环只做 drawImage + 变换。
 *   ③ 音效（用户：**「还有加音效」**）：`ceremonyAudio.js` 程序化合成，零音频资源 ——
 *      题字一声古琴（fail 低音 / pass 高音）、进门风起＋上行泛音、镀金卦象一记清铃、收尾钟声。
 *      右上角有静音开关（不点击也出声的场景，必须留一个出口）。
 *
 * 工程约定同族：portal 到 body、rAF 相位状态机、相位探针 data-qc-phase、?qcHold= 定格、?qcStart= 直达相位。
 */

/* 山水图：模块加载即开始拉取 —— 仪式前有整轮测验的时间，通常早就到位 */
const landscapeImg = typeof window !== 'undefined' ? new Image() : null
if (landscapeImg) landscapeImg.src = landscapeUrl

const T_COVER = 900 // 云雾遮满
const T_DISPERSE_PASS = 1400 // 白云散开 → 露门庭
const T_DISPERSE_FAIL = 2800 // 淡墨散开 → 露主页：延长 + 整体淡出 = 迷途知返的朦胧
const GATE_CHURN = 1800 // 门前静置（「一秒后」运镜）
const T_ENTER = 1900 // 进门运镜（穿过门洞）
const T_EXIT_COVER = 760 // 收尾白云遮满
const T_EXIT_FADE = 2300 // 收尾散开（同样放慢，别硬切）

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

const MOTTO = { fail: '運隨時變，切勿焦躁', pass: '靜神定心，自有所得' }

/* 题字节奏（用户 2026-10-01 定稿：**竖排两列、右列先**、要有「落下感」、落齐后要停够）
 *
 *   · 排版：逗号前后分成**左右两列**，右列先 —— 传统诏书 / 中式书写本来就是右起
 *     （DOM 顺序 = 书写顺序＝第一句在前，摆成「右列在前」交给 CSS 的 `row-reverse`）
 *   · 节奏：列内**自上而下**逐字落下；右列落齐、停一拍（COL_GAP），左列才起笔
 *   · 每字只落一次（CSS 侧 iteration-count: 1 + fill both），**落定即静止**
 *     —— 不要呼吸、不要浮动，会晃的字是「飘」，不是庄重
 *
 *  返回 { cols, finish }：cols 是两列的逐字时间表，finish 是整句落齐的时刻。
 *  finish 用来把「点击继续」提示压到落齐之后 —— 提示提前冒出来会把手带走，字就白落了
 *  （用户反馈的「停留时间太短」，根子在这里）。 */
const CH_STEP = 0.19 // 同一列内逐字间隔
const CH_DUR = 1.5 // 单字落下用时（要够长才看得见「落」）
const COL_GAP = 0.55 // 右列落齐 → 左列起笔之间的停顿
const HOLD_AFTER = 1.7 // 整句落齐后的静默
function mottoColumns(text) {
  const parts = text.split('，').filter(Boolean)
  let cursor = 0
  const cols = parts.map((s, ci) => {
    if (ci > 0) cursor += COL_GAP
    return [...s].map((ch) => {
      const item = { ch, delay: cursor }
      cursor += CH_STEP
      return item
    })
  })
  return { cols, finish: cursor - CH_STEP + CH_DUR }
}

/* 水墨调色：刻意避纯黑 —— 飘渺神秘优先，黑云也带灰调 */
const C = {
  paper: '246, 244, 240',
  mist1: '228, 225, 219',
  mist2: '198, 194, 186',
  mist3: '152, 147, 139',
  inkSoft: '84, 79, 71',
  ink1: '52, 48, 43',
  ink2: '34, 31, 28',
  red: '150, 62, 48',
  night1: '80, 77, 72', // 墨气底：中灰而非纯黑（要仙境水墨，不要阴森）
  night2: '176, 171, 162', // 云中亮雾（提仙气）
  night3: '54, 51, 47', // 暗墨（拉浓淡层次，别让雾面发平）
}

/* 调试定格（与另两个转场的 ?transFreeze 同族，生产不带参数即自动推进） */
const QC_HOLD = (() => {
  try {
    return (new URLSearchParams(window.location.search).get('qcHold') || '').split(',').filter(Boolean)
  } catch {
    return []
  }
})()
const held = (name) => QC_HOLD.includes(name)

/* 调试起始相位（?qcStart=gate|door|reward）—— 免跑整轮测验即可核对美术；生产不带即正常流程 */
const QC_START = (() => {
  try {
    return new URLSearchParams(window.location.search).get('qcStart') || ''
  } catch {
    return ''
  }
})()

/* 雾团：极坐标铺开，绕屏心缓慢旋涌（确定性：只在挂载时生成一次） */
function makeMist(n) {
  const a = []
  for (let i = 0; i < n; i++) {
    a.push({
      ang: Math.random() * Math.PI * 2,
      al: 0.2 + Math.random() * 0.44,
      d: 0.08 + Math.random() * 0.6,
      r: 88 + Math.random() * 168,
      sp: 0.14 + Math.random() * 0.32,
      ph: Math.random() * Math.PI * 2,
      tone: Math.random(),
    })
  }
  return a
}

export default function QuizCeremony({ variant = 'fail', reward = null, onCovered, onHome }) {
  const rootRef = useRef(null)
  const inkRef = useRef(null)
  const fgRef = useRef(null)
  const [phase, setPhase] = useState(QC_START || 'cover')
  const [muteState, setMuteState] = useState(() => isMuted())
  const st = useRef({ phase: QC_START || 'cover', pt: 0, covered: !!QC_START, raf: 0 })
  const cb = useRef({})
  cb.current = { onCovered, onHome }

  useEffect(() => {
    const cv = inkRef.current
    const fg = fgRef.current
    const ctx = cv.getContext('2d')
    const fctx = fg.getContext('2d')
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = 0
    let H = 0
    let S = 1

    const fit = () => {
      W = window.innerWidth
      H = window.innerHeight
      S = Math.min(W, H) / 1080
      for (const [c, cx2] of [
        [cv, ctx],
        [fg, fctx],
      ]) {
        c.width = Math.round(W * dpr)
        c.height = Math.round(H * dpr)
        c.style.width = W + 'px'
        c.style.height = H + 'px'
        cx2.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
    fit()
    window.addEventListener('resize', fit)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const isPass = variant === 'pass'
    // 音效：环境风声整场都在（先做一个「远」），各相位的乐器声见下面的 phase effect
    primeCeremonyAudio()
    windOn(isPass ? 0.062 : 0.05, 3.6)
    const mist = makeMist(72)
    const start = performance.now()
    st.current.pt = start
    let raf = 0

    /* 相位推进：canvas 走 st.current.phase，DOM 走 phase state */
    const go = (next) => {
      st.current.phase = next
      st.current.pt = performance.now()
      setPhase(next)
    }

    /* 软圆雾 */
    const soft = (x, y, r, rgb, a) => {
      if (a <= 0.008 || r <= 0) return
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(${rgb}, ${a})`)
      g.addColorStop(0.45, `rgba(${rgb}, ${a * 0.5})`)
      g.addColorStop(0.76, `rgba(${rgb}, ${a * 0.18})`)
      g.addColorStop(1, `rgba(${rgb}, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    /* 软椭圆（雾带 / 流丝） */
    const softEll = (x, y, rx, ry, rgb, a) => {
      if (a <= 0.008 || rx <= 0 || ry <= 0) return
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(1, ry / rx)
      soft(0, 0, rx, rgb, a)
      ctx.restore()
    }
    /* 两张大图都是**离屏预渲染**的位图，逐帧只做 drawImage + 变换。
       门是静态的，没必要每帧重算上千个墨点；山水图带羽化 alpha，也必须预烘。 */
    let gateCv = null // 水墨门（1.6 倍分辨率烘一次，进门放大到 2.75 倍仍不糊）
    let landCv = null // 水墨山水（已 cover 铺满 + 四边羽化）
    let landKey = '' // 山水图的尺寸缓存键
    const ensureGate = () => {
      if (!gateCv) gateCv = buildGateLayer(W, H, S)
      return gateCv
    }
    const ensureLand = () => {
      const img = landscapeImg
      if (!img || !img.complete || !img.naturalWidth) return null
      const key = W + 'x' + H
      if (landCv && landKey === key) return landCv
      landCv = buildLandscapeLayer(img, W, H)
      landKey = key
      return landCv
    }

    /* ---------- 云海（cover / motto / exit）：持续旋涌 + 流丝 ---------- */
    const drawCloudSea = (t, k, drift, isWhite) => {
      if (k <= 0.01) return
      for (const p of mist) {
        const ang = p.ang + t * 0.00026 * p.sp
        const d = (p.d + 0.14 * Math.sin(t * 0.00055 * p.sp + p.ph)) * Math.max(W, H)
        const x = W / 2 + Math.cos(ang) * d + Math.sin(t * 0.001 + p.ph) * 46 * S
        const y = H / 2 + Math.sin(ang) * d * 0.68 + Math.cos(t * 0.0008 + p.ph) * 30 * S - drift
        const r = p.r * S * (1 + 0.18 * Math.sin(t * 0.0012 * p.sp + p.ph))
        const a = p.al * k * (0.68 + 0.32 * Math.sin(t * 0.0014 * p.sp + p.ph))
        if (isWhite) soft(x, y, r, p.tone > 0.42 ? C.paper : C.mist1, Math.min(0.9, a))
        else soft(x, y, r, p.tone > 0.45 ? C.night2 : C.night3, Math.min(0.9, a))
      }
      // 流丝：横向掠过的细长雾带 —— 让「烟」真的在流
      for (let i = 0; i < 16; i++) {
        const ph = i * 1.7
        const y = (((i * 137) % 100) / 100) * H * 1.05 - H * 0.02 + Math.sin(t * 0.0006 + ph) * 26 * S
        const x = (((t * (0.026 + (i % 5) * 0.01) + i * 233) % (W + 760)) - 380)
        const a = (0.05 + 0.05 * Math.sin(t * 0.0011 + ph)) * k
        if (a <= 0.008) continue
        softEll(x, y, (230 + (i % 4) * 120) * S, (16 + (i % 3) * 9) * S, isWhite ? C.paper : C.night2, Math.max(0, a))
      }
    }

    /* ---------- 门庭场景：水墨山水为远景，水墨门为前景。enterK: 0 站在门前 → 1 已进门 ---------- */
    const drawScene = (t, enterK) => {
      const ek = clamp01(enterK)
      const cam = easeInOut(ek)
      const k = 1 + 1.75 * cam // 运镜推近
      const near = 1 - clamp01((ek - 0.32) / 0.68) // 穿过门后：门框完全淡出

      // 底：雾白宣纸
      ctx.fillStyle = `rgb(${C.paper})`
      ctx.fillRect(0, 0, W, H)

      const cx = W / 2
      const cy = H * 0.58
      const doorW = Math.min(W * 0.3, 380 * S)
      const doorH = Math.min(H * 0.46, 470 * S)
      const anchorY = cy + doorH * 0.17 // = (oyTop + oyBot) / 2，运镜绕它缩放

      /* ---- 远景：水墨山水画。门前是雾中若隐的楼阁，进门时推近聚焦主楼 ----
         用 **multiply** 而不是普通叠加：画的白底乘上去等于没乘（不压暗页面），
         只有墨色压深 —— 于是它真的「画在宣纸上」，而不是贴了一张比纸暗的方块。
         normal 模式下那片米白底会把整屏压灰，这也是上一版山水看不见的原因之一。 */
      const land = ensureLand()
      if (land) {
        // 焦点从画面正中平移到主楼所在的（0.53, 0.24）—— 起止都平滑，不会有跳变
        const sx = 0.5 + 0.03 * cam
        const sy = 0.5 - 0.26 * cam
        const Z = 1 + 0.85 * cam
        const dw = W * Z
        const dh = H * Z
        const tx = W / 2
        const ty = H * (0.5 - 0.06 * cam)
        ctx.save()
        ctx.globalCompositeOperation = 'multiply'
        ctx.globalAlpha = 0.68 + 0.32 * cam // 门前淡（在雾里）→ 进门后满
        ctx.drawImage(land, tx - sx * dw, ty - sy * dh, dw, dh)
        ctx.restore()
      }

      // 上下压角墨晕：把视线收进画面中间（薄薄一层就够，厚了会把山水洗白）
      soft(W * 0.5, H * 0.06, W * 0.82, C.mist1, 0.26)
      soft(W * 0.5, H * 0.99, W * 0.86, C.mist2, 0.2)

      /* ---- 中景雾带：横着掠过山水 → 楼阁是「在雾里」，不是贴上去的一张画 ----
         刻意避开楼阁所在的上三分之一，只在云海那一段铺，否则等于把画糊掉 */
      const mistK = 1 - 0.32 * cam
      for (let i = 0; i < 6; i++) {
        const y = H * (0.32 + i * 0.13) + Math.sin(t * 0.0004 + i * 1.3) * 14 * S
        const x = W * (0.5 + 0.4 * Math.sin(i * 2.1 + t * 0.00023))
        softEll(x, y, W * (0.5 + 0.22 * ((i * 7) % 3)), H * (0.03 + (i % 3) * 0.013), C.mist1, 0.32 * mistK)
      }
      // 楼阁那一带只留一丝薄雾（要「若隐」不要「隐没」）
      softEll(W * 0.52, H * 0.21, W * 0.48, H * 0.07, C.mist1, 0.22 * mistK)

      /* ---- 门：预渲染位图 + 运镜（绕 anchorY 放大，穿过去时淡出）---- */
      if (near > 0.012) {
        const g = ensureGate()
        ctx.save()
        ctx.globalAlpha = near
        ctx.translate(cx, anchorY)
        ctx.scale(k, k)
        ctx.translate(-cx, -anchorY)
        // 门洞里的雾光：门内是「虚」的，门才立得住
        softEll(cx, anchorY + doorH * 0.1, doorW * (0.78 + 0.7 * ek), doorH * (0.62 + 0.45 * ek), C.paper, 0.9)
        ctx.drawImage(g, 0, 0, W, H)
        ctx.restore()
      }

      // 门前后的飘雾（白 + 淡墨），让画面「飘渺」
      for (let i = 0; i < 24; i++) {
        const ph = i * 2.3
        const drift = t * (0.032 + (i % 4) * 0.013)
        const x = ((drift + i * 271) % (W + 900)) - 450
        const y = H * (0.32 + 0.6 * ((i % 7) / 7)) + Math.sin(t * 0.0007 + ph) * 36 * S
        const white = i % 3 !== 0
        const a = (white ? 0.24 : 0.13) * (0.68 + 0.32 * Math.sin(t * 0.001 + ph)) * (1 - 0.22 * cam)
        softEll(x, y, (170 + (i % 5) * 92) * S, (32 + (i % 4) * 15) * S, white ? C.paper : C.mist3, Math.max(0, a))
      }

      /* ---- 穿门那一瞬：白雾起、过半后退去（不落成一片死白），露出门后的山水 ---- */
      if (ek > 0.34) {
        const q = clamp01((ek - 0.34) / 0.66)
        const wash = 0.7 * Math.sin(Math.PI * Math.pow(q, 0.7))
        if (wash > 0.01) {
          ctx.fillStyle = `rgba(${C.paper}, ${wash})`
          ctx.fillRect(0, 0, W, H)
        }
      }

      /* ---- 镀金卦象背后：白色云气（用户要求「不然看不清」）----
         卦象是金色、山水是浅色，两边的明度贴得很近，加上山石的细线条还跟笔画绞在一起，
         所以「看不清」。这里垫一层**白色翻涌的云气** —— 作用是「衬」不是「遮」：
         先把背后那片杂纹理虚掉，金色才有干净的底可依（浓度上限压在 0.6 左右，别糊成一片白）。 */
      const rk = clamp01((ek - 0.7) / 0.3) // 进门快完成时才起，别抢了进门那一下
      if (rk > 0.01) {
        const mc = W / 2
        const mr = H * 0.48
        const unit = Math.min(W, H)
        // 云团要**围着卦象聚**、别铺满：铺满等于给整幅画加了一层白滤镜，
        // 山水会发灰发白，而云团自己也看不出形状（试过，全屏那版就是这个问题）。
        // 现在的量：覆盖中央约 76% 宽 / 77% 高，四角留出山水。
        for (let i = 0; i < 14; i++) {
          const ph = i * 1.53
          const ang = ph + t * 0.00026 * (0.6 + (i % 5) * 0.2) // 绕中心旋涌
          const dist = (0.06 + (0.14 * ((i * 7) % 10)) / 10) * unit
          const x = mc + Math.cos(ang) * dist * 1.8 + Math.sin(t * 0.0017 + ph) * 48 * S
          const y = mr + Math.sin(ang) * dist * 0.75 + Math.cos(t * 0.0019 + ph) * 32 * S
          // 半径与浓度都带**大幅**脉动 —— 「翻涌」全靠这个；幅度一小就成了一片静止的白斑
          const r = (130 + (i % 4) * 62) * S * (1 + 0.28 * Math.sin(t * 0.0022 * (0.7 + (i % 3) * 0.25) + ph))
          const a = (0.3 + 0.24 * Math.sin(t * 0.0025 + ph)) * rk
          if (a <= 0.01) continue
          soft(x, y, r, i % 5 === 0 ? C.mist1 : C.paper, Math.min(0.56, a))
        }
        // 几道横向流丝掠过卦象 —— 「流」的感觉靠这个，纯圆团堆在一起只会像斑点
        for (let i = 0; i < 6; i++) {
          const ph = i * 2.1
          const y = mr + (i - 2.5) * 44 * S + Math.cos(t * 0.0016 + ph) * 22 * S
          const x = mc + Math.sin(t * 0.0013 + ph) * 95 * S
          softEll(x, y, (300 + (i % 3) * 90) * S, (34 + (i % 3) * 12) * S, C.paper, (0.24 + 0.14 * Math.sin(t * 0.0019 + ph)) * rk)
        }
        // 正中垫一团（卦象正下方才是「看不清」最重的地方）：浓度也一起脉动，别做成一块静止的白
        soft(mc, mr, unit * 0.3 * (1 + 0.08 * Math.sin(t * 0.0015)), C.paper, (0.3 + 0.11 * Math.sin(t * 0.0014)) * rk)
      }
    }

    const frame = (now) => {
      const t = now - start
      const pt = now - st.current.pt
      const p = st.current.phase
      ctx.clearRect(0, 0, W, H)
      fctx.clearRect(0, 0, W, H)
      let rootAlpha = 1 // 整层透明度：散开的后段淡出 → 露主界面不硬切

      if (p === 'cover' || p === 'motto') {
        // 未达容错 = 水墨墨气（中灰，不阴森）；达成 = 白云翻涌
        ctx.fillStyle = isPass ? `rgb(${C.paper})` : `rgb(${C.night1})`
        ctx.fillRect(0, 0, W, H)
        drawCloudSea(t, 1, 0, isPass)
        if (p === 'cover' && pt >= T_COVER && !st.current.covered) {
          st.current.covered = true
          go('motto')
        }
      } else if (p === 'disperse') {
        if (isPass) {
          const q1 = clamp01(pt / T_DISPERSE_PASS)
          drawScene(t, 0)
          drawCloudSea(t, 1 - easeInOut(q1), easeOut(q1) * H * 0.25, true)
          if (pt >= T_DISPERSE_PASS) go('gate')
        } else {
          // 未达容错：云气悠悠散开 —— 底墨渐薄、云团上飘、后段整层淡出（朦胧，不硬切）
          const q1 = clamp01(pt / T_DISPERSE_FAIL)
          ctx.fillStyle = `rgba(${C.night1}, ${1 - 0.62 * easeInOut(q1)})`
          ctx.fillRect(0, 0, W, H)
          drawCloudSea(t, (1 - easeInOut(clamp01((q1 - 0.12) / 0.88))) * 1.15, easeOut(q1) * H * 0.22, false)
          rootAlpha = 1 - easeInOut(clamp01((q1 - 0.4) / 0.6))
          if (pt >= T_DISPERSE_FAIL) {
            cb.current.onHome && cb.current.onHome()
            return
          }
        }
      } else if (p === 'gate') {
        drawScene(t, 0)
        if (pt >= GATE_CHURN && !held('gate')) go('door')
      } else if (p === 'door') {
        // 进门：运镜穿过门洞（不是开门 —— 本就没有门板）
        const k = easeInOut(clamp01(pt / T_ENTER))
        drawScene(t, k)
        if (pt >= T_ENTER && !held('door')) go('reward')
      } else if (p === 'reward') {
        drawScene(t, 1)
      } else if (p === 'exit') {
        // 收尾：白云先遮满，再悠悠散开 + 整层淡出（同样不硬切）
        const coverK = easeOut(clamp01(pt / T_EXIT_COVER))
        const q1 = clamp01((pt - T_EXIT_COVER) / T_EXIT_FADE)
        const paperA = coverK * (1 - 0.55 * easeInOut(q1))
        ctx.fillStyle = `rgba(${C.paper}, ${paperA})`
        ctx.fillRect(0, 0, W, H)
        drawScene(t, 1)
        drawCloudSea(t, Math.max(coverK, 1 - easeInOut(q1)), 0, true)
        rootAlpha = 1 - easeInOut(clamp01((q1 - 0.35) / 0.65))
        if (pt >= T_EXIT_COVER + T_EXIT_FADE) {
          cb.current.onHome && cb.current.onHome()
          return
        }
      }

      // 前景薄雾（画在题字之上，让字像浮在烟里、并与烟一起流动）
      if (p === 'motto' || p === 'gate' || p === 'door') {
        const dark = !isPass && (p === 'motto')
        for (let i = 0; i < 7; i++) {
          const ph = i * 2.1
          const x = (((t * (0.016 + (i % 3) * 0.006) + i * 331) % (W + 900)) - 450)
          const y = H * (0.18 + 0.64 * ((i % 5) / 5)) + Math.sin(t * 0.0005 + ph) * 22 * S
          const a = 0.05 + 0.04 * Math.sin(t * 0.0009 + ph)
          if (a <= 0.008) continue
          const g = fctx.createRadialGradient(x, y, 0, x, y, (210 + (i % 4) * 130) * S)
          const col = dark ? '235, 233, 228' : '255, 255, 255'
          g.addColorStop(0, `rgba(${col}, ${Math.max(0, a)})`)
          g.addColorStop(0.6, `rgba(${col}, ${Math.max(0, a) * 0.4})`)
          g.addColorStop(1, `rgba(${col}, 0)`)
          fctx.save()
          fctx.translate(x, y)
          fctx.scale(1, 0.22)
          fctx.fillStyle = g
          fctx.beginPath()
          fctx.arc(0, 0, (210 + (i % 4) * 130) * S, 0, Math.PI * 2)
          fctx.fill()
          fctx.restore()
        }
      }

      if (rootRef.current) rootRef.current.style.opacity = String(clamp01(rootAlpha))
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
      document.body.style.overflow = prevOverflow
      windOff(0.7) // 离场务必收风，否则噪声会一直跟着页面
    }
  }, [])

  /* 声音事件：按相位各触发一次。挂在 effect 而不是点击回调里 ——
     ?qcStart=gate 这类调试直达也能出声，且相位回退/重渲染不会重复触发。 */
  const sounded = useRef({})
  useEffect(() => {
    if (sounded.current[phase]) return
    sounded.current[phase] = true
    if (phase === 'motto') sfxMotto(variant === 'pass')
    else if (phase === 'door') sfxDoor()
    else if (phase === 'reward') sfxReward()
    else if (phase === 'exit') sfxExit()
  }, [phase, variant])

  /* 点击推进：motto（云散）与 reward（白云收尾）；调试定格时 gate/door 也可点击推进 */
  const handleClick = () => {
    const p = st.current.phase
    if (p === 'motto') {
      if (variant !== 'pass') cb.current.onCovered && cb.current.onCovered()
      st.current.pt = performance.now()
      st.current.phase = 'disperse'
      setPhase('disperse')
    } else if (held(p) && (p === 'gate' || p === 'door')) {
      const next = p === 'gate' ? 'door' : 'reward'
      st.current.pt = performance.now()
      st.current.phase = next
      setPhase(next)
    } else if (p === 'reward') {
      cb.current.onCovered && cb.current.onCovered()
      st.current.pt = performance.now()
      st.current.phase = 'exit'
      setPhase('exit')
    }
  }

  const text = MOTTO[variant] || MOTTO.fail
  const motto = mottoColumns(text)
  const lightField = variant === 'pass' && phase === 'motto'

  return createPortal(
    <div
      ref={rootRef}
      className={'qc-root' + (lightField ? ' is-light' : '')}
      data-qc-phase={phase}
      onClick={handleClick}
      role="presentation"
    >
      <canvas ref={inkRef} aria-hidden="true" />

      {phase === 'motto' && (
        // 竖排两列：DOM 里第一句在前（＝书写顺序），CSS 用 row-reverse 把它摆到右边
        <div className={'qc-motto ' + (variant === 'pass' ? 'pass' : 'fail')}>
          {motto.cols.map((col, ci) => (
            <div className="qc-motto-col" key={ci}>
              {col.map(({ ch, delay }, i) => (
                <span
                  key={i}
                  className="qc-motto-ch"
                  data-ch={ch}
                  data-delay={delay.toFixed(2)}
                  style={{ animationDelay: `${delay.toFixed(2)}s`, animationDuration: `${CH_DUR}s` }}
                >
                  {ch}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {phase === 'reward' && reward && (
        <div className="qc-reward">
          <div className="qc-reward-symbol" aria-hidden="true">
            {reward.symbol}
          </div>
          <div className="qc-reward-name">{reward.name}</div>
        </div>
      )}

      {/* 前景薄雾层：压在题字之上 → 字像是烟的一部分 */}
      <canvas ref={fgRef} className="qc-fg" aria-hidden="true" />

      {/* 静音开关：仪式是会出声的，必须给用户留一个出口（点击不推进相位） */}
      <button
        className={'qc-sound' + (muteState ? ' is-off' : '')}
        type="button"
        title={muteState ? '开启音效' : '静音'}
        aria-label={muteState ? '开启音效' : '静音'}
        onClick={(e) => {
          e.stopPropagation()
          setMuteState(toggleMuted())
        }}
      >
        {muteState ? '静' : '音'}
      </button>

      {phase !== 'reward' && (phase === 'motto' || ((phase === 'gate' || phase === 'door') && held(phase))) && (
        // 题字相位：提示压到整句落齐 + 静默之后才冒出来（提前出现会诱导用户早点走，字就白落了）
        <div
          className="qc-hint"
          style={phase === 'motto' ? { animationDelay: `${(motto.finish + HOLD_AFTER).toFixed(2)}s` } : undefined}
        >
          点 击 继 续
        </div>
      )}
    </div>,
    document.body
  )
}
