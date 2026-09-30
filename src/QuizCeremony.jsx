import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 测验终局仪式（Day 12 · 用户指定分镜）
 *
 * fail（未达容错）：
 *   黑云翻涌遮屏（深黑夹杂淡黑，遮住后持续翻涌）→ 白色毛笔隶书「运随时变，切勿焦躁」
 *   → 点击 → 黑云消散（露出已切好的主页）→ 回总表
 * pass（达成容错）：
 *   白云翻涌遮屏（持续翻涌）→ 砂金毛笔隶书「静神定心，自有所得」
 *   → 点击 → 云雾散开露出「太虚幻境」式水墨门庭（黑白两色云雾缭绕涌动）
 *   → 1s 后门开 + 运镜推近 → 云雾中浮现镀金卦象（只有卦象与卦名）→ 点击 → 白云翻涌遮屏 → 散开回总表
 *
 * 工程约定与 QuizInkSweep 同族：portal 到 body、rAF 状态机、点击只在交互相（motto/reward）生效。
 */

const T_COVER = 900
const T_DISPERSE = 1000
const GATE_CHURN = 1600 // 门庭云雾涌动（含「一秒后门开」的静置）
const T_DOOR = 1400 // 开门 + 运镜
const T_EXIT_COVER = 450
const T_EXIT_FADE = 850

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

const MOTTO = { fail: '运随时变，切勿焦躁', pass: '静神定心，自有所得' }

/* 调试定格（与另两个转场的 ?transFreeze 同族，生产不带参数即自动推进）：
   ?qcHold=gate,door → 列出的相位改为「点击才推进」，便于逐帧截图核对 */
const QC_HOLD = (() => {
  try {
    return (new URLSearchParams(window.location.search).get('qcHold') || '').split(',').filter(Boolean)
  } catch {
    return []
  }
})()
const held = (name) => QC_HOLD.includes(name)

/* 云雾涌动场：极坐标分布的一团团软雾，绕屏心缓慢旋转 + 呼吸（确定性：puffs 只在挂载时生成一次） */
function makePuffs() {
  const puffs = []
  for (let i = 0; i < 68; i++) {
    puffs.push({
      ang: Math.random() * Math.PI * 2, // 极角
      al: 0.22 + Math.random() * 0.5, // 这团雾的浓度（有浓有淡才有翻涌层次）
      d: 0.1 + Math.random() * 0.55, // 归一化半径
      r: 88 + Math.random() * 158,
      sp: 0.1 + Math.random() * 0.22,
      ph: Math.random() * Math.PI * 2,
      tone: Math.random(), // 深浅
    })
  }
  return puffs
}

