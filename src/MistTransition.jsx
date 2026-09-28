import { useEffect, useRef } from 'react'

/**
 * 进入测验的「坠入仙境」转场（Day 11，用户指定分镜）：
 *   ① 0–2s   屏幕模糊 + 云雾自下而上升腾（白雾团，营造坠入仙境）
 *   ② 2–5s   淡黑墨自下翻涌遮住屏幕（3 秒涨满）
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

      /* ---------- ② 淡黑墨翻涌（3 秒涨满）→ ③ 散去 ---------- */
      ictx.clearRect(0, 0, W, H)
      if (el >= T_INK_START) {
        const surgeP = clamp01((el - T_INK_START) / (T_COVER - T_INK_START)) // 0→1 涨满
        const outP = clamp01((el - T_COVER) / (T_OUT_END - T_COVER)) // 散去进度
        const alpha = 0.94 * easeInOutCubic(surgeP) * (1 - easeInOutCubic(outP))
        if (alpha > 0.01) {
          const rise = easeInOutCubic(surgeP) * (H * 1.18) // 涨幅略超屏高，保证盖满
          const drift = easeInOutCubic(outP) * H * 0.35 // 散去时整体向上飘走
          // 两层波面：后层更暗更缓，前层翻涌 —— 「翻涌」的层次感
          const layers = [
            { ph: 0, amp: H * 0.045, k: 1, a: 1, v: 1 },
            { ph: 2.1, amp: H * 0.07, k: 1.7, a: 0.55, v: 1.25 },
          ]
          for (const L of layers) {
            ictx.beginPath()
            ictx.moveTo(0, H + 10)
            const STEP = 26
            for (let x = 0; x <= W + STEP; x += STEP) {
              const u = x / W
              const wave =
                Math.sin(u * 9 * L.k + L.ph + el / 260) * L.amp * (0.5 + surgeP * 0.5) +
                Math.sin(u * 17 * L.k - el / 190) * L.amp * 0.5
              const y = H - rise * L.v + drift + wave * (0.4 + surgeP * 0.6)
              ictx.lineTo(x, y)
            }
            ictx.lineTo(W, H + 10)
            ictx.closePath()
            ictx.fillStyle = `rgba(${INK}, ${alpha * L.a})`
            ictx.fill()
          }
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
