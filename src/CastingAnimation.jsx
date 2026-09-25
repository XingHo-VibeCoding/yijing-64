import { useEffect, useRef, useState } from 'react'
import './casting.css'
import CastResult from './CastResult.jsx'

/* ============================================================
   起卦动画（F7）
   第一段：太极双鱼逆时针 + 三圈阴阳爻快速旋转 + 外圈虚圆 → 9 秒后同停，太极归位
            → 黑墨翻涌遮住图案 → 保持 1 秒 → 墨散去，浮现卦象
   第二段：点击后黑墨翻涌遮住卦象 → 保持 1 秒 → 散去，突出「确定的爻」，其余淡化至 10%
   ============================================================ */

const INK = '22,19,17'          // 墨色
const T = {
  cast: 9000,                   // 第一段旋转总时长
  inkIn: 800,                   // 墨涌上来
  hold: 1000,                   // 保持
  inkOut: 800,                  // 墨散去
  reveal: 900,                  // 卦象浮现
  focusIn: 700,                 // 第二段：墨遮住卦象
  focusHold: 1000,              // 第二段：保持
  focusOut: 800,                // 第二段：散去
}
const T_CAST_END = T.cast
const T_INK_END = T_CAST_END + T.inkIn
const T_HOLD_END = T_INK_END + T.hold
const T_OUT_END = T_HOLD_END + T.inkOut
const T_REVEAL_END = T_OUT_END + T.reveal

const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3)

const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/* 交叉淡入淡出用时间点 —— 一律逐帧算，不用 CSS 过渡：
   分段跳变（按 phase 切 opacity）会让「图案渐隐 / 卦象浮现」显得生硬 */
const T_HEX_IN_START = T_HOLD_END + T.inkOut * 0.5     // 墨散到一半，卦象才开始显
const T_HEX_IN_END = T_OUT_END + T.reveal * 0.55       // 略早于结果页出现，收尾更顺

/** 便于逐帧验证：URL 加 ?castSpeed=0.2 即以 1/5 速度播放 */
const SPEED = (() => {
  if (typeof window === 'undefined') return 1
  const v = parseFloat(new URLSearchParams(window.location.search).get('castSpeed'))
  return Number.isFinite(v) && v > 0 ? v : 1
})()

/** 调试用：?castFreeze=9500 把动画定格在 9.5 秒处（墨仍在流动），用于逐帧核对 */
const FREEZE = (() => {
  if (typeof window === 'undefined') return null
  const v = parseFloat(new URLSearchParams(window.location.search).get('castFreeze'))
  return Number.isFinite(v) && v >= 0 ? v : null
})()

/* ---------- 墨：点云叠出自然的墨斑（不规则边缘 + 浓淡层次） ---------- */
/** 墨点纹理（带毛边）。转场动画 `InkTransition` 也用这一份 —— 保证两处的墨是同一种墨 */
export function makeDotTexture(size = 128) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  const r = size / 2
  const rg = g.createRadialGradient(r, r, 0, r, r, r)
  rg.addColorStop(0, `rgba(${INK},1)`)
  rg.addColorStop(0.30, `rgba(${INK},0.70)`)
  rg.addColorStop(0.62, `rgba(${INK},0.24)`)
  rg.addColorStop(0.85, `rgba(${INK},0.05)`)
  rg.addColorStop(1, `rgba(${INK},0)`)
  g.fillStyle = rg
  g.fillRect(0, 0, size, size)
  // 偏心叠点，让纹理边缘长出不规则的「毛边」
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2
    const d = r * (0.42 + Math.random() * 0.52)
    const pr = r * (0.08 + Math.random() * 0.22)
    const x = r + Math.cos(a) * d
    const y = r + Math.sin(a) * d
    const g2 = g.createRadialGradient(x, y, 0, x, y, pr)
    g2.addColorStop(0, `rgba(${INK},0.26)`)
    g2.addColorStop(1, `rgba(${INK},0)`)
    g.fillStyle = g2
    g.beginPath()
    g.arc(x, y, pr, 0, Math.PI * 2)
    g.fill()
  }
  return c
}

