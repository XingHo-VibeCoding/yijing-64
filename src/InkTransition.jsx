import { useEffect, useRef } from 'react'
import HexagramFigure from './HexagramFigure.jsx'
import { makeDotTexture } from './CastingAnimation.jsx'

/**
 * 点击总表某一卦后的转场（F1 → F2）：
 *   涟漪 → 淡墨侵染（屏幕逐渐变模糊）→ 约 3 秒后墨散 → 卦象浮现在屏幕中央
 *   → 约 1 秒后卦象移到详情页里它本来的位置，其余内容浮现
 *
 * 两条来自「带时间轴动画」的经验，写死在这里：
 *   ① **先有 `?transSpeed` / `?transFreeze` 再写动画** —— 5 秒多的转场靠 sleep 猜帧必然抓错
 *   ② 所有 opacity / blur / transform 都是**关于 elapsed 的连续函数**（不用 CSS transition 补间、不用 latch），
 *      这样 `?transFreeze=2000` 直接跳到中段时，画面也和真实进度一致
 */
const INK = '22,19,17'

const T_RIPPLE_END = 700      // 涟漪
const T_DYE_START = 250       // 墨开始侵染
const T_DYE_FULL = 3000       // 基本铺满
const T_OUT_END = 3800        // 墨散尽
const T_CENTER_START = 3500   // 卦象在屏幕中央浮现（墨还没散完就开始，接得上）
const T_CENTER_END = 4600
const T_MOVE_START = 4600     // 卦象移向详情页里它本来的位置
const T_MOVE_END = 5500
const T_DONE = 5600

const BLUR_PEAK = 7           // 峰值模糊（px）
const PAGE_DIM = 0.25         // 墨盖着时，底下内容压暗到多少

const SPEED = (() => {
  if (typeof window === 'undefined') return 1
  const v = parseFloat(new URLSearchParams(window.location.search).get('transSpeed'))
  return Number.isFinite(v) && v > 0 ? v : 1
})()

/** 调试用：?transFreeze=2000 把转场定格在第 2 秒（墨仍在流动），用于逐帧截图核对 */
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
 * 侵染感来自**痕迹会留下** —— 每帧把当前前沿的墨点画进一张**不清空的** stain 画布，越积越浓。
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
    })
  }
  return { rays, diag, origin }
}

