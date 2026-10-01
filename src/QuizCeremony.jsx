import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 测验终局仪式（Day 12 · 用户分镜；2026-10-01 美术返工）
 *
 * fail（未达容错）：淡墨云海遮屏、持续翻涌 → 白色毛笔行书「運隨時變，切勿焦躁」
 *                   → 点击 → 云散 → 回总表
 * pass（达成）    ：白云遮屏 → 砂金毛笔行书「靜神定心，自有所得」
 *                   → 点击 → 云散 → 2D 水墨门洞（无匾额、无门板）→ 秒余后**运镜进门**（穿过门洞）
 *                   → 雾中浮现镀金卦象 → 点击 → 白云遮屏 → 散开回总表
 *
 * 美术要求（用户指定）：飘渺神秘优先 —— 云雾第一目的是「雾」不是「黑」；
 * 黑云去纯黑改雾灰调；题字本身随烟雾流动；门庭 2D 水墨（平涂墨块 + 雾中楼阁 + 一点朱红）。
 * 题字用**繁体**：这是用户对仪式两句话的明确要求（项目其余界面文案仍为简体）。
 *
 * 工程约定同族：portal 到 body、rAF 相位状态机、相位探针 data-qc-phase、?qcHold= 定格。
 */

const T_COVER = 900 // 云雾遮满
const T_DISPERSE_PASS = 1400 // 白云散开 → 露门庭
const T_DISPERSE_FAIL = 2800 // 淡墨散开 → 露主页：延长 + 整体淡出 = 迷途知返的朦胧
const GATE_CHURN = 1800 // 门前静置（「一秒后」运镜）
const T_ENTER = 1900 // 进门运镜（穿过门洞）
const T_EXIT_COVER = 760 // 收尾白云遮满
const T_EXIT_FADE = 2300 // 收尾散开（同样放慢，别硬切）

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOut = (t) => 1 - Math.pow(1 - t, 3)

const MOTTO = { fail: '運隨時變，切勿焦躁', pass: '靜神定心，自有所得' }

/* 水墨调色：刻意避纯黑 —— 飘渺神秘优先，黑云也带灰调 */
const C = {
  paper: '246, 244, 240',
  mist1: '228, 225, 219',
  mist2: '198, 194, 186',
  mist3: '152, 147, 139',
  inkSoft: '84, 79, 71',
  ink1: '52, 48, 43',
  ink2: '34, 31, 28',
  red: '150, 62, 48',
  night1: '80, 77, 72', // 墨气底：中灰而非纯黑（要仙境水墨，不要阴森）
  night2: '176, 171, 162', // 云中亮雾（提仙气）
  night3: '54, 51, 47', // 暗墨（拉浓淡层次，别让雾面发平）
}

/* 调试定格（与另两个转场的 ?transFreeze 同族，生产不带参数即自动推进） */
const QC_HOLD = (() => {
  try {
    return (new URLSearchParams(window.location.search).get('qcHold') || '').split(',').filter(Boolean)
  } catch {
    return []
  }
})()
const held = (name) => QC_HOLD.includes(name)

/* 调试起始相位（?qcStart=gate|door|reward）—— 免跑整轮测验即可核对美术；生产不带即正常流程 */
const QC_START = (() => {
  try {
    return new URLSearchParams(window.location.search).get('qcStart') || ''
  } catch {
    return ''
  }
})()

/* 雾团：极坐标铺开，绕屏心缓慢旋涌（确定性：只在挂载时生成一次） */
function makeMist(n) {
  const a = []
  for (let i = 0; i < n; i++) {
    a.push({
      ang: Math.random() * Math.PI * 2,
      al: 0.2 + Math.random() * 0.44,
      d: 0.08 + Math.random() * 0.6,
      r: 88 + Math.random() * 168,
      sp: 0.14 + Math.random() * 0.32,
      ph: Math.random() * Math.PI * 2,
      tone: Math.random(),
    })
  }
  return a
}

