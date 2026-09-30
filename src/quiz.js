/**
 * F3 记忆测验 · 出题逻辑
 *
 * 这个文件**刻意不 import 任何数据**（数据由调用方传进来）—— 这样能脱离浏览器，
 * 在 Node 里直接跑出题验证脚本，而不是只靠肉眼看界面。
 *
 * Day 11 起题型更换（用户拍板）：不再「看卦象选卦名」，改为
 *   **出示卦名 → 用户用阴阳爻自己拼出卦象**（每轮 8 题）。
 * 因此旧的「干扰项」规则（相邻卦序 / 同族卦）随旧题型一并移除。
 */

/** 容错率：8 题里最多错 3 道（答对 ≥5 即达成） */
export const PASS_MIN = 5

export const QUESTIONS_PER_ROUND = 8

/**
 * 生成一轮题：8 题，**同一轮内不重复**；64 卦全部可作为题面。
 * @returns {Array<{id:number}>}
 */
export function makeRound(all, size = QUESTIONS_PER_ROUND, rng = Math.random) {
  const ids = all.map((h) => h.id)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  return ids.slice(0, Math.min(size, ids.length)).map((id) => ({ id }))
}
