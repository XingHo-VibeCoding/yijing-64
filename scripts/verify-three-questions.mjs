/* 校验 threeQuestions.js：选项互斥 / 无英文混入 / 组装后不超 30 字 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const q = await import(pathToFileURL(path.join(root, 'src/reading/threeQuestions.js')).href)
const vd = await import(pathToFileURL(path.join(root, 'src/reading/verdict.js')).href)
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/64卦.json'), 'utf8'))

const han = (s) => [...s].filter((c) => /[\u4e00-\u9fa5]/.test(c)).length

console.log('=== 三问校验 ===\n')

// ① 结构
console.log('问题数:', q.QUESTIONS.length, q.QUESTIONS.length === 3 ? '✓' : '✗')
for (const Q of q.QUESTIONS) {
  const ids = Q.options.map((o) => o.id)
  const dupId = ids.length !== new Set(ids).size
  console.log(
    `  ${Q.title}｜问「${Q.ask}」｜${Q.options.length} 个选项` +
    `｜id ${dupId ? '✗ 有重复' : '✓ 无重复'}`
  )
}

// ② 玄妙度：题面与选项里不能用白话口水词，也不能英文
const BANNED_EASY = ['你要', '你觉得', '开心', '难受', '压力', '焦虑', '放松']
const bannedHit = []
const latinHit = []
for (const Q of q.QUESTIONS) {
  for (const w of BANNED_EASY) if (Q.ask.includes(w)) bannedHit.push(`${Q.title} 题面含白话「${w}」`)
  if (/[a-zA-Z]/.test(Q.ask) || /[a-zA-Z]/.test(Q.hint || '')) latinHit.push(`${Q.title} 题面含英文`)
  for (const o of Q.options) {
    for (const w of BANNED_EASY) if (o.desc.includes(w)) bannedHit.push(`${Q.title}/${o.id} 含白话「${w}」`)
    if (/[a-zA-Z]/.test(o.desc)) latinHit.push(`${Q.title}/${o.id} 含英文：${o.desc}`)
  }
}
console.log('白话口水词:', bannedHit.length ? '✗ ' + bannedHit.join(' / ') : '✓ 无')
console.log('英文混入:', latinHit.length ? '✗ ' + latinHit.join(' / ') : '✓ 无')

// ③ ⭐ 组装后是否仍 ≤30 字（**最关键**：追加三个字可能把字数顶破上限）
const allCombos = []
for (const a of q.QUESTIONS[0].options) {
  for (const b of q.QUESTIONS[1].options) {
    for (const c of q.QUESTIONS[2].options) {
      allCombos.push({ going: a.id, blocked: b.id, need: c.id })
    }
  }
}
console.log(`\n组合数: ${allCombos.length}（5×5×5 的上限应在此之下，实际按选项数）`)

let over = []
let maxLen = 0
let sample = ''
for (const it of data.items) {
  const base = vd.verdictLine(it)
  for (const ans of allCombos) {
    const full = q.appendAnswers(base, ans)
    const n = han(full)
    if (n > maxLen) { maxLen = n; sample = `卦${it.id} ${ans.going}/${ans.blocked}/${ans.need}: ${full}` }
    if (n > 30) over.push(`卦${it.id} ${ans.going}/${ans.blocked}/${ans.need} = ${n}字: ${full}`)
  }
}
console.log('追加后超 30 字的组合:', over.length ? '✗ ' + over.slice(0, 3).join(' / ') : `✓ 无（最长 ${maxLen} 字）`)
if (over.length) console.log('  最长示例:', sample)

// ④ 部分作答也不能顶破
let partialOver = []
for (const it of data.items) {
  const base = vd.verdictLine(it)
  const partials = [
    { going: 'hold' },
    { blocked: 'self' },
    { need: 'steady' },
    { going: 'hold', blocked: 'self' },
    { going: 'hold', blocked: 'self', need: 'deep' },
    {},
    null,
    undefined,
  ]
  for (const p of partials) {
    const n = han(q.appendAnswers(base, p))
    if (n > 30) partialOver.push(`卦${it.id} ${JSON.stringify(p)} = ${n}字`)
  }
}
console.log('部分作答超 30 字:', partialOver.length ? '✗ ' + partialOver.slice(0, 3).join(' / ') : '✓ 无')

// ⑤ 边界：禁词
const FORBIDDEN = ['宜', '不宜', '建议你', '命定', '天机', '必然', '注定', '一定能', '必定']
const hits = []
for (const it of data.items) {
  for (const ans of allCombos) {
    const full = q.appendAnswers(vd.verdictLine(it), ans)
    for (const w of FORBIDDEN) if (full.includes(w)) hits.push(`卦${it.id}: 「${w}」`)
    if (/你会(?!发现|明白|知道|觉得|想起|看到|注意到)/.test(full)) hits.push(`卦${it.id}: 「你会」+断言`)
  }
}
console.log('禁词命中:', hits.length ? '✗ ' + [...new Set(hits)].slice(0, 5).join(' / ') : '✓ 无')

// ⑥ 用户选的字确实出现在结果里（证明「精准」有真实落点，不是空话）
const t1 = q.appendAnswers(vd.verdictLine(data.items[0]), { going: 'hold', blocked: 'self', need: 'steady' })
const hasAll = ['守', '心', '定'].every((w) => t1.includes(w))
console.log('\n=== 落点验证 ===')
console.log('  乾 + 选「守/心/定」→', t1)
console.log('  三个字都进去了:', hasAll ? '✓' : '✗')

const ok = q.QUESTIONS.length === 3 && !bannedHit.length && !latinHit.length &&
  !over.length && !partialOver.length && !hits.length && hasAll
console.log('\n结论:', ok ? '✓ 全部通过' : '✗ 有未通过项')
process.exit(ok ? 0 : 1)