export default function QuizCeremony({ variant = 'fail', reward = null, onCovered, onHome }) {
  const canvasRef = useRef(null)
  const [phase, setPhase] = useState('cover')
  const st = useRef({ phase: 'cover', pt: 0, covered: false, switched: false, raf: 0 })
  const cb = useRef({})
  cb.current = { onCovered, onHome }

  useEffect(() => {
    const cv = canvasRef.current
    const ctx = cv.getContext('2d')
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = 0
    let H = 0
    let S = 1
    const fit = () => {
      W = window.innerWidth
      H = window.innerHeight
      S = Math.min(W, H) / 1080
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
      cv.style.width = W + 'px'
      cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()
    window.addEventListener('resize', fit)
    // 仪式期间藏掉底层页面的滚动条（否则右缘会露出一条白条）
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const isPass = variant === 'pass'
    const puffs = makePuffs()
    const start = performance.now()
    st.current.pt = start
    let raf = 0

    /* 相位推进：canvas 走 st.current.phase，DOM（题字/卦象）走 phase state */
    const go = (next) => {
      st.current.phase = next
      st.current.pt = now0()
      setPhase(next)
    }
    const now0 = () => performance.now()

    const soft = (x, y, r, rgb, a) => {
      if (a <= 0.01 || r <= 0) return
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(${rgb}, ${a})`)
      g.addColorStop(0.45, `rgba(${rgb}, ${a * 0.55})`)
      g.addColorStop(0.75, `rgba(${rgb}, ${a * 0.2})`)
      g.addColorStop(1, `rgba(${rgb}, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    /* 云雾场：黑（深黑+淡黑）或白；k = 不透明度，drift = 整体上飘距离 */
    const drawCloudField = (t, k, drift, isWhite) => {
      if (k <= 0.01) return
      for (const p of puffs) {
        const ang = p.ang + t * 0.00017 * p.sp * 8
        const d = (p.d + 0.12 * Math.sin(t * 0.0004 * p.sp + p.ph)) * Math.max(W, H)
        const x = W / 2 + Math.cos(ang) * d + Math.sin(t * 0.0006 + p.ph) * 30 * S
        const y = H / 2 + Math.sin(ang) * d * 0.72 + Math.cos(t * 0.0005 + p.ph) * 22 * S - drift
        const r = p.r * S * (1 + 0.14 * Math.sin(t * 0.0008 * p.sp + p.ph))
        const a = p.al * k * (0.72 + 0.28 * Math.sin(t * 0.001 * p.sp + p.ph))
        if (isWhite) {
          // 白云：多数纯白堆叠、少数浅灰垫层次 → 云海有起伏不老是一片死白
          soft(x, y, r, p.tone > 0.42 ? '255, 255, 255' : '212, 208, 199', Math.min(0.95, a))
        } else {
          soft(x, y, r, p.tone > 0.55 ? '44, 39, 34' : '6, 5, 4', Math.min(0.96, a))
        }
      }
    }

    /* 水墨门庭：墨晕底 + 门后天光 + 立柱/楣梁/门扇（笔触带洇边）+「太虚幻境」匾
       四周黑白两色云雾缭绕涌动 */
    const drawGate = (t, openK, zoomK) => {
      // 墨底：深墨晕 + 中央透出的微光（门后的天光）
      ctx.fillStyle = '#0e0c09'
      ctx.fillRect(0, 0, W, H)
      soft(W * 0.5, H * 0.52, Math.max(W, H) * 0.62, '46, 41, 34', 0.55)
      soft(W * 0.5, H * 0.6, Math.min(W, H) * 0.34, '150, 132, 100', 0.16)

      ctx.save()
      const cx = W / 2
      const cy = H * 0.56
      ctx.translate(cx, cy)
      ctx.scale(zoomK, zoomK)
      ctx.translate(-cx, -cy)

      const gw = Math.min(W * 0.6, 880 * S)
      const ph = H * 0.56
      const x0 = cx - gw / 2
      const yTop = cy - ph * 0.66

      // 笔触墨块：三层错位堆叠 + 微抖 → 有洇边，不是矢量方块
      const inkBar = (bx, by, bw, bh, c0, c1, seed) => {
        const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh)
        g.addColorStop(0, c0)
        g.addColorStop(0.5, c1)
        g.addColorStop(1, c0)
        for (let k = 0; k < 3; k++) {
          const j = Math.sin(t * 0.0003 + seed + k * 2.1) * bh * 0.07
          ctx.fillStyle = g
          ctx.globalAlpha = k === 0 ? 1 : 0.4
          ctx.fillRect(bx + j * 0.5, by + j, bw - j, bh - j * 0.5)
        }
        ctx.globalAlpha = 1
      }

      // 台基
      inkBar(x0 - gw * 0.1, cy + ph * 0.2, gw * 1.2, ph * 0.1, '#191510', '#2a241c', 0.4)

      // 门洞里的光（随 openK 变亮变大）—— 运镜推近时这就是「门后」
      const doorCy = cy + ph * 0.02
      const doorR = gw * (0.38 + 0.92 * openK)
      const lg = ctx.createRadialGradient(cx, doorCy, 0, cx, doorCy, doorR)
      lg.addColorStop(0, `rgba(250, 240, 214, ${0.5 + 0.42 * openK})`)
      lg.addColorStop(0.5, `rgba(226, 208, 170, ${0.26 + 0.3 * openK})`)
      lg.addColorStop(1, 'rgba(226, 208, 170, 0)')
      ctx.fillStyle = lg
      ctx.fillRect(x0, yTop, gw, ph * 0.92)

      // 门扇（两扇，随 openK 向外滑开）：深墨 + 竖笔纹 + 内框线
      const dw = gw / 2 - 5
      const dTop = cy - ph * 0.28
      const dH = ph * 0.5
      const slide = openK * dw * 0.92
      for (const side of [-1, 1]) {
        const px = side < 0 ? x0 - slide : cx + 3 + slide
        inkBar(px, dTop, dw, dH, '#1a1611', '#302a21', side)
        ctx.strokeStyle = 'rgba(150, 132, 104, .2)'
        ctx.lineWidth = 1
        for (let i = 1; i < 5; i++) {
          ctx.beginPath()
          ctx.moveTo(px + (dw / 5) * i, dTop + 9)
          ctx.lineTo(px + (dw / 5) * i, dTop + dH - 9)
          ctx.stroke()
        }
        ctx.strokeStyle = 'rgba(160, 140, 108, .32)'
        ctx.strokeRect(px + 7, dTop + 7, dw - 14, dH - 14)
      }

      // 立柱（两根，带洇边的竖向墨柱）
      for (const px of [x0, x0 + gw - gw * 0.09]) {
        inkBar(px, yTop + 40 * S, gw * 0.09, ph * 0.86, '#1c1712', '#3d3428', px * 0.01)
      }

      // 楣梁
      inkBar(x0 - gw * 0.06, yTop, gw * 1.12, 40 * S, '#1c1712', '#332c23', 1.7)

      // 匾额：太虚幻境
      const pw = gw * 0.4
      const phh = 58 * S
      const py = yTop - phh - 12 * S
      ctx.fillStyle = '#e8dcbe'
      ctx.fillRect(cx - pw / 2, py, pw, phh)
      ctx.strokeStyle = 'rgba(58, 47, 34, .85)'
      ctx.lineWidth = 2.5
      ctx.strokeRect(cx - pw / 2 + 4, py + 4, pw - 8, phh - 8)
      ctx.fillStyle = '#2b241c'
      ctx.font = `${40 * S}px "LiSu", "STLiti", "KaiTi", serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('太 虚 幻 境', cx, py + phh / 2 + 2)
      ctx.lineWidth = 1
      ctx.restore()

      // 四周黑白两色云雾缭绕涌动：白雾贴地翻卷、黑雾自上压下、两侧白雾缭绕
      for (let i = 0; i < puffs.length; i++) {
        const pf = puffs[i]
        const drift = t * 0.0004 * pf.sp
        if (i % 3 === 0) {
          const bx = (i / puffs.length) * W + Math.sin(drift + pf.ph) * 90 * S
          const by = H * (0.84 + 0.11 * Math.sin(drift * 1.3 + pf.ph)) - zoomK * 36
          soft(bx, by, pf.r * S * (0.9 + openK * 0.5), '246, 243, 236',
            (0.24 + 0.2 * Math.sin(drift * 2 + pf.ph)) * clamp01(0.55 + 0.45 * openK))
        } else if (i % 3 === 1) {
          const bx = (((i * 7) % puffs.length) / puffs.length) * W + Math.sin(drift * 0.8 + pf.ph) * 70 * S
          const by = H * (0.06 + 0.2 * Math.abs(Math.sin(drift + pf.ph)))
          soft(bx, by, pf.r * S * 1.15, '6, 5, 4', 0.4 + 0.2 * Math.sin(drift * 1.7 + pf.ph))
        } else {
          const sx = (i % 2 ? W * 0.88 : W * 0.12) + Math.sin(drift * 1.1 + pf.ph) * 50 * S
          const sy = H * (0.42 + 0.3 * Math.sin(drift * 0.9 + pf.ph))
          soft(sx, sy, pf.r * S * 0.85, '238, 235, 228', 0.2 + 0.16 * Math.sin(drift * 2.3 + pf.ph))
        }
      }
    }

    const frame = (now) => {
      const t = now - start
      const pt = now - st.current.pt
      const p = st.current.phase
      ctx.clearRect(0, 0, W, H)

      if (p === 'cover' || p === 'motto') {
        // 未达容错 = 深黑云海；达成 = 白云翻涌（浅底 + 白/浅灰云团）
        ctx.fillStyle = isPass ? '#f2f0ea' : '#0c0a08'
        ctx.fillRect(0, 0, W, H)
        drawCloudField(t, 1, 0, isPass)
        if (p === 'cover' && pt >= T_COVER && !st.current.covered) {
          st.current.covered = true
          go('motto')
        }
      } else if (p === 'disperse') {
        if (isPass) {
          // 白云散开 → 露出门庭
          drawGate(t, 0, 1)
          drawCloudField(t, 1 - easeInOut(clamp01(pt / T_DISPERSE)), easeOut(clamp01(pt / T_DISPERSE)) * H * 0.25, true)
          if (pt >= T_DISPERSE) go('gate')
        } else {
          // 黑云散开 → 露出主页（onCovered 已在此刻把视图切走）
          ctx.fillStyle = '#0c0a08'
          ctx.fillRect(0, 0, W, H)
          drawCloudField(t, 1 - easeInOut(clamp01(pt / T_DISPERSE)), easeOut(clamp01(pt / T_DISPERSE)) * H * 0.3, false)
          if (pt >= T_DISPERSE) {
            cb.current.onHome && cb.current.onHome()
            return
          }
        }
      } else if (p === 'gate') {
        drawGate(t, 0, 1)
        if (pt >= GATE_CHURN && !held('gate')) go('door')
      } else if (p === 'door') {
        const k = easeInOut(clamp01(pt / T_DOOR))
        drawGate(t, k, 1 + 0.95 * k)
        if (pt >= T_DOOR && !held('door')) go('reward')
      } else if (p === 'reward') {
        drawGate(t, 1, 1.95 + 0.05 * Math.sin(t * 0.0008))
      } else if (p === 'exit') {
        // 白云翻涌遮屏 → 散开露出主页
        const coverK = easeOut(clamp01(pt / T_EXIT_COVER))
        const fadeK = 1 - easeInOut(clamp01((pt - T_EXIT_COVER) / T_EXIT_FADE))
        ctx.fillStyle = '#f2f0ea'
        ctx.fillRect(0, 0, W, H)
        drawGate(t, 1, 1.95)
        drawCloudField(t, Math.max(coverK, fadeK), 0, true)
        if (pt >= T_EXIT_COVER + T_EXIT_FADE) {
          cb.current.onHome && cb.current.onHome()
          return
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    const onResize = () => fit()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
      document.body.style.overflow = prevOverflow
    }
  }, [])

  /* 点击推进：只在 motto（黑云/白云散开）与 reward（白云翻涌收尾）两相生效 */
  const handleClick = () => {
    const p = st.current.phase
    if (p === 'motto') {
      if (variant !== 'pass') cb.current.onCovered && cb.current.onCovered() // 黑云散开时露出的就是主页
      st.current.pt = performance.now()
      setPhase('disperse')
      st.current.phase = 'disperse'
    } else if (held(p) && (p === 'gate' || p === 'door')) {
      // 只在调试定格（?qcHold=）时才有这一相：点击手动推门
      const next = p === 'gate' ? 'door' : 'reward'
      st.current.pt = performance.now()
      st.current.phase = next
      setPhase(next)
    } else if (p === 'reward') {
      cb.current.onCovered && cb.current.onCovered() // 先把主页切到云雾后面
      st.current.pt = performance.now()
      setPhase('exit')
      st.current.phase = 'exit'
    }
  }

  return createPortal(
    <div
      className={'qc-root' + (variant === 'pass' && phase === 'motto' ? ' is-light' : '')}
      data-qc-phase={phase}
      onClick={handleClick}
      role="presentation"
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {phase === 'motto' && (
        <div className={'qc-motto ' + (variant === 'pass' ? 'pass' : 'fail')}>{MOTTO[variant] || MOTTO.fail}</div>
      )}
      {phase === 'reward' && reward && (
        <div className="qc-reward">
          <div className="qc-reward-symbol" aria-hidden="true">
            {reward.symbol}
          </div>
          <div className="qc-reward-name">{reward.name}</div>
        </div>
      )}
      {phase !== 'reward' &&
        (phase === 'motto' || ((phase === 'gate' || phase === 'door') && held(phase))) && (
          <div className="qc-hint">点 击 继 续</div>
        )}
    </div>,
    document.body
  )
}