function makeBlobs(w, h) {
  const R = Math.hypot(w, h) / 2
  const out = []
  for (let i = 0; i < 78; i++) {
    // 三档分布：**外围墨云带最密**（「黑云翻墨」主要发生在这里）→ 中环 → 近中心（稀而淡，护住图案）
    // 指数 e：rr = u^e · R。e≈0.5 = 面积均匀；**e < 0.5 才是真的偏外围**（之前用 0.58 反而偏稀）
    const z = Math.random()
    const exp = z < 0.56 ? 0.44 : z < 0.83 ? 0.95 : 2.10
    const rr = Math.pow(Math.random(), exp) * R * 0.98   // 收在可视圆内，别把墨甩到画面外
    const far = rr / (R * 0.98)                          // 0 = 正中，1 = 画面边缘
    // 浓度：中心 0.94 → 边缘 0.42（原来边缘 0.10，再乘遮罩就什么都看不见了）
    const base = 0.94 - far * 0.52
    const peripheral = far > 0.52
    // 团内点云：两次随机相乘 → 中心密、边缘疏。外围的云要多带点、带大点，才像「云」而不是「雾」
    const n = (peripheral ? 22 : 12) + Math.floor(Math.random() * (peripheral ? 12 : 6))
    const dots = []
    for (let j = 0; j < n; j++) {
      const ta = Math.random() * Math.PI * 2
      const td = (Math.random() * 0.5 + Math.random() * 0.5) * 0.95
      dots.push({
        dx: Math.cos(ta) * td,
        dy: Math.sin(ta) * td * 0.80,
        s: 0.26 + Math.random() * (peripheral ? 0.86 : 0.48),
        a: (peripheral ? 0.17 : 0.14) + Math.random() * (peripheral ? 0.50 : 0.44),
      })
    }
    out.push({
      rr,
      a0: Math.random() * Math.PI * 2,
      // 角速度：内圈快、外圈慢，约三成反向 —— 交错翻涌，不再是整体匀速转
      w: (0.00034 + Math.random() * 0.00072) * (Math.random() < 0.30 ? -1 : 1) * (1 - far * 0.42),
      surgeAmp: 0.05 + Math.random() * 0.10,   // 径向「翻」：云块一涨一落
      surgeSp: 0.00030 + Math.random() * 0.00062,
      surgePh: Math.random() * Math.PI * 2,
      wobAmp: 0.06 + Math.random() * 0.13,     // 切向游移（弧度）：云块在空白处游走
      wobSp: 0.00034 + Math.random() * 0.00072,
      wobPh: Math.random() * Math.PI * 2,
      rad: (peripheral ? 0.10 + Math.random() * 0.16 : 0.070 + Math.random() * 0.130) * R,
      rotS: (Math.random() - 0.5) * 0.0018,    // 自转（卷）
      spin: Math.random() * Math.PI * 2,
      bp: 0.00060 + Math.random() * 0.00090,   // 体量呼吸
      bph: Math.random() * Math.PI * 2,
      base,
      dots,
    })
  }
  return out
}

