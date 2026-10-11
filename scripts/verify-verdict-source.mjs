/* 核验：短评前半段是否用了该卦象辞/卦辞里的原句（不许凭记忆写《周易》） */
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vd = await import(pathToFileURL(path.join(root, 'src/reading/verdict.js')).href)
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/64卦.json'), 'utf8'))

console.log('=== 引文核验：短评前半段 vs 象辞原文 ===\n')

/** 取中文词块：连续 2 字以上的汉字串 */
function chunks(s) {
  return (s.match(/[\u4e00-\u9fa5]{2,}/g) || [])
}

/** 去重（用 Set 会丢失顺序，这里手动去） */
function uniq(arr) {
  const seen = new Set()
  const out = []
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x) } }
  return out
}

const bad = []
const rows = []
for (const it of data.items) {
  const v = vd.verdictLine(it)
  // 依据 = 象辞 + 卦辞
  const basis = chunks(it.image).concat(chunks(it.judgment))
  // 短评前半（第一个分号之前）应能在依据里找到 3 字以上的公共片段
  const head = v.split('；')[0]
  const hit = uniq(basis).find((b) => b.length >= 3 && head.includes(b))
  if (!hit) bad.push(`${it.id} ${it.name}：短评前半「${head}」在象辞/卦辞里找不到 3 字以上原句`)
  rows.push({
    id: it.id, name: it.name,
    ok: !!hit, hit: hit || '（无对应原句）',
    image: it.image, v,
  })
}

console.log('前半段能在原文找到依据的卦:', rows.filter(r => r.ok).length, '/ 64')
console.log('无依据的:', bad.length ? '' : '无')
if (bad.length) bad.forEach(b => console.log('  ✗', b))

console.log('\n=== 逐卦明细（前半原句 → 后半评语）===')
for (const r of rows) {
  const mark = r.ok ? '·' : '✗'
  console.log(`${mark} ${String(r.id).padStart(2)} ${r.name.padEnd(3)} ${r.v}`)
}

const ok = bad.length === 0
console.log('\n结论:', ok ? '✓ 全部有原文依据' : `✗ ${bad.length} 条无依据`)
process.exit(ok ? 0 : 1)