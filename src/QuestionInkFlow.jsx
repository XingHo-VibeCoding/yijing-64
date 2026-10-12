import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { QUESTIONS } from './reading/threeQuestions.js'
/* ⭐ 直接复用起卦动画的那份墨点纹理 —— 与 CastingAnimation / InkTransition 同一种墨，
 * 衔接段的墨与动画内部的墨才是「同一种」，观感才连得上。
 * 曾用径向渐变云代替，结果聚成一块死黑、完全看不出翻涌。 */
import { makeDotTexture } from './CastingAnimation.jsx'

/**
 * 起卦三问 · 水墨全屏转场 v2（Day 22 用户复核后重做）：
 *
 *   ① 点「起 一 卦」→ 白色雾气升腾铺满（**先让雾稳住，再出字**——此前 1.5s 就出题，
 *      雾未实、题面与首页内容重叠，用户截图指正）
 *   ② 雾面翻涌的背景上，问题以**黑色毛笔楷体**直接浮现（无底框、无衬底墨晕）
 *   ③ 每答完一题，**白云气翻涌汇集**（约 1.3s，全程自动，不需用户点「继续」）（不是黑墨、也不是纯色白屏——交错翻涌带淡墨阴影层次）
 *      → 散开时新问题的字逐个显影
 *   ④ 三问答完白云再汇集 → **黑云翻涌衔接**（照起卦动画「一二段之间」那段的观感：
 *      极坐标绕心翻涌、向心收拢遮严实、保持片刻、再墨散开）→ 露出起卦动画
 *      （动画在墨涌住的保持段开播，散开时正播到第一段旋转中段）
 *
 * ============================================================
 * 结构约定（同族）：portal 到 body、单 canvas 单 rAF、确定性逐帧重绘、
 * 回调 latest-ref、?transFreeze=N 定格、?tqPhase 直达、?tqFinal 直达散开段。
 * ============================================================
 *
 * ⚠️ 产品边界（不许动摇）：
 *   - 三问**必须回答**（用户明确去掉「直接看解读」）；`?cast=` 深链仍跳过（调试用）
 *   - 三问不影响「卦是什么」；作答只存内存、不上云、不进记录
 */

const INK = '24, 20, 16'
const PAPER = '247, 239, 224'
const MIST = '252, 249, 242' // 亮白云团（比纸色更亮一档，翻涌时看得见）

/* 时间轴（ms）——veil 再加长：雾要多翻涌一会儿、且浓到盖死底页（用户二轮指正） */
const T_VEIL = 3200
/* ⏱ 一问的节奏（用户 2026-10-12 定：「问题间动画持续三秒」）：
 * 实测原参数从答完到选项可点要 5.3s（sweep 2.75s + 显影 2.55s）——
 * 慢得像「卡住等点击」。现压缩到 **约 3.0s**：
 *   sweep 1.30s（白云涌起 0.8 + 散开 0.5）→ 题面首字 0.26s 起逐字显影
 *   → 选项 0.9s 起依次洇出，1.7s 内全部可点。
 * 换题**全自动**：答完即涌、散开即出下一题，全程无需用户点「继续」（本来也没有继续按钮）。 */
const T_COVER = 800 // sweep：白云遮满（换题 / 进衔接点）
const T_SWEEP_END = 1300 // sweep：散开完毕
/* handoff：三问→起卦动画的黑云衔接（用户指正「衔接太生硬」）
 * 参数照 CastingAnimation 的 inkIn 800 / hold 1000 / inkOut 800 等比放大，
 * 保证「墨涌上来 → 保持 → 墨散去」的节奏与起卦动画内部转场同源 */
const T_HANDOFF_IN = 1150 // 墨涌上来（白雾 → 黑墨）
const T_HANDOFF_HOLD = 850 // 保持（动画在这段开播）
const T_HANDOFF_OUT = 1250 // 墨散开，露出动画

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

export default function QuestionInkFlow({ onAllAnswered, onExit }) {
  const canvasRef = useRef(null)
  /* ⚠️ initPhase 必须在所有引用它的 useState **之前**声明（TDZ 教训见注释尾部） */
  const initParams = new URLSearchParams(
    typeof window !== 'undefined' ? window.location.search : ''
  )
  const initPhase = initParams.get('tqPhase')
  const initFinal = initParams.get('tqFinal') === '1'

  const [step, setStep] = useState(0)
  const [phase, setPhase] = useState(initPhase === 'ask' || initPhase === 'sweep' ? initPhase : 'veil')
  const [answers, setAnswers] = useState({})
  /* CSS 底状态机：veil 完成 → is-paper；sweep → is-inked；final 遮满 → is-final */
  const [veiled, setVeiled] = useState(initPhase === 'ask' || initPhase === 'sweep')
  const [inked, setInked] = useState(initPhase === 'sweep')
  const [leaving, setLeaving] = useState(initFinal)
  const [handoff, setHandoff] = useState(false) // 黑云衔接段（白雾 → 墨 → 露动画）
  /* ⚠️ 选项是**淡入动画**（opacity 0 → 1），动画没跑完时元素已经能点 ——
   * 用户可以点到「还看不见的按钮」（本机 CDP 验证时测到 options 从 DOM 里就在）。
   * 故进入题目后的 1s 内锁住选项（此时选项尚未开始洇出，题面正在显影）。 */
  const [entering, setEntering] = useState(false)
  useEffect(() => {
    if (phase !== 'ask') return undefined
    setEntering(true)
    const t = setTimeout(() => setEntering(false), 1000)
    return () => clearTimeout(t)
  }, [phase, step])
  const finalRef = useRef(initFinal)
  /* ⚠️ 挡严实（用户二轮指正）：mount 后立刻开始把 CSS 底铺向纸色（0.8s 内），
   * 不等 veil 翻涌完 —— 底页**一刻都不许透出来**；雾的升腾感由 canvas 在纸色上继续翻涌 */
  const [cover, setCover] = useState(initPhase === 'ask' || initPhase === 'sweep')
  useEffect(() => {
    const t = setTimeout(() => setCover(true), 60)
    return () => clearTimeout(t)
  }, [])

  const cbRef = useRef({})
  cbRef.current = { onAllAnswered, onExit }
  const stepRef = useRef(0)
  stepRef.current = step
  const answersRef = useRef(answers)
  answersRef.current = answers
  /* canvas 模式：veil | idle | sweep（⚠️ DOM 的 phase=ask 对应 canvas 的 idle——值域映射） */
  const modeRef = useRef(initPhase === 'sweep' ? 'sweep' : initPhase === 'ask' ? 'idle' : 'veil')
  const sweepStartRef = useRef(0)
  const handoffStartRef = useRef(0)
  /* covered 必须能被 beginSweep 重置：原来它是 effect 内的局部变量、只在「换题」分支
   * 复位 —— 于是 sweep 期间**第二次**作答（双击 / 误触）会重开一轮 sweep，
   * 但 covered 仍为 true → 不再 setStep → **点了答案却不换题**（用户报的卡住之一） */
  const coveredRef = useRef(false)

  const pick = (qKey, optId) => {
    /* ⚠️⚠️ 作答守卫（Day 23 修「有概率不进入下一个问题」）：
     * 只有当前**真的停在题目相位**才接受作答。
     * 为什么必须有 —— `.qi-dom` 在白云/黑云盖住时只是 opacity: 0，**并没有禁用交互**，
     * 于是：
     *   ① handoff 期间点到透明区域 → beginSweep(false) 把 finalRef 改回 false
     *      → 第三题答完不再进衔接段，浮层永不卸载 → **动画卡死不开始**；
     *   ② sweep 期间双击 → 重开一轮 sweep 且 covered 仍为 true → 不 setStep
     *      → **点了答案却不换题**。
     * 这两条都在「用户看不见但点得到」的时间窗里发生，所以表现为**有概率**。 */
    if (modeRef.current !== 'idle') return
    if (answersRef.current[qKey]) return // 同一题不重复作答
    const next = { ...answersRef.current, [qKey]: optId }
    answersRef.current = next
    setAnswers(next)
    /* ⚠️ 必须回答：最后一问答完才 final；不存在跳过路径 */
    beginSweep(stepRef.current === QUESTIONS.length - 1)
  }

  const beginSweep = (final) => {
    finalRef.current = final
    modeRef.current = 'sweep'
    coveredRef.current = false // 每轮 sweep 重新判定「遮满」，否则二次 sweep 不推进 step
    sweepStartRef.current = performance.now()
    setPhase('sweep')
    setInked(true)
  }

  /* ---------------- canvas 主循环（mount 一次） ---------------- */
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!canvas || !ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let W = window.innerWidth
    let H = window.innerHeight
    const fit = () => {
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()

    const FREEZE_RAW = new URLSearchParams(window.location.search).get('transFreeze')
    const FREEZE = FREEZE_RAW === null ? null : Number(FREEZE_RAW)

    /* ---------- 白雾团：veil 升腾 + idle 常驻翻涌（更亮的白，纸面上可见） ---------- */
    const mist = []
    for (let i = 0; i < 30; i++) {
      mist.push({
        bx: Math.random(), // 比例坐标（resize 重投影）
        y0: H + 40 + Math.random() * H * 0.5,
        r: (150 + Math.random() * 230) * (W / 1440), // 更大——大面积叠盖
        v: (0.26 + Math.random() * 0.3) * H,
        sway: 24 + Math.random() * 52,
        ph: Math.random() * Math.PI * 2,
        a: 0.5 + Math.random() * 0.38, // 更浓
        delay: Math.random() * 500,
      })
    }

    /* ---------- 白云团：sweep 翻涌（用户二轮指正：不要黑墨，改白色云气） ----------
     * 每团带 3 个偏移子团，子团绕母心慢转 → 碎云翻涌感；
     * 白底上纯白不可见，故每团随附一朵**淡墨阴影云**（低alpha）压在下面出层次 */
    const surge = []
    for (let i = 0; i < 14; i++) {
      const kids = []
      for (let k = 0; k < 3; k++) {
        kids.push({
          ang: Math.random() * Math.PI * 2,
          rr: 0.25 + Math.random() * 0.5, // 相对母团半径的偏移
          w: (Math.random() - 0.5) * 0.0016, // 子团绕行角速度
          r: 0.45 + Math.random() * 0.4,
        })
      }
      surge.push({
        bx: (0.06 + 0.88 * (i / 13) + (Math.random() - 0.5) * 0.05),
        y0: H + 80 + (i % 4) * 110 + Math.random() * 70,
        r: (130 + Math.random() * 170) * (W / 1440),
        v: H * (0.0005 + Math.random() * 0.0003),
        sway: 22 + Math.random() * 40,
        ph: Math.random() * Math.PI * 2,
        a: 0.5 + Math.random() * 0.3, // 白云要浓
        delay: Math.random() * 500,
        kids,
        roll: (Math.random() - 0.5) * 0.0012, // 母团自转
      })
    }

    /* ---------- 黑墨团：handoff 衔接段 ----------
     * 照 CastingAnimation.drawInk 的观感：**极坐标绕心翻涌** —— 每团有自己的角速度 w
     * （少数反向）与径向呼吸（surgeSp/surgeAmp），并随遮盖度向心收拢（kConv），
     * 不是几颗圆球直线上升 */
    const dot = makeDotTexture(128)
    const ink = []
    for (let i = 0; i < 22; i++) {
      const far = i / 21 // 0 内圈 → 1 外圈
      const rr = 0.16 + far * 0.62 + Math.random() * 0.1
      const rad = (60 + Math.random() * 60) * (W / 1440) * (0.75 + far * 0.5)
      const dots = []
      const nDots = 5 + Math.floor(Math.random() * 4)
      for (let k = 0; k < nDots; k++) {
        const ta = Math.random() * Math.PI * 2
        const td = rad * (0.35 + Math.random() * 0.62)
        dots.push({
          dx: Math.cos(ta) * td,
          dy: Math.sin(ta) * td * 0.8,
          s: 0.28 + Math.random() * 0.62,
          a: 0.2 + Math.random() * 0.5,
        })
      }
      ink.push({
        rr,
        a0: Math.random() * Math.PI * 2,
        /* 内圈快、外圈慢、约三成反向 → 交错翻涌（照 CastingAnimation 的取法） */
        w: (0.00034 + Math.random() * 0.00072) * (Math.random() < 0.3 ? -1 : 1) * (1 - far * 0.42),
        surgeSp: 0.0004 + Math.random() * 0.0007,
        surgeAmp: 0.05 + Math.random() * 0.12,
        bph: Math.random() * Math.PI * 2,
        bp: 0.0006 + Math.random() * 0.001,
        rad,
        base: 0.5 + Math.random() * 0.34,
        dots,
      })
    }

    const px = (ratio) => ratio * W

    const t0 = performance.now()
    let veilDone = false
    let exited = false
    let castStarted = false
    let cleared = false
    let raf = 0

    /** 画一朵「碎云」：母团 + 绕行子团，各自呼吸（软边径向渐变叠加）。rgb 决定云色 */
    function drawCloud(x, y, r, alpha, t, c, rgb) {
      if (alpha <= 0.012) return
      const spin = t * c.roll
      // 母团
      let g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, `rgba(${rgb}, ${alpha})`)
      g.addColorStop(0.6, `rgba(${rgb}, ${alpha * 0.62})`)
      g.addColorStop(1, `rgba(${rgb}, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      // 子团：绕母心慢转 + 呼吸 → 翻涌的碎云（无子团时即整团软边云）
      for (const k of c.kids || []) {
        const ka = k.ang + t * k.w
        const rr2 = r * k.rr * (1 + Math.sin(t * 0.0011 + k.ang * 3) * 0.18)
        const kx = x + Math.cos(ka) * rr2
        const ky = y + Math.sin(ka) * rr2 * 0.9
        const kr = r * k.r
        const ka2 = alpha * 0.8
        g = ctx.createRadialGradient(kx, ky, 0, kx, ky, kr)
        g.addColorStop(0, `rgba(${rgb}, ${ka2})`)
        g.addColorStop(0.6, `rgba(${rgb}, ${ka2 * 0.6})`)
        g.addColorStop(1, `rgba(${rgb}, 0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(kx, ky, kr, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const loop = (now) => {
      const el = FREEZE != null ? FREEZE : now - t0
      const mode = modeRef.current

      ctx.clearRect(0, 0, W, H)

      /* ---------- veil：白雾升腾（雾稳住后才转 ask——用户指正的重叠根因） ---------- */
      if (mode === 'veil') {
        const t = el / 1000
        /* 淡墨阴影雾先走一遍：大面积白里出明暗，翻涌才看得见（用户二轮指正「加深浓度」） */
        for (const b of mist) {
          const lt = Math.max(0, el - b.delay - 200)
          if (lt <= 0) continue
          const y = b.y0 - b.v * (lt / 1000) - easeOutCubic(clamp01(lt / 2600)) * H * 0.35
          if (y < -b.r) continue
          const x = px(b.bx) + Math.sin(t * 0.7 + b.ph) * b.sway
          const a = b.a * clamp01(lt / 500) * 0.12
          if (a <= 0.01) continue
          const g = ctx.createRadialGradient(x, y, 0, x, y, b.r)
          g.addColorStop(0, `rgba(${INK}, ${a})`)
          g.addColorStop(1, `rgba(${INK}, 0)`)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(x, y, b.r, 0, Math.PI * 2)
          ctx.fill()
        }
        for (const b of mist) {
          const lt = Math.max(0, el - b.delay)
          if (lt <= 0) continue
          const y = b.y0 - b.v * (lt / 1000) - easeOutCubic(clamp01(lt / 2600)) * H * 0.35
          if (y < -b.r) continue
          const x = px(b.bx) + Math.sin(t * 0.7 + b.ph) * b.sway
          const a = b.a * clamp01(lt / 500)
          if (a <= 0.01) continue
          const g = ctx.createRadialGradient(x, y, 0, x, y, b.r)
          g.addColorStop(0, `rgba(250, 247, 240, ${a})`)
          g.addColorStop(0.55, `rgba(246, 242, 233, ${a * 0.55})`)
          g.addColorStop(1, `rgba(246, 242, 233, 0)`)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(x, y, b.r, 0, Math.PI * 2)
          ctx.fill()
        }
        if (!veilDone && el >= T_VEIL && FREEZE == null) {
          veilDone = true
          modeRef.current = 'idle'
          setPhase('ask')
          setVeiled(true)
        }
      }

      /* ---------- idle：白雾翻涌常驻（比纸色亮的雾团缓慢滚动，翻涌可见） ---------- */
      if (mode === 'idle') {
        const t = el / 1000
        for (const b of mist) {
          /* 确定性循环：雾团在屏内缓滚，不出屏 */
          const cyc = (el * b.v * 0.0006 + b.delay) % (H + b.r * 2)
          const y = H + b.r - cyc
          const x = px(b.bx) + Math.sin(el / 900 + b.ph) * b.sway * 1.4
          const env = clamp01(cyc / (b.r * 1.4)) * clamp01((H + b.r - cyc) / (b.r * 1.4))
          const a = 0.34 * env
          if (a <= 0.01) continue
          const g = ctx.createRadialGradient(x, y, 0, x, y, b.r)
          g.addColorStop(0, `rgba(252, 250, 244, ${a})`)
          g.addColorStop(0.6, `rgba(250, 246, 238, ${a * 0.5})`)
          g.addColorStop(1, `rgba(250, 246, 238, 0)`)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(x, y, b.r, 0, Math.PI * 2)
          ctx.fill()
        }
        /* 极淡墨晕交替：让「翻涌」有明暗层次，不是一片白 */
        const t2 = el / 1000
        for (let i = 0; i < 5; i++) {
          const gy = ((i * 0.21 + t2 * 0.014) % 1.1 - 0.05) * H
          const gx = W * (0.2 + 0.6 * ((i * 0.37 + Math.sin(t2 * 0.2 + i) * 0.12) % 1))
          const a = 0.028 + 0.014 * Math.sin(t2 * 0.5 + i * 2.1)
          const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.min(W, H) * 0.3)
          g.addColorStop(0, `rgba(${INK}, ${Math.max(0.005, a)})`)
          g.addColorStop(1, `rgba(${INK}, 0)`)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(gx, gy, Math.min(W, H) * 0.3, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      /* ---------- sweep：黑云翻涌（涌上遮满 → 遮满后原地缓滚 → 散开） ---------- */
      if (mode === 'sweep') {
        const sp = el - sweepStartRef.current
        const outP = clamp01((sp - T_COVER) / (T_SWEEP_END - T_COVER))
        const live = 1 - easeInOutCubic(outP)
        const surgeP = clamp01(sp / (T_COVER * 0.85))
        /* 淡墨阴影云先铺一层（白底上白云才可见：翻涌的明暗层次靠它） */
        for (const c of surge) {
          if (sp < c.delay) continue
          const prog = (sp - c.delay) * c.v
          let y
          if (prog < H + c.r) y = H + c.r - prog
          else y = ((prog - (H + c.r)) % (H * 0.5)) * 0.2 + H * 0.25
          const x = px(c.bx) + Math.sin(sp / 700 + c.ph) * c.sway
          const env = sp < T_COVER ? clamp01(prog / (c.r * 1.2)) : 1
          const a = c.a * env * (0.4 + 0.6 * surgeP) * live * 0.22
          drawCloud(x, y, c.r * (0.9 + 0.25 * surgeP), a, sp, c, INK)
        }
        /* 白云主体压上 */
        for (const c of surge) {
          if (sp < c.delay) continue
          const prog = (sp - c.delay) * c.v
          let y
          if (prog < H + c.r) y = H + c.r - prog
          else y = ((prog - (H + c.r)) % (H * 0.5)) * 0.2 + H * 0.25
          const x = px(c.bx) + Math.sin(sp / 700 + c.ph) * c.sway
          const env = sp < T_COVER ? clamp01(prog / (c.r * 1.2)) : 1
          const a = c.a * env * (0.4 + 0.6 * surgeP) * live
          drawCloud(x, y, c.r * (0.9 + 0.25 * surgeP), a, sp, c, MIST)
        }
        /* 兜底雾面：涌起后半段补实（保证换题藏在云下）；散开段整体变淡上飘 */
        const veilA = 0.97 * easeInOutCubic(clamp01((sp - 350) / (T_COVER - 350))) * live
        if (veilA > 0.01) {
          ctx.fillStyle = `rgba(${PAPER}, ${veilA})`
          ctx.fillRect(0, -easeInOutCubic(outP) * H * 0.22, W, H)
        }
        if (!coveredRef.current && sp >= T_COVER && FREEZE == null) {
          coveredRef.current = true
          setInked(true)
          if (!finalRef.current) {
            setStep((s) => Math.min(s + 1, QUESTIONS.length - 1))
          }
        }
        if (sp >= T_SWEEP_END && FREEZE == null) {
          if (finalRef.current && !exited) {
            /* 换题是「白云散开露出新题」；三问答完则**接力给黑云衔接段**，
             * 由它负责把白雾过渡到起卦动画（此前这里直接卸载 → 衔接生硬） */
            exited = true
            modeRef.current = 'handoff'
            handoffStartRef.current = performance.now()
            setPhase('handoff')
            setHandoff(true)
          } else {
            coveredRef.current = false
            modeRef.current = 'idle'
            setPhase('ask')
            setInked(false)
          }
        }
      }

      /* ---------- handoff：黑云翻涌衔接（白雾 → 墨 → 露出起卦动画） ---------- */
      if (mode === 'handoff') {
        const hp = performance.now() - handoffStartRef.current
        const holdEnd = T_HANDOFF_IN + T_HANDOFF_HOLD
        const inP = clamp01(hp / T_HANDOFF_IN)
        const outP = clamp01((hp - holdEnd) / T_HANDOFF_OUT)
        /* 遮盖度：涌上 → 保持 1 → 散去。CSS 底色同步走（is-handoff 深墨 → is-final 透明），
         * **底色与墨云同步淡**，不出现「墨散了但底色还黑着」的断层 */
        const cov = hp <= holdEnd ? easeInOutCubic(inP) : 1 - easeInOutCubic(outP)
        if (cov > 0.005) {
          const cx = W / 2
          const cy = H / 2
          const kConv = 1 - cov * 0.38 // 遮得越实，墨团越向心收拢（不收到死黑）
          for (const b of ink) {
            const rr =
              b.rr * Math.min(W, H) * (1 + Math.sin(hp * b.surgeSp + b.bph) * b.surgeAmp) * kConv
            const ang = b.a0 + hp * b.w
            const bx = cx + Math.cos(ang) * rr
            const by = cy + Math.sin(ang) * rr * 0.96
            const sc = (1 + Math.sin(hp * b.bp + b.bph) * 0.24) * (1 + cov * 0.3)
            ctx.globalAlpha = Math.min(1, b.base * cov)
            for (const d of b.dots) {
              const px2 = bx + d.dx * sc
              const py2 = by + d.dy * sc
              const pr = b.rad * d.s * sc
              ctx.drawImage(dot, px2 - pr, py2 - pr, pr * 2, pr * 2)
            }
          }
          ctx.globalAlpha = 1
          /* 兜底墨面：**中心浓、边缘留空**的径向铺底（不能一整块平涂 ——
           * 平涂会把翻涌抹平成死黑，起卦动画的墨也是靠中心最浓、外缘仍留墨在翻涌） */
          const gv = ctx.createRadialGradient(
            W / 2, H / 2, 0,
            W / 2, H / 2, Math.max(W, H) * 0.62
          )
          const peak = Math.min(0.9, cov * 0.9)
          gv.addColorStop(0, `rgba(${INK}, ${peak})`)
          gv.addColorStop(0.5, `rgba(${INK}, ${peak * 0.8})`)
          gv.addColorStop(0.8, `rgba(${INK}, ${peak * 0.3})`)
          gv.addColorStop(1, `rgba(${INK}, ${peak * 0.06})`)
          ctx.fillStyle = gv
          ctx.fillRect(0, 0, W, H)
        }
        /* 动画在「保持段」开播：此刻墨已遮严实，下层起卦动画从第一段旋转开始跑，
         * 等墨散开时正好播到中段 —— 观感上像墨散开「让出」了动画 */
        if (!castStarted && hp >= T_HANDOFF_IN * 0.45) {
          castStarted = true
          cbRef.current.onAllAnswered && cbRef.current.onAllAnswered(answersRef.current)
        }
        if (hp >= holdEnd + T_HANDOFF_OUT && FREEZE == null && !cleared) {
          cleared = true
          setLeaving(true) // CSS 底色与整体透明度平缓淡出（1.5s）
          setTimeout(() => {
            cbRef.current.onExit && cbRef.current.onExit()
          }, 1500)
        }
      }

      if (FREEZE != null) return // 定格：画当前相位画面，不推进不回调
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    window.addEventListener('resize', fit)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
    }
  }, [])

  const Q = QUESTIONS[step]
  const answered = Object.keys(answers).length

  return createPortal(
    <div
      className={
        'qi-stage' +
        (cover ? ' is-cover' : '') +
        (veiled ? ' is-paper' : '') +
        (inked ? ' is-inked' : '') +
        (handoff ? ' is-handoff' : '') +
        (entering ? ' is-entering' : '') +
        (leaving ? ' is-final' : '')
      }
      data-tq-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label="起卦三问"
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {phase !== 'veil' && Q ? (
        <div className="qi-dom">
          <header className="qi-head">
            <p className="qi-eyebrow">卦已成 · 解读之前</p>
          </header>
          <section className="qi-step" key={step}>
            <p className="tq-step-no">{Q.title}</p>
            <h3 className="tq-ask qi-ink-chars">
              {[...Q.ask].map((ch, i) => (
                <span key={i} className="tq-char" style={{ animationDelay: 260 + i * 62 + 'ms' }}>
                  {ch}
                </span>
              ))}
            </h3>
            {Q.hint ? <p className="tq-hint">{Q.hint}</p> : null}
            <ul className="tq-opts">
              {Q.options.map((o, i) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className="tq-opt qi-appear"
                    style={{ animationDelay: 900 + i * 110 + 'ms' }}
                    onClick={() => pick(Q.key, o.id)}
                  >
                    <span className="tq-opt-key" aria-hidden="true">{i + 1}</span>
                    <span className="tq-opt-word">{o.word}</span>
                    <span className="tq-opt-desc">{o.desc.split('—')[1] ? o.desc.split('—')[1].trim() : o.desc}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <footer className="tq-foot">
            <div className="tq-dots" aria-label={`已答 ${answered} / 3`}>
              {QUESTIONS.map((qq) => (
                <span key={qq.key} className={'tq-dot' + (answers[qq.key] ? ' is-on' : '')} />
              ))}
            </div>
          </footer>
        </div>
      ) : null}
    </div>,
    document.body
  )
}