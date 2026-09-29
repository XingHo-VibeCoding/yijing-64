import { useEffect, useRef } from 'react'

/**
 * 进入测验的「坠入仙境」转场（Day 11，用户指定分镜）：
 *   ① 0–2s   屏幕模糊 + 云雾自下而上升腾（白雾团，营造坠入仙境）
 *   ② 2–5s   淡黑墨云自下涌过遮住屏幕（流式云团不断涌过，无水线）
 *   ③ 5s     墨盖满的一瞬通知外层换页（藏在墨底下）
 *   ④ 5–6.3s 墨散去，露出测验页
 *
 * 结构与 InkTransition 同族：portal 容器 + canvas + root 上的 CSS 变量（模糊/压暗）。
 * 回调走 latest-ref：covered 时外层换页引发重渲染，动画不能因此重播。
 */

/* 分镜时间轴（ms） */
const T_MIST = 2000 // 云雾段
const T_INK_START = 2000 // 墨开始翻涌
const T_COVER = 5000 // 墨盖满（换页点）
const T_OUT_END = 6300 // 墨散尽
const T_DONE = 6400

const INK = '24, 20, 16' // 淡黑的基色

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

function makeBlobs(W, H) {
  // 云雾团：从屏幕下缘之外升起，横向错落、速度不一
  const blobs = []
  const N = 16
  for (let i = 0; i < N; i++) {
    blobs.push({
      x: (0.04 + 0.92 * (i / (N - 1)) + (Math.random() - 0.5) * 0.06) * W,
      y: H + 40 + Math.random() * H * 0.5, // 起点在屏外下方
      r: (70 + Math.random() * 130) * (W / 1440),
      v: (0.28 + Math.random() * 0.3) * H, // 上升速度 px/s
      sway: 20 + Math.random() * 46, // 横向摆幅
      ph: Math.random() * Math.PI * 2,
      a: 0.16 + Math.random() * 0.2,
      delay: Math.random() * 500, // 升腾的错落感
    })
  }
  return blobs
}

