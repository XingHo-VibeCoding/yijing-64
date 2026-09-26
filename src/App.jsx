import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import data from '../data/64卦.json'
import yaoData from '../data/64卦-爻辞.json'
import HexagramFigure from './HexagramFigure.jsx'
import CastingAnimation from './CastingAnimation.jsx'
import Records from './Records.jsx'
import Quiz from './Quiz.jsx'
import SourceTag from './SourceTag.jsx'
import InkTransition from './InkTransition.jsx'
import * as store from './storage.js'
import { fetchHexagrams, mockMode } from './mockApi.js'

const VOLUMES = [
  { key: '上经', range: '1–30' },
  { key: '下经', range: '31–64' },
]

/**
 * 极简 hash 路由（不引第三方路由库）。
 *   #/h/15     → 第 15 卦详情页（**可直接打开、可分享**，PRD F2 边界条件）
 *   #/quiz     → F3 记忆测验
 *   #/records  → 过往起卦记录
 *   空 / 其它  → 总表
 * 地址栏是状态的唯一来源：pushState 只有这两处，其余全靠 hashchange 回读。
 */
function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  if (raw.startsWith('h/')) {
    const id = Number.parseInt(raw.slice(2), 10)
    if (Number.isInteger(id) && id >= 1 && id <= 64) return { kind: 'detail', id }
  }
  if (raw === 'quiz') return { kind: 'quiz' }
  if (raw === 'records') return { kind: 'records' }
  return { kind: 'list' }
}

