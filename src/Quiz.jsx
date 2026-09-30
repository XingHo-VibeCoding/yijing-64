import { useEffect, useState } from 'react'
import data from '../data/64卦.json'
import HexagramFigure from './HexagramFigure.jsx'
import QuizInkBackground from './QuizInkBackground.jsx'
import QuizInkSweep from './QuizInkSweep.jsx'
import SourceTag from './SourceTag.jsx'
import * as store from './storage.js'
import { makeRound, QUESTIONS_PER_ROUND, PASS_MIN } from './quiz.js'

const byId = (id) => data.items.find((h) => h.id === id)
const YAO_LABEL = ['初', '二', '三', '四', '五', '上']

/**
 * F3 · 记忆测验页（P1）—— Day 11 题型更换
 *
 * 一轮 8 题：**出示卦名，用户用下方「阳爻 / 阴爻」两个键从初爻往上拼出卦象**，
 * 摆满六爻自动判定，答错立刻亮出正确卦象。答对 6 题以上 → 随机出示一枚
 * 「未镀金」的卦（不重复），点击领取后该卦在卦象总表的木牌镀金（卦名与卦辞变金字，永久）。
 *
 * 两条来自 PRD F3 的硬要求不变：
 *   ① **答错后必须立刻看到正确答案** → 全程本地判定
 *   ② **同一轮内不出重复题** → 由 quiz.js 的洗牌保证
 */
