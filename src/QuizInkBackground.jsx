import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * 测验页的水墨底（Day 11 追加，用户指定的美术方向）
 *
 * 构图参照用户给的水墨样例：**白宣打底 + 云气水墨**——左上到右下的浓墨漩涡笔触、
 * 中右侧大团白色云气、四角浓墨压边；整体持续缓慢流动（笔触沿漩涡呼吸式摆动 + 云气漂移）。
 * 中央留一块亮底（白色薄雾）保证题面文字可读。
 *
 * 两条工程约定（本项目 canvas 动画的教训）：
 *   ① **确定性逐帧重绘**：随机量初始化时一次性生成，画面只是 el 的函数 —— 同一 el 永远同一画面，
 *      `?transFreeze` 定格才可信（累积式画法在 freeze 下会瞬间糊死）；
 *   ② 每帧 clearRect 后整幅重画，不做跨帧残留。
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v))

export default function QuizInkBackground() {
  const ref = useRef(null)

  useEffect(() => {
    const cv = ref.current
    const ctx = cv.getContext('2d')
    if (!cv || !ctx) return

    const params = new URLSearchParams(window.location.search)
    const fz = parseFloat(params.get('transFreeze'))
    const FREEZE = Number.isFinite(fz) && fz >= 0 ? fz : null

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = 0
    let H = 0

    /* ---------- 随机量：一次性生成，之后只做时间函数 ---------- */
    // 浓墨笔触：分「束」成扇 —— 每束围绕螺旋上的一个位置展开，像一笔扫出的扇面（毛笔感）
    const GROUPS = 18
    const strokes = []
    for (let g = 0; g < GROUPS; g++) {
      const gt = g / GROUPS
      const baseAng = gt * Math.PI * 2.35 - 1.15
      const baseRad = 0.07 + gt * 0.95
      const n = 12 + Math.floor(Math.random() * 10) // 每束的笔数
      for (let i = 0; i < n; i++) {
        strokes.push({
          ang: baseAng + (Math.random() - 0.5) * 0.2, // 扇面展开
          rad: baseRad * (1 + (Math.random() - 0.5) * 0.34),
          len: 0.03 + Math.random() * 0.055, // 笔触长度（沿弧）
          w: 5 + Math.random() * 13, // 笔宽（毛笔粗度）
          a: 0.14 + Math.random() * 0.34, // 墨色浓度
          ph: Math.random() * Math.PI * 2,
          jit: 0.4 + Math.random() * 1.2,
        })
      }
    }
    // 白色云气团（中右侧为主）
    const CLOUDS = 18
    const clouds = []
    for (let i = 0; i < CLOUDS; i++) {
      const central = i < 12
      clouds.push({
        u: central ? 0.34 + Math.random() * 0.52 : Math.random(), // 归一化 x
        v: central ? 0.28 + Math.random() * 0.44 : Math.random(), // 归一化 y
        r: (110 + Math.random() * 190) * 0.9,
        a: 0.5 + Math.random() * 0.45,
        ph: Math.random() * Math.PI * 2,
        sp: 4 + Math.random() * 12, // 漂移幅度（px）
      })
    }

    const fit = () => {
      W = window.innerWidth
      H = window.innerHeight
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
      cv.style.width = W + 'px'
      cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()

    const start = performance.now()
    let raf = 0

    const draw = (now) => {
      const el = FREEZE != null ? FREEZE : now - start
      const T = el / 1000

      // ① 白宣底（带极轻的暖灰渐变，避免死白）
      ctx.clearRect(0, 0, W, H)
      const bg = ctx.createLinearGradient(0, 0, W * 0.6, H)
      bg.addColorStop(0, '#f8f6f2')
      bg.addColorStop(0.6, '#f3f1ec')
      bg.addColorStop(1, '#eceae4')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, W, H)

      // ② 四角浓墨压边（上左、右下最重）
      const corners = [
        { x: 0.06, y: 0.04, r: 0.62, a: 0.5 },
        { x: 0.97, y: 0.98, r: 0.58, a: 0.46 },
        { x: 0.02, y: 1.0, r: 0.36, a: 0.3 },
        { x: 1.0, y: 0.06, r: 0.3, a: 0.22 },
      ]
      for (const c of corners) {
        const cx = c.x * W
        const cy = c.y * H
        const r = c.r * Math.max(W, H)
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
        g.addColorStop(0, `rgba(18, 17, 15, ${c.a})`)
        g.addColorStop(0.45, `rgba(24, 22, 20, ${c.a * 0.5})`)
        g.addColorStop(1, 'rgba(24, 22, 20, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fill()
      }

      // ③ 浓墨笔触：沿漩涡排布，随时间沿弧摆动（「流动」的主体）
      const ox = W * 0.3
      const oy = H * 0.22
      const swirl = Math.min(W, H) * 1.5
      const SPAN = Math.PI * 2.35
      // 螺旋上的取点（含随时间的摆动 = 笔触在「走」）
      const pt = (ang, rad, out) => [ox + Math.cos(ang) * rad * swirl * 0.85 * out, oy + Math.sin(ang) * rad * swirl * 0.6 * out]
      ctx.lineCap = 'round'
      for (const s of strokes) {
        const breathe = Math.sin(T * 0.55 + s.ph) * s.jit
        const ang = s.ang + breathe * 0.022 + T * 0.012
        const rad = s.rad
        const [x, y] = pt(ang, rad, 1)
        if (x < -120 || x > W + 120 || y < -120 || y > H + 120) continue
        const [x2, y2] = pt(ang + s.len * SPAN, rad * 1.02, 1)
        // 锥形笔触：沿二次曲线分 7 段，宽度按两端尖的包络 —— 毛笔拖曳感（不是平行棍）
        const SEGS = 7
        const cx = (x + x2) / 2 + breathe * 9
        const cy = (y + y2) / 2 - breathe * 7
        const q = (t) => {
          const it = 1 - t
          return [it * it * x + 2 * it * t * cx + t * t * x2, it * it * y + 2 * it * t * cy + t * t * y2]
        }
        for (let k = 0; k < SEGS; k++) {
          const t0 = k / SEGS
          const t1 = (k + 1) / SEGS
          const env = Math.sin(Math.PI * (0.1 + 0.8 * ((t0 + t1) / 2))) // 两头尖、中间粗
          const [ax, ay] = q(t0)
          const [bx, by] = q(t1)
          ctx.beginPath()
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx, by)
          ctx.strokeStyle = `rgba(18, 16, 14, ${s.a * env * 1.5})`
          ctx.lineWidth = Math.max(0.6, s.w * env)
          ctx.stroke()
        }
      }

      // ④ 白色云气团：中右侧大团翻卷（缓慢漂移 = 云在流）
      for (const c of clouds) {
        const x = c.u * W + Math.sin(T * 0.22 + c.ph) * c.sp
        const y = c.v * H + Math.cos(T * 0.17 + c.ph) * c.sp * 0.7
        const gw = c.r * (1 + 0.08 * Math.sin(T * 0.3 + c.ph))
        const g = ctx.createRadialGradient(x, y, gw * 0.15, x, y, gw)
        g.addColorStop(0, `rgba(252, 251, 249, ${c.a})`)
        g.addColorStop(0.6, `rgba(250, 249, 246, ${c.a * 0.6})`)
        g.addColorStop(1, 'rgba(250, 249, 246, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, gw, 0, Math.PI * 2)
        ctx.fill()
      }

      // ⑤ 中央亮底：保证题面文字可读（白雾薄纱，随呼吸微微起伏）
      const veilR = Math.min(W * 0.5, H * 0.62)
      const veila = 0.72 + 0.05 * Math.sin(T * 0.5)
      const vg = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, veilR)
      vg.addColorStop(0, `rgba(250, 249, 247, ${veila})`)
      vg.addColorStop(0.65, `rgba(249, 248, 245, ${veila * 0.5})`)
      vg.addColorStop(1, 'rgba(249, 248, 245, 0)')
      ctx.fillStyle = vg
      ctx.fillRect(0, 0, W, H)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    const onResize = () => fit()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // ⚠️ 必须 portal 到 body：转场期间 .page 带 filter（模糊），filter 会把 fixed 子元素的
  // 定位基准从视口改成 .page 盒子 → 画布只盖住卡片盒，四周露出木底（「不完整页面」事故）。
  // portal 出去 + z-index:-1：藏在不透明页面之后、body 木纹之前，测验页透明让出底色。
  return createPortal(<canvas ref={ref} className="quiz-ink-canvas" aria-hidden="true" />, document.body)
}