/** 改 hash；值没变就不动（避免无意义的历史记录堆积），变化会触发 hashchange */
function go(hash) {
  if (window.location.hash === hash) return
  window.location.hash = hash
}

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
  const quizSum = store.quizSummary()
  const current = currentId === null ? null : data.items.find((h) => h.id === currentId)

  /* ---------- 主视图的数据走 mock 接口（Day 8：本周不接真实 API） ----------
     数据本身就在本地 JSON 里，「成功」态内容与原来完全一致；
     走一层接口是为了让 **加载 / 空 / 错误**三种状态真实出现、可逐个截图核对，
     也是 F6 接云端时的预演 —— 到时候只换 mockApi.js 的实现，这个状态机不动。 */
  const [transition, setTransition] = useState(null) // { id, x, y } —— 点总表某一卦后的墨侵染转场

  const [list, setList] = useState({ status: 'loading', items: [], error: '' })
  const loadList = useCallback(() => {
    setList({ status: 'loading', items: [], error: '' })
    fetchHexagrams({ mode: mockMode() })
      .then((r) => setList({ status: 'ready', items: r.items, error: '' }))
      .catch((e) => setList({ status: 'error', items: [], error: (e && e.message) || '未知错误' }))
  }, [])
  useEffect(() => {
    loadList()
  }, [loadList])

  /* 回到总表时，把刚起的卦滚到视野中间 */
  useEffect(() => {
    if (casting || currentId !== null || view !== 'list' || highlightId == null) return
    if (list.status !== 'ready') return // 列表还没渲染出来，滚了也白滚
    const el = document.querySelector(`[data-hid="${highlightId}"]`)
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [casting, currentId, view, highlightId, list.status])

  /* ---------- 地址栏 → 状态（直接打开 /#/h/15 也能进详情页） ---------- */
  useEffect(() => {
    const sync = () => {
      const r = parseHash()
      if (r.kind === 'detail') {
        setCurrentId(r.id)
        setView('list')
      } else {
        setCurrentId(null)
        setView(r.kind === 'records' ? 'records' : r.kind === 'quiz' ? 'quiz' : 'list')
      }
    }
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

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
    go(`#/h/${id}`)
  }

  /**
   * 从总表进详情：先放一段「涟漪 → 墨侵染 → 墨散 → 卦象浮现 → 归位」的转场。
   * 起点取鼠标位置；**键盘回车触发时没有鼠标坐标**，改用被点那一行的中心（否则涟漪会从左上角冒出来）。
   */
  const startTransition = (id, e) => {
    const hasPointer = Number.isFinite(e.clientX) && (e.clientX !== 0 || e.clientY !== 0)
    const rect = e.currentTarget.getBoundingClientRect()
    setTransition({
      id,
      x: hasPointer ? e.clientX : rect.left + rect.width / 2,
      y: hasPointer ? e.clientY : rect.top + rect.height / 2,
    })
    openDetail(id, 'list')
  }

  /**
   * F1 交互：列表里用 ↑ / ↓ 在卦之间移动焦点，回车即进入（`<button>` 原生支持 Enter / Space）。
   * 到头就停住、不绕回 —— 绕回会让人失去「我在第几个」的位置感。
   */
  const onItemKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(document.querySelectorAll('.item'))
    const i = items.indexOf(e.currentTarget)
    if (i < 0) return
    const target = e.key === 'ArrowDown' ? items[i + 1] : items[i - 1]
    if (!target) return
    e.preventDefault()
    target.focus()
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
          go('#/')
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
    // 翻页（PRD F2 元素 6）：首尾两卦要正确处理 —— 第 1 卦没有上一卦、第 64 卦没有下一卦
    const prevHex = data.items.find((h) => h.id === current.id - 1) || null
    const nextHex = data.items.find((h) => h.id === current.id + 1) || null

    return (
      // 详情页 = 竹简记录（.page-slips 覆盖成竹简质地）
      <main className="page page-slips">
        <div className="detail-bar">
          <button
            type="button"
            className="back"
            onClick={() => {
              setCurrentId(null)
              setView(backTo)
              go(backTo === 'records' ? '#/records' : '#/')
            }}
          >
            ← {backTo === 'records' ? '返回记录' : '返回总表'}
          </button>

          <nav className="pager" aria-label="翻页">
            <button
              type="button"
              className="pager-btn"
              disabled={!prevHex}
              onClick={() => prevHex && openDetail(prevHex.id, backTo)}
            >
              ‹ 上一卦{prevHex ? ` · ${prevHex.name}` : ''}
            </button>
            <button
              type="button"
              className="pager-btn"
              disabled={!nextHex}
              onClick={() => nextHex && openDetail(nextHex.id, backTo)}
            >
              {nextHex ? `${nextHex.name} · ` : ''}下一卦 ›
            </button>
          </nav>
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
            <h1 className="detail-name">
              {current.name}
              {current.pinyin ? <span className="detail-pinyin">{current.pinyin}</span> : null}
            </h1>
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

        {/* 从总表点进来的那一次，走「涟漪 → 墨侵染 → 墨散 → 卦象浮现 → 归位」的转场。
            ⚠️ 必须用 portal 挂到 body 下：`.page` 上的 filter 会把 fixed 的定位基准
            从视口改成页面本身（转场层会被卷进页面坐标，「屏幕中央」变成「整页中央」） */}
        {transition &&
          createPortal(
            <InkTransition
              key={transition.id}
              lines={data.items.find((h) => h.id === transition.id)?.lines || []}
              origin={{ x: transition.x, y: transition.y }}
              onDone={() => setTransition(null)}
            />,
            document.body
          )}
      </main>
    )
  }

  /* ---------- F3 记忆测验 ---------- */
  if (view === 'quiz') {
    return (
      <Quiz
        onOpenDetail={(id) => openDetail(id, 'list')}
        onBack={() => {
          setView('list')
          go('#/')
        }}
      />
    )
  }

  /* ---------- F8 过往起卦记录 ---------- */
  if (view === 'records') {
    return (
      <Records
        records={records}
        favorites={favorites}
        quizRounds={quizSum.rounds}
        onOpen={(id) => openDetail(id, 'records')}
        onClear={() => {
          store.clearAll()
          bump()
        }}
        onToggleFav={(id) => {
          store.toggleFavorite(id)
          bump()
        }}
        onBack={() => {
          setView('list')
          go('#/')
        }}
      />
    )
  }

  /* ---------- 卦象爻辞总表（四种页面状态：加载 / 空 / 错误 / 成功） ---------- */

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
        <button
          type="button"
          className="my-records"
          onClick={() => {
            setView('records')
            go('#/records')
          }}
        >
          我的记录
          {records.length + favorites.length > 0 ? (
            <span className="my-records-n">
              {records.length} 条记录 · {favorites.length} 个收藏
            </span>
          ) : (
            <span className="my-records-n">每天第一卦会自动记在这里</span>
          )}
        </button>

        <button
          type="button"
          className="my-records"
          onClick={() => {
            setView('quiz')
            go('#/quiz')
          }}
        >
          测一测
          {quizSum.answered > 0 ? (
            <span className="my-records-n">
              {quizSum.rounds} 轮 · 正确率 {Math.round(quizSum.accuracy * 100)}% · 最好一次 {quizSum.best} 题
            </span>
          ) : (
            <span className="my-records-n">看卦象选卦名 · 一轮 20 题</span>
          )}
        </button>

        <p className="boundary">本页不提供占卜、预测与运势判断</p>
      </header>

      {/* 加载中：骨架行。骨架屏不是装饰 —— 它告诉用户「在动，不是坏了」 */}
      {list.status === 'loading' && (
        <section className="volume" aria-busy="true">
          <ul className="list" aria-label="列表加载中">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i}>
                <div className="item item-skeleton" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 错误：明说出了什么事 + 给一条明确的出路（重试），不用 alert 拦住整个页面 */}
      {list.status === 'error' && (
        <section className="state state-error" role="alert">
          <p className="state-title">列表没有加载出来</p>
          <p className="state-sub">{list.error} —— 已起的卦与测验进度不受影响。点「重试」再试一次。</p>
          <button type="button" className="cr-btn cr-btn-primary" onClick={loadList}>
            重试
          </button>
        </section>
      )}

      {/* 空：空不是错，但最容易被当成「坏了」—— 所以要说清为什么空、下一步能做什么 */}
      {list.status === 'ready' && list.items.length === 0 && (
        <section className="state">
          <p className="state-title">这里还没有卦</p>
          <p className="state-sub">
            数据源返回了空列表（?mock=empty 的演示）。按「重试」会重新加载一次。
          </p>
          <button type="button" className="cr-btn" onClick={loadList}>
            重试
          </button>
        </section>
      )}

      {/* 成功 */}
      {list.status === 'ready' && list.items.length > 0 && (
        <>
          {VOLUMES.map(({ key, range }) => (
            <section key={key} className="volume">
              <h2 className="volume-title">
                {key} <span className="volume-range">{range}</span>
              </h2>
              <ul className="list">
                {list.items
                  .filter((h) => h.volume === key)
                  .map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className={'item' + (highlightId === h.id ? ' is-hit' : '')}
                        data-hid={h.id}
                        onKeyDown={onItemKeyDown}
                        onClick={(e) => {
                          setHighlightId(null)
                          startTransition(h.id, e)
                        }}
                      >
                        <span className="item-id">{h.id}</span>
                        <span className="item-symbol" aria-hidden="true">{h.symbol}</span>
                        <span className="item-name">{h.name}</span>
                        <span className="item-trigrams">
                          上{h.upperTrigram}（{h.upperNature}）· 下{h.lowerTrigram}（{h.lowerNature}）
                        </span>
                        <span className="item-judgment">{h.judgment}</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}

          <footer className="foot">
            共 {list.items.length} 卦 · 每卦含六爻爻线与上下卦 · 数据来源：{data.meta.source}
          </footer>
        </>
      )}
    </main>
  )
}
