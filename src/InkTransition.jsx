import { useEffect, useRef } from 'react'
import { makeDotTexture } from './CastingAnimation.jsx'

/**
 * 点击总表某一卦后的转场（F1 → F2）：
 *   ① 石头入水的涟漪 → ② 淡墨侵染、屏幕渐糊 → ③ 约 3 秒墨散
 *   → ④ 竹简展开、占满整个屏幕 → ⑤ 内容以「墨起」的形式浮现
 *
 * 两条来自「带时间轴动画」的经验，写死在这里：
 *   ① **先有 `?transSpeed` / `?transFreeze` 再写动画** —— 6 秒的转场靠 sleep 猜帧必然抓错
 *   ② 所有 opacity / blur / transform 都是**关于 elapsed 的连续函数**（不用 CSS transition 补间、不用 latch），
 *      这样 `?transFreeze=2000` 直接跳到中段时，画面也和真实进度一致
 */
const INK = '22,19,17'

/* 时间轴（v3：涟漪更慢更有诗意 / 卷轴展开放慢 / 最后一拍才交接详情页）
   涟漪 0–2000 → 墨侵染 700–3600 → 墨散 3600–4600
   → 卷轴展开 4400–6600（2.2 秒，慢）→ 边缘墨流 4600–7000
   → 最后一层墨起 6600–7800：把「卷轴 → 详情页」的交接盖住，**这一拍之前绝不露出详情页** */
const T_RIPPLE_END = 2000     // ① 涟漪（石头入水：冲击 → 波列推开 → 水珠）
const T_DYE_START = 700       // ② 墨开始侵染
const T_DYE_FULL = 3600       //    基本铺满（此时遮挡最完全）
const T_FLOOD_START = 2200    //    整片淹没的起点：把墨点之间的缝合上
const T_OUT_END = 4600        // ③ 墨散尽
const T_SCROLL_START = 4400   // ④ 竹简开始展开（与墨散略有重叠，接得上）
const T_SCROLL_END = 6600     //    展开到占满屏幕（2.2 秒 —— 慢）
const T_EDGE_START = 4600     //    卷轴边缘的淡黑墨开始沿边往下淌
const T_EDGE_END = 7100       //    墨流随展开推进、渐淡收尾
const T_WASH_START = 6600     // ⑤ 最后一层墨（墨起）：盖住「卷轴 → 详情页」的交接
const T_WASH_PEAK = 7000      //    峰值时屏幕几乎全墨 —— 此刻才允许底下的详情页换上来
const T_WASH_END = 7800       //    墨退去，详情页这一拍才显出来
const T_DONE = 7900

const BLUR_PEAK = 10          // 墨侵染期的峰值模糊（px）
const BLUR_EMERGE = 8         // 墨起时的模糊（px）
const PAGE_DIM = 0.15         // 转场全程，底下内容压暗到多少（这一档才叫「看不见」）
const HOLD_BLUR = 6           // 卷轴展开期间保持的模糊（px）—— 不糊的话详情页还是能被认出来

const SPEED = (() => {
  if (typeof window === 'undefined') return 1
  const v = parseFloat(new URLSearchParams(window.location.search).get('transSpeed'))
  return Number.isFinite(v) && v > 0 ? v : 1
})()

/** 调试用：?transFreeze=2000 把转场定格在第 2 秒（画面仍在按真实时间流动），用于逐帧截图核对 */
const FREEZE = (() => {
  if (typeof window === 'undefined') return null
  const v = parseFloat(new URLSearchParams(window.location.search).get('transFreeze'))
  return Number.isFinite(v) && v >= 0 ? v : null
})()

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3)
const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)

/**
 * 墨的「侵染射线」：从点击点向外，每条有自己的出发时间、速度和摆动。
 * 侵染感来自**痕迹会留下** —— 前沿墨点画进一张**不清空的** stain 画布，越积越浓。
 */
function makeRays(w, h, origin) {
  const diag = Math.hypot(w, h)
  const rays = []
  for (let i = 0; i < 170; i++) {
    const a = Math.random() * Math.PI * 2
    rays.push({
      a,
      cos: Math.cos(a),
      sin: Math.sin(a),
      v: (0.55 + Math.random() * 1.05) * (diag / 3000),   // px/ms：3 秒内大致铺满
      delay: Math.random() * 900,                          // 不是同时出发 → 边缘参差
      wob: Math.random() * Math.PI * 2,                    // 摆动相位
      wobF: 0.00035 + Math.random() * 0.00055,
      size: 0.03 + Math.random() * 0.075,                  // 相对屏幕对角线的墨点大小
      last: 0,                                             // 该射线已经洇到多远（落点按距离算）
    })
  }
  return { rays, diag, origin }
}

