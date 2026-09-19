import { useEffect, useRef, useState } from 'react'
import './casting.css'

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

/** 各阶段图案的不透明度：墨涌上来时图案同步淡出，两者配合才叫「遮住」 */
const FIG_OPACITY = { casting: 1, inkIn: 0.22, hold: 0, inkOut: 0.55, reveal: 0, done: 0 }
const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

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
function makeDotTexture(size = 128) {
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
  const cx = w / 2
  const cy = h / 2
  const R = Math.hypot(w, h) / 2
  const out = []
  for (let i = 0; i < 36; i++) {
    // 指数 > 1 → 偏向中心（铺满画面，不再只在外围成环）
    const rr = Math.pow(Math.random(), 1.15) * R * 1.05
    const a0 = Math.random() * Math.PI * 2
    // 团内点云：两次随机相乘 → 中心密、边缘疏
    const n = 13 + Math.floor(Math.random() * 9)
    const dots = []
    for (let j = 0; j < n; j++) {
      const ta = Math.random() * Math.PI * 2
      const td = (Math.random() * 0.5 + Math.random() * 0.5) * 0.92
      dots.push({
        dx: Math.cos(ta) * td,
        dy: Math.sin(ta) * td * 0.78,
        s: 0.30 + Math.random() * 0.55,
        a: 0.16 + Math.random() * 0.42,
      })
    }
    out.push({
      ox: cx + Math.cos(a0) * rr,
      oy: cy + Math.sin(a0) * rr,
      rad: (0.075 + Math.random() * 0.135) * R,
      // 浓度梯度：中心 0.95 → 周边 0.10
      base: 0.10 + Math.max(0, 1 - rr / (R * 1.05)) * 0.85,
      dots,
      sx: 0.00020 + Math.random() * 0.00052,
      sy: 0.00017 + Math.random() * 0.00044,
      px: Math.random() * Math.PI * 2,
      py: Math.random() * Math.PI * 2,
      rx: (0.04 + Math.random() * 0.12) * R,
      ry: (0.035 + Math.random() * 0.11) * R,
      rp: 0.0005 + Math.random() * 0.0012,
      pr: Math.random() * Math.PI * 2,
      rotS: (Math.random() - 0.5) * 0.0007,
      spin: Math.random() * Math.PI * 2,
    })
  }
  return out
}

