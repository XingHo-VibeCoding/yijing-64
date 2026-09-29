import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

const T_COVER = 1150 // 墨云涌起遮满全屏的时刻（此刻换题）
const T_END = 2350 // 墨散完毕
const INK = '24, 20, 16'
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp01 = (t) => Math.min(1, Math.max(0, t))

/**
 * 测验「下一题」的黑墨翻涌转场：墨云自下涌起遮住全屏 → 遮满一瞬换题（onCovered）
 * → 墨散露新题（onDone）。
 * 与 InkTransition/MistTransition 同族约定：portal 到 body（防 filter 改 fixed 基准）、
 * 确定性逐帧重绘（同 el 同画面）、onCovered 一次性 latch、回调走 latest-ref。
 */
export default function QuizInkSweep({ onCovered, onDone }) {
  const ref = useRef(null)
  const cbRef = useRef({})
  cbRef.current = { onCovered, onDone }

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas.getContext('2d')
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(window.innerWidth * dpr)
    canvas.height = Math.round(window.innerHeight * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const VW = window.innerWidth
    const VH = window.innerHeight

    /* 墨云团：网格错峰自下涌过（确定性：同一 el 永远同一画面） */
    const clouds = []
    const COLS = 8
    const ROWS = 4
    for (let cx = 0; cx < COLS; cx++) {
      for (let cy = 0; cy < ROWS; cy++) {
        clouds.push({
          x: ((cx + 0.5) / COLS + (Math.random() - 0.5) * 0.14) * VW,
          r: (90 + Math.random() * 130) * (VW / 1440),
          v: VH * (0.00055 + Math.random() * 0.00035),
          sway: 18 + Math.random() * 30,
          ph: Math.random() * Math.PI * 2,
          a: 0.16 + Math.random() * 0.12,
          delay: Math.random() * 500,
        })
      }
    }

    const start = performance.now()
    let covered = false
    let raf = 0
    /* ?transFreeze=N：定格在 N ms 的画面（与 InkTransition/MistTransition 同约定），只画不走 */
    const freezeRaw = new URLSearchParams(window.location.search).get('transFreeze')
    const frozen = freezeRaw === null ? null : Number(freezeRaw)

    const frame = (now) => {
      const el = frozen !== null ? frozen : now - start
      const outP = clamp01((el - T_COVER) / (T_END - T_COVER))
      ctx.clearRect(0, 0, VW, VH)

      for (const c of clouds) {
        if (el < c.delay) continue
        const cycle = ((el - c.delay) * c.v) % (VH + c.r * 2)
        const y = VH + c.r - cycle
        const x = c.x + Math.sin(el / 650 + c.ph) * c.sway
        /* 生命包络：出生淡入、行至屏顶淡出 */
        const env = clamp01(cycle / (c.r * 1.4)) * clamp01((VH + c.r - cycle) / (c.r * 1.4))
        const surge = clamp01(el / (T_COVER * 0.8))
        const a = c.a * env * (0.35 + 0.65 * surge) * (1 - easeInOutCubic(outP))
        if (a <= 0.01) continue
        const g = ctx.createRadialGradient(x, y, 0, x, y, c.r)
        g.addColorStop(0, `rgba(${INK}, ${a})`)
        g.addColorStop(0.6, `rgba(${INK}, ${a * 0.6})`)
        g.addColorStop(1, `rgba(${INK}, 0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, c.r, 0, Math.PI * 2)
        ctx.fill()
      }

      /* 兜底墨面：涌起后半段渐渐铺实（盖满前保证全屏遮蔽，换题藏在下面）；
         散去时整体变淡并向上飘走 */
      const veil = 0.95 * easeInOutCubic(clamp01((el - 350) / (T_COVER - 350))) * (1 - easeInOutCubic(outP))
      if (veil > 0.01) {
        ctx.fillStyle = `rgba(${INK}, ${veil})`
        ctx.fillRect(0, -easeInOutCubic(outP) * VH * 0.25, VW, VH)
      }

      if (frozen !== null) return // 定格：只画一帧，不触发回调不推进
      if (!covered && el >= T_COVER) {
        covered = true
        cbRef.current.onCovered && cbRef.current.onCovered()
      }
      if (el >= T_END) {
        cbRef.current.onDone && cbRef.current.onDone()
        return
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return createPortal(
    <div className="q-sweep" role="presentation">
      <canvas ref={ref} aria-hidden="true" />
    </div>,
    document.body
  )
}
