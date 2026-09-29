import { useEffect, useState } from 'react'
import data from '../data/64卦.json'
import HexagramFigure from './HexagramFigure.jsx'
import QuizInkBackground from './QuizInkBackground.jsx'
import QuizInkSweep from './QuizInkSweep.jsx'
import SourceTag from './SourceTag.jsx'
import * as store from './storage.js'
import { makeRound, QUESTIONS_PER_ROUND } from './quiz.js'

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
export default function Quiz({ onOpenDetail, onBack }) {
  const [round, setRound] = useState(() => makeRound(data.items))
  const [index, setIndex] = useState(0)
  const [built, setBuilt] = useState([]) // 已摆的爻（自初爻往上），元素为 1(阳)/0(阴)
  const [judged, setJudged] = useState(false)
  const [correct, setCorrect] = useState(0)
  const [wrongIds, setWrongIds] = useState([])
  const [result, setResult] = useState(null) // { score, total, rewardId, claimed }
  const [sweep, setSweep] = useState(false) // 下一题的黑墨翻涌转场进行中
  const [claimed, setClaimed] = useState(false)

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
    // 最后一题答完 → 记成绩，并抽出奖励卦（从未镀金的卦里随机，不重复）
    store.saveQuizRound({ score: correct, total: round.length, answeredIds: round.map((r) => r.id), wrongIds })
    const gilded = new Set(store.loadGilded())
    const pool = data.items.map((h) => h.id).filter((id) => !gilded.has(id))
    const rewardId = pool.length && correct >= 6 ? pool[Math.floor(Math.random() * pool.length)] : null
    setResult({ score: correct, total: round.length, rewardId, claimed: false })
  }

  /* 墨遮满全屏的一瞬换题：新题的名字会按 nameShown 时序在墨散中浮出 */
  const handleSweepCovered = () => {
    setIndex((i) => i + 1)
    setBuilt([])
    setJudged(false)
  }
  const handleSweepDone = () => setSweep(false)

  const claimReward = () => {
    if (!result || !result.rewardId || result.claimed) return
    store.addGilded(result.rewardId)
    setClaimed(true)
    setResult({ ...result, claimed: true })
  }

  const restart = () => {
    setRound(makeRound(data.items))
    setIndex(0)
    setBuilt([])
    setJudged(false)
    setCorrect(0)
    setWrongIds([])
    setResult(null)
    setClaimed(false)
  }

  /* ---------- 结果页 ---------- */
  if (result) {
    const summary = store.quizSummary()
    const wrongBook = store.quizWrongBook()
    const reward = result.rewardId ? byId(result.rewardId) : null

    return (
      <main className="page quiz quiz-ink">
      <QuizInkBackground />
        <div className="detail-bar">
          <button type="button" className="back" onClick={onBack}>
            ← 返回总表
          </button>
        </div>

        <header className="head">
          <h1>
            本轮 {result.score} / {result.total}
          </h1>
          {result.rewardId ? (
            <p className="sub">答对 6 题以上，示一枚新卦 —— 点击即可为它镀金</p>
          ) : (
            <p className="sub">6 题以上正确可得「镀金一卦」的奖励，再接再厉</p>
          )}
        </header>

        {/* 奖励：随机出示一枚未镀金的卦，点击领取 */}
        {reward && (
          <section className="q-reward" aria-live="polite">
            <h2 className="q-reward-title">{claimed ? '已镀金' : '新卦出示'}</h2>
            <button
              type="button"
              className={'q-reward-card' + (claimed ? ' is-claimed' : '')}
              onClick={claimReward}
              disabled={claimed}
            >
              <span className="q-reward-symbol" aria-hidden="true">
                {reward.symbol}
              </span>
              <span className="q-reward-name">{reward.name}</span>
              <span className="q-reward-meta">第 {reward.id} 卦 · {reward.judgment}</span>
              <span className="q-reward-go">{claimed ? '金字已在总表点亮' : '点击领取 · 为它镀金'}</span>
            </button>
            <p className="q-reward-note">
              镀金永久有效：这枚卦在卦象总表上的卦名与卦辞会变为金字。已镀过的卦不会再出示。
            </p>
          </section>
        )}
        {!reward && result.rewardId === null && result.score >= 6 && (
          <p className="q-none">六十四卦已全部镀金 —— 再无新卦可出示，敬请收下这份完满。</p>
        )}

        <section className="block">
          <h2 className="block-title">这一轮答错的</h2>
          {wrongIds.length ? (
            <ul className="q-wrong-list">
              {wrongIds.map((id) => {
                const h = byId(id)
                return (
                  <li key={id}>
                    <button type="button" className="q-wrong-item" onClick={() => onOpenDetail(id)}>
                      <span className="q-wrong-symbol" aria-hidden="true">
                        {h.symbol}
                      </span>
                      <span className="q-wrong-name">{h.name}</span>
                      <span className="q-wrong-id">第 {id} 卦</span>
                      <span className="q-wrong-go">去读这一卦 →</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="q-none">这一轮全对，没有错题。</p>
          )}
        </section>

        <section className="block">
          <h2 className="block-title">累计</h2>
          <p className="q-sum">
            已测 <b>{summary.rounds}</b> 轮 · 共 <b>{summary.answered}</b> 题 · 正确率{' '}
            <b>{Math.round(summary.accuracy * 100)}%</b> · 最好一次 <b>{summary.best}</b> 题
          </p>
          <p className="q-sum-soft">
            错题本里还有 {wrongBook.length} 卦没答对过（答对过一次就会移出）。
          </p>
          <SourceTag
            kind="ours"
            note="测验进度与镀金只写在这台设备的浏览器里；不采集任何身份信息，也没有上传（云端同步尚未接入）"
          />
        </section>

        <div className="cr-actions q-actions">
          <button type="button" className="cr-btn cr-btn-primary" onClick={restart}>
            再来一轮
          </button>
          <button type="button" className="cr-btn" onClick={onBack}>
            回总表
          </button>
        </div>
      </main>
    )
  }

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
            {isLast ? '看成绩' : '下一题'}
          </button>
        </div>
      )}

      <p className="q-foot">
        一轮 {QUESTIONS_PER_ROUND} 题 · 同一轮不重复 · 答对 6 题以上随机出示一枚未镀金的卦，点击即镀金
      </p>

      {sweep && <QuizInkSweep onCovered={handleSweepCovered} onDone={handleSweepDone} />}
    </main>
  )
}
