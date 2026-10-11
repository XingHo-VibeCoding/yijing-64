import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { QUESTIONS, answersComplete } from './reading/threeQuestions.js'

/**
 * 起卦三问 · 水墨全屏转场（Day 22 重做 UI，用户指定分镜）：
 *
 *   ① 点「起 一 卦」后 —— 白色云气升腾，铺满成一张「纸面」（遮住屏幕）
 *   ② 纸面上问题以水墨形式浮现（题面逐字显影，选项依次洇出）
 *   ③ 每答完一题 —— 淡墨云涌起汇集遮满 → 散开时**新问题的字**逐个显影
 *   ④ 三问答完（或跳过）—— 墨云再次汇集，散开时露出的是**起卦动画**
 *      （遮满一瞬动画已在下层开播，墨散即衔接）
 *
 * ============================================================
 * 结构约定（与 InkTransition / MistTransition / QuizInkSweep 同族）：
 *   - portal 到 body（防 filter 改 fixed 定位基准）
 *   - 单 canvas + 单 rAF 主循环，确定性逐帧重绘（同一 el 永远同一画面）
 *   - 回调走 latest-ref；onCovered 一次性 latch
 *   - ?transFreeze=N 定格在 N ms（只画不走，不触发回调）
 * ============================================================
 *
 * ⚠️ 流程边界（沿用 Day 22 的产品判断，不许动摇）：
 *   - 三问**不影响「卦是什么」**：卦在点按钮那刻已由 castOnce 定死，
 *     三问只影响「解读怎么写」。遮满时动画才开播，但卦早已定。
 *   - 可跳过，跳过也完全可用（短评逐卦原句）。
 *   - 作答只存内存、不上云、不进记录。
 */

const INK = '24, 20, 16'
const PAPER = '247, 239, 224' // 纸面基色（同 .tq-box 宣纸底）

/* 时间轴（ms） */
const T_VEIL = 1500 // 白雾铺满成纸面
const T_COVER = 1150 // sweep：墨云遮满（换题/进动画点）
const T_SWEEP_END = 2300 // sweep：墨散完毕

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3)