export default function MistTransition({ onCovered, onDone }) {
  const mistRef = useRef(null)
  const inkRef = useRef(null)

  const cbRef = useRef({})
  cbRef.current.onCovered = onCovered
  cbRef.current.onDone = onDone

  useEffect(() => {
    const mistC = mistRef.current
    const inkC = inkRef.current
    const mctx = mistC.getContext('2d')
    const ictx = inkC.getContext('2d')
    if (!mistC || !inkC || !mctx || !ictx) return

    const params = new URLSearchParams(window.location.search)
    const fz = parseFloat(params.get('transFreeze'))
    const FREEZE = Number.isFinite(fz) && fz >= 0 ? fz : null

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = window.innerWidth
    let H = window.innerHeight
    const fit = () => {
      W = window.innerWidth
      H = window.innerHeight
      for (const c of [mistC, inkC]) {
        c.width = Math.round(W * dpr)
        c.height = Math.round(H * dpr)
        c.style.width = W + 'px'
        c.style.height = H + 'px'
      }
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ictx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()

    const blobs = makeBlobs(W, H)

    /* 墨云团（淡黑）：从屏下涌上、软边大团、不断叠加堆积 —— 云感而非水线 */
    const makeClouds = (w, h) => {
      const clouds = []
      const COLS = 8
      const ROWS = 6
      for (let cx = 0; cx < COLS; cx++) {
        for (let cy = 0; cy < ROWS; cy++) {
          clouds.push({
            x: ((cx + 0.5) / COLS + (Math.random() - 0.5) * 0.16) * w,
            y: h + 60 + cy * 90 + Math.random() * 70, // 起点在屏外下方，行错峰
            r: (95 + Math.random() * 140) * (w / 1440),
            v: h * (0.00042 + Math.random() * 0.00026), // px/ms，升速错落
            sway: 26 + Math.random() * 40,
            ph: Math.random() * Math.PI * 2,
            a: 0.10 + Math.random() * 0.09,
            delay: T_INK_START + 60 + Math.random() * 1000, // 墨涌首秒内全部出发（3s 时已铺满中屏）
          })
        }
      }
      return clouds
    }
    const clouds = makeClouds(W, H)

    const root = document.documentElement
    root.classList.add('ink-transitioning') // 复用 .page 的模糊/压暗管道

    const start = performance.now()
    let raf = 0
    let covered = false // 换页 latch（一次性事件）

    const loop = (now) => {
      const el = FREEZE != null ? FREEZE : (now - start)

      /* ---------- 页面模糊与压暗：云雾段屏幕渐模糊（坠入仙境），盖满后换页，散去时复明 ---------- */
      const revealP = clamp01((el - T_COVER) / (T_OUT_END - T_COVER))
      const mistBlur = 10 * easeOutCubic(clamp01(el / 1600))
      const blur = Math.max(mistBlur * (1 - revealP), 6 * (1 - revealP))
      root.style.setProperty('--ink-blur', `${(Math.round(blur * 4) / 4).toFixed(2)}px`)
      const dim = 1 - (1 - 0.15) * easeInOutCubic(clamp01((el - T_INK_START) / (T_COVER - T_INK_START))) * (1 - revealP)
      root.style.setProperty('--ink-dim', String(Math.round(dim * 50) / 50))

      if (!covered && el >= T_COVER) {
        covered = true
        window.scrollTo(0, 0)
        cbRef.current.onCovered && cbRef.current.onCovered()
      }

      /* ---------- ① 云雾层 ---------- */
      mctx.clearRect(0, 0, W, H)
      if (el < T_OUT_END) {
        const t = el / 1000
        const fade = el < T_MIST ? 1 : Math.max(0, 1 - (el - T_MIST) / 1800) // 墨起后雾渐散
        for (const b of blobs) {
          const lt = Math.max(0, el - b.delay)
          if (lt <= 0) continue
          const y = b.y - b.v * (lt / 1000) - easeOutCubic(clamp01(lt / 2500)) * H * 0.35
          if (y < -b.r) continue
          const x = b.x + Math.sin(t * 0.7 + b.ph) * b.sway
          const a = b.a * fade * clamp01(lt / 600)
          if (a <= 0.01) continue
          const g = mctx.createRadialGradient(x, y, 0, x, y, b.r)
          g.addColorStop(0, `rgba(246, 243, 236, ${a})`)
          g.addColorStop(0.55, `rgba(240, 236, 227, ${a * 0.55})`)
          g.addColorStop(1, 'rgba(240, 236, 227, 0)')
          mctx.fillStyle = g
          mctx.beginPath()
          mctx.arc(x, y, b.r, 0, Math.PI * 2)
          mctx.fill()
        }
      }

      /* ---------- ② 淡黑墨「云涌」（确定性流式：墨云不断从屏下涌过）→ ③ 上飘散去 ---------- */
      ictx.clearRect(0, 0, W, H)
      const outP = clamp01((el - T_COVER) / (T_OUT_END - T_COVER))
      if (el >= T_INK_START) {
        const surgeP = clamp01((el - T_INK_START) / (T_COVER - T_INK_START))
        const live = 1 - easeInOutCubic(outP) // 散去时墨云整体变淡
        const LIFE = 2600 // 一朵云从屏下升到屏上的旅程
        for (const c of clouds) {
          if (el < c.delay) continue
          const cycle = ((el - c.delay) * c.v) % (H + c.r * 2) // 确定性：同一 el 永远同一画面
          const y = H + c.r - cycle
          const x = c.x + Math.sin(el / 700 + c.ph) * c.sway
          // 生命包络：出生淡入、临近屏顶淡出（云在远处消散）
          const env = clamp01(cycle / (c.r * 1.5)) * clamp01((H + c.r - cycle) / (c.r * 1.5))
          const a = c.a * env * live * (0.5 + surgeP * 0.5)
          if (a <= 0.01) continue
          const g = ictx.createRadialGradient(x, y, 0, x, y, c.r)
          g.addColorStop(0, `rgba(${INK}, ${a})`)
          g.addColorStop(0.6, `rgba(${INK}, ${a * 0.62})`)
          g.addColorStop(1, `rgba(${INK}, 0)`)
          ictx.fillStyle = g
          ictx.beginPath()
          ictx.arc(x, y, c.r, 0, Math.PI * 2)
          ictx.fill()
        }
        // 兜底薄纱：墨涌后半段渐渐铺实，盖满前保证全屏遮蔽（换页藏在下面）
        const veil = 0.92 * easeInOutCubic(clamp01((el - 3900) / (T_COVER - 3900))) * (1 - easeInOutCubic(outP))
        if (veil > 0.01) {
          ictx.fillStyle = `rgba(${INK}, ${veil})`
          ictx.fillRect(0, 0, W, H)
        }
      }

      if (el >= T_DONE) {
        root.classList.remove('ink-transitioning')
        root.style.removeProperty('--ink-blur')
        root.style.removeProperty('--ink-dim')
        cbRef.current.onDone && cbRef.current.onDone()
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
  }, [])

  return (
    <div className="ink-trans" role="presentation">
      <canvas ref={mistRef} className="ink-trans-canvas" />
      <canvas ref={inkRef} className="ink-trans-canvas" />
    </div>
  )
}
