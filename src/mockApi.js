/**
 * mock 数据接口 —— 主视图（总表）从这里拿数据
 *
 * 本周不接真实 API（课程安排，第 3 周才做）。真实数据就在本地 `data/64卦.json`，
 * 所以「成功」态的内容与原来**完全一致**；走这一层接口的目的是让
 * **加载 / 空 / 错误**三种状态真实出现、可演示、可验证 ——
 * 也是将来 F6 接云端时的预演（到时候只换这一层的实现，状态机不动）。
 *
 * 三个开关（写在地址栏 query 上，便于逐个截图核对）：
 *   ?mock=error   第一次请求**必定失败**，点「重试」后成功 —— 完整走一遍「错 → 重试 → 恢复」
 *   ?mock=empty   返回空列表（看空状态长什么样）
 *   ?mock=slow    延迟 2 秒返回（默认 600ms）—— 让加载态肉眼可见
 *
 * 与起卦动画的调试参数（?castSpeed / ?castFreeze）互不干扰。
 */
import data from '../data/64卦.json'

const BASE_DELAY = 600
const SLOW_DELAY = 3500 // 慢网络模拟。3.5s：加载态肉眼可见（截图工具会等页面稳定，见 .workbuddy/memory/2026-09-25.md）

/** 读地址栏上的 mock 开关；其它值一律当作 ok */
export function mockMode() {
  const v = new URLSearchParams(window.location.search).get('mock')
  return v === 'error' || v === 'empty' || v === 'slow' ? v : 'ok'
}

/** error 模式的时间窗：页面加载后前 5 秒内的请求**必失败**，之后成功。
 *  为什么按时间而不是按「第一次」：dev 下 React StrictMode 会把 effect 跑两遍，
 *  「只失败第一次」会被第二遍调用直接救回，错误态一闪就没 —— 时间窗对双跑免疫。 */
const ERROR_WINDOW_MS = 5000
const loadedAt = Date.now()

/**
 * @returns {Promise<{items: Array, meta: object}>}
 */
export function fetchHexagrams({ mode = 'ok' } = {}) {
  const delay = mode === 'slow' ? SLOW_DELAY : BASE_DELAY
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (mode === 'error') {
        if (Date.now() - loadedAt < ERROR_WINDOW_MS) {
          reject(new Error('mock 接口请求失败（?mock=error 演示，稍候点「重试」可恢复）'))
          return
        }
        resolve({ items: data.items, meta: data.meta })
        return
      }
      resolve({ items: mode === 'empty' ? [] : data.items, meta: data.meta })
    }, delay)
  })
}
