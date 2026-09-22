import { useEffect, useRef, useState } from 'react'
import yaoData from '../data/64卦-爻辞.json'
import SourceTag from './SourceTag.jsx'

/**
 * 三层解读 · 第三层「想跟你说的话」
 *
 * 落点由卦的属性固定决定（PRD §4.1.3 吉凶方向表）：
 *   吉 → 戒骄躁    凶 → 劝慰（运随时变，成事在人）    平 → 中性陈述
 *
 * ⚠️ 这三段是**本项目的理解**，不是《周易》原文，因此展示时必须带「非原文」标注。
 * ⚠️ 不得出现「你会……」「建议你……」「宜 / 不宜」这类预测性与建议性表述。
 */
const THIRD_LAYER = {
  吉: '此刻是顺的。但《易》讲得最多的恰恰是：顺的时候最容易走岔。把眼下这份顺当成油门，而不是终点。',
  凶: '眼下是难的。但六十四卦排下来，没有一卦能一直难下去——运随时变，成事在人。',
  平: '谈不上吉也谈不上凶，它只是把这件事实话实说。继续观察，不必急着下结论。',
}

const FORTUNE_NOTE = {
  吉: '《易》的吉，多半是提醒而不是许诺。',
  凶: '《易》的凶，讲的是处境，不是判决。',
  平: '六十四卦里，这样的卦占了不少。',
}

/** 上下卦的结构描述：自然象的位置关系（如「上坤下艮」→「地在山上」） */
function structurePhrase(upperNature, lowerNature) {
  return upperNature === lowerNature ? `上下皆${upperNature}` : `${upperNature}在${lowerNature}上`
}

/**
 * 起卦结果页（PRD F7 结果页）
 *
 * 结构：卦头 → 两层交互键 → 三层解读（展开后）→ 边界声明 → 去读全卦
 * 卦象图不在本组件里：它由 CastingAnimation 的 SVG 舞台渲染（这样才能吃到那段水墨动画）。
 */
export default function CastResult({
  result,
  changingLines = [],
  onFocusLine,
  focusing = false,
  archived = false,
  favorited = false,
  onToggleFav,
  onRecast,
  onEnterList,
  onEnterDetail,
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  const readRef = useRef(null)

  /* 展开解读后自动滚到解读区：面板从屏幅 44% 处开始，不滚的话三层解读在视口外 */
  useEffect(() => {
    if (!open) return
    const box = boxRef.current
    const target = readRef.current
    if (box && target) box.scrollTop = target.offsetTop - 10
  }, [open])

  const yaos = yaoData.byId[String(result.id)] || []
  // 变爻**只取一爻**（解读聚焦）：changingLines 是 1–6 的位置，爻辞数组按「初→上」排列。
  // 这里再 slice 一次 —— 即使历史数据里存了多个变爻，界面也不会出现「多爻齐亮」
  const changingYaos = changingLines
    .slice(0, 1)
    .map((pos) => ({ pos, yao: yaos[pos - 1] }))
    .filter((x) => x.yao)

  const fortune = result.fortune || '平'

  return (
    <div className="cast-result" ref={boxRef}>
      <div className="cr-inner">
        {/* ── 卦头 ── */}
        <header className="cr-head">
          <h1 className="cr-name">{result.name}</h1>
          <p className="cr-meta">
            第 {result.id} 卦 · {result.volume}
            <span className={`cr-fortune cr-f-${fortune}`}>{fortune}</span>
          </p>
          <p className="cr-trigrams">
            上{result.upperTrigram}（{result.upperNature}） · 下{result.lowerTrigram}（{result.lowerNature}）
          </p>
        </header>

        {/* ── 与存档的关系（PRD F8：每天的第一卦才入记录） ── */}
        <p className={'cr-archive' + (archived ? ' is-in' : '')}>
          {archived ? (
            <>今天的卦<b>已记录</b> —— 日后可以在「我的记录」里回看这一天起的正是这一卦。</>
          ) : (
            <>今天的第一卦已经记过了，<b>本卦仅作娱乐，不入记录</b>。</>
          )}
        </p>

        {/* ── 变爻：触发第二段水墨动画 ── */}
        {changingYaos.length > 0 && (
          <div className="cr-focus">
            <button
              type="button"
              className="cr-focus-btn"
              onClick={onFocusLine}
              disabled={focusing}
            >
              {focusing ? '墨正翻涌…' : `看这一爻 · ${changingYaos[0].yao.label}`}
            </button>
            <span className="cr-focus-hint">卦起.见爻</span>
          </div>
        )}

        {/* ── 两个交互键（PRD F7：给当下的感受 / 给继续读下去的路） ── */}
        <div className="cr-actions">
          <button type="button" className="cr-btn cr-btn-primary" onClick={() => setOpen((v) => !v)}>
            {open ? '收起解读' : '查看解读'}
          </button>
          <button type="button" className="cr-btn" onClick={onEnterList}>
            进入卦象爻辞总表
          </button>
        </div>

        {/* ── 次级动作：收藏与再起一卦（收藏与存档是两件事） ── */}
        <div className="cr-actions cr-actions-sub">
          <button
            type="button"
            className={'cr-btn cr-btn-mini' + (favorited ? ' is-on' : '')}
            onClick={onToggleFav}
          >
            {favorited ? '★ 已收藏' : '☆ 收藏这一卦'}
          </button>
          <button type="button" className="cr-btn cr-btn-mini" onClick={onRecast}>
            再起一卦
          </button>
        </div>

        {/* ── 三层解读（展开） ── */}
        {open && (
          <div className="cr-reading" ref={readRef}>
            {/* 第一层 · 卦象说什么 */}
            <section className="cr-layer">
              <h2 className="cr-layer-title">
                <span className="cr-layer-no">第一层</span>卦象说什么
              </h2>
              <p className="cr-layer-body">
                上卦为{result.upperTrigram}，取象「{result.upperNature}」；
                下卦为{result.lowerTrigram}，取象「{result.lowerNature}」。
                两卦相叠，画面就是「<b>{structurePhrase(result.upperNature, result.lowerNature)}</b>」。
              </p>
              <SourceTag kind="ours" note="本层由上下卦的取象推出，只描述画面，不作吉凶判断" />
            </section>

            {/* 第二层 · 卦辞爻辞怎么讲 */}
            <section className="cr-layer">
              <h2 className="cr-layer-title">
                <span className="cr-layer-no">第二层</span>卦辞爻辞怎么讲
              </h2>

              <div className="cr-text">
                <span className="cr-text-label">卦辞</span>
                <p className="cr-classic">{result.judgment}</p>
              </div>
              <div className="cr-text">
                <span className="cr-text-label">象辞</span>
                <p className="cr-classic">{result.image}</p>
              </div>

              {changingYaos.map(({ yao }) => (
                <div className="cr-text cr-text-hi" key={yao.label}>
                  <span className="cr-text-label">变爻 · {yao.label}</span>
                  <p className="cr-classic">{yao.text}</p>
                  {yao.xiang ? <p className="cr-classic cr-sub">象曰：{yao.xiang}</p> : null}
                </div>
              ))}

              {changingYaos.length === 0 && (
                <p className="cr-none">本次起卦没有变爻，因此不需要特别指出某一爻。</p>
              )}

              <SourceTag
                kind="text"
                note="卦辞与爻辞取自通行本（王弼本），已逐条核对，一字未改"
              />
            </section>

            {/* 第三层 · 想跟你说的话 */}
            <section className="cr-layer">
              <h2 className="cr-layer-title">
                <span className="cr-layer-no">第三层</span>想跟你说的话
              </h2>
              <p className="cr-layer-body cr-talk">{THIRD_LAYER[fortune]}</p>
              {result.fortuneBasis?.length ? (
                <p className="cr-basis">
                  这一卦判为「{fortune}」，依据是卦辞里的「{result.fortuneBasis.join('」「')}」。
                </p>
              ) : null}
              <SourceTag kind="ours" note="上面这段是本项目的理解，不是《周易》里的话" />
            </section>

            {/* ── 去读全卦：把好奇导向学习 ── */}
            <button type="button" className="cr-btn cr-btn-wide" onClick={onEnterDetail}>
              读这一卦的全卦 →
            </button>
          </div>
        )}

        {/* ── 边界声明（PRD §1.3：首页与起卦结果页各有一次） ── */}
        <footer className="cr-boundary">
          <p className="cr-boundary-main">成事在人，莫问前程</p>
          <p className="cr-boundary-sub">
            本页不预测、不建议，请把它当作一段古文的解读。
            卦不替你做决定——它只是让你多一个看当下的角度。
          </p>
        </footer>
      </div>
    </div>
  )
}
