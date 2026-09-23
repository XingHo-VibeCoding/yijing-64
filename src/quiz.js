/**
 * F3 记忆测验 · 出题逻辑
 *
 * 这个文件**刻意不 import 任何数据**（数据由调用方传进来）—— 这样能脱离浏览器，
 * 在 Node 里直接跑「干扰项规则」的验证脚本（.workbuddy/check-quiz.mjs），
 * 而不是只靠肉眼看界面。
 *
 * PRD F3「干扰项生成规则（重要）」原文：
 *   3 个选项**不能随机乱凑**，必须够像，否则是送分题。干扰项只能来自两处：
 *     ① 相邻卦序（该卦 ±1 至 ±3 卦之内）
 *     ② 同一上卦或同一下卦家族（与该卦共享一个三画卦的卦）
 *   ⚠️ 本期不做变卦与关联卦推演，**数据里不存在「关系卦」可用**，
 *      不要按互卦 / 错卦 / 综卦来取干扰项。
 */

export const QUESTIONS_PER_ROUND = 20

/** 候选干扰项：相邻卦序（±1…±3）∪ 同族（上卦相同 或 下卦相同） */
export function distractorPool(target, all) {
  const ids = new Set()

  for (let d = 1; d <= 3; d++) {
    for (const id of [target.id - d, target.id + d]) {
      if (all.some((h) => h.id === id)) ids.add(id)
    }
  }

  for (const h of all) {
    if (h.id === target.id) continue
    if (h.upperTrigram === target.upperTrigram || h.lowerTrigram === target.lowerTrigram) ids.add(h.id)
  }

  ids.delete(target.id)
  return [...ids]
}

/** 从候选池里抽 2 个干扰项（不重复、不含答案本身） */
export function makeDistractors(target, all, rng = Math.random) {
  const pool = distractorPool(target, all)
  const picked = []
  while (picked.length < 2 && pool.length) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0])
  }
  return picked
}

/**
 * 生成一轮题：默认 20 题，**同一轮内不重复**；64 卦全部可作为题面。
 * @returns {Array<{id:number, options:number[]}>} options 已打乱顺序（否则正确答案总落在最后）
 */
export function makeRound(all, size = QUESTIONS_PER_ROUND, rng = Math.random) {
  const ids = all.map((h) => h.id)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }

  return ids.slice(0, Math.min(size, ids.length)).map((id) => {
    const target = all.find((h) => h.id === id)
    const options = [...makeDistractors(target, all, rng), id]
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[options[i], options[j]] = [options[j], options[i]]
    }
    return { id, options }
  })
}
