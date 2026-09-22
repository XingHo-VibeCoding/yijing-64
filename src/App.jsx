import { useEffect, useState } from 'react'
import data from '../data/64卦.json'
import yaoData from '../data/64卦-爻辞.json'
import HexagramFigure from './HexagramFigure.jsx'
import CastingAnimation from './CastingAnimation.jsx'
import Records from './Records.jsx'
import SourceTag from './SourceTag.jsx'
import * as store from './storage.js'

const VOLUMES = [
  { key: '上经', range: '1–30' },
  { key: '下经', range: '31–64' },
]

/**
 * 「这一卦至少有一个变爻」的概率。
 * 传统取法里每爻有 1/4 是变爻（老阳 3/16 + 老阴 1/16），六爻独立 →
 * 至少一个变爻的概率 = 1 − (3/4)^6 ≈ 0.822。
 */
const P_HAS_CHANGING = 1 - Math.pow(0.75, 6)

/**
 * 一键起卦：六爻各自随机（阳 / 阴各半），再按六爻查卦。
 *
 * 变爻**一次只取一爻**——解读要聚焦，第二段动画也只突出这一爻。
 * 做法等价于「先按每爻 1/4 各自判定，再只留一爻」，但结果确定只有一个：
 * 先按上式的概率决定「有没有变爻」，再在六爻中均匀取一爻
 * （在传统模型里，条件于「至少一个变爻」时，变爻位置本就是均匀分布）。
 */
function castOnce() {
  const lines = Array.from({ length: 6 }, () => (Math.random() < 0.5 ? 1 : 0))
  const hit = data.items.find((h) => h.lines.join('') === lines.join('')) || data.items[0]
  const changing = Math.random() < P_HAS_CHANGING ? [1 + Math.floor(Math.random() * 6)] : []
  return { id: hit.id, changing }
}