function drawInk(ctx, w, h, blobs, dot, t, intensity, converge, clear = true) {
  if (clear) ctx.clearRect(0, 0, w, h)
  if (intensity <= 0.002 || !dot) return

  const cx = w / 2
  const cy = h / 2
  const kConv = 1 - converge * 0.5

  for (const b of blobs) {
    // 极坐标演算：角速度各团不同（内快外慢、少数反向）→ 交错翻涌
    const rr = b.rr * (1 + Math.sin(t * b.surgeSp + b.surgePh) * b.surgeAmp) * kConv
    const ang = b.a0 + t * b.w + Math.sin(t * b.wobSp + b.wobPh) * b.wobAmp
    const bx = cx + Math.cos(ang) * rr
    const by = cy + Math.sin(ang) * rr * 0.96
    const sc = (1 + Math.sin(t * b.bp + b.bph) * 0.24) * (1 + converge * 0.55)
    const spin = b.spin + t * b.rotS
    const cs = Math.cos(spin)
    const sn = Math.sin(spin)
    const base = b.base * intensity

    for (const d of b.dots) {
      const px = bx + (d.dx * cs - d.dy * sn) * b.rad * sc
      const py = by + (d.dx * sn + d.dy * cs) * b.rad * sc
      const pr = b.rad * d.s * sc
      ctx.globalAlpha = Math.min(1, base * d.a)
      ctx.drawImage(dot, px - pr, py - pr, pr * 2, pr * 2)
    }
  }
  ctx.globalAlpha = 1

  // 全局浓度遮罩：中心仍最浓，但**外缘不再压到 0.10** —— 周边要留住能翻涌的墨
  ctx.globalCompositeOperation = 'destination-in'
  const gm = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.58)
  gm.addColorStop(0, 'rgba(0,0,0,1)')
  gm.addColorStop(0.40, 'rgba(0,0,0,0.86)')
  gm.addColorStop(0.68, 'rgba(0,0,0,0.70)')
  gm.addColorStop(1, 'rgba(0,0,0,0.52)')
  ctx.fillStyle = gm
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'source-over'
}

/* ---------- 阳爻 / 阴爻 ---------- */
function Yao({ yang, len = 13, sw = 2.6, opacity = 1 }) {
  const half = len / 2
  const gap = len * 0.19
  return (
    <g opacity={opacity}>
      {yang ? (
        <line x1={-half} y1="0" x2={half} y2="0" stroke="#1b1714" strokeWidth={sw} strokeLinecap="round" />
      ) : (
        <>
          <line x1={-half} y1="0" x2={-gap} y2="0" stroke="#1b1714" strokeWidth={sw} strokeLinecap="round" />
          <line x1={gap} y1="0" x2={half} y2="0" stroke="#1b1714" strokeWidth={sw} strokeLinecap="round" />
        </>
      )}
    </g>
  )
}

/* ---------- 一圈阴阳爻 ---------- */
function Ring({ radius, count, seed, yaoLen }) {
  const items = []
  for (let i = 0; i < count; i++) {
    // 交错排列阴阳爻
    const yang = (i + seed) % 2 === 0
    items.push({ a: (i / count) * 360, yang })
  }
  return (
    <g>
      {items.map((it, i) => (
        <g key={i} transform={`rotate(${it.a}) translate(0 ${-radius})`}>
          <Yao yang={it.yang} len={yaoLen} sw={yaoLen * 0.2} opacity={0.82} />
        </g>
      ))}
    </g>
  )
}

/* ---------- 太极双鱼 ---------- */
function Taiji({ R = 42 }) {
  const d =
    `M 0 ${-R} ` +
    `A ${R} ${R} 0 0 1 0 ${R} ` +
    `A ${R / 2} ${R / 2} 0 0 1 0 0 ` +
    `A ${R / 2} ${R / 2} 0 0 0 0 ${-R} Z`
  return (
    <g>
      {/* 黑鱼（头在下方：下半个小圆向左鼓起，那里最宽） */}
      <path d={d} fill="#1b1714" />
      {/* 黑鱼的白眼 */}
      <circle cx="0" cy={R / 2} r={R / 6} fill="#f5f2ec" />
      {/* 白鱼的黑眼（白鱼的头在上方，是留白那一半） */}
      <circle cx="0" cy={-R / 2} r={R / 6} fill="#1b1714" />
      {/* 外圈 */}
      <circle r={R} fill="none" stroke="#1b1714" strokeWidth="1.7" opacity="0.9" />
    </g>
  )
}