export default function QuizCeremony({ variant = 'fail', reward = null, onCovered, onHome }) {
  const rootRef = useRef(null)
  const inkRef = useRef(null)
  const fgRef = useRef(null)
  const [phase, setPhase] = useState(QC_START || 'cover')
  const st = useRef({ phase: QC_START || 'cover', pt: 0, covered: !!QC_START, raf: 0 })
  const cb = useRef({})
  cb.current = { onCovered, onHome }

  useEffect(() => {
    const cv = inkRef.current
    const fg = fgRef.current
    const ctx = cv.getContext('2d')
    const fctx = fg.getContext('2d')
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = 0
    let H = 0
    let S = 1

    const fit = () => {
      W = window.innerWidth
      H = window.innerHeight
      S = Math.min(W, H) / 1080
      for (const [c, cx2] of [
        [cv, ctx],
        [fg, fctx],
      ]) {
        c.width = Math.round(W * dpr)
        c.height = Math.round(H * dpr)
        c.style.width = W + 'px'
        c.style.height = H + 'px'
        cx2.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
    fit()
    window.addEventListener('resize', fit)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const isPass = variant === 'pass'
    const mist = makeMist(72)
    const start = performance.now()
    st.current.pt = start
    let raf = 0

    /* 相位推进：canvas 走 st.current.phase，DOM 走 phase state */
    const go = (next) => {
      st.current.phase = next
      st.current.pt = performance.now()
      setPhase(next)
    }

    /* 软圆雾 */
    const soft = (x, y, r, rgb, a) => {
      if (a <= 0.008 || r <= 0) return
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(${rgb}, ${a})`)
      g.addColorStop(0.45, `rgba(${rgb}, ${a * 0.5})`)
      g.addColorStop(0.76, `rgba(${rgb}, ${a * 0.18})`)
      g.addColorStop(1, `rgba(${rgb}, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    /* 软椭圆（雾带 / 流丝） */
    const softEll = (x, y, rx, ry, rgb, a) => {
      if (a <= 0.008 || rx <= 0 || ry <= 0) return
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(1, ry / rx)
      soft(0, 0, rx, rgb, a)
      ctx.restore()
    }
    /* 模糊墨块：2D 平涂 + 洇边（水墨质感的关键） */
    const brush = (drawFn, blurPx, rgb, a) => {
      if (a <= 0.008) return
      ctx.save()
      try {
        ctx.filter = `blur(${(blurPx * S).toFixed(2)}px)`
      } catch {
        /* 不支持 filter 就退化为硬边 */
      }
      ctx.globalAlpha = a
      ctx.fillStyle = `rgb(${rgb})`
      ctx.beginPath()
      drawFn()
      ctx.fill()
      ctx.restore()
    }

    /* ---------- 云海（cover / motto / exit）：持续旋涌 + 流丝 ---------- */
    const drawCloudSea = (t, k, drift, isWhite) => {
      if (k <= 0.01) return
      for (const p of mist) {
        const ang = p.ang + t * 0.00026 * p.sp
        const d = (p.d + 0.14 * Math.sin(t * 0.00055 * p.sp + p.ph)) * Math.max(W, H)
        const x = W / 2 + Math.cos(ang) * d + Math.sin(t * 0.001 + p.ph) * 46 * S
        const y = H / 2 + Math.sin(ang) * d * 0.68 + Math.cos(t * 0.0008 + p.ph) * 30 * S - drift
        const r = p.r * S * (1 + 0.18 * Math.sin(t * 0.0012 * p.sp + p.ph))
        const a = p.al * k * (0.68 + 0.32 * Math.sin(t * 0.0014 * p.sp + p.ph))
        if (isWhite) soft(x, y, r, p.tone > 0.42 ? C.paper : C.mist1, Math.min(0.9, a))
        else soft(x, y, r, p.tone > 0.45 ? C.night2 : C.night3, Math.min(0.9, a))
      }
      // 流丝：横向掠过的细长雾带 —— 让「烟」真的在流
      for (let i = 0; i < 16; i++) {
        const ph = i * 1.7
        const y = (((i * 137) % 100) / 100) * H * 1.05 - H * 0.02 + Math.sin(t * 0.0006 + ph) * 26 * S
        const x = (((t * (0.026 + (i % 5) * 0.01) + i * 233) % (W + 760)) - 380)
        const a = (0.05 + 0.05 * Math.sin(t * 0.0011 + ph)) * k
        if (a <= 0.008) continue
        softEll(x, y, (230 + (i % 4) * 120) * S, (16 + (i % 3) * 9) * S, isWhite ? C.paper : C.night2, Math.max(0, a))
      }
    }

    /* ---------- 2D 水墨楼阁剪影（远景，雾中） ---------- */
    const pagoda = (px, baseY, s, rgb, a) => {
      if (a <= 0.02) return
      for (let k = 0; k < 3; k++) {
        const w = s * (1 - k * 0.2)
        const y = baseY - s * (0.5 + k * 0.72)
        // 檐（平直 2D 飞檐 + 上翘角）
        brush(() => {
          ctx.moveTo(px - w * 0.6, y)
          ctx.lineTo(px + w * 0.6, y)
          ctx.lineTo(px + w * 0.46, y - s * 0.3)
          ctx.lineTo(px - w * 0.46, y - s * 0.3)
          ctx.closePath()
          ctx.fill()
          ctx.moveTo(px - w * 0.6, y)
          ctx.lineTo(px - w * 0.8, y - s * 0.17)
          ctx.lineTo(px - w * 0.58, y - s * 0.05)
          ctx.closePath()
          ctx.fill()
          ctx.moveTo(px + w * 0.6, y)
          ctx.lineTo(px + w * 0.8, y - s * 0.17)
          ctx.lineTo(px + w * 0.58, y - s * 0.05)
          ctx.closePath()
          ctx.fill()
        }, 7, rgb, a)
        // 层身
        brush(() => ctx.fillRect(px - w * 0.28, y - s * 0.3 - s * 0.44, w * 0.56, s * 0.44), 6, rgb, a * 0.92)
      }
      // 刹顶
      brush(() => ctx.fillRect(px - s * 0.022, baseY - s * 2.86, s * 0.044, s * 0.42), 4, rgb, a * 0.9)
    }

    /* ---------- 2D 水墨门洞（无匾额 / 无门板），enterK: 0 站在门前 → 1 已进门 ---------- */
    const drawGate = (t, enterK) => {
      const k = 1 + 1.75 * easeInOut(clamp01(enterK)) // 运镜推近
      const near = 1 - clamp01((enterK - 0.32) / 0.68) // 穿过门后：门框完全淡出

      // 底：雾白宣纸 + 上下墨晕
      ctx.fillStyle = `rgb(${C.paper})`
      ctx.fillRect(0, 0, W, H)
      soft(W * 0.5, H * 0.14, W * 0.8, C.mist1, 0.5)
      soft(W * 0.5, H * 0.95, W * 0.85, C.mist2, 0.3)

      const cx = W / 2
      const cy = H * 0.58
      const doorW = Math.min(W * 0.3, 380 * S)
      const doorH = Math.min(H * 0.46, 470 * S)
      const oyTop = cy - doorH * 0.3
      const oyBot = cy + doorH * 0.64
      const anchorY = (oyTop + oyBot) / 2

      // 远景：雾带 + 雾中楼阁群（进门时先行淡出 —— 它们都在门外）
      const far = 1 - clamp01(enterK * 1.5)
      if (far > 0.02) {
        for (let i = 0; i < 7; i++) {
          const y = H * (0.18 + i * 0.11) + Math.sin(t * 0.0004 + i) * 12 * S
          softEll(W * (0.5 + 0.36 * Math.sin(i * 2.1 + t * 0.0002)), y, W * 0.66, H * 0.05, C.mist1, 0.55 * far)
        }
        pagoda(W * 0.12, H * 0.73, 134 * S, C.mist3, 0.5 * far)
        pagoda(W * 0.87, H * 0.71, 152 * S, C.mist3, 0.46 * far)
        pagoda(W * 0.27, H * 0.6, 88 * S, C.mist2, 0.44 * far)
        pagoda(W * 0.73, H * 0.56, 76 * S, C.mist2, 0.4 * far)
        pagoda(W * 0.44, H * 0.45, 56 * S, C.mist1, 0.52 * far)
        pagoda(W * 0.62, H * 0.7, 104 * S, C.mist3, 0.32 * far)
      }

      ctx.save()
      ctx.translate(cx, anchorY)
      ctx.scale(k, k)
      ctx.translate(-cx, -anchorY)

      // 门洞里的雾光 + 门后更远的楼阁（透过门洞看见的那一层）
      softEll(cx, anchorY, doorW * (0.7 + 0.75 * enterK), doorH * (0.6 + 0.5 * enterK), C.paper, 0.92)
      softEll(cx, anchorY, doorW * 1.65, doorH * 1.15, C.mist1, 0.32)
      if (far > 0.02) {
        pagoda(cx - doorW * 0.22, oyBot + doorH * 0.03, 72 * S, C.mist2, 0.5 * far)
        pagoda(cx + doorW * 0.28, oyBot - doorH * 0.01, 56 * S, C.mist2, 0.42 * far)
      }

      const pw = doorW * 0.22
      const pilTop = oyTop - doorH * 0.08
      const pilH = oyBot - pilTop + doorH * 0.16
      // 左右立柱（墨柱 + 亮心 + 颗粒，破掉平涂感）
      for (const side of [-1, 1]) {
        const px = side < 0 ? cx - doorW / 2 - pw : cx + doorW / 2
        brush(() => ctx.fillRect(px, pilTop, pw, pilH), 11, C.ink1, 0.86 * near)
        brush(() => ctx.fillRect(px + pw * 0.3, pilTop + pilH * 0.03, pw * 0.34, pilH * 0.94), 9, C.inkSoft, 0.5 * near)
        // 柱脚墨积
        brush(() => ctx.fillRect(px - pw * 0.06, oyBot - doorH * 0.02, pw * 1.12, doorH * 0.12), 13, C.ink2, 0.7 * near)
      }
      // 台基
      brush(() => ctx.fillRect(cx - doorW * 1.02, oyBot + doorH * 0.08, doorW * 2.04, doorH * 0.12), 13, C.ink1, 0.42 * near)
      // 楣梁
      brush(() => ctx.fillRect(cx - doorW / 2 - pw * 1.32, oyTop - doorH * 0.2, doorW + pw * 2.64, doorH * 0.12), 10, C.ink1, 0.88 * near)
      brush(() => ctx.fillRect(cx - doorW / 2, oyTop - doorH * 0.145, doorW, doorH * 0.03), 7, C.inkSoft, 0.34 * near)
      // 檐（平直飞檐 + 上翘角）
      brush(() => {
        ctx.moveTo(cx - doorW * 0.98, oyTop - doorH * 0.19)
        ctx.lineTo(cx + doorW * 0.98, oyTop - doorH * 0.19)
        ctx.lineTo(cx + doorW * 0.74, oyTop - doorH * 0.35)
        ctx.lineTo(cx - doorW * 0.74, oyTop - doorH * 0.35)
        ctx.closePath()
        ctx.fill()
        ctx.moveTo(cx - doorW * 0.98, oyTop - doorH * 0.19)
        ctx.lineTo(cx - doorW * 1.16, oyTop - doorH * 0.34)
        ctx.lineTo(cx - doorW * 0.93, oyTop - doorH * 0.24)
        ctx.closePath()
        ctx.fill()
        ctx.moveTo(cx + doorW * 0.98, oyTop - doorH * 0.19)
        ctx.lineTo(cx + doorW * 1.16, oyTop - doorH * 0.34)
        ctx.lineTo(cx + doorW * 0.93, oyTop - doorH * 0.24)
        ctx.closePath()
        ctx.fill()
      }, 8, C.ink1, 0.86 * near)
      // 檐上留白（墨的浓淡层次）
      brush(() => ctx.fillRect(cx - doorW * 0.62, oyTop - doorH * 0.34, doorW * 1.24, doorH * 0.05), 9, C.inkSoft, 0.3 * near)
      // 一点朱红（画风参考里的那点红）
      brush(() => ctx.fillRect(cx - doorW / 2, oyTop, doorW, doorH * 0.024), 2.5, C.red, 0.4 * near)
      ctx.restore()

      // 门前后的飘雾（白 + 淡墨），让画面「飘渺」
      for (let i = 0; i < 24; i++) {
        const ph = i * 2.3
        const drift = t * (0.032 + (i % 4) * 0.013)
        const x = (((drift + i * 271) % (W + 900)) - 450)
        const y = H * (0.32 + 0.6 * ((i % 7) / 7)) + Math.sin(t * 0.0007 + ph) * 36 * S
        const white = i % 3 !== 0
        const a = (white ? 0.32 : 0.18) * (0.68 + 0.32 * Math.sin(t * 0.001 + ph))
        softEll(x, y, (170 + (i % 5) * 92) * S, (32 + (i % 4) * 15) * S, white ? C.paper : C.mist3, Math.max(0, a))
      }

      // 穿过门洞之后：白雾只做过渡（峰值后回落），门后的雾中楼阁渐显 —— 不要一片死白
      if (enterK > 0.42) {
        const inside = clamp01((enterK - 0.42) / 0.58)
        const wash = 0.74 * (1 - easeInOut(inside))
        if (wash > 0.01) {
          ctx.fillStyle = `rgba(${C.paper}, ${wash})`
          ctx.fillRect(0, 0, W, H)
        }
        // 门后世界：雾带 + 雾中楼阁（随进门进度浮现）
        if (inside > 0.05) {
          for (let i = 0; i < 6; i++) {
            softEll(W * (0.16 + i * 0.14), H * (0.46 + 0.09 * i) + Math.sin(t * 0.0005 + i) * 14 * S,
              W * 0.32, H * 0.042, C.mist1, 0.42 * inside)
          }
          pagoda(W * 0.19, H * 0.77, 112 * S, C.mist3, 0.58 * inside)
          pagoda(W * 0.81, H * 0.74, 136 * S, C.mist3, 0.5 * inside)
          pagoda(W * 0.5, H * 0.62, 78 * S, C.mist2, 0.55 * inside)
          pagoda(W * 0.35, H * 0.69, 62 * S, C.mist2, 0.42 * inside)
        }
      }
    }

    const frame = (now) => {
      const t = now - start
      const pt = now - st.current.pt
      const p = st.current.phase
      ctx.clearRect(0, 0, W, H)
      fctx.clearRect(0, 0, W, H)
      let rootAlpha = 1 // 整层透明度：散开的后段淡出 → 露主界面不硬切

      if (p === 'cover' || p === 'motto') {
        // 未达容错 = 水墨墨气（中灰，不阴森）；达成 = 白云翻涌
        ctx.fillStyle = isPass ? `rgb(${C.paper})` : `rgb(${C.night1})`
        ctx.fillRect(0, 0, W, H)
        drawCloudSea(t, 1, 0, isPass)
        if (p === 'cover' && pt >= T_COVER && !st.current.covered) {
          st.current.covered = true
          go('motto')
        }
      } else if (p === 'disperse') {
        if (isPass) {
          const q1 = clamp01(pt / T_DISPERSE_PASS)
          drawGate(t, 0)
          drawCloudSea(t, 1 - easeInOut(q1), easeOut(q1) * H * 0.25, true)
          if (pt >= T_DISPERSE_PASS) go('gate')
        } else {
          // 未达容错：云气悠悠散开 —— 底墨渐薄、云团上飘、后段整层淡出（朦胧，不硬切）
          const q1 = clamp01(pt / T_DISPERSE_FAIL)
          ctx.fillStyle = `rgba(${C.night1}, ${1 - 0.62 * easeInOut(q1)})`
          ctx.fillRect(0, 0, W, H)
          drawCloudSea(t, (1 - easeInOut(clamp01((q1 - 0.12) / 0.88))) * 1.15, easeOut(q1) * H * 0.22, false)
          rootAlpha = 1 - easeInOut(clamp01((q1 - 0.4) / 0.6))
          if (pt >= T_DISPERSE_FAIL) {
            cb.current.onHome && cb.current.onHome()
            return
          }
        }
      } else if (p === 'gate') {
        drawGate(t, 0)
        if (pt >= GATE_CHURN && !held('gate')) go('door')
      } else if (p === 'door') {
        // 进门：运镜穿过门洞（不是开门 —— 本就没有门板）
        const k = easeInOut(clamp01(pt / T_ENTER))
        drawGate(t, k)
        if (pt >= T_ENTER && !held('door')) go('reward')
      } else if (p === 'reward') {
        drawGate(t, 1)
      } else if (p === 'exit') {
        // 收尾：白云先遮满，再悠悠散开 + 整层淡出（同样不硬切）
        const coverK = easeOut(clamp01(pt / T_EXIT_COVER))
        const q1 = clamp01((pt - T_EXIT_COVER) / T_EXIT_FADE)
        const paperA = coverK * (1 - 0.55 * easeInOut(q1))
        ctx.fillStyle = `rgba(${C.paper}, ${paperA})`
        ctx.fillRect(0, 0, W, H)
        drawGate(t, 1)
        drawCloudSea(t, Math.max(coverK, 1 - easeInOut(q1)), 0, true)
        rootAlpha = 1 - easeInOut(clamp01((q1 - 0.35) / 0.65))
        if (pt >= T_EXIT_COVER + T_EXIT_FADE) {
          cb.current.onHome && cb.current.onHome()
          return
        }
      }

      // 前景薄雾（画在题字之上，让字像浮在烟里、并与烟一起流动）
      if (p === 'motto' || p === 'gate' || p === 'door') {
        const dark = !isPass && (p === 'motto')
        for (let i = 0; i < 7; i++) {
          const ph = i * 2.1
          const x = (((t * (0.016 + (i % 3) * 0.006) + i * 331) % (W + 900)) - 450)
          const y = H * (0.18 + 0.64 * ((i % 5) / 5)) + Math.sin(t * 0.0005 + ph) * 22 * S
          const a = 0.05 + 0.04 * Math.sin(t * 0.0009 + ph)
          if (a <= 0.008) continue
          const g = fctx.createRadialGradient(x, y, 0, x, y, (210 + (i % 4) * 130) * S)
          const col = dark ? '235, 233, 228' : '255, 255, 255'
          g.addColorStop(0, `rgba(${col}, ${Math.max(0, a)})`)
          g.addColorStop(0.6, `rgba(${col}, ${Math.max(0, a) * 0.4})`)
          g.addColorStop(1, `rgba(${col}, 0)`)
          fctx.save()
          fctx.translate(x, y)
          fctx.scale(1, 0.22)
          fctx.fillStyle = g
          fctx.beginPath()
          fctx.arc(0, 0, (210 + (i % 4) * 130) * S, 0, Math.PI * 2)
          fctx.fill()
          fctx.restore()
        }
      }

      if (rootRef.current) rootRef.current.style.opacity = String(clamp01(rootAlpha))
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
      document.body.style.overflow = prevOverflow
    }
  }, [])

  /* 点击推进：motto（云散）与 reward（白云收尾）；调试定格时 gate/door 也可点击推进 */
  const handleClick = () => {
    const p = st.current.phase
    if (p === 'motto') {
      if (variant !== 'pass') cb.current.onCovered && cb.current.onCovered()
      st.current.pt = performance.now()
      st.current.phase = 'disperse'
      setPhase('disperse')
    } else if (held(p) && (p === 'gate' || p === 'door')) {
      const next = p === 'gate' ? 'door' : 'reward'
      st.current.pt = performance.now()
      st.current.phase = next
      setPhase(next)
    } else if (p === 'reward') {
      cb.current.onCovered && cb.current.onCovered()
      st.current.pt = performance.now()
      st.current.phase = 'exit'
      setPhase('exit')
    }
  }

  const text = MOTTO[variant] || MOTTO.fail
  const lightField = variant === 'pass' && phase === 'motto'

  return createPortal(
    <div
      ref={rootRef}
      className={'qc-root' + (lightField ? ' is-light' : '')}
      data-qc-phase={phase}
      onClick={handleClick}
      role="presentation"
    >
      <canvas ref={inkRef} aria-hidden="true" />

      {phase === 'motto' && (
        <div className={'qc-motto ' + (variant === 'pass' ? 'pass' : 'fail')}>
          {[...text].map((ch, i) => (
            <span
              key={i}
              className="qc-motto-ch"
              data-ch={ch}
              style={{
                animationDelay: `${(i * 0.42).toFixed(2)}s, ${(i * 0.63).toFixed(2)}s`,
                animationDuration: `${(5.2 + (i % 3) * 0.9).toFixed(1)}s, ${(3.4 + (i % 4) * 0.5).toFixed(1)}s`,
              }}
            >
              {ch}
            </span>
          ))}
        </div>
      )}

      {phase === 'reward' && reward && (
        <div className="qc-reward">
          <div className="qc-reward-symbol" aria-hidden="true">
            {reward.symbol}
          </div>
          <div className="qc-reward-name">{reward.name}</div>
        </div>
      )}

      {/* 前景薄雾层：压在题字之上 → 字像是烟的一部分 */}
      <canvas ref={fgRef} className="qc-fg" aria-hidden="true" />

      {phase !== 'reward' && (phase === 'motto' || ((phase === 'gate' || phase === 'door') && held(phase))) && (
        <div className="qc-hint">点 击 继 续</div>
      )}
    </div>,
    document.body
  )
}
