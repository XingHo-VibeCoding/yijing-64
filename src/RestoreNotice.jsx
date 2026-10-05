/**
 * 启动轻提示（Day 19）——「检测到您可能有之前的进度，是否恢复？」
 *
 * ## 为什么不放在记录页
 * 断链判据是「本机有数据 + 云端读到 0 条」。用户对「我的记录怎么空了」的感知
 * 发生在**打开应用的那一刻**，不是在他自己摸到记录页的时候。放在记录页等于
 * 让用户先经历一次「少了东西」的困惑，再去找原因 —— 那是把排查成本转嫁给用户。
 *
 * ## 三条克制（这个提示很容易做成打扰，所以刻意收着）
 *   ① **只问一次**：点「暂不处理」后本机记住这个 uid，不再反复出现。
 *   ② **不挡首屏**：固定在顶部横幅，**不遮住**总表与起卦按钮 —— 产品的 P0 主入口
 *      是一键起卦，任何东西都不该拦在它前面。
 *   ③ **不做倒计时、不自动消失**：这是需要用户明确表态的事，不该被时间悄悄拿走。
 *
 * ## 措辞口径
 * 按 PRD 情绪价值线走：**只说事实 + 给选择**，不用「丢失」「异常」「清零」这类
 * 制造焦虑的词；也不承诺「一定找回」。事实上数据一直都在本机。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as store from './storage.js'

export default function RestoreNotice() {
  const [id, setId] = useState(() => store.identityStatus())
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const timer = useRef(null)

  const sync = useCallback(() => setId(store.identityStatus()), [])

  /**
   * 身份判定是**异步**的（要先拿云端会话再拉数据），首帧一定读不到。
   * 所以不能只读一次 —— 两条合起来保证「判定刚完成」那一刻界面一定更新：
   *   ① 订阅 `yijing:identity-resolved`（storage.js 每次判定完都派发）
   *   ② 多级兜底轮询（网络慢 / 云端拉取失败要走失败分支）
   * ⚠️ 之前记录页的两个面板都栽在「一次性读取 → 永远停在读取中」，别再犯。
   */
  useEffect(() => {
    window.addEventListener('yijing:identity-resolved', sync)
    sync()
    const t1 = setTimeout(sync, 1200)
    const t2 = setTimeout(sync, 3500)
    const t3 = setTimeout(sync, 8000)
    return () => {
      window.removeEventListener('yijing:identity-resolved', sync)
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3)
    }
  }, [sync])

  /* 恢复运行中：成功报真实条数，失败说清「本机数据还在」——不报假成功 */
  const onRestore = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setDone('')
    try {
      const r = await store.restoreToCloud()
      const bad = r.failedRecords + r.failedFavorites
      setDone(
        (bad > 0 ? `部分恢复（${bad} 条没写上云）` : '已恢复到云端')
        + `：记录 ${r.records} 条 · 收藏 ${r.favorites} 条`
      )
    } catch (e) {
      setDone('恢复没成功：' + ((e && e.message) || '未知错误') + '。本机数据仍在，可稍后再试。')
    } finally {
      setBusy(false)
      sync()
    }
  }, [busy, sync])

  const onSkip = useCallback(() => {
    store.declineRestore()
    setDone('好，先不恢复。你的记录仍在本机，随时可在记录页恢复。')
    sync()
  }, [sync])

  /* 恢复结果出来后自动收起，4 秒后自清（与收藏失败提示条同节奏） */
  useEffect(() => {
    if (!done) return undefined
    timer.current = setTimeout(() => setDone(''), 6000)
    return () => clearTimeout(timer.current)
  }, [done])

  if (id.status !== 'recoverable' && !done) return null

  return (
    <aside className="restore-notice" role="status" aria-live="polite">
      <p className="restore-text">
        {done ? (
          done
        ) : (
          <>
            检测到您可能有之前的进度
            <span className="restore-count">（本机 {id.localTotal} 条，尚未备份）</span>
            ，是否恢复？
          </>
        )}
      </p>
      {!done && (
        <div className="restore-row">
          <button
            type="button"
            className="restore-btn is-primary"
            onClick={onRestore}
            disabled={busy}
          >
            {busy ? '恢复中…' : '恢复'}
          </button>
          <button type="button" className="restore-btn" onClick={onSkip} disabled={busy}>
            暂不处理
          </button>
        </div>
      )}
    </aside>
  )
}
