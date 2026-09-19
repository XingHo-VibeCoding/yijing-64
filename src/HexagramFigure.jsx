const ORDER = ['初', '二', '三', '四', '五', '上']

/** 爻题：初九/六二/九三/六四/九五/上六 */
function lineLabel(index, isYang) {
  const num = isYang ? '九' : '六'
  if (index === 0) return `初${num}`
  if (index === 5) return `上${num}`
  return `${num}${ORDER[index]}`
}

/**
 * 卦象图：六条爻线。
 * lines[0] 是初爻（最下），渲染时反转为自上而下。
 * 阳爻 = 一条整线；阴爻 = 中间断开的两段。
 */
export default function HexagramFigure({ lines, size = 'md' }) {
  const topDown = lines
    .map((v, i) => ({ isYang: v === 1, label: lineLabel(i, v === 1) }))
    .reverse()

  return (
    <div className={`figure figure-${size}`} role="img" aria-label="卦象图：六爻自下而上">
      {topDown.map((l, i) => (
        <div className="figure-row" key={i}>
          <span className="figure-label">{l.label}</span>
          <span className="figure-line">
            {l.isYang ? (
              <i className="bar bar-whole" />
            ) : (
              <>
                <i className="bar bar-half" />
                <i className="bar bar-half" />
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