export default function App() {
  const [currentId, setCurrentId] = useState(null)
  const [casting, setCasting] = useState(null)   // { id, changing, archived }
  const [castSeq, setCastSeq] = useState(0)      // 作为 key：保证「再起一卦」真的从头播
  const [highlightId, setHighlightId] = useState(null)
  const [view, setView] = useState('list')       // 'list' | 'records'
  const [backTo, setBackTo] = useState('list')   // 详情页「返回」回到哪
  const [, setTick] = useState(0)
  const bump = () => setTick((n) => n + 1)       // 本地存储变动后强制重读

  const records = store.loadRecords()
  const favorites = store.loadFavorites()
  const current = currentId === null ? null : data.items.find((h) => h.id === currentId)

  /* 回到总表时，把刚起的卦滚到视野中间 */
  useEffect(() => {
    if (casting || currentId !== null || view !== 'list' || highlightId == null) return
    const el = document.querySelector(`[data-hid="${highlightId}"]`)
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [casting, currentId, view, highlightId])

  /* ---------- 起卦：一键出结果，并判定是否入档 ---------- */
  const startCast = () => {
    const c = castOnce()
    // 每天的第一卦自动存档；今天已有记录则本卦不入档（PRD F8）
    const archived = store.archiveFirstOfToday(c.id, c.changing)
    setCastSeq((n) => n + 1)
    setCasting({ ...c, archived })
    bump()
  }

  const openDetail = (id, from = 'list') => {
    setBackTo(from)
    setView('list')
    setCurrentId(id)
  }

  /* ---------- 起卦流程（动画 + 结果页） ---------- */
  if (casting) {
    const target = data.items.find((h) => h.id === casting.id)
    return (
      <CastingAnimation
        key={castSeq}
        result={target}
        // 只取第一个：解读聚焦一爻（万一有历史数据带多个变爻，界面也不会出现「多爻齐亮」）
        changingLines={casting.changing.slice(0, 1)}
        archived={casting.archived}
        favorited={favorites.some((f) => f.hexagramId === casting.id)}
        onToggleFav={() => {
          store.toggleFavorite(casting.id)
          bump()
        }}
        onRecast={startCast}
        onEnterList={(id) => {
          setCasting(null)
          setView('list')
          setHighlightId(id)
        }}
        onEnterDetail={(id) => {
          setCasting(null)
          openDetail(id, 'list')
        }}
      />
    )
  }

  /* ---------- 单卦详情 ---------- */
  if (current) {
    const yaos = yaoData.byId[String(current.id)] || []
    const fortune = current.fortune || '平'
    const basis = current.fortuneBasis || []
    const fav = favorites.some((f) => f.hexagramId === current.id)

    return (
      <main className="page">
        <div className="detail-bar">
          <button
            type="button"
            className="back"
            onClick={() => {
              setCurrentId(null)
              setView(backTo)
            }}
          >
            ← {backTo === 'records' ? '返回记录' : '返回总表'}
          </button>
          <button
            type="button"
            className={'fav-btn' + (fav ? ' is-on' : '')}
            onClick={() => {
              store.toggleFavorite(current.id)
              bump()
            }}
          >
            {fav ? '★ 已收藏' : '☆ 收藏这一卦'}
          </button>
        </div>

        <header className="detail-head">
          <div className="detail-symbol" aria-hidden="true">{current.symbol}</div>
          <div>
            <h1 className="detail-name">{current.name}</h1>
            <p className="detail-meta">
              第 {current.id} 卦 · {current.volume}
              <span className={`fortune fortune-${fortune}`}>{fortune}</span>
            </p>
          </div>
        </header>

        {/* 卦象 */}
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
          <SourceTag kind="text" note="卦序与卦符依据通行本（王弼本）；卦符取自 Unicode U+4DC0–U+4DFF" />
        </section>

        {/* 卦辞 / 象辞 */}
        <section className="block">
          <h2 className="block-title">卦辞 · 象辞</h2>
          <div className="classic-block">
            <span className="classic-label">卦辞</span>
            <p className="classic">{current.judgment}</p>
          </div>
          <div className="classic-block">
            <span className="classic-label">象辞</span>
            <p className="classic">{current.image}</p>
          </div>
          <SourceTag kind="text" note="取自通行本（王弼本），已逐条核对，一字未改" />
        </section>

        {/* 六爻爻辞 */}
        <section className="block">
          <h2 className="block-title">六爻爻辞</h2>
          <ol className="yao-list">
            {yaos.map((y) => (
              <li className="yao" key={y.label}>
                <span className="yao-label">{y.label}</span>
                <div>
                  <p className="classic">{y.text}</p>
                  {y.xiang ? <p className="classic yao-xiang">象曰：{y.xiang}</p> : null}
                </div>
              </li>
            ))}
          </ol>
          <SourceTag
            kind="text"
            note="爻辞取自通行本（王弼本）；384 条爻题阴阳已与卦象交叉验证，0 不一致"
          />
        </section>

        {/* 吉凶平：本项目的判定，依据可追溯 */}
        <section className="block">
          <h2 className="block-title">吉 · 凶 · 平</h2>
          <p className="fortune-line">
            本卦判为 <b className={`fortune-text fortune-text-${fortune}`}>{fortune}</b>
            {basis.length ? <>，依据是卦辞里的「{basis.join('」「')}」。</> : '。'}
          </p>
          <p className="fortune-note">
            {fortune === '吉'
              ? '吉卦提醒的是戒骄躁——顺境最容易松懈，这句吉不是许诺，是提醒。'
              : fortune === '凶'
                ? '凶卦讲的是处境，不是判决。运随时变，成事在人。'
                : '谈不上吉也谈不上凶，它只是把这件事实话实说。'}
          </p>
          <SourceTag kind="ours" note="这是本项目按卦辞整体处境作出的判定，不作未来断言" />
        </section>
      </main>
    )
  }

  /* ---------- F8 过往起卦记录 ---------- */
  if (view === 'records') {
    return (
      <Records
        records={records}
        favorites={favorites}
        onOpen={(id) => openDetail(id, 'records')}
        onClear={() => {
          store.clearAll()
          bump()
        }}
        onToggleFav={(id) => {
          store.toggleFavorite(id)
          bump()
        }}
        onBack={() => setView('list')}
      />
    )
  }

  /* ---------- 卦象爻辞总表 ---------- */
  const total = data.items.length

  return (
    <main className="page">
      <header className="head">
        <h1>易经六十四卦学习</h1>
        <p className="sub">认识卦象 · 读懂原文 · 记住卦序</p>

        {/* 全页视觉权重最高的动作（PRD F7） */}
        <button type="button" className="cast-cta" onClick={startCast}>
          <span className="cast-cta-main">起 一 卦</span>
          <span className="cast-cta-sub">成事在人，莫问前程</span>
        </button>

        {/* 我的记录入口（PRD F1：次级按钮） */}
        <button type="button" className="my-records" onClick={() => setView('records')}>
          我的记录
          {records.length + favorites.length > 0 ? (
            <span className="my-records-n">
              {records.length} 条记录 · {favorites.length} 个收藏
            </span>
          ) : (
            <span className="my-records-n">每天第一卦会自动记在这里</span>
          )}
        </button>

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
                  <button
                    type="button"
                    className={'item' + (highlightId === h.id ? ' is-hit' : '')}
                    data-hid={h.id}
                    onClick={() => {
                      setHighlightId(null)
                      openDetail(h.id, 'list')
                    }}
                  >
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
        共 {total} 卦 · 每卦含六爻爻线与上下卦 · 数据来源：{data.meta.source}
      </footer>
    </main>
  )
}
