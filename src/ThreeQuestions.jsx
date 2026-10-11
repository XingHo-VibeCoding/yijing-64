import { useEffect, useState } from 'react'
import { QUESTIONS, answersComplete } from './reading/threeQuestions.js'

/**
 * 起卦三问 · 浮层
 *
 * 流程：点击「起 一 卦」→ 出卦动画 → **先浮出这三问** → 用户作答 → 结果页。
 *
 * ⚠️ 设计要点（三条，改之前先想清楚）：
 *
 * ① **问题在出卦之后、结果页之前**，不是替代起卦。
 *    起卦仍是一次随机（用户要的是「今天是什么卦」这件事，不能被选择污染）；
 *    三问只影响**解读怎么写**，不影响**卦是什么**。
 *    这条边界很重要：若让用户选卦，就等于把「今日之卦」变成了用户编的。
 *
 * ② **可跳过，且不跳过也能用**。
 *    跳过 → 短评就是原来的逐卦专属句（`verdictLine` 的结果），一个字不变。
 *    故三问是**增强**，不是**前置条件** —— 不做这件事，功能也不会残废。
 *
 * ③ **回答只存本地、只用于本次解读**，不上云、不进记录。
 *    这是「不采集身份信息」那条边界的延续：这三问问的是心境，不是身份。
 */
export default function ThreeQuestions({ onDone }) {
  const [answers, setAnswers] = useState({})
  const [done, setDone] = useState(false)

  // 键盘：1–4 选当前题，Enter 进入下一题 / 完成
  useEffect(() => {
    if (done) return undefined
    const onKey = (e) => {
      const idx = Object.keys(answers).length
      if (idx >= QUESTIONS.length) return
      const Q = QUESTIONS[idx]
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= Q.options.length) {
        setAnswers((a) => ({ ...a, [Q.key]: Q.options[n - 1].id }))
        e.preventDefault()
      } else if (e.key === 'Enter') {
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [answers, done])

  // 全部答完 → 停 400ms 让最后一个选项的选中态被看见，再进结果页
  useEffect(() => {
    if (!answersComplete(answers)) return undefined
    const t = setTimeout(() => {
      setDone(true)
      onDone(answers)
    }, 420)
    return () => clearTimeout(t)
  }, [answers, onDone])

  const answeredCount = Object.keys(answers).length
  const current = QUESTIONS[answeredCount] || null

  return (
    <div className="tq-mask">
      <section className="tq-box" aria-live="polite">
        <header className="tq-head">
          <p className="tq-eyebrow">卦已成 · 解读之前</p>
          <h2 className="tq-title">三问</h2>
          <p className="tq-lead">
            此卦已定。下面三问，只为解读更贴着此刻的你 ——
            <b>答的是你自己的心境，不是卦象</b>。不愿答，可径入解读。
          </p>
        </header>

        {current ? (
          <div className="tq-step">
            <p className="tq-step-no">{current.title}</p>
            <h3 className="tq-ask">{current.ask}</h3>
            {current.hint ? <p className="tq-hint">{current.hint}</p> : null}
            <ul className="tq-opts">
              {current.options.map((o, i) => (
                <li key={o.id}>
                  <button
                    type="button"
                    className="tq-opt"
                    onClick={() => setAnswers((a) => ({ ...a, [current.key]: o.id }))}
                  >
                    <span className="tq-opt-key" aria-hidden="true">{i + 1}</span>
                    <span className="tq-opt-word">{o.word}</span>
                    <span className="tq-opt-desc">{o.desc.split('—')[1] ? o.desc.split('—')[1].trim() : o.desc}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="tq-step tq-step-done">
            <p className="tq-done">三问已毕</p>
            <p className="tq-done-sub">正在按你的作答解读…</p>
          </div>
        )}

        <footer className="tq-foot">
          <div className="tq-dots" aria-label={`已答 ${answeredCount} / 3`}>
            {QUESTIONS.map((Q, i) => (
              <span key={Q.key} className={'tq-dot' + (answers[Q.key] ? ' is-on' : '')} />
            ))}
          </div>
          <button type="button" className="tq-skip" onClick={() => onDone(answers)}>
            不答，直接看解读
          </button>
        </footer>
      </section>
    </div>
  )
}