/**
 * 来源标注（PRD F5）：让用户一眼分清
 *   ① 《周易》原文      —— kind="text"
 *   ② 现代白话解读      —— kind="plain"
 *   ③ 本项目的理解（非原文） —— kind="ours"
 *
 * 这是产品硬约束 3「原文与解读必须分层可见」的落点，任何一段正文都必须带标注。
 */
const LABEL = {
  text: '《周易》原文',
  plain: '现代白话解读',
  ours: '本项目的理解 · 非原文',
}

export default function SourceTag({ kind = 'text', note }) {
  return (
    <p className={`src src-${kind}`}>
      <span className="src-kind">{LABEL[kind]}</span>
      {note ? <span className="src-note">{note}</span> : null}
    </p>
  )
}