/** 墨痕落点的间距（px）：按距离落而不是按帧落，密度才与帧率 / 定格 / 慢放无关 */
const SPACING = 9
/** 圆心留白半径：这一圈交给水渍渐变（否则所有射线都从点击点出发，圆心会瞬间叠成一团黑） */
const R0 = 120

export default function InkTransition({ lines, origin, onDone }) {
  const canvasRef = useRef(null)
  const edgeRef = useRef(null)      // 卷轴边缘的淡墨（画在卷轴**之上**，才能压住竹简边）
  const scrollRef = useRef(null)
  const washRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const edge = edgeRef.current
    const ctx = canvas.getContext('2d')
    const ectx = edge ? edge.getContext('2d') : null
    if (!canvas || !ctx) return

    /* 两张画布：stain **不清空**（累积墨痕 = 侵染感），main 每帧清空后合成 */
    const stain = document.createElement('canvas')
    const sctx = stain.getContext('2d')

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = window.innerWidth
    let H = window.innerHeight
    const fit = () => {
      W = window.innerWidth
      H = window.innerHeight
      for (const c of [canvas, stain, edge]) {
        if (!c) continue
        c.width = Math.round(W * dpr)
        c.height = Math.round(H * dpr)
      }
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      if (edge) {
        edge.style.width = W + 'px'
        edge.style.height = H + 'px'
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (ectx) ectx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()

    const dot = makeDotTexture()
    const o = origin || { x: W / 2, y: H / 2 }
    const { rays, diag } = makeRays(W, H, o)

    const root = document.documentElement
    root.classList.add('ink-transitioning')

    const start = performance.now()
    let raf = 0

    /* 详情页刚挂载时先把滚动位置归到顶（趁墨盖着屏幕，用户看不见） */
    setTimeout(() => {
      window.scrollTo(0, 0)
    }, 420)

    const loop = (now) => {
      const el = FREEZE != null ? FREEZE : (now - start) * SPEED

      /* ---------- ① 石头入水（更慢、更真实：不规则波圈 + 二次溅落 + 水珠） ---------- */
      ctx.clearRect(0, 0, W, H)
      if (el < T_RIPPLE_END + 300) {
        const p = clamp01(el / T_RIPPLE_END)

        // 画一圈「不规则」的水波：真实的水纹不是正圆，半径带角向扰动
        const ringPath = (cx, cy, r, phase, amp) => {
          ctx.beginPath()
          const SEG = 40
          for (let i = 0; i <= SEG; i++) {
            const th = (i / SEG) * Math.PI * 2
            const rr =
              r * (1 + amp * Math.sin(th * 3 + phase) + amp * 0.55 * Math.sin(th * 5 - phase * 0.7 + 1.3))
            const x = cx + Math.cos(th) * rr
            const y = cy + Math.sin(th) * rr
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.closePath()
        }

        // 1a. 石头砸下去的那一下：触点先陷出一个暗坑，随后被水填平
        const dimpleA = 0.52 * (1 - clamp01((el - 300) / 1100))
        if (dimpleA > 0.005) {
          const rr = 26 + 30 * easeOutCubic(clamp01(el / 320))
          const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, rr)
          g.addColorStop(0, `rgba(${INK},${dimpleA})`)
          g.addColorStop(0.62, `rgba(${INK},${dimpleA * 0.45})`)
          g.addColorStop(1, `rgba(${INK},0)`)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(o.x, o.y, rr, 0, Math.PI * 2)
          ctx.fill()
        }

        // 1b. 波列：一圈圈向外推开。越往外波长越大（色散）、振幅越小（1/√r 量级）
        const front = (1 - Math.pow(1 - p, 2.2)) * diag * 0.62
        const CRESTS = 9
        for (let k = 0; k < CRESTS; k++) {
          const lambda = 40 + 20 * p + k * 6
          const r = front - k * lambda
          if (r <= 4) continue
          const amp = 0.46 * Math.exp(-k * 0.40) * (1 - p) * (r / Math.max(1, front))
          if (amp <= 0.004) continue
          const phase = k * 1.7 + p * 2.4
          ringPath(o.x, o.y, r, phase, 0.012)
          ctx.strokeStyle = `rgba(${INK},${amp * 0.30})`
          ctx.lineWidth = 15 // 外柔边：水的厚度
          ctx.stroke()
          ctx.strokeStyle = `rgba(${INK},${amp})`
          ctx.lineWidth = 4 // 波峰
          ctx.stroke()
          ctx.strokeStyle = `rgba(255,255,255,${amp * 0.5})`
          ctx.lineWidth = 1.4 // 水面反光
          ctx.stroke()
        }

        // 1b-2. 第二组更淡的波（二次溅落），错后一拍出发 —— 水面才有层次
        if (p > 0.34) {
          const p2 = (p - 0.34) / 0.66
          const front2 = easeOutCubic(p2) * diag * 0.34
          for (let k = 0; k < 3; k++) {
            const r = front2 - k * (34 + 12 * p2)
            if (r <= 4) continue
            const amp = 0.20 * Math.exp(-k * 0.5) * (1 - p2) * 0.8
            if (amp <= 0.004) continue
            ringPath(o.x, o.y, r, k * 2.3 + 1.1, 0.016)
            ctx.strokeStyle = `rgba(${INK},${amp})`
            ctx.lineWidth = 3
            ctx.stroke()
          }
        }

        // 1b-3. 溅起的水珠：入水后头 0.9 秒里往外抛的小墨点（抛物线：先升后落）
        if (el < 900) {
          const q = el / 900
          for (let i = 0; i < 16; i++) {
            const a = i * 2.399 + 0.7
            const d = 30 + easeOutCubic(q) * (150 + (i % 5) * 34)
            const lift = Math.sin(q * Math.PI) * (26 + (i % 4) * 9)
            ctx.fillStyle = `rgba(${INK},${0.30 * (1 - q)})`
            ctx.beginPath()
            ctx.arc(o.x + Math.cos(a) * d, o.y + Math.sin(a) * d - lift, 1.6 + (i % 3) * 0.8, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }

      /* ---------- ② 墨的侵染 ---------- */
      const dyeP = clamp01((el - T_DYE_START) / (T_DYE_FULL - T_DYE_START))
      if (dyeP > 0) {
        // 2a. 前沿墨点 → 画进不清空的 stain（痕迹留下 = 侵染）
        for (const r of rays) {
          const t = el - T_DYE_START - r.delay
          if (t <= 0) continue
          const rad = Math.min(t * r.v, diag)
          const from = r.last || 0
          if (rad <= from) continue
          const steps = Math.ceil((rad - from) / SPACING)
          for (let i = 1; i <= steps; i++) {
            const rr = from + ((rad - from) * i) / steps
            if (rr < R0) continue // 圆心交给水渍渐变（否则所有射线叠在圆心，瞬间黑成一团）
            const wob = Math.sin((now + i * 37) * r.wobF + r.wob) * 26
            const d = r.size * diag
            const ramp = Math.min(1, (rr - R0) / 260)
            sctx.globalAlpha = 0.125 * ramp
            sctx.drawImage(dot, o.x + r.cos * rr - wob * r.sin - d, o.y + r.sin * rr + wob * r.cos - d, d * 2, d * 2)
            sctx.globalAlpha = 0.085 * ramp
            sctx.drawImage(dot, o.x + r.cos * (rr * 0.72) - d, o.y + r.sin * (rr * 0.72) - d, d * 2, d * 2)
          }
          r.last = rad
        }
        sctx.globalAlpha = 1
        ctx.drawImage(stain, 0, 0, W, H)

        // 2b. 整片漫开的水渍（浓度随侵染进度一起长，避免第一帧就是实心黑）
        const cr = easeOutCubic(dyeP) * diag * 1.15
        const strength = 0.35 + 0.65 * dyeP
        const wash = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Math.max(1, cr))
        wash.addColorStop(0, `rgba(${INK},${0.86 * strength})`)
        wash.addColorStop(0.60, `rgba(${INK},${0.74 * strength})`)
        wash.addColorStop(0.86, `rgba(${INK},${0.46 * strength})`)
        wash.addColorStop(1, `rgba(${INK},${0.14 * strength})`)
        ctx.fillStyle = wash
        ctx.fillRect(0, 0, W, H)

        // 2c. 整片淹没：把墨点之间的缝彻底合上（「遮挡要完全」的关键）
        const floodP = clamp01((el - T_FLOOD_START) / (T_DYE_FULL - T_FLOOD_START))
        if (floodP > 0) {
          ctx.fillStyle = `rgba(${INK},${0.34 * floodP})`
          ctx.fillRect(0, 0, W, H)
        }

        // 2d. 前沿的亮墨（正在爬的那条边）—— 动感主要来自这里
        for (const r of rays) {
          const t = el - T_DYE_START - r.delay
          if (t <= 0) continue
          const rad = t * r.v
          if (rad > diag) continue
          const wob = Math.sin(now * r.wobF + r.wob) * 30
          const d = r.size * diag * 1.3
          ctx.globalAlpha = 0.28
          ctx.drawImage(dot, o.x + r.cos * rad - wob * r.sin - d, o.y + r.sin * rad + wob * r.cos - d, d * 2, d * 2)
        }
        ctx.globalAlpha = 1
      }

      /* 墨的整体浓度：侵染期 1，散去期 → 0（连续函数，不用 latch） */
      const inkAlpha = el < T_DYE_FULL ? 1 : 1 - easeInOutCubic(clamp01((el - T_DYE_FULL) / (T_OUT_END - T_DYE_FULL)))
      canvas.style.opacity = String(clamp01(inkAlpha))

      /* ---------- ④ 竹简展开（慢）+ ⑤ 卷轴边缘的淡黑墨流动 ---------- */
      const scroll = scrollRef.current
      const open = clamp01((el - T_SCROLL_START) / (T_SCROLL_END - T_SCROLL_START))
      if (scroll) {
        // 从中间向两侧展开（scaleX 0.04 → 1）。
        // **全程不透明** —— 之前写成 open × opacity，展开时整个卷轴是半透明的，
        // 底下的详情页一路透出来，这正是「动画还没结束就看到详情页」的原因。
        // **展开完成后保持占满，不提前交棒**；只在墨起盖到峰值之后、墨还盖着时淡出。
        scroll.style.transform = `scaleX(${(0.04 + 0.96 * easeOutCubic(open)).toFixed(4)})`
        const scrollFade = clamp01((el - T_WASH_PEAK) / 320)
        scroll.style.opacity = String((1 - scrollFade).toFixed(3))
      }

      // 边缘淡墨：贴着卷轴两条正在外推的边，往下淌。画在卷轴**之上**的独立画布里
      if (ectx) {
        const edgeA =
          clamp01((el - T_EDGE_START) / 520) *
          (1 - easeInOutCubic(clamp01((el - T_SCROLL_END) / (T_EDGE_END - T_SCROLL_END))))
        ectx.clearRect(0, 0, W, H)
        if (edgeA > 0.004) {
          const halfW = (0.04 + 0.96 * easeOutCubic(open)) * W / 2
          const ex = [W / 2 - halfW, W / 2 + halfW]
          const BW = 200
          for (let e = 0; e < 2; e++) {
            // 墨浓在**卷轴内侧**（竹片吸墨，从展开边往里洇）；
            // 外侧几乎不画 —— 外面是深色木桌面，墨画上去等于没画
            const dir = e === 0 ? 1 : -1
            const a = edgeA * 0.72
            const xa = ex[e] - dir * 6            // 外侧（桌面）一点点
            const xb = ex[e] + dir * BW           // 内侧（卷轴深处）
            const x0 = Math.min(xa, xb)
            const x1 = Math.max(xa, xb)
            const pEdge = (ex[e] - x0) / (x1 - x0)  // 卷轴边在渐变里的位置
            const g = ectx.createLinearGradient(x0, 0, x1, 0)
            g.addColorStop(0, `rgba(${INK},0)`)                       // 桌面：不画
            g.addColorStop(pEdge, `rgba(${INK},${a})`)                // 贴边的一线最浓
            g.addColorStop(pEdge + (1 - pEdge) * 0.3, `rgba(${INK},${a * 0.45})`)
            g.addColorStop(pEdge + (1 - pEdge) * 0.7, `rgba(${INK},${a * 0.16})`)
            g.addColorStop(1, `rgba(${INK},0)`)                       // 卷轴深处：不画
            ectx.fillStyle = g
            ectx.fillRect(x0, 0, x1 - x0, H)
            // 「流动」：三条柔边墨痕贴着边、随时间缓缓下移
            for (let i = 0; i < 5; i++) {
              const off = ((el * (0.016 + i * 0.005) + i * 230) % (H + 360)) - 180
              const gx = ex[e] + dir * (10 + i * 31)
              const gs = ectx.createLinearGradient(0, off - 190, 0, off + 190)
              gs.addColorStop(0, `rgba(${INK},0)`)
              gs.addColorStop(0.5, `rgba(${INK},${a * 0.5})`)
              gs.addColorStop(1, `rgba(${INK},0)`)
              ectx.fillStyle = gs
              ectx.fillRect(Math.min(gx, gx + dir * 22), off - 190, 22, 380)
            }
            // 往下淌的墨滴（贴边内侧、错峰出发、到屏外循环）
            for (let i = 0; i < 6; i++) {
              const seed = i * 173 + e * 61
              const t = el - T_EDGE_START - (i % 4) * 260
              if (t <= 0) continue
              const y = ((t * (0.026 + (i % 3) * 0.011)) % (H + 240)) - 120
              const x = ex[e] + dir * (6 + (i % 3) * 11)
              const da = edgeA * (0.34 + 0.2 * Math.sin(seed * 2))
              const len = 40 + (i % 3) * 26
              const g2 = ectx.createLinearGradient(x, y - len, x, y)
              g2.addColorStop(0, `rgba(${INK},0)`)
              g2.addColorStop(1, `rgba(${INK},${da})`)
              ectx.fillStyle = g2
              ectx.fillRect(x - 2.2, y - len, 4.4, len)
            }
          }
        }
      }

      /* ---------- ⑥ 最后一层墨起：盖住「卷轴 → 详情页」的交接 ---------- */
      // 6600 涌上来 → 7000 盖到峰值（此刻底下的详情页换上来，但屏幕几乎全墨）→ 退去时才显出来
      const washP =
        clamp01((el - T_WASH_START) / (T_WASH_PEAK - T_WASH_START)) *
        (1 - clamp01((el - T_WASH_PEAK) / (T_WASH_END - T_WASH_PEAK)))
      const washEl = washRef.current
      if (washEl) washEl.style.opacity = String((washP * 0.95).toFixed(3))

      /* ---------- 模糊与压暗 ----------
         页面透明度：整段转场都压在 0.15（暗到认不出内容），
         只在最后一拍（墨起退去）随墨一起亮起来 —— 这样卷轴展开时不会露出详情页。
         模糊同理：卷轴展开期间保底 6px，最后一拍才放开。 */
      const revealP = clamp01((el - T_WASH_PEAK) / (T_WASH_END - T_WASH_PEAK))
      const dim = PAGE_DIM + (1 - PAGE_DIM) * revealP
      root.style.setProperty('--ink-dim', String(Math.round(dim * 50) / 50))

      const dyeBlur =
        el < T_DYE_FULL
          ? BLUR_PEAK * easeOutCubic(clamp01((el - T_DYE_START) / (T_DYE_FULL - T_DYE_START - 500)))
          : BLUR_PEAK * (1 - easeInOutCubic(clamp01((el - T_DYE_FULL) / (T_OUT_END - T_DYE_FULL))))
      const blur = Math.max(0, dyeBlur, HOLD_BLUR * (1 - revealP)) + BLUR_EMERGE * washP
      root.style.setProperty('--ink-blur', `${(Math.round(blur * 4) / 4).toFixed(2)}px`)

      if (el >= T_DONE) {
        root.classList.remove('ink-transitioning')
        root.style.removeProperty('--ink-blur')
        root.style.removeProperty('--ink-dim')
        onDone && onDone()
        return
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const onResize = () => fit()
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      root.classList.remove('ink-transitioning')
      root.style.removeProperty('--ink-blur')
      root.style.removeProperty('--ink-dim')
    }
  }, [lines, origin, onDone])

  return (
    <div className="ink-trans" role="presentation">
      <canvas ref={canvasRef} className="ink-trans-canvas" />
      {/* 竹简：从中间向两侧展开，占满屏幕 */}
      <div ref={scrollRef} className="ink-trans-scroll" />
      {/* 卷轴边缘的淡黑墨（画在卷轴之上，压住竹简边并往外洇开） */}
      <canvas ref={edgeRef} className="ink-trans-edge" />
      {/* 墨起：最后一层墨，盖住「卷轴 → 详情页」的交接 */}
      <div ref={washRef} className="ink-trans-wash" />
    </div>
  )
}
