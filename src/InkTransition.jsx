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

const T_RIPPLE_END = 1200     // ① 涟漪（石头入水：冲击 → 波列推开）
const T_DYE_START = 400       // ② 墨开始侵染
const T_DYE_FULL = 3000       //    基本铺满（此时遮挡最完全）
const T_FLOOD_START = 1600    //    整片淹没的起点：把墨点之间的缝合上
const T_OUT_END = 3900        // ③ 墨散尽
const T_SCROLL_START = 3700   // ④ 竹简开始展开（与墨散略有重叠，接得上）
const T_SCROLL_END = 4900     //    展开到占满屏幕
const T_SCROLL_FADE = 5150    //    交给真正的详情页（同为竹简质地，无缝）
const T_WASH_START = 4700     // ⑤ 内容浮现前的一层墨（墨起）
const T_WASH_PEAK = 5050
const T_WASH_END = 5850
const T_DONE = 6000

const BLUR_PEAK = 10          // 墨侵染期的峰值模糊（px）
const BLUR_EMERGE = 8         // 墨起时的模糊（px）
const PAGE_DIM = 0.15         // 墨盖着时，底下内容压暗到多少

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
  const scrollRef = useRef(null)
  const washRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
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
      for (const c of [canvas, stain]) {
        c.width = Math.round(W * dpr)
        c.height = Math.round(H * dpr)
      }
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0)
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

      /* ---------- ① 石头入水 ---------- */
      ctx.clearRect(0, 0, W, H)
      if (el < T_RIPPLE_END + 260) {
        const p = clamp01(el / T_RIPPLE_END)

        // 1a. 石头砸下去的那一下：触点先陷出一个暗坑，随后被水填平
        const dimpleA = 0.52 * (1 - clamp01((el - 200) / 800))
        if (dimpleA > 0.005) {
          const rr = 26 + 30 * easeOutCubic(clamp01(el / 260))
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
        const front = easeOutCubic(p) * diag * 0.62
        const CRESTS = 8
        for (let k = 0; k < CRESTS; k++) {
          const lambda = 38 + 18 * p + k * 5
          const r = front - k * lambda
          if (r <= 4) continue
          const amp = 0.46 * Math.exp(-k * 0.42) * (1 - p) * (r / Math.max(1, front))
          if (amp <= 0.004) continue
          ctx.beginPath()
          ctx.arc(o.x, o.y, r, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${INK},${amp * 0.35})`
          ctx.lineWidth = 13 // 外柔边：水的厚度
          ctx.stroke()
          ctx.strokeStyle = `rgba(${INK},${amp})`
          ctx.lineWidth = 4 // 波峰
          ctx.stroke()
          ctx.strokeStyle = `rgba(255,255,255,${amp * 0.5})`
          ctx.lineWidth = 1.4 // 水面反光
          ctx.stroke()
        }

        // 1c. 溅起的一线：入水那一瞬间最前一圈更亮（石头激起的那一道）
        if (p < 0.4 && front > 6) {
          const a = 0.32 * (1 - p / 0.4)
          ctx.beginPath()
          ctx.arc(o.x, o.y, front, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${INK},${a})`
          ctx.lineWidth = 2
          ctx.stroke()
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

      /* ---------- ④ 竹简展开 ---------- */
      const scroll = scrollRef.current
      if (scroll) {
        const open = clamp01((el - T_SCROLL_START) / (T_SCROLL_END - T_SCROLL_START))
        const handed = clamp01((el - T_SCROLL_END) / (T_SCROLL_FADE - T_SCROLL_END)) // 交给真正的页面
        // 从中间向两侧展开（scaleX 0.04 → 1），展开完成后淡出，让详情页的竹简接上
        scroll.style.transform = `scaleX(${(0.04 + 0.96 * easeOutCubic(open)).toFixed(4)})`
        scroll.style.opacity = String((open * (1 - handed)).toFixed(3))
      }

      /* ---------- ⑤ 内容以「墨起」浮现 ---------- */
      // 墨涌上来（4700→5050）再退去（5050→5850），退去的过程中底下的内容一点点显出来
      const washP =
        clamp01((el - T_WASH_START) / (T_WASH_PEAK - T_WASH_START)) *
        (1 - clamp01((el - T_WASH_PEAK) / (T_WASH_END - T_WASH_PEAK)))
      const washEl = washRef.current
      if (washEl) washEl.style.opacity = String((washP * 0.92).toFixed(3))

      /* ---------- 模糊与压暗（值已量化：不变就不触发整页重栅格化，更顺） ---------- */
      const dyeBlur =
        el < T_DYE_FULL
          ? BLUR_PEAK * easeOutCubic(clamp01((el - T_DYE_START) / (T_DYE_FULL - T_DYE_START - 500)))
          : BLUR_PEAK * (1 - easeInOutCubic(clamp01((el - T_DYE_FULL) / (T_OUT_END - T_DYE_FULL))))
      const blur = Math.max(0, dyeBlur) + BLUR_EMERGE * washP
      root.style.setProperty('--ink-blur', `${(Math.round(blur * 4) / 4).toFixed(2)}px`)

      const dim = PAGE_DIM + (1 - PAGE_DIM) * (1 - washP)
      root.style.setProperty('--ink-dim', String(Math.round(dim * 50) / 50))

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
      {/* 墨起：内容浮现前涌上来的那层墨 */}
      <div ref={washRef} className="ink-trans-wash" />
    </div>
  )
}
