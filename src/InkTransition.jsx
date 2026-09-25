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

const T_RIPPLE_END = 1100     // 涟漪（水波：一整列波峰推进，比原来长一点才看得出是水）
const T_DYE_START = 350       // 墨开始侵染（让涟漪先单独亮一会儿）
const T_DYE_FULL = 3000       // 基本铺满
const T_OUT_END = 3800        // 墨散尽
const T_CENTER_START = 3500   // 卦象在屏幕中央浮现（墨还没散完就开始，接得上）
const T_CENTER_END = 4600
const T_MOVE_START = 4600     // 卦象移向详情页里它本来的位置
const T_MOVE_END = 5500
const T_DONE = 5600

const BLUR_PEAK = 10          // 峰值模糊（px）
const PAGE_DIM = 0.15         // 墨盖着时，底下内容压暗到多少（压得更狠 = 遮得更完全）
const T_FLOOD_START = 1600    // 整片淹没的起点：保证**完全**盖住，不留缝

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
      last: 0,                                             // 该射线已经洇到多远（落点按距离算）
    })
  }
  return { rays, diag, origin }
}

/** 墨痕落点的间距（px）：按距离落而不是按帧落，密度才与帧率 / 定格 / 慢放无关 */
const SPACING = 9
/** 圆心留白半径：这一圈交给水渍渐变（否则所有射线的墨点都叠在圆心，立刻黑成一团） */
const R0 = 120

