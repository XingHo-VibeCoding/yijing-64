import { useState } from 'react'
import data from '../data/64卦.json'
import HexagramFigure from './HexagramFigure.jsx'

const VOLUMES = [
  { key: '上经', range: '1–30' },
  { key: '下经', range: '31–64' },
]

/** 来源标注：区分「经典原文」与「后人解读」（PRD 第 6 节 F5） */
function SourceTag({ kind, note }) {
  return (
    <p className={`src src-${kind}`}>
      <span className="src-kind">{kind === 'text' ? '《周易》原文' : '现代白话解读'}</span>
      <span className="src-note">{note}</span>
    </p>
  )
}

export default function App() {
  const [currentId, setCurrentId] = useState(null)
  const current = currentId === null ? null : data.items.find((h) => h.id === currentId)

  if (current) {
    return (
      <main className="page">
        <button type="button" className="back" onClick={() => setCurrentId(null)}>
          ← 返回列表
        </button>

        <header className="detail-head">
          <div className="detail-symbol" aria-hidden="true">{current.symbol}</div>
          <div>
            <h1 className="detail-name">{current.name}</h1>
            <p className="detail-meta">第 {current.id} 卦 · {current.volume}</p>
          </div>
        </header>

        <section className="block">
          <h2 className="block-title">卦象</h2>
          <div className="figure-wrap">
            <HexagramFigure lines={current.lines} />
            <dl className="trigrams">
              <div>
                <dt>上卦</dt>
                <dd>{current.upperTrigram}（{current.upperNature}）</dd>
              </div>
              <div>
                <dt>下卦</dt>
                <dd>{current.lowerTrigram}（{current.lowerNature}）</dd>
              </div>
            </dl>
          </div>
          <SourceTag kind="text" note="卦象与卦序依据通行本（王弼本）；卦符取自 Unicode U+4DC0–U+4DFF" />
        </section>

        <section className="pending">
          <h2 className="pending-title">待补内容</h2>
          <ul>
            <li>卦辞、象辞（原文 + 白话）</li>
            <li>六条爻辞（原文 + 白话 + 小象）</li>
            <li>卦名拼音</li>
          </ul>
          <p className="pending-note">
            按 PRD 第 7.2 节，原文须以 ctext.org 王弼本逐条核对后录入，本步未做。
          </p>
        </section>
      </main>
    )
  }

  const withFigure = data.items.length

  return (
    <main className="page">
      <header className="head">
        <h1>易经六十四卦学习</h1>
        <p className="sub">认识卦象 · 读懂原文 · 记住卦序</p>
        <p className="boundary">本页不提供占卜、预测与运势判断</p>
      </header>

      {VOLUMES.map(({ key, range }) => (
        <section key={key} className="volume">
          <h2 className="volume-title">
            {key} <span className="volume-range">{range}</span>
          </h2>
          <ul className="list">
            {data.items
              .filter((h) => h.volume === key)
              .map((h) => (
                <li key={h.id}>
                  <button type="button" className="item" onClick={() => setCurrentId(h.id)}>
                    <span className="item-id">{h.id}</span>
                    <span className="item-symbol" aria-hidden="true">{h.symbol}</span>
                    <span className="item-name">{h.name}</span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}

      <footer className="foot">
        共 {withFigure} 卦 · 每卦含六爻爻线与上下卦 · 数据来源：{data.meta.source}
      </footer>
    </main>
  )
}
