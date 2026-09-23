import { useState } from 'react'
import hexData from '../data/64卦.json'
import SourceTag from './SourceTag.jsx'

const ITEM = (id) => hexData.items.find((h) => h.id === id)
const ORDER = ['初', '二', '三', '四', '五', '上']

/** 变爻位置 → 爻题（初九 / 六二 / 上六……），阴阳取自该卦的爻线。只取一爻。 */
function yaoLabels(hex, positions) {
  return (positions || [])
    .slice(0, 1)
    .map((p) => {
      const isYang = hex.lines[p - 1] === 1
      const num = isYang ? '九' : '六'
      if (p === 1) return `初${num}`
      if (p === 6) return `上${num}`
      return `${num}${ORDER[p - 1]}`
    })
    .join('')
}

/**
 * F8 · 过往起卦记录与收藏
 *
 * 这是「情绪价值」的留存机制：让起卦留下时间的痕迹，
 * 用户日后回看「那一天我起的正是这一卦」，结合当时的生活重新读它。
 *
 * 记录**不可事后编辑** —— 改写它就失去了回看的意义（PRD F8）。
 */
export default function Records({ records, favorites, quizRounds = 0, onOpen, onClear, onToggleFav, onBack }) {
  const [tab, setTab] = useState('records')
  const [confirming, setConfirming] = useState(false)
  // ⚠️ 测验进度（F3）也算「有记录」—— 否则只测过一轮、还没起过卦时，
  //    这个页面会显示成空的，「清空我的记录」按钮就不出现，进度再也清不掉
  const empty = records.length === 0 && favorites.length === 0 && quizRounds === 0

  return (
    <main className="page">
      <button type="button" className="back" onClick={onBack}>
        ← 返回总表
      </button>

      <header className="rec-head">
        <h1 className="rec-title">过往起卦记录</h1>
        <p className="rec-sub">
          回看「那天我起的正是这一卦」——结合当时的生活重新读它，比当天读更有味道。
        </p>
      </header>

      {/* 两个分区 */}
      <div className="rec-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'records'}
          className={'rec-tab' + (tab === 'records' ? ' is-on' : '')}
          onClick={() => setTab('records')}
        >
          起卦记录 <span className="rec-tab-n">{records.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'favorites'}
          className={'rec-tab' + (tab === 'favorites' ? ' is-on' : '')}
          onClick={() => setTab('favorites')}
        >
          收藏 <span className="rec-tab-n">{favorites.length}</span>
        </button>
      </div>

      {/* ── 起卦记录 ── */}
      {tab === 'records' && (
        <section className="rec-list">
          {records.length === 0 ? (
            <p className="rec-empty">
              还没有记录。<b>每天第一次起卦会自动记在这里</b>，一天只记一条——
              想多起几次随时可以，只是后面的不入记录。
            </p>
          ) : (
            <ul className="rec-ul">
              {records.map((r) => {
                const hex = ITEM(r.hexagramId)
                if (!hex) return null
                const changing = yaoLabels(hex, r.changingLines)
                return (
                  <li key={r.date}>
                    <button type="button" className="rec-item" onClick={() => onOpen(hex.id)}>
                      <div className="rec-item-top">
                        <span className="rec-date">{r.date}</span>
                        <span className="rec-symbol" aria-hidden="true">{hex.symbol}</span>
                        <span className="rec-name">
                          {hex.name}
                          <span className="rec-id">第 {hex.id} 卦</span>
                        </span>
                        {changing ? <span className="rec-changing">变爻 {changing}</span> : null}
                      </div>
                      <p className="rec-judgment">{hex.judgment}</p>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {/* ── 收藏 ── */}
      {tab === 'favorites' && (
        <section className="rec-list">
          {favorites.length === 0 ? (
            <p className="rec-empty">
              还没有收藏。起卦结果页与卦的详情页都能收藏——<b>收藏与记录是两件事</b>：
              记录只留每天第一卦，收藏随你。
            </p>
          ) : (
            <ul className="rec-ul">
              {favorites.map((f) => {
                const hex = ITEM(f.hexagramId)
                if (!hex) return null
                return (
                  <li key={f.hexagramId}>
                    <div className="rec-item rec-item-fav">
                      <button type="button" className="rec-fav-main" onClick={() => onOpen(hex.id)}>
                        <span className="rec-symbol" aria-hidden="true">{hex.symbol}</span>
                        <span className="rec-name">
                          {hex.name}
                          <span className="rec-id">第 {hex.id} 卦 · 收藏于 {f.date}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="rec-fav-off"
                        onClick={() => onToggleFav(hex.id)}
                        aria-label={`取消收藏 ${hex.name}`}
                      >
                        取消收藏
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      <SourceTag
        kind="ours"
        note="记录只保存「日期 + 卦序 + 变爻」，不保存精确时刻，也不保存任何身份信息"
      />

      {/* 清空：二次确认 */}
      {!empty && (
        <section className="rec-danger">
          {confirming ? (
            <div className="rec-confirm">
              <p className="rec-confirm-text">
                确定清空全部记录、收藏与测验成绩吗？<b>不可恢复。</b>
              </p>
              <div className="rec-confirm-row">
                <button
                  type="button"
                  className="rec-btn rec-btn-danger"
                  onClick={() => {
                    onClear()
                    setConfirming(false)
                  }}
                >
                  确定清空
                </button>
                <button type="button" className="rec-btn" onClick={() => setConfirming(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="rec-btn rec-btn-ghost" onClick={() => setConfirming(true)}>
              清空我的记录
            </button>
          )}
        </section>
      )}
    </main>
  )
}
