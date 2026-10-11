/* 校验 verdict.js：64 卦全覆盖 / ≤30 字 / 无英文混入 / 收尾完整 / 无禁词 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(root, 'src/reading/verdict.js')).href)
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/64卦.json'), 'utf8'))
const V = mod.VERDICT

console.log('=== verdict.js 校验 ===\n')

// ① 条目与覆盖
const keys = Object.keys(V).map(Number).sort((a, b) => a - b)
console.log('条目数:', keys.length, keys.length === 64 ? '✓' : '✗ 应为 64')
const missing = []
for (let i = 1; i <= 64; i++) if (!V[i]) missing.push(i)
console.log('缺卦序:', missing.length ? '✗ ' + missing.join(',') : '✓ 无')

// ② 重复句（同一句被多卦用 = 通用兜底）
const seen = new Map()
const dup = []
for (const k of keys) {
  if (seen.has(V[k])) dup.push(`${seen.get(V[k])} 与 ${k} 同句`)
  else seen.set(V[k], k)
}
console.log('重复句:', dup.length ? '✗ ' + dup.join(' / ') : '✓ 无')

// ③ 字数（只数汉字，标点不计 —— 这是「不超过 30 字」的判法）
const han = (s) => [...s].filter((c) => /[\u4e00-\u9fa5]/.test(c)).length
const over = keys.filter((k) => han(V[k]) > 30)
console.log('超过 30 字:', over.length ? '✗ ' + over.map((k) => `${k}(${han(V[k])})`).join(' ') : '✓ 无')
const lens = keys.map((k) => han(V[k]))
console.log('  字数分布: 最短', Math.min(...lens), '最长', Math.max(...lens), '中位', lens.sort((a, b) => a - b)[32])

// ③b ⭐ 卦名对得上（**最关键的一条**）
// 背景：曾按「乾屯蒙需讼师比」的另一种排法写数据，结果 20 余条卦名对不上，
// 而字数、禁词、重复句**全部通过** —— 只有拿真实数据逐条比才能发现。
// 判据：短评里出现的卦名（若含）必须与该 id 对应的卦名一致；
//另打印每卦的取象，便于人工核对短评是否扣住了该卦的自然象。
console.log('\n=== 逐卦核对（id / 卦名 / 取象 / 短评）===')
const nameWrong = []
for (const it of data.items) {
  const t = mod.verdictLine(it)
  // 短评里若写了卦名，必须与数据一致。
  // ⚠️ 判据必须精确：**单字卦名会命中普通词**（「比」在「相比」、「丰」在「丰盛」、
  //    「益」在「利益」、「离」在「离岸」…）。朴素 includes 会报 13 处假阳性，
  //    而「检测器有假阳性 = 全绿没意义」，所以改成**最短子串匹配**：
  //    只在短评里找「卦名 + 一个非汉字」或「非汉字 + 卦名」的完整词。
  for (const nm of data.items.map((x) => x.name)) {
    if (nm === it.name) continue
    const re = new RegExp(`(^|[^\\u4e00-\\u9fa5])${nm}([^\\u4e00-\\u9fa5]|$)`)
    if (re.test(t)) {
      nameWrong.push(`第 ${it.id} 卦（${it.name}）的短评里出现了别的卦名「${nm}」`)
    }
  }
  console.log(
    `${String(it.id).padStart(2)} ${it.name.padEnd(3)} ${it.fortune} ` +
    `${it.upperNature}上${it.lowerNature}下  ${t}`
  )
}
console.log('\n卦名错位:', nameWrong.length ? '✗ ' + nameWrong.join(' / ') : '✓ 无')

// ④ 异常字符：英文 / 半角标点 / 收尾不完整
const latin = keys.filter((k) => /[a-zA-Z]/.test(V[k]))
console.log('混入英文:', latin.length ? '✗ ' + latin.map((k) => `${k}: ${V[k]}`).join(' / ') : '✓ 无')
const badEnd = keys.filter((k) => !/[。；]$/.test(V[k]))
console.log('收尾异常:', badEnd.length ? '✗ ' + badEnd.map((k) => `${k}: ${V[k]}`).join(' / ') : '✓ 无')

// ⑤ 边界自检（禁词，与 thirdLayer 用同一套口径）
const FORBIDDEN = ['不宜', '建议你', '命定', '天机', '必然', '注定', '一定能', '必定']
const hits = []
for (const k of keys) {
  for (const w of FORBIDDEN) if (V[k].includes(w)) hits.push(`${k}: 「${w}」`)
  if (V[k].includes('宜')) hits.push(`${k}: 「宜」`)
  if (/你会(?!发现|明白|知道|觉得|想起|看到|注意到)/.test(V[k])) hits.push(`${k}: 「你会」+断言`)
}
console.log('禁词命中:', hits.length ? '✗ ' + hits.join(' / ') : '✓ 无')

// ⑥ 抽查
console.log('\n=== 抽查 6 卦 ===')
for (const id of [1, 12, 39, 47, 63, 64]) {
  const it = data.items.find((x) => x.id === id)
  const t = mod.verdictLine(it)
  console.log(`【${it.name}·${it.fortune}】${it.judgment}`)
  console.log(`  短评（${han(t)}字）：${t}`)
}

const ok = keys.length === 64 && !missing.length && !dup.length && !over.length &&
  !latin.length && !badEnd.length && !hits.length && !nameWrong.length
console.log('\n结论:', ok ? '✓ 全部通过' : '✗ 有未通过项')
process.exit(ok ? 0 : 1)