function drawInk(ctx, w, h, blobs, dot, t, intensity, converge, clear = true) {
  if (clear) ctx.clearRect(0, 0, w, h)
  if (intensity <= 0.002 || !dot) return

  const cx = w / 2
  const cy = h / 2
  const gRot = t * 0.00006           // 整体翻涌旋转
  const cosG = Math.cos(gRot)
  const sinG = Math.sin(gRot)

  for (const b of blobs) {
    const dx = b.ox - cx
    const dy = b.oy - cy
    const rx0 = dx * cosG - dy * sinG
    const ry0 = dx * sinG + dy * cosG
    const k = 1 - converge * 0.5
    const bx = cx + rx0 * k + Math.sin(t * b.sx + b.px) * b.rx
    const by = cy + ry0 * k + Math.cos(t * b.sy + b.py) * b.ry
    const sc = (1 + Math.sin(t * b.rp + b.pr) * 0.20) * (1 + converge * 0.55)
    const spin = b.spin + gRot * 0.9 + t * b.rotS
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

  // 全局浓度遮罩：中心浓、周边淡
  ctx.globalCompositeOperation = 'destination-in'
  const gm = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.58)
  gm.addColorStop(0, 'rgba(0,0,0,1)')
  gm.addColorStop(0.42, 'rgba(0,0,0,0.70)')
  gm.addColorStop(0.75, 'rgba(0,0,0,0.30)')
  gm.addColorStop(1, 'rgba(0,0,0,0.10)')
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
      {/* 黑鱼 */}
      <path d={d} fill="#1b1714" />
      {/* 白眼（黑鱼中的白点） */}
      <circle cx="0" cy={-R / 2} r={R / 6} fill="#f5f2ec" />
      {/* 黑眼（白鱼中的黑点） */}
      <circle cx="0" cy={R / 2} r={R / 6} fill="#1b1714" />
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

export default function CastingAnimation({ result, changingLines = [], onFinish }) {
  const [phase, setPhase] = useState('casting')
  const [focusOn, setFocusOn] = useState(false)

  const bgRef = useRef(null)
  const coverRef = useRef(null)
  const taijiRef = useRef(null)
  const ringRefs = [useRef(null), useRef(null), useRef(null)]
  const blobsRef = useRef([])
  const dotRef = useRef(null)
  const focusRef = useRef(null)   // { start, active }

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

      /* --- 墨的浓度曲线 --- */
      // 背景墨：全程翻涌，浓度始终低（不遮图案）
      const bgInt = ph === 'reveal' || ph === 'done' ? 0.26 : 0.30

      // 覆盖墨（第一段）：从四周涌上来，**盖在图案之上**（1.7 倍强度 → 真正遮住）
      let coverMain = 0
      let converge = 0
      if (ph === 'inkIn') {
        const p = clamp01((el - T_CAST_END) / T.inkIn)
        coverMain = easeInOutCubic(p) * 1.7
        converge = easeInOutCubic(p)
      } else if (ph === 'hold') {
        coverMain = 1.7
        converge = 1
      } else if (ph === 'inkOut') {
        const p = clamp01((el - T_HOLD_END) / T.inkOut)
        coverMain = (1 - easeInOutCubic(p)) * 1.7
        converge = 1 - easeInOutCubic(p)
      }

      /* --- 第二段：点击后墨再翻涌 --- */
      let coverFocus = 0
      const f = focusRef.current
      if (f && f.active) {
        const ft = (now - f.start) * SPEED
        if (ft < T.focusIn) {
          coverFocus = easeInOutCubic(ft / T.focusIn)
        } else if (ft < T.focusIn + T.focusHold) {
          coverFocus = 1
        } else if (ft < T.focusIn + T.focusHold + T.focusOut) {
          coverFocus = 1 - easeInOutCubic((ft - T.focusIn - T.focusHold) / T.focusOut)
        } else {
          coverFocus = 0
          f.active = false
          setFocusOn(true)
        }
      }

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
    focusRef.current = { start: performance.now(), active: true }
    setFocusOn(false)
  }

  const showHex = phase === 'reveal' || phase === 'done'

  return (
    <div className="cast-root">
      {/* 背景墨：一直翻涌旋转，营造动态感，但不遮图案 */}
      <canvas ref={bgRef} className="cast-canvas cast-bg" />
      {/* 覆盖墨：只在遮住图案时出现 */}
      <canvas ref={coverRef} className="cast-canvas cast-cover" />

      <svg className="cast-stage" viewBox="-115 -115 230 230" aria-hidden="true">
        {/* 卦象（墨散去后浮现） */}
        <g
          className="cast-hex"
          style={{
            opacity: showHex ? 1 : 0,
            transform: showHex ? 'scale(1)' : 'scale(.86)',
            transition: `opacity ${T.reveal}ms ease, transform ${T.reveal}ms cubic-bezier(.2,.8,.3,1)`,
          }}
        >
          <HexFigure
            lines={result.lines}
            highlight={changingLines}
            dimOthers={focusOn && changingLines.length > 0}
          />
        </g>

        {/* 起卦图案：墨涌上来时同步淡出，配合墨做到真正遮住 */}
        <g
          className="cast-figure"
          style={{
            opacity: showHex ? 0 : (FIG_OPACITY[phase] ?? 1),
            transition: 'opacity 700ms ease',
          }}
        >
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

      {/* 第二段的触发把手（动画完成后出现） */}
      {phase === 'done' && (
        <button type="button" className="cast-focus-btn" onClick={handleFocus}>
          {changingLines.length > 0 ? '看这一爻' : '再看一遍'}
        </button>
      )}

      {phase === 'done' && onFinish && (
        <button type="button" className="cast-skip" onClick={onFinish}>
          查看解读 →
        </button>
      )}
    </div>
  )
}