export default function InkTransition({ lines, origin, onDone }) {
  const canvasRef = useRef(null)
  const figRef = useRef(null)
  const haloRef = useRef(null)

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
    let figBase = null // 卦象浮现阶段还没缩放时的基准宽度（只量一次）

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

      /* ---------- 1. 涟漪：一列水波向外推进 ----------
         单个细圆圈只会读成「展开的环」，水的感觉来自三点：
         ① 一整列波峰（波长固定）② 每个波峰有厚度（外柔边）+ 一道水面反光
         ③ 最前方还带一层极淡的水膜，看着是「水被推开」而不是「画了个圆」。
         包络用正弦：中间的波峰最强、首尾都弱。 */
      ctx.clearRect(0, 0, W, H)
      if (el < T_RIPPLE_END + 220) {
        const p = clamp01(el / T_RIPPLE_END)
        const front = easeOutCubic(p) * diag * 0.62
        const LAMBDA = 58 // 波长
        const CRESTS = 6 // 波峰数
        for (let k = 0; k < CRESTS; k++) {
          const r = front - k * LAMBDA
          if (r <= 3) continue
          const env = Math.sin((Math.PI * (k + 0.6)) / CRESTS)
          const a = 0.50 * env * (1 - p) * (1 - k / (CRESTS * 1.8))
          if (a <= 0.002) continue
          ctx.beginPath()
          ctx.arc(o.x, o.y, r, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${INK},${a * 0.40})`
          ctx.lineWidth = 12 // 外柔边：水波的厚度
          ctx.stroke()
          ctx.strokeStyle = `rgba(${INK},${a})`
          ctx.lineWidth = 4.5 // 波峰本体
          ctx.stroke()
          ctx.strokeStyle = `rgba(255,255,255,${a * 0.55})` // 水面反光
          ctx.lineWidth = 1.6
          ctx.stroke()
        }
        if (front > 8) {
          const g = ctx.createRadialGradient(o.x, o.y, Math.max(1, front * 0.5), o.x, o.y, front)
          g.addColorStop(0, `rgba(${INK},0)`)
          g.addColorStop(0.84, `rgba(${INK},${0.10 * (1 - p)})`)
          g.addColorStop(1, `rgba(${INK},0)`)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(o.x, o.y, front, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      /* ---------- 2. 墨的侵染 ---------- */
      const dyeP = clamp01((el - T_DYE_START) / (T_DYE_FULL - T_DYE_START))
      if (dyeP > 0) {
        // 2a. 前沿墨点 → 画进不清空的 stain（痕迹留下 = 侵染）
        // ⚠️ 落点按「前进的距离」每隔 SPACING 一个，**不按帧** —— 按帧落的话，
        //    帧率、?transFreeze、?transSpeed 都会改变墨的密度（定格久了还会黑成一团）
        for (const r of rays) {
          const t = el - T_DYE_START - r.delay
          if (t <= 0) continue
          const rad = Math.min(t * r.v, diag)
          const from = r.last || 0
          if (rad <= from) continue
          const steps = Math.ceil((rad - from) / SPACING)
          for (let i = 1; i <= steps; i++) {
            const rr = from + ((rad - from) * i) / steps
            // 圆心一小圈交给平滑的水渍渐变去画 —— 所有射线都从点击点出发，
            // 上百条射线的早期墨点会全部叠在圆心，立刻黑成一团（实测踩中）
            if (rr < R0) continue
            const wob = Math.sin((now + i * 37) * r.wobF + r.wob) * 26
            const d = r.size * diag
            // 离开 R0 后再慢慢变实：像从中心「洇」出来，而不是「炸」出来
            const ramp = Math.min(1, (rr - R0) / 260)
            sctx.globalAlpha = 0.125 * ramp
            sctx.drawImage(dot, o.x + r.cos * rr - wob * r.sin - d, o.y + r.sin * rr + wob * r.cos - d, d * 2, d * 2)
            sctx.globalAlpha = 0.085 * ramp
            sctx.drawImage(dot, o.x + r.cos * (rr * 0.72) - d, o.y + r.sin * (rr * 0.72) - d, d * 2, d * 2)
          }
          r.last = rad
        }
        sctx.globalAlpha = 1

        // 2b. 整片漫开的水渍（铺得快、铺得浓；但**浓度随侵染进度一起长**——
        //     不然第一帧点击点就是一团实心黑，太突兀）
        const cr = easeOutCubic(dyeP) * diag * 1.15
        const strength = 0.35 + 0.65 * dyeP
        const wash = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, Math.max(1, cr))
        wash.addColorStop(0, `rgba(${INK},${0.86 * strength})`)
        wash.addColorStop(0.60, `rgba(${INK},${0.74 * strength})`)
        wash.addColorStop(0.86, `rgba(${INK},${0.46 * strength})`)
        wash.addColorStop(1, `rgba(${INK},${0.14 * strength})`)
        ctx.fillStyle = wash
        ctx.fillRect(0, 0, W, H)

        // 2c. 整片淹没：墨点之间总有缝，靠这一步把缝彻底合上（「遮挡要完全」的关键）
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

      /* 墨的整体浓度：侵染期 1，散去期 → 0（用连续函数，不用 latch） */
      const inkAlpha = el < T_DYE_FULL ? 1 : 1 - easeInOutCubic(clamp01((el - T_DYE_FULL) / (T_OUT_END - T_DYE_FULL)))
      canvas.style.opacity = String(clamp01(inkAlpha))

      /* ---------- 3. 屏幕模糊 + 底下的内容压暗 ----------
         ⚠️ 流畅度：每帧改 filter 会强制整页重新栅格化。量化到 0.25px 一档、亮度到 0.02 一档，
        值没变就不触发重绘 —— 肉眼分不出差异，但整页模糊这条最贵的路径少跑一大半。 */
      const blur = el < T_DYE_FULL
        ? BLUR_PEAK * easeOutCubic(clamp01((el - T_DYE_START) / (T_DYE_FULL - T_DYE_START - 500)))
        : BLUR_PEAK * (1 - easeInOutCubic(clamp01((el - T_DYE_FULL) / (T_OUT_END - T_DYE_FULL))))
      root.style.setProperty('--ink-blur', `${(Math.round(Math.max(0, blur) * 4) / 4).toFixed(2)}px`)

      const contentP = clamp01((el - T_MOVE_START) / (T_MOVE_END - T_MOVE_START))
      const dim = PAGE_DIM + (1 - PAGE_DIM) * contentP
      root.style.setProperty('--ink-dim', String(Math.round(dim * 50) / 50))

      /* ---------- 4. 卦象浮现（神秘感：从墨雾里浮出） ---------- */
      const fig = figRef.current
      const halo = haloRef.current
      const inP = clamp01((el - T_CENTER_START) / (T_CENTER_END - T_CENTER_START))
      const moveP = clamp01((el - T_MOVE_START) / (T_MOVE_END - T_MOVE_START))

      // 光晕：先亮起来托住卦象，再慢慢收回去（「有东西浮出来」而不是「图片淡入」）
      if (halo) {
        const up = clamp01((el - T_CENTER_START) / 900)
        const down = clamp01((el - 5200) / 400)
        halo.style.opacity = String((0.9 * up * (1 - down)).toFixed(3))
      }

      if (fig) {
        fig.style.opacity = String(inP.toFixed(3))
        // 从模糊到清晰：14px → 0 —— 像隔着一层雾辨认出它
        fig.style.filter = `blur(${(14 * (1 - easeInOutCubic(inP))).toFixed(2)}px)`

        // 基准尺寸只量一次（量当前 rect 会把已应用的缩放再乘一遍，越乘越小）
        if (!figBase && el < T_MOVE_START) {
          const r0 = fig.getBoundingClientRect()
          if (r0.width > 0) figBase = { w: r0.width }
        }

        // 5. 移向详情页里它本来的位置（从中心 → 目标 rect，同时缩到目标大小）
        let scale = 0.94 + 0.06 * easeOutCubic(inP) // 浮现时轻微放大，像浮近了一点
        let tx = 0
        let ty = 0
        if (moveP > 0 && target && figBase) {
          const fr = fig.getBoundingClientRect()
          const mp = easeInOutCubic(moveP)
          // fr 已含上一帧的位移，所以这个差就是「还差多少」；mp→1 时正好落到位
          tx = ((target.left + target.width / 2) - (fr.left + fr.width / 2)) * mp
          ty = ((target.top + target.height / 2) - (fr.top + fr.height / 2)) * mp
          scale *= 1 + ((target.width / figBase.w) - 1) * mp
        }
        fig.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(4)})`
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
        {/* 光晕：卦象从墨雾里浮出来时，先有这么一团托着它（神秘感） */}
        <div ref={haloRef} className="ink-trans-halo" />
        <div ref={figRef} className="ink-trans-fig">
          <HexagramFigure lines={lines} size="lg" labels={false} />
        </div>
      </div>
    </div>
  )
}