export default function Quiz({ onOpenDetail, onBack, onCeremony }) {
  const [round, setRound] = useState(() => makeRound(data.items))
  const [index, setIndex] = useState(0)
  const [built, setBuilt] = useState([]) // 已摆的爻（自初爻往上），元素为 1(阳)/0(阴)
  const [judged, setJudged] = useState(false)
  const [correct, setCorrect] = useState(0)
  const [wrongIds, setWrongIds] = useState([])
  const [sweep, setSweep] = useState(false) // 下一题的黑墨翻涌转场进行中

  const q = round[index]
  const target = byId(q.id)

  /* 每题切换的「墨散名浮」：先 0.65s 水墨聚拢，再让卦名由模糊中浮出（水墨仍在四周流动） */
  const [nameShown, setNameShown] = useState(false)
  useEffect(() => {
    setNameShown(false)
    const t = window.setTimeout(() => setNameShown(true), 650)
    return () => window.clearTimeout(t)
  }, [index, round])
  const full = built.length === 6
  const isLast = index === round.length - 1

  const place = (bit) => {
    if (judged || built.length >= 6) return
    const next = [...built, bit]
    setBuilt(next)
    if (next.length === 6) {
      // 摆满六爻自动判定
      setJudged(true)
      if (next.join('') === target.lines.join('')) {
        setCorrect((n) => n + 1)
      } else {
        setWrongIds((w) => [...w, q.id])
      }
    }
  }

  const undo = () => {
    if (judged || built.length === 0) return
    setBuilt(built.slice(0, -1))
  }

  const advance = () => {
    if (!isLast) {
      if (sweep) return // 转场进行中忽略重复点击
      setSweep(true) // 黑墨翻涌遮屏 → 遮满一瞬换题 → 散开露新题
      return
    }
    // 最后一题答完 → 记成绩 → 终局仪式（未达容错：黑云劝慰；达成：白云 + 门庭 + 镀金卦象）
    store.saveQuizRound({ score: correct, total: round.length, answeredIds: round.map((r) => r.id), wrongIds })
    const passed = correct >= PASS_MIN
    let rewardId = null
    if (passed) {
      const gilded = new Set(store.loadGilded())
      const pool = data.items.map((h) => h.id).filter((id) => !gilded.has(id))
      if (pool.length) {
        rewardId = pool[Math.floor(Math.random() * pool.length)]
        store.addGilded(rewardId) // 奖励即领：门后浮现的卦象就是已经镀金的它
      }
    }
    onCeremony({ variant: passed ? 'pass' : 'fail', rewardId })
  }

  /* 墨遮满全屏的一瞬换题：新题的名字会按 nameShown 时序在墨散中浮出 */
  const handleSweepCovered = () => {
    setIndex((i) => i + 1)
    setBuilt([])
    setJudged(false)
  }
  const handleSweepDone = () => setSweep(false)

  /* ---------- 答题：出示卦名，用户拼卦象 ---------- */
  return (
    <main className="page quiz quiz-ink">
      <QuizInkBackground />
      <div className="detail-bar">
        <button type="button" className="back" onClick={onBack}>
          ← 退出测验
        </button>
      </div>

      <div className="q-bar">
        <span className="q-progress">
          第 <b>{index + 1}</b> / {round.length} 题
        </span>
        <span className="q-score">
          本轮正确 <b>{correct}</b>
        </span>
      </div>

      <section className="q-face">
        <p className={"q-face-name" + (nameShown ? " is-shown" : "")}>{target.name}</p>
        <p className="q-face-hint">用下面的阴阳爻，从初爻到上爻拼出这一卦</p>
      </section>

      {/* 拼卦区：上爻在显示的最上方，初爻在最下 —— 摆满六爻自动判定 */}
      <div className="q-build" role="group" aria-label="拼卦区">
        {[5, 4, 3, 2, 1, 0].map((i) => {
          const v = built[i]
          return (
            <div className="q-slot" key={i}>
              <span className="q-slot-label">{YAO_LABEL[i]}</span>
              <span className={'q-slot-line' + (v === undefined ? ' is-empty' : v === 1 ? ' is-yang' : ' is-yin')}>
                {v === 1 && <span className="yao-bar" />}
                {v === 0 && (
                  <>
                    <span className="yao-bar" />
                    <span className="yao-bar" />
                  </>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {/* 阴阳爻：一条流动的水墨从中间截断 —— 左半白色为一条（阳爻），右半黑色中间有截断（阴爻） */}
      <div className="yao-input" role="group" aria-label="阴阳爻输入">
        <button
          type="button"
          className="q-key-yang yao-side"
          disabled={judged}
          onClick={() => place(1)}
          aria-label="阳爻（左：白色一条）"
        >
          <span className="yao-ink yao-ink-yang" aria-hidden="true" />
          <span className="yao-side-label">阳爻</span>
        </button>
        <button
          type="button"
          className="q-key-yin yao-side"
          disabled={judged}
          onClick={() => place(0)}
          aria-label="阴爻（右：黑色中断）"
        >
          <span className="yao-ink yao-ink-yin" aria-hidden="true">
            <i />
            <i />
          </span>
          <span className="yao-side-label">阴爻</span>
        </button>
      </div>
      <div className="yao-undo-row">
        <button type="button" className="q-key-undo" disabled={judged || built.length === 0} onClick={undo}>
          撤销一笔
        </button>
      </div>

      {judged && (
        <div className={'q-feedback' + (built.join('') === target.lines.join('') ? ' is-right' : ' is-wrong')}>
          <p className="q-verdict">{built.join('') === target.lines.join('') ? '拼对了' : '拼错了'}</p>
          <p className="q-answer">
            正确卦象：<b>{target.name}</b>
            <span className="q-answer-meta">
              {target.symbol} · 第 {target.id} 卦 · 上{target.upperTrigram}下{target.lowerTrigram}
            </span>
          </p>
          <div className="q-answer-figure">
            <HexagramFigure lines={target.lines} size="md" labels={false} />
          </div>
        </div>
      )}

      {judged && (
        <div className="cr-actions q-actions">
          <button type="button" className="cr-btn cr-btn-primary" onClick={advance}>
            {isLast ? '礼成' : '下一题'}
          </button>
        </div>
      )}

      <p className="q-foot">
        一轮 {QUESTIONS_PER_ROUND} 题 · 同一轮不重复 · 最多错 3 道 · 达成后门庭深处会出示一枚未镀金的卦，点击即镀金
      </p>

      {sweep && <QuizInkSweep onCovered={handleSweepCovered} onDone={handleSweepDone} />}
    </main>
  )
}