export default function QuestionInkFlow({ onAllAnswered, onExit }) {
  const canvasRef = useRef(null)
  /* step：当前第几问（0–2）；phase：veil（雾起）/ ask（作答）/ sweep（墨涌换题） */
  /* ⚠️ initPhase 必须在所有引用它的 useState **之前**声明 ——
   * 此前它声明在 modeRef 附近（靠后），而 phase 的 useState 在前面就用了它，
   * 打包后触发 TDZ（Cannot access before initialization），整棵树白屏。
   * 教训同 Day 21 的 fortune TDZ：**声明顺序要按使用顺序排，不能按语义分组排**。 */
  const initPhase = new URLSearchParams(
    typeof window !== 'undefined' ? window.location.search : ''
  ).get('tqPhase')
  const [step, setStep] = useState(0)
  const [phase, setPhase] = useState(initPhase === 'ask' || initPhase === 'sweep' ? initPhase : 'veil')
  const [answers, setAnswers] = useState({})
  /* CSS 底的状态机：veil 完成 → is-paper（纸面）；sweep 开始 → is-inked（墨遮满）；
   * final 遮满 → is-final（整层淡出露动画）；普通换题散开 → 回 is-paper */
  /* ⚠️ 直达相位（?tqPhase）跳过了 veil/前序 sweep，CSS 底的初值必须与「已到达」的
   * 视觉状态一致：直达 ask = 纸面已在；直达 sweep = 墨已遮满。
   * 否则 is-paper / is-inked 永远不会置位，底色透明、下层页面整个透出来（截图抓到过）。 */
  /* ?tqFinal=1：直达「三问答完后的散开段」（验证墨散露出起卦动画） */
  const initFinal = new URLSearchParams(
    typeof window !== 'undefined' ? window.location.search : ''
  ).get('tqFinal') === '1'
  const [veiled, setVeiled] = useState(initPhase === 'ask' || initPhase === 'sweep')
  const [inked, setInked] = useState(initPhase === 'sweep')
  const [leaving, setLeaving] = useState(initFinal)
  const finalRef = useRef(initFinal)

  const cbRef = useRef({})
  cbRef.current = { onAllAnswered, onExit }
  /* latest-ref：canvas 循环读这里，不因重渲染重建 */
  const stepRef = useRef(0)
  stepRef.current = step
  const answersRef = useRef(answers)
  answersRef.current = answers
  /* canvas 循环的模式：veil | idle | sweep。
   * ?tqPhase=ask|sweep 直达该相位（与 ?qcStart 同族的调试约定）；final 时 paperA 也会按 final 渐隐 */
  /* ⚠️ 值域映射：DOM 的 phase 叫 'ask'，canvas 的模式叫 'idle' ——
   * 此前 tqPhase=ask 直达时 modeRef='ask' 不匹配循环里任何绘制分支，
   * canvas 整帧空白 → 纸面底没画 → 下层页面整个透出来（截图抓到的）。 */
  const modeRef = useRef(initPhase === 'sweep' ? 'sweep' : initPhase === 'ask' ? 'idle' : 'veil')
  const sweepStartRef = useRef(0)

  const pick = (qKey, optId) => {
    const next = { ...answersRef.current, [qKey]: optId }
    answersRef.current = next
    setAnswers(next)
    beginSweep(stepRef.current === QUESTIONS.length - 1)
  }

  const skip = () => beginSweep(true)

  /** 进入墨涌段。final=true 表示遮满后直接进起卦动画 */
  const beginSweep = (final) => {
    finalRef.current = final
    modeRef.current = 'sweep'
    sweepStartRef.current = performance.now()
    setPhase('sweep')
    setInked(true) // CSS 底随即开始向墨色过渡（与 canvas 墨云同步涌起）
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

    /* ?transFreeze=N：定格（同族转场约定） */
    const fz = parseFloat(new URLSearchParams(window.location.search).get('transFreeze'))
    const FREEZE = Number.isFinite(fz) && fz >= 0 ? fz : null

    /* 白雾团：自下升腾铺满（veil 相位用），铺满后化为纸面 */
    const blobs = []
    for (let i = 0; i < 16; i++) {
      blobs.push({
        x: (0.04 + 0.92 * (i / 15) + (Math.random() - 0.5) * 0.06) * 1440,
        y: H + 40 + Math.random() * H * 0.5,
        r: (80 + Math.random() * 140) * (W / 1440),
        v: (0.3 + Math.random() * 0.32) * H,
        sway: 18 + Math.random() * 44,
        ph: Math.random() * Math.PI * 2,
        a: 0.2 + Math.random() * 0.22,
        delay: Math.random() * 350,
      })
    }

    /* 淡墨云团：ask 相位常驻流动（云雾流动感是项目硬约束——拒绝静止背景） */
    const clouds = []
    for (let cx = 0; cx < 8; cx++) {
      for (let cy = 0; cy < 4; cy++) {
        clouds.push({
          x: ((cx + 0.5) / 8 + (Math.random() - 0.5) * 0.14) * 1440,
          r: (90 + Math.random() * 130) * (W / 1440),
          v: H * (0.00016 + Math.random() * 0.00012), // 缓慢：作答时的底，只流动不抢戏
          sway: 20 + Math.random() * 34,
          ph: Math.random() * Math.PI * 2,
          a: 0.05 + Math.random() * 0.045,
          delay: Math.random() * 800,
        })
      }
    }

    /* sweep 墨云团：涌起遮满用（快而厚） */
    const surge = []
    for (let cx = 0; cx < 8; cx++) {
      for (let cy = 0; cy < 4; cy++) {
        surge.push({
          x: ((cx + 0.5) / 8 + (Math.random() - 0.5) * 0.14) * 1440,
          r: (95 + Math.random() * 140) * (W / 1440),
          v: H * (0.00055 + Math.random() * 0.00035),
          sway: 18 + Math.random() * 30,
          ph: Math.random() * Math.PI * 2,
          a: 0.16 + Math.random() * 0.12,
          delay: Math.random() * 450,
        })
      }
    }

    /* x 坐标按当前 W 重投影（blobs/clouds 以 1440 基准存的比例位置） */
    const px = (x) => (x / 1440) * W

    const t0 = performance.now()
    let veilDone = false
    let covered = false
    let exited = false
    let raf = 0

    const loop = (now) => {
      const el = FREEZE != null ? FREEZE : now - t0
      const mode = modeRef.current
      /* FREEZE 时用「定格时刻以来」的 sweep 局部时间，保证 sweep 画面正确 */
      if (FREEZE != null && mode === 'sweep') {
        sweepStartRef.current = 0 // sweep 局部时间 = el
      }

      ctx.clearRect(0, 0, W, H)

      /* ---------- 纸面底改由 CSS 承担（.qi-stage 背景 + 状态 class 过渡） ----------
       * 原因：无头截图（虚拟时间）下 canvas 层不进合成输出——纸面画了也截不到，
       * 视觉验证只能靠 DOM。分工改为：CSS 管静态底与遮满/散开过渡（可验证、可降级），
       * canvas 只画动态云雾（veil 白雾 / idle 流云 / sweep 墨涌），真实浏览器中作质感增强。
       * canvas 位图本身已用探针验证非空（toDataURL ≈ 695KB）。 */

      /* ---------- veil 相位：白雾自下升腾（铺满的那刻转 ask） ---------- */
      if (mode === 'veil') {
        const t = el / 1000
        for (const b of blobs) {
          const lt = Math.max(0, el - b.delay)
          if (lt <= 0) continue
          const y = b.y - b.v * (lt / 1000) - easeOutCubic(clamp01(lt / 2500)) * H * 0.35
          if (y < -b.r) continue
          const x = px(b.x) + Math.sin(t * 0.7 + b.ph) * b.sway
          const a = b.a * clamp01(lt / 500)
          if (a <= 0.01) continue
          const g = ctx.createRadialGradient(x, y, 0, x, y, b.r)
          g.addColorStop(0, `rgba(248, 245, 238, ${a})`)
          g.addColorStop(0.55, `rgba(243, 239, 230, ${a * 0.55})`)
          g.addColorStop(1, `rgba(243, 239, 230, 0)`)
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

      /* ---------- idle 相位：淡墨云常驻流动 + 题面背后一团墨晕呼吸 ---------- */
      if (mode === 'idle') {
        const t = el / 1000
        for (const c of clouds) {
          if (el < c.delay) continue
          const cycle = ((el - c.delay) * c.v) % (H + c.r * 2)
          const y = H + c.r - cycle
          const x = px(c.x) + Math.sin(el / 650 + c.ph) * c.sway
          const env = clamp01(cycle / (c.r * 1.4)) * clamp01((H + c.r - cycle) / (c.r * 1.4))
          const a = c.a * env
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
        /* 题面背后的墨晕：极淡、缓慢呼吸（呼应「水墨形式浮现」） */
        const breath = 0.045 + 0.014 * Math.sin(el / 1400)
        const gy = H * 0.34
        const g = ctx.createRadialGradient(W / 2, gy, 0, W / 2, gy, Math.min(W, H) * 0.46)
        g.addColorStop(0, `rgba(${INK}, ${breath})`)
        g.addColorStop(0.6, `rgba(${INK}, ${breath * 0.55})`)
        g.addColorStop(1, `rgba(${INK}, 0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.ellipse(W / 2, gy, W * 0.44, Math.min(W, H) * 0.4, 0, 0, Math.PI * 2)
        ctx.fill()
      }

      /* ---------- sweep 相位：墨云涌起遮满 →（遮满一瞬换题/进动画）→ 散开 ---------- */
      if (mode === 'sweep') {
        const sp = el - sweepStartRef.current
        const outP = clamp01((sp - T_COVER) / (T_SWEEP_END - T_COVER))
        const live = 1 - easeInOutCubic(outP)
        for (const c of surge) {
          if (sp < c.delay) continue
          const cycle = ((sp - c.delay) * c.v) % (H + c.r * 2)
          const y = H + c.r - cycle
          const x = px(c.x) + Math.sin(sp / 650 + c.ph) * c.sway
          const env = clamp01(cycle / (c.r * 1.4)) * clamp01((H + c.r - cycle) / (c.r * 1.4))
          const a = c.a * env * (0.35 + 0.65 * clamp01(sp / (T_COVER * 0.8))) * live
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
        /* 兜底墨面：遮满前铺实；散开段整体变淡并向上飘走 */
        const veilA = 0.95 * easeInOutCubic(clamp01((sp - 300) / (T_COVER - 300))) * live
        if (veilA > 0.01) {
          ctx.fillStyle = `rgba(${INK}, ${veilA})`
          ctx.fillRect(0, -easeInOutCubic(outP) * H * 0.25, W, H)
        }
        if (!covered && sp >= T_COVER && FREEZE == null) {
          covered = true
          setInked(true)
          if (finalRef.current) {
            /* 遮满一瞬：起卦动画在下层开播（overlay 继续盖着播墨散） */
            setLeaving(true)
            cbRef.current.onAllAnswered && cbRef.current.onAllAnswered(answersRef.current)
          } else {
            /* 换题：墨散的过程中新问题的字正在逐个显影 */
            setStep((s) => Math.min(s + 1, QUESTIONS.length - 1))
          }
        }
        if (sp >= T_SWEEP_END && FREEZE == null) {
          if (finalRef.current && !exited) {
            exited = true
            cbRef.current.onExit && cbRef.current.onExit()
            return // 卸载：下层动画接管
          }
          covered = false
          modeRef.current = 'idle'
          setPhase('ask')
          setInked(false) // 墨散开，回到纸面
        }
      }

      if (FREEZE != null) return // 定格：只画当前相位画面，不推进不回调
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
  /* veil 相位不渲染题面；sweep 相位 DOM 留在原地，由 CSS 淡出（被涌起的墨盖住） */

  return createPortal(
    <div
      className={
        'qi-stage' +
        (veiled ? ' is-paper' : '') +
        (inked ? ' is-inked' : '') +
        (leaving ? ' is-final' : '')
      }
      data-tq-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label="起卦三问"
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {phase !== 'veil' && Q ? (
        <div className={'qi-dom' + (finalRef.current ? ' is-final' : '')}>
          <header className="qi-head">
            <p className="qi-eyebrow">卦已成 · 解读之前</p>
          </header>
          <section className="qi-step" key={step}>
            <p className="tq-step-no">{Q.title}</p>
            <h3 className="tq-ask qi-ink-chars">
              {[...Q.ask].map((ch, i) => (
                <span key={i} className="tq-char" style={{ animationDelay: 160 + i * 55 + 'ms' }}>
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
                    style={{ animationDelay: 520 + i * 95 + 'ms' }}
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
            <button type="button" className="tq-skip" onClick={skip}>
              不答，直接起卦
            </button>
          </footer>
        </div>
      ) : null}
    </div>,
    document.body
  )
}