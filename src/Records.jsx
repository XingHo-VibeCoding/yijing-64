import { useCallback, useEffect, useState } from 'react'
import hexData from '../data/64卦.json'
import SourceTag from './SourceTag.jsx'
import * as store from './storage.js'

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
  /* 进度码（换设备带走进度）：只有日期/卦序/变爻/收藏/镀金/成绩，不含身份信息 */
  const [code, setCode] = useState('')
  const [importText, setImportText] = useState('')
  const [msg, setMsg] = useState('')
  /* 云端读取状态（Day 17）：让「数据是从接口读到的」在页面上看得见，
     而不是只写在代码里。via=api 表示走了云函数读接口，rdb 表示已回退直连。 */
  const [cloud, setCloud] = useState(() => store.cloudReadStatus())
  const [busy, setBusy] = useState(false)
  /* uid 断链：本地有记录、但当前 uid 云端一条也没有（换浏览器 / 清了站点数据 / 无痕）
     —— 这时页面看着像「记录被清零」。**只在确迹象象时出现，且要用户确认才重绑。 */
  const [orphan, setOrphan] = useState(() => store.orphanStatus())
  const [rebound, setRebound] = useState('')
  /* 检查台（Day 20 · 余力加练）：健康接口状态 + 写入测试入口。
     ⚠️ 都用**既有能力**（`/api/health` 与 POST 接口），不新增任何后端行为。 */
  const [health, setHealth] = useState({ state: 'idle', text: '' })
  const [probeId, setProbeId] = useState('1')
  const [probe, setProbe] = useState({ state: 'idle', text: '' })

  const checkHealth = useCallback(async () => {
    setHealth({ state: 'busy', text: '' })
    try {
      const r = await store.debugHealth()
      setHealth({
        state: r.ok ? 'ok' : 'bad',
        text: r.ok ? `正常 · ${r.body.service || 'yijing-64'} · ${r.ms} ms` : `异常 · HTTP ${r.status}`,
      })
    } catch (e) {
      setHealth({ state: 'bad', text: '连不上：' + ((e && e.message) || '未知错误') })
    }
  }, [])

  const runProbe = useCallback(async () => {
    const id = Number(probeId)
    if (!Number.isInteger(id) || id < 1 || id > 64) {
      setProbe({ state: 'bad', text: '卦序号要填 1 – 64 之间的整数' })
      return
    }
    setProbe({ state: 'busy', text: '' })
    try {
      const r = await store.debugApiWrite('favorites', { hexagramId: id })
      const body = r.body || {}
      const tip = r.status === 201 ? '已新建' : r.status === 200 ? '已收藏（幂等）' : '被拒绝'
      setProbe({
        state: r.status === 200 || r.status === 201 ? 'ok' : 'bad',
        text: `卦 ${id} → HTTP ${r.status} · ${tip}${body.data ? ' · 收藏日 ' + body.data.createdAt : ''}${
          body.error ? ' · ' + body.error.message : ''
        }`,
      })
      // 写入可能改变了云端条数，把读取面板一起刷新
      await store.refreshFromCloud()
      setCloud(store.cloudReadStatus())
    } catch (e) {
      setProbe({ state: 'bad', text: '连不上：' + ((e && e.message) || '未知错误') })
    }
  }, [probeId])

  const readCloud = useCallback(async () => {
    setBusy(true)
    try {
      await store.refreshFromCloud()
      setCloud(store.cloudReadStatus())
      setOrphan(store.orphanStatus())
    } catch (e) {
      setCloud({ ...store.cloudReadStatus(), detail: '读取失败：' + ((e && e.message) || '未知错误') })
    } finally {
      setBusy(false)
    }
  }, [])

  /* 用户确认后重绑：把本地记录 / 收藏重新推到当前 uid 下 */
  const doRebind = useCallback(async () => {
    setBusy(true)
    try {
      const r = await store.rebindLocalToCloud()
      const bad = (r.failedRecords || 0) + (r.failedFavorites || 0)
      setRebound(
        (bad > 0 ? '部分完成（' + bad + ' 条没写上云）' : '已重新备份')
        + '：记录 ' + r.records + ' 条 · 收藏 ' + r.favorites + ' 条'
      )
      setCloud(store.cloudReadStatus())
      setOrphan(store.orphanStatus())
    } catch (e) {
      setRebound('重绑失败：' + ((e && e.message) || '未知错误'))
    } finally {
      setBusy(false)
    }
  }, [])

  /* ⚠️ 云端状态是**异步**拉回来的，首帧一定读不到 —— 所以这里不能只读一次：
   *   ① 订阅 `yijing:cloud-synced`（storage.js 每次合并成功都会派发）；
   *   ② 再加一条兜底轮询（合并成功但**没有新数据**时不会派发事件，只靠轮询）。
   * 两条合起来保证「拉取刚完成」的那一刻，界面一定会更新一次。
   * ⚠️ 之前两个面板（云端读取 / uid 断链）都栽在这里：一次性读取 → 永远停在「读取中」。 */
  useEffect(() => {
    const sync = () => {
      setCloud(store.cloudReadStatus())
      setOrphan(store.orphanStatus())
    }
    window.addEventListener('yijing:cloud-synced', sync)
    sync()                                                    // 立即读一次（已拉完的情形）
    const t1 = setTimeout(sync, 1500)                         // 兜底：首帧之后
    const t2 = setTimeout(sync, 4000)                         // 兜底：网络慢的情形
    const t3 = setTimeout(sync, 9000)                         // 兜底：更慢的情形
    return () => {
      window.removeEventListener('yijing:cloud-synced', sync)
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3)
    }
  }, [])

  /* 「一键自检」：地址栏加 `?check=1` 就自动跑一遍健康检查 + 写入测试。
     用途有两个：① 同伴拿到链接后不必点按钮就能看到接口通不通；
     ② 验收时能截到「点了之后」的真实状态，而不是只有按钮的空面板。
     ⚠️ 写入测试默认**不执行**（`?check=1` 只查不写），要连写入一起跑写 `?check=write` ——
     写入是**真实往云端加一行**，不能默认就跑。 */
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('check')) return
    checkHealth()
    const mode = new URLSearchParams(window.location.search).get('check')
    if (mode !== 'write') return
    // 等健康检查把 busy 态走完再写，避免两条请求抢同一份会话
    const t = setTimeout(runProbe, 2200)
    return () => clearTimeout(t)
  }, [checkHealth, runProbe])
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
          {/* 规则说明（Day 13）：结果页的存档提示已改成箴言，这条功能说明改在此处常驻。
              空态那句提示自带同一规则，所以只在有记录时显示，避免同一屏说两遍。 */}
          {records.length > 0 && <p className="rec-note">只收录每日第一次起卦</p>}
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

      {/* 进度码：换设备带走进度（导出 / 导入，不经服务器） */}
      <section className="rec-backup">
        <h2 className="rec-backup-title">换设备带走进度</h2>
        <p className="rec-backup-note">
          进度码里只有日期、卦序、变爻、收藏、镀金与成绩 —— <b>不含任何身份信息</b>，
          也不会经过我们的服务器。在另一台设备打开本页，粘贴这串码即可恢复。
        </p>

        <div className="rec-backup-row">
          <button
            type="button"
            className="rec-btn"
            onClick={() => {
              try {
                setCode(store.exportBackupCode())
                setMsg('进度码已生成，复制走即可')
              } catch (e) {
                setMsg('生成失败：' + ((e && e.message) || '未知错误'))
              }
            }}
          >
            生成进度码
          </button>
          {code && (
            <button
              type="button"
              className="rec-btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code)
                  setMsg('已复制到剪贴板')
                } catch {
                  setMsg('复制失败 —— 请手动选中下面的码复制')
                }
              }}
            >
              复制
            </button>
          )}
        </div>

        {code && (
          <textarea
            className="rec-backup-code"
            readOnly
            rows={3}
            value={code}
            aria-label="进度码"
            onFocus={(e) => e.target.select()}
          />
        )}

        <div className="rec-backup-row">
          <input
            className="rec-backup-input"
            type="text"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="粘贴进度码（YJ64-…）"
            aria-label="粘贴进度码"
          />
          <button
            type="button"
            className="rec-btn"
            onClick={() => {
              try {
                const r = store.importBackupCode(importText)
                setMsg(
                  `已合并：记录 +${r.records} · 收藏 +${r.favorites} · 镀金 +${r.gilded} · 成绩 +${r.rounds}`
                )
                setImportText('')
              } catch (e) {
                setMsg(((e && e.message) || '导入失败') + '')
              }
            }}
          >
            导入并合并
          </button>
        </div>

        {msg && (
          <p className="rec-backup-msg" role="status">
            {msg}
          </p>
        )}
      </section>

      {/* uid 断链提示：本地有记录、但当前 uid 云端一条也没有 → 看着像「记录被清零」。
          只在确迹象象时出现；**要不要重绑由用户决定**，绝不自动改他的数据。 */}
      {orphan.done && orphan.broken && !rebound && (
        <section className="rec-orphan" role="alert">
          <p className="rec-orphan-text">
            你在本机有 <b>{orphan.localCount}</b> 条起卦记录，但云端一条也没有 ——
            多半是换了浏览器、清了站点数据，或用无痕模式打开过。
            <b>本机记录没有丢</b>，只是没备份到云上。要现在重新备份吗？
          </p>
          <div className="rec-orphan-row">
            <button type="button" className="rec-btn" onClick={doRebind} disabled={busy}>
              {busy ? '处理中…' : '重新备份到云端'}
            </button>
            <button type="button" className="rec-btn rec-btn-ghost" onClick={() => setRebound('已跳过')}>
              暂不处理
            </button>
          </div>
        </section>
      )}
      {orphan.done && orphan.failed && !rebound && (
        <p className="rec-orphan-msg" role="status">
          云端这次没连上（不影响本机记录）。网络恢复后点上面的「重新读取」即可。
        </p>
      )}
      {rebound && (
        <p className="rec-orphan-msg" role="status">
          {rebound}
        </p>
      )}

      {/* 云端读取（Day 17）：本项目的记录与收藏由云函数读接口从数据库读出，
          身份判定在服务端与 RLS。这里把接口地址、读到的条数与读取时间显示出来 ——
          「数据是接口给的」这件事在页面上可见，而不是只写在代码里。 */}
      <section className="rec-cloud">
        <div className="rec-cloud-head">
          <h2 className="rec-cloud-title">云端读取</h2>
          <span className={'rec-cloud-badge' + (cloud.via === 'api' ? ' is-api' : '')}>
            {cloud.via === 'api' ? '来自读接口' : cloud.via === 'rdb' ? '已回退直连' : '读取中'}
          </span>
        </div>
        <p className="rec-cloud-note">
          接口 <code>GET /api/records</code> · <code>GET /api/favorites</code>
          {cloud.detail ? (
            <>
              <br />
              <span className="rec-cloud-url">{cloud.detail}</span>
            </>
          ) : null}
          <br />
          读到的数据 —— 起卦记录 <b>{cloud.records}</b> 条 · 收藏 <b>{cloud.favorites}</b> 条
          {cloud.at ? <> · {new Date(cloud.at).toLocaleTimeString('zh-CN')}</> : null}
        </p>
        <div className="rec-cloud-row">
          <button type="button" className="rec-btn" onClick={readCloud} disabled={busy}>
            {busy ? '读取中…' : '重新读取'}
          </button>
        </div>

        {/* ── 检查台（Day 20）──
            健康状态 / 核心表真实数据（上面那两个计数就是）/ 一次写入测试入口。
            三项都用**既有能力**：`/api/health` 与 POST /api/favorites。 */}
        <div className="rec-check">
          <div className="rec-check-row">
            <span className="rec-check-label">健康状态</span>
            <button type="button" className="rec-btn rec-btn-sm" onClick={checkHealth} disabled={health.state === 'busy'}>
              {health.state === 'busy' ? '检查中…' : '检查'}
            </button>
            {health.text ? (
              <span className={'rec-check-out is-' + health.state}>{health.text}</span>
            ) : (
              <span className="rec-check-idle">点「检查」看云函数是否活着</span>
            )}
          </div>
          <div className="rec-check-row">
            <span className="rec-check-label">写入测试</span>
            <input
              type="number"
              className="rec-check-input"
              min="1"
              max="64"
              value={probeId}
              onChange={(e) => setProbeId(e.target.value)}
              aria-label="要收藏的卦序号"
            />
            <button type="button" className="rec-btn rec-btn-sm" onClick={runProbe} disabled={probe.state === 'busy'}>
              {probe.state === 'busy' ? '写入中…' : '收藏这一卦'}
            </button>
          </div>
          {probe.text ? <p className={'rec-check-out is-' + probe.state}>{probe.text}</p> : null}
          <p className="rec-check-note">
            写入测试会真的往云端收藏表加一行（已存在的卦返回 200，不重复写）。
            这是<strong>真实数据</strong>，不是演示数据。
          </p>
        </div>
      </section>

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
