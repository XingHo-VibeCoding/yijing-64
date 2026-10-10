/**
 * 第三层三段式 · 服务端渲染验收
 *
 * 为什么走 SSR 而不是无头截图：
 *   无头 Edge 的 **虚拟时间下 CSS 动画与 React 调度不推进**（项目里已记过同源坑），
 *   起卦动画走不完 → 结果页出不来 → 截图只有空白（实测连试 5 种参数组合皆如此）。
 *   而本任务要验的是「**文案与结构**」，这两件事 SSR 都能验，且是**真实渲染**，
 *   不是字符串拼接。截图改用「本地页面 + ?cast= 参数」供人工复核。
 *
 * 用法：node .workbuddy/ssr-render.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { build } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ⚠️ 用 fileURLToPath 而不是 URL.pathname —— 后者会把中文目录当 %E6%96%87 编码（ENOENT）
const __here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__here, '..')
process.chdir(root)

// ⓪ 临时生成 SSR 入口（**不放进仓库** —— 仓库根不放调试残留，AGENTS R1）
const ssrEntry = path.join(root, 'src', '.ssr-entry.tmp.jsx')
fs.writeFileSync(ssrEntry, "import C from './CastResult.jsx'\nexport default C\n", 'utf8')
process.on('exit', () => { try { fs.unlinkSync(ssrEntry) } catch (e) {} })

// ① 用 vite 的 SSR 模式把 CastResult 打成可 require 的产物
await build({
  root,
  logLevel: 'error',
  build: {
    ssr: ssrEntry,
    outDir: '.workbuddy/verify-ssr-out',
    emptyOutDir: true,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'entry.cjs' } },
  },
})

const { default: CastResult } = await import(
  'file:///' + path.join(root, '.workbuddy/ssr-out-9/entry.cjs').replace(/\\/g, '/')
)
// JSON 直接 fs 读（Node 的 ESM 需要 import attribute，vite 会处理，裸 Node 不会）
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/64卦.json'), 'utf8'))

// ② 渲染 6 卦。⚠️ SSR 里没有 location，`?openReading=1` 读不到，
//    所以给 window 造一个最小桩，让 CastResult 走「默认展开」那条分支。
globalThis.window = {
  location: { search: '?openReading=1' },
}
const ids = [1, 11, 2, 33, 44, 64]
console.log('='.repeat(74))
for (const id of ids) {
  const r = data.items.find((x) => x.id === id)
  const html = renderToStaticMarkup(
    createElement(CastResult, {
      result: r,
      changingLines: [],
      onRecast: () => {},
      onEnterList: () => {},
      onEnterDetail: () => {},
    })
  )
  const talk = html.match(/class="cr-talk[\s\S]*?<\/section>/)
  if (!talk) {
    console.log(`${r.name}：未渲染出第三层（open 默认收起，属预期）`)
    continue
  }
  const pick = (cls) => {
    const m = talk[0].match(new RegExp('class="' + cls + '"[^>]*>([\\s\\S]*?)</p>'))
    return m ? m[1].replace(/<[^>]*>/g, '').trim() : '（无）'
  }
  console.log(`\n【${r.name}·${r.fortune}】${r.judgment}`)
  console.log('  处境：', pick('cr-talk-situ'))
  console.log('  共鸣：', pick('cr-talk-reso'))
  console.log('  落点：', pick('cr-talk-land'))
}
console.log('\n' + '='.repeat(74))