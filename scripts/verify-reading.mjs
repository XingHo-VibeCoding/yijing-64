import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

// ⚠️ 用 fileURLToPath 而不是 URL.pathname —— 后者会把中文目录当 %E6%96%87 编码（ENOENT）
const __here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__here, '..')
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/64卦.json'), 'utf8'))
const mod = await import(pathToFileURL(path.join(root, 'src/reading/thirdLayer.js')).href)
const items = data.items

const miss = []
const sit = new Map()
const res = new Map()
const full = new Set()

for (const it of items) {
  const r = mod.situationLine(it)
  if (!r || r.length < 6) miss.push(it.name)
  if (!sit.has(r)) sit.set(r, [])
  sit.get(r).push(it.name)
  const rr = mod.resonanceLine(it, it.fortune)
  if (!res.has(rr)) res.set(rr, [])
  res.get(rr).push(`${it.name}(${it.fortune})`)
  full.add(mod.buildThirdLayer(it, it.fortune).full)
}

console.log('卦数:', items.length)
console.log('处境句取不到值的卦:', miss.length ? miss : '无')
console.log('处境句去重后:', sit.size, '种 / 64卦')
console.log('共鸣句去重后:', res.size, '种')
console.log('全文去重后:', full.size, '篇（应接近 64）')

const dup = [...sit.entries()].filter(([, v]) => v.length > 1)
console.log('\n被多卦复用的处境句:', dup.length, '句')
for (const [k, v] of dup) console.log('  ', k.slice(0, 24) + '…', '→', v.join(' '))

console.log('\n=== 抽查 6 卦 ===')
for (const id of [1, 2, 3, 11, 44, 64]) {
  const it = items.find((x) => x.id === id)
  const o = mod.buildThirdLayer(it, it.fortune)
  console.log(`\n【${it.name}·${it.fortune}】${it.judgment}`)
  console.log('  处境：', o.situation)
  console.log('  共鸣：', o.resonance)
  console.log('  落点：', o.landing.replace(/\*\*/g, ''))
}

// 边界自检：**只扫我们写的三段**，不扫卦辞原文
// （原文里有「宜」「不宜」是《周易》原话，第二层已标 text，不受此约束）
// ⚠️ 「你会」要**带上下文**判：文里常有「你会发现」这种中性用法（不是预测）。
//    之前用朴素 `includes('你会')` 把「你**会发现**不是全都今天必须做」误报成违规 ——
//    检测器自己有假阳性，同样会让「全绿」变得没有意义。
//    现在只判「你会」后面直接跟表示断言的字（要、会、应该、必然…）。
const FORBIDDEN = ['宜', '不宜', '建议你', '命定', '天机', '必然', '注定', '一定能', '必定']
const FORBIDDEN_RE = [
  /你会(?!发现|明白|知道|觉得|想起|看到|注意到)/,  // 「你会」+断言
  /你会[要会应该]/,
]
const hit = []
let fallback = []
for (const it of items) {
  const o = mod.buildThirdLayer(it, it.fortune)
  const mine = o.situation + o.resonance + o.landing
  for (const w of FORBIDDEN) {
    if (mine.includes(w)) hit.push(`${it.name}: 「${w}」`)
  }
  // 正则类单独判（带上下文，避免误报）
  for (const re of FORBIDDEN_RE.slice(0, 2)) {
    const m = mine.match(re)
    if (m) hit.push(`${it.name}: 正则 ${re} 命中「${m[0]}」`)
  }
  if (mod.isFallback(it)) fallback.push(it.name)
}
console.log('\n=== 边界自检（只扫本项目文案，不含卦辞原文）===')
console.log(hit.length ? '✗ 命中禁用词: ' + hit.join(' / ') : '✓ 通过：无预测/建议/命定类词')
console.log('\n=== 兜底句检查 ===')
console.log(fallback.length ? '✗ 落到通用兜底的卦 ' + fallback.length + ' 个: ' + fallback.join(' ')
  : '✓ 通过：64 卦全部有专属处境句')
