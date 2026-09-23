import { useState } from 'react'
import data from '../data/64卦.json'
import HexagramFigure from './HexagramFigure.jsx'
import SourceTag from './SourceTag.jsx'
import * as store from './storage.js'
import { makeRound, QUESTIONS_PER_ROUND } from './quiz.js'

const byId = (id) => data.items.find((h) => h.id === id)

/**
 * F3 · 记忆测验页（P1）
 *
 * 一次一轮 20 题：看卦象选卦名、答后立刻反馈、本轮成绩 + 错题清单。
 * 题目全部在本地生成（src/quiz.js），进度写本机（storage.js 的测验那一段）。
 *
 * 两条来自 PRD F3 的硬要求：
 *   ① **答错后必须立刻看到正确答案**，不允许「等服务端返回」→ 全程本地判定
 *   ② **同一轮内不出重复题**，64 卦全部可作为题面 → 由 quiz.js 的洗牌保证（已用脚本验过 500 轮）
 */
export default function Quiz({ onOpenDetail, onBack }) {
  const [round, setRound] = useState(() => makeRound(data.items))
  const [index, setIndex] = useState(0)
  const [picked, setPicked] = useState(null)
  const [correct, setCorrect] = useState(0)
  const [streak, setStreak] = useState(0)
  const [bestStreak, setBestStreak] = useState(0)
  const [wrongIds, setWrongIds] = useState([])
  const [result, setResult] = useState(null)

  const q = round[index]
  const target = byId(q.id)
  const answered = picked !== null
  const isLast = index === round.length - 1

  const pick = (id) => {
    if (answered) return // 一题只判一次
    setPicked(id)
    if (id === q.id) {
      const v = streak + 1
      setStreak(v)
      setCorrect((n) => n + 1)
      if (v > bestStreak) setBestStreak(v)
    } else {
      setStreak(0)
      setWrongIds((w) => [...w, q.id])
    }
  }

  const advance = () => {
    if (!isLast) {
      setIndex((i) => i + 1)
      setPicked(null)
      return
    }
    // 最后一题答完 → 记成绩（correct / wrongIds 已包含最后一题）
    store.saveQuizRound({ score: correct, total: round.length, answeredIds: round.map((r) => r.id), wrongIds })
    setResult({ score: correct, total: round.length })
  }

  const restart = () => {
    setRound(makeRound(data.items))
    setIndex(0)
    setPicked(null)
    setCorrect(0)
    setStreak(0)
    setBestStreak(0)
    setWrongIds([])
    setResult(null)
  }

  /* ---------- 结果页 ---------- */
  if (result) {
    const summary = store.quizSummary()
    const wrongBook = store.quizWrongBook()

    return (
      <main className="page quiz">
        <div className="detail-bar">
          <button type="button" className="back" onClick={onBack}>
            ← 返回总表
          </button>
        </div>

        <header className="head">
          <h1>
            本轮 {result.score} / {result.total}
          </h1>
          <p className="sub">最长连对 {bestStreak} 题</p>
        </header>

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
            note="测验进度只写在这台设备的浏览器里；不采集任何身份信息，也没有上传（云端同步尚未接入）"
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

  /* ---------- 答题 ---------- */
  return (
    <main className="page quiz">
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
          连对 <b>{streak}</b> · 本轮正确 <b>{correct}</b>
        </span>
      </div>

      <section className="q-face">
        <HexagramFigure lines={target.lines} size="lg" labels={false} />
        <p className="q-face-hint">这一卦叫什么？</p>
      </section>

      <div className="q-options">
        {q.options.map((id) => {
          const h = byId(id)
          const cls =
            'q-opt' +
            (answered && id === q.id ? ' is-answer' : '') +
            (answered && id === picked && id !== q.id ? ' is-chosen-wrong' : '')
          return (
            <button key={id} type="button" className={cls} disabled={answered} onClick={() => pick(id)}>
              {h.name}
            </button>
          )
        })}
      </div>

      {answered && (
        <div className={'q-feedback' + (picked === q.id ? ' is-right' : ' is-wrong')}>
          <p className="q-verdict">{picked === q.id ? '答对了' : '答错了'}</p>
          <p className="q-answer">
            正确答案：<b>{target.name}</b>
            <span className="q-answer-meta">
              {target.symbol} · 第 {target.id} 卦 · 上{target.upperTrigram}下{target.lowerTrigram}
            </span>
          </p>
        </div>
      )}

      {answered && (
        <div className="cr-actions q-actions">
          <button type="button" className="cr-btn cr-btn-primary" onClick={advance}>
            {isLast ? '看成绩' : '下一题'}
          </button>
        </div>
      )}

      <p className="q-foot">
        一轮 {QUESTIONS_PER_ROUND} 题 · 同一轮不重复 · 干扰项取自相邻卦序与同族卦（不送分）
      </p>
    </main>
  )
}