/* ---------- 卦象（六爻，从下往上） ---------- */
function HexFigure({ lines, highlight = [], dimOthers = false }) {
  const W = 40        // 爻长
  const GAP = 15      // 爻间距
  const total = lines.length * GAP
  return (
    <g>
      {lines.map((v, i) => {
        const y = total / 2 - GAP / 2 - i * GAP   // 从下往上
        const isHi = highlight.includes(i + 1)
        const op = dimOthers ? (isHi ? 1 : 0.1) : 1
        return (
          <g key={i} transform={`translate(0 ${y})`} style={{ transition: 'opacity .6s ease' }} opacity={op}>
            <Yao yang={v === 1} len={W} sw={5} />
          </g>
        )
      })}
    </g>
  )
}

export default function CastingAnimation({
  result,
  changingLines = [],
  archived = false,
  favorited = false,
  onToggleFav,
  onRecast,
  onEnterList,
  onEnterDetail,
}) {
  const [phase, setPhase] = useState('casting')
  const [focusOn, setFocusOn] = useState(false)
  const [focusing, setFocusing] = useState(false)

  const bgRef = useRef(null)
  const coverRef = useRef(null)
  const taijiRef = useRef(null)
  const ringRefs = [useRef(null), useRef(null), useRef(null)]
  const blobsRef = useRef([])
  const dotRef = useRef(null)
  const focusRef = useRef(null)   // { start, active, primed }
  const hexRef = useRef(null)     // 卦象组（逐帧改透明度）
  const hexScaleRef = useRef(null) // 卦象缩放外壳（逐帧写 transform 属性）
  const figRef = useRef(null)     // 起卦图案组（双鱼 + 三圈）

  /* ---------- rAF 主循环 ---------- */
  useEffect(() => {
    const bg = bgRef.current
    const cover = coverRef.current
    if (!bg || !cover) return
    const ctxBg = bg.getContext('2d')
    const ctxCv = cover.getContext('2d')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      for (const c of [bg, cover]) {
        c.width = Math.floor(w * dpr)
        c.height = Math.floor(h * dpr)
        c.style.width = w + 'px'
        c.style.height = h + 'px'
      }
      ctxBg.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctxCv.setTransform(dpr, 0, 0, dpr, 0, 0)
      blobsRef.current = makeBlobs(w, h)
      if (!dotRef.current) dotRef.current = makeDotTexture()
    }
    resize()
    window.addEventListener('resize', resize)

    const RING_TURNS = [7, -9, 11]     // 三圈：圈数不同、方向交错
    let start = performance.now()
    let lastPhase = 'casting'
    let doneAt = null                  // 进入 done（结果页出现）的时刻，用于放大卦象

    const loop = (now) => {
      const el = FREEZE != null ? FREEZE : (now - start) * SPEED
      const w = window.innerWidth
      const h = window.innerHeight

      /* --- 阶段推进 --- */
      let ph = 'casting'
      if (el >= T_REVEAL_END) ph = 'done'
      else if (el >= T_OUT_END) ph = 'reveal'
      else if (el >= T_HOLD_END) ph = 'inkOut'
      else if (el >= T_INK_END) ph = 'hold'
      else if (el >= T_CAST_END) ph = 'inkIn'
      if (ph !== lastPhase) {
        lastPhase = ph
        setPhase(ph)
      }

      const t = el

      /* --- 第一段：旋转角度 --- */
      const castP = clamp01(t / T.cast)
      if (ph === 'casting') {
        const e = easeOutCubic(castP)          // 结尾自然减速 → 正好落在整数圈，即标准位置
        if (taijiRef.current) taijiRef.current.setAttribute('transform', `rotate(${-3 * 360 * e})`)
        for (let i = 0; i < 3; i++) {
          const r = ringRefs[i].current
          if (r) r.setAttribute('transform', `rotate(${RING_TURNS[i] * 360 * e})`)
        }
      } else {
        // 定格在标准位置
        if (taijiRef.current) taijiRef.current.setAttribute('transform', 'rotate(0)')
        for (let i = 0; i < 3; i++) {
          const r = ringRefs[i].current
          if (r) r.setAttribute('transform', 'rotate(0)')
        }
      }

      /* --- 墨的浓度曲线（同时给出归一化进度，供交叉淡入淡出用） --- */
      // 背景墨：全程翻涌。动画中 0.30；出结果页后降到 0.14 —— 结果页的文字压在水墨上，
      // 浓度高会让小字读不清，也让顶部的卦象发灰
      const bgInt = ph === 'reveal' || ph === 'done' ? 0.14 : 0.30

      // 覆盖墨（第一段）：从四周涌上来，**盖在图案之上**（1.7 倍强度 → 真正遮住）
      let coverMain = 0
      let converge = 0
      let covMain = 0                                   // 归一化进度 0–1
      if (ph === 'inkIn') {
        covMain = easeInOutCubic(clamp01((el - T_CAST_END) / T.inkIn))
        converge = covMain
      } else if (ph === 'hold') {
        covMain = 1
        converge = 1
      } else if (ph === 'inkOut') {
        covMain = 1 - easeInOutCubic(clamp01((el - T_HOLD_END) / T.inkOut))
        converge = covMain
      }
      coverMain = covMain * 1.7

      /* --- 第二段：点击后墨再翻涌 --- */
      let covFocus = 0
      let fHex = 1                                      // 第二段里卦象自身的透明度
      const f = focusRef.current
      if (f && f.active) {
        const ft = (now - f.start) * SPEED
        if (ft < T.focusIn) {
          const p = clamp01(ft / T.focusIn)
          covFocus = easeInOutCubic(p)
          fHex = 1 - clamp01(p * 1.6)                   // 墨涌上来，卦象同步隐去
        } else if (ft < T.focusIn + T.focusHold) {
          covFocus = 1
          fHex = 0
          // 变爻的淡化在「墨还遮着」时就完成 —— 等墨散开，卦象已经安静下来了
          if (!f.primed) {
            f.primed = true
            setFocusOn(true)
          }
        } else if (ft < T.focusIn + T.focusHold + T.focusOut) {
          const p = clamp01((ft - T.focusIn - T.focusHold) / T.focusOut)
          covFocus = 1 - easeInOutCubic(p)
          fHex = clamp01((p - 0.3) / 0.7)               // 墨散到后半程，卦象才慢慢显出来
        } else {
          covFocus = 0
          fHex = 1
          f.active = false
          setFocusing(false)
        }
      }
      const coverFocus = covFocus * 1.7

      /* --- 交叉淡入淡出（逐帧，才算顺） --- */
      // 卦象：墨散到一半开始浮现，到结果页出现前刚好到位
      const hexBase = clamp01((el - T_HEX_IN_START) / (T_HEX_IN_END - T_HEX_IN_START))
      const hexOp = Math.min(hexBase, fHex)
      if (hexRef.current) hexRef.current.style.opacity = hexOp.toFixed(3)

      // 结果页出现后再放大一档，让六爻填满画面（viewBox 230 里卦象只占 90，不放大就留一大片空）
      // ⚠️ 用 SVG transform 属性，不用 CSS transform：viewBox 的 min-x/min-y 是负数（-115）时，
      //    CSS 的 transform-box: view-box + transform-origin: center 会把原点算到右下角，
      //    图形直接被甩出屏幕。SVG 属性则在图形自己的坐标系里缩放，原点就是中心。
      if (ph === 'done' && doneAt === null) doneAt = now
      const growP = doneAt === null ? 0 : clamp01((now - doneAt) / 950)
      const scale = (1 + 1.25 * easeOutCubic(growP)) * (0.92 + 0.08 * hexOp)
      if (hexScaleRef.current) hexScaleRef.current.setAttribute('transform', `scale(${scale.toFixed(4)})`)

      // 图案（双鱼 + 三圈）：墨涌上来就跟着渐隐，之后一去不回
      // 用时间函数而不是「记住状态」—— 分段跳变或状态残留都会让过渡生硬
      const figOut = clamp01((el - T_CAST_END) / (T.inkIn * 0.62))
      const figOp = el >= T_INK_END ? 0 : 1 - figOut
      if (figRef.current) figRef.current.style.opacity = figOp.toFixed(3)

      // 墨始终用真实时间推进 → 即使定格，墨水也在流动
      drawInk(ctxBg, w, h, blobsRef.current, dotRef.current, now * 0.5 + 4000, bgInt, 0)

      const cInt = Math.max(coverMain, coverFocus)
      const cConv = coverMain >= coverFocus ? converge : 0.7
      drawInk(ctxCv, w, h, blobsRef.current, dotRef.current, now * 0.8 + 900, cInt, cConv)
      if (cInt > 0.55) {
        // 换一个时间相位再叠一遍：墨点落在不同位置，补上缝隙 → 真正遮住图案
        drawInk(ctxCv, w, h, blobsRef.current, dotRef.current, now * 0.8 + 3170, cInt * 0.8, cConv, false)
      }

      // 背景墨始终保持翻涌（含动画结束后），循环不停
      requestAnimationFrame(loop)
    }
    const raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  /* ---------- 第二段：点击触发（主循环不停，这里只负责启动） ---------- */
  const handleFocus = () => {
    if (phase !== 'done' && phase !== 'reveal') return
    const f = focusRef.current
    if (f && f.active) return
    // 不要在这里把 focusOn 复位 —— 那会让「淡化」在点击瞬间可见地跳一下；
    // 真正的淡化放在墨遮住之后（见主循环里的 primed）
    focusRef.current = { start: performance.now(), active: true, primed: false }
    setFocusing(true)
  }

  return (
    <div className={'cast-root' + (phase === 'done' ? ' is-result' : '')}>
      {/* 背景墨：一直翻涌旋转，营造动态感，但不遮图案 */}
      <canvas ref={bgRef} className="cast-canvas cast-bg" />
      {/* 覆盖墨：只在遮住图案时出现 */}
      <canvas ref={coverRef} className="cast-canvas cast-cover" />

      <svg className="cast-stage" viewBox="-115 -115 230 230" aria-hidden="true">
        {/* 卦象（墨散开时浮现；透明度与缩放由主循环逐帧写 SVG transform 属性） */}
        <g className="cast-hex-scale" ref={hexScaleRef}>
          <g className="cast-hex" ref={hexRef} style={{ opacity: 0 }}>
            <HexFigure
              lines={result.lines}
              highlight={changingLines}
              dimOthers={focusOn && changingLines.length > 0}
            />
          </g>
        </g>

        {/* 起卦图案：墨涌上来时同步渐隐（同样逐帧给），配合墨做到真正遮住 */}
        <g className="cast-figure" ref={figRef}>
          {/* 外侧虚圆：运不只是表面预测 */}
          <circle r="103" className="cast-dashed" />
          <circle r="88" className="cast-dashed cast-dashed-thin" />

          {/* 三圈交错阴阳爻 */}
          <g ref={ringRefs[0]}><Ring radius={72} count={14} seed={0} yaoLen={13} /></g>
          <g ref={ringRefs[1]}><Ring radius={58} count={11} seed={1} yaoLen={11} /></g>
          <g ref={ringRefs[2]}><Ring radius={45} count={8} seed={0} yaoLen={9} /></g>

          {/* 中心太极双鱼 */}
          <g ref={taijiRef}>
            <Taiji R={30} />
          </g>
        </g>
      </svg>

      {/* 动画结束 → 出结果页（卦头、三层解读、两个交互键、边界声明） */}
      {phase === 'done' && (
        <CastResult
          result={result}
          changingLines={changingLines}
          archived={archived}
          favorited={favorited}
          onToggleFav={onToggleFav}
          onRecast={onRecast}
          onFocusLine={handleFocus}
          focusing={focusing}
          onEnterList={() => onEnterList && onEnterList(result.id)}
          onEnterDetail={() => onEnterDetail && onEnterDetail(result.id)}
        />
      )}
    </div>
  )
}