export default function InkTransition({ lines, origin, onDone }) {
  const canvasRef = useRef(null)
  const figRef = useRef(null)

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

    /* 目标位置：详情页里那张卦象图。趁墨还盖着屏幕时先把它滚到视野中间（用户看不见） */
    let target = null
    setTimeout(() => {
      const el = document.querySelector('.figure-wrap .figure')
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      // 滚动后再量一次（滚动是异步生效的）
      requestAnimationFrame(() => {
        target = el.getBoundingClientRect()
      })
    }, 420)

    const loop = (now) => {
      const el = FREEZE != null ? FREEZE : (now - start) * SPEED

      /* ---------- 1. 涟漪 ---------- */
      ctx.clearRect(0, 0, W, H)
      if (el < T_RIPPLE_END) {
        const p = clamp01(el / T_RIPPLE_END)
        for (let k = 0; k < 3; k++) {
          const kp = clamp01(p - k * 0.16)
          if (kp <= 0) continue
          const r = easeOutCubic(kp) * diag * 0.55
          ctx.beginPath()
          ctx.arc(o.x, o.y, r, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${INK},${0.42 * (1 - kp) * (1 - k * 0.25)})`
          ctx.lineWidth = 2.5 - k * 0.6
          ctx.stroke()
        }
      }

      /* ---------- 2. 墨的侵染 ---------- */
      const dyeP = clamp01((el - T_DYE_START) / (T_DYE_FULL - T_DYE_START))
      if (dyeP > 0) {
        // 2a. 前沿墨点 → 画进不清空的 stain（痕迹留下 = 侵染）
        for (const r of rays) {
          const t = el - T_DYE_START - r.delay
          if (t <= 0) continue
          const rad = t * r.v
          if (rad > diag) continue
          const wob = Math.sin(now * r.wobF + r.wob) * 26
          const d = r.size * diag
          sctx.globalAlpha = 0.085
          sctx.drawImage(dot, o.x + r.cos * rad - wob * r.sin - d, o.y + r.sin * rad + wob * r.cos - d, d * 2, d * 2)
          sctx.globalAlpha = 0.055
          sctx.drawImage(dot, o.x + r.cos * (rad * 0.72) - d, o.y + r.sin * (rad * 0.72) - d, d * 2, d * 2)
        }
        sctx.globalAlpha = 1

        // 2b. 整片漫开的水渍：保证铺满，边缘随半径推进
        const cr = easeInOutCubic(dyeP) * diag * 1.05
        const wash = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Math.max(1, cr))
        wash.addColorStop(0, `rgba(${INK},0.62)`)
        wash.addColorStop(0.62, `rgba(${INK},0.42)`)
        wash.addColorStop(0.88, `rgba(${INK},0.14)`)
        wash.addColorStop(1, `rgba(${INK},0)`)
        ctx.fillStyle = wash
        ctx.fillRect(0, 0, W, H)

        // 2c. 前沿的亮墨（正在爬的那条边）—— 动感主要来自这里
        for (const r of rays) {
          const t = el - T_DYE_START - r.delay
          if (t <= 0) continue
          const rad = t * r.v
          if (rad > diag) continue
          const wob = Math.sin(now * r.wobF + r.wob) * 30
          const d = r.size * diag * 1.25
          ctx.globalAlpha = 0.20
          ctx.drawImage(dot, o.x + r.cos * rad - wob * r.sin - d, o.y + r.sin * rad + wob * r.cos - d, d * 2, d * 2)
        }
        ctx.globalAlpha = 1
      }

      /* 墨的整体浓度：侵染期 1，散去期 → 0（用连续函数，不用 latch） */
      const inkAlpha = el < T_DYE_FULL ? 1 : 1 - easeInOutCubic(clamp01((el - T_DYE_FULL) / (T_OUT_END - T_DYE_FULL)))
      canvas.style.opacity = String(clamp01(inkAlpha))

      /* ---------- 3. 屏幕模糊 + 底下的内容压暗 ---------- */
      const blur = el < T_DYE_FULL
        ? BLUR_PEAK * easeOutCubic(clamp01((el - T_DYE_START) / (T_DYE_FULL - T_DYE_START - 500)))
        : BLUR_PEAK * (1 - easeInOutCubic(clamp01((el - T_DYE_FULL) / (T_OUT_END - T_DYE_FULL))))
      root.style.setProperty('--ink-blur', `${Math.max(0, blur).toFixed(2)}px`)

      const contentP = clamp01((el - T_MOVE_START) / (T_MOVE_END - T_MOVE_START))
      root.style.setProperty('--ink-dim', String(PAGE_DIM + (1 - PAGE_DIM) * contentP))

      /* ---------- 4. 卦象：先在屏幕中央浮现 ---------- */
      const fig = figRef.current
      if (fig) {
        const inP = clamp01((el - T_CENTER_START) / (T_CENTER_END - T_CENTER_START))
        fig.style.opacity = String(inP)

        // 5. 移向详情页里它本来的位置（从中心 → 目标 rect，同时缩到目标大小）
        const moveP = clamp01((el - T_MOVE_START) / (T_MOVE_END - T_MOVE_START))
        if (moveP > 0 && target) {
          const fr = fig.getBoundingClientRect()
          const dx = (target.left + target.width / 2) - (fr.left + fr.width / 2)
          const dy = (target.top + target.height / 2) - (fr.top + fr.height / 2)
          const sc = 1 + ((target.width / fr.width) - 1) * easeInOutCubic(moveP)
          const px = easeInOutCubic(moveP)
          // 注意：fr 会随上一次的 transform 变化，所以用「目标中心 vs 当前中心」的差直接累加到位移上
          fig.style.transform = `translate(${dx * px}px, ${dy * px}px) scale(${sc})`
        }
      }

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
      <div className="ink-trans-stage">
        <div ref={figRef} className="ink-trans-fig">
          <HexagramFigure lines={lines} size="lg" labels={false} />
        </div>
      </div>
    </div>
  )
}
