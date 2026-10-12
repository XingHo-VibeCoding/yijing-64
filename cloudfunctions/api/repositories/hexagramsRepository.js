/**
 * 数据访问层：卦象主数据（**静态文件，不查数据库**）
 *
 * 为什么这里没有 SQL：六十四卦是随前端包发布的静态数据，契约 §1 明确它**不入库**，
 * 库里也没有对应表。所以本repository 读的是打进云函数包的一份 JSON
 * （`cloudfunctions/api/data/hexagrams.json`）。
 *
 * ⚠️ **两份数据的漂移风险**：仓库根 `data/64卦.json` + `data/64卦-爻辞.json` 是正本，
 *   云函数目录里这一份是**从正本合成**的副本。合成由
 *   `scripts/build-cloud-hexagrams.mjs` 完成，并有
 *   `scripts/verify-cloud-hexagrams.mjs` 逐字段比对 —— 改卦辞时必须跑后者。
 *
 * 分层约定：与 recordsRepository 一致，异常抛出、状态码留给接口层。
 * 唯一额外的一条：**这里自己抛出 kind='not_found'**，因为静态数据的「查不到」
 * 不是上游故障，而是正常业务结果（契约 1.2 要 404）。
 */

const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'data', 'hexagrams.json')

/** 进程内缓存：冷启动读一次，之后常驻（云函数实例会复用） */
let CACHE = null

function load() {
  if (CACHE) return CACHE
  try {
    const raw = fs.readFileSync(FILE, 'utf8')
    const list = JSON.parse(raw)
    if (!Array.isArray(list) || list.length !== 64) {
      const err = new Error('卦象库形状异常（应为 64 条）')
      err.kind = 'bad_shape'
      throw err
    }
    CACHE = list
    return CACHE
  } catch (e) {
    if (e.kind) throw e
    const err = new Error('卦象库读取失败：' + e.message)
    err.kind = 'bad_shape'
    throw err
  }
}

/**
 * 搜索用的归一化：**去掉声调符号并转小写**。
 * ⚠️ 数据里的拼音是带声调的（`qián`），而用户十有八九敲的是 `qian` ——
 *    不归一化的话，契约承诺的「按拼音模糊」实际上只对会打声调符号的人生效。
 *    （这条是跑契约回归时被自己的用例抓出来的：搜 `qian` 返回 0 条。）
 */
const TONE_MAP = { 'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a', 'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e', 'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i', 'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o', 'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u', 'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v' }

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .split('')
    .map((c) => TONE_MAP[c] || c)
    .join('')
    .trim()
}

/** 列表接口**不下发 lines**（契约 1.1 脚注：避免首屏体积翻 6 倍） */
function toListItem(h) {
  return {
    id: h.id,
    name: h.name,
    symbol: h.symbol,
    pinyin: h.pinyin,
    volume: h.volume,
    upper: h.upper,
    lower: h.lower,
    fortune: h.fortune,
  }
}

/**
 * 契约 1.1 `GET /api/hexagrams`
 * @param {object} [opts]
 * @param {string} [opts.volume] 上经 / 下经
 * @param {string} [opts.q]      按卦名或拼音模糊（大小写不敏感）
 * @returns {Array} 列表项（已裁掉 lines）
 */
function listHexagrams({ volume = '', q = '' } = {}) {
  let items = load()
  if (volume) items = items.filter((h) => h.volume === volume)
  const kw = normalize(String(q || ''))
  if (kw) {
    items = items.filter(
      (h) =>
        h.name.includes(kw) ||
        normalize(String(h.pinyin || '')).includes(kw) ||
        h.symbol.includes(kw)
    )
  }
  return items.map(toListItem)
}

/**
 * 契约 1.2 `GET /api/hexagrams/:id`
 * @param {number} id 1–64（范围校验在接口层）
 * @returns {object} 含 judgment / image / fortuneBasis / lines 的完整条目
 * @throws {kind:'not_found'} id 合法但库中无此卦（正常业务结果 → 404）
 */
function getHexagram(id) {
  const hit = load().find((h) => h.id === id)
  if (!hit) {
    const err = new Error('卦不存在：' + id)
    err.kind = 'not_found'
    throw err
  }
  return {
    id: hit.id,
    name: hit.name,
    symbol: hit.symbol,
    pinyin: hit.pinyin,
    volume: hit.volume,
    upper: hit.upper,
    lower: hit.lower,
    judgment: hit.judgment,
    image: hit.image,
    fortune: hit.fortune,
    fortuneBasis: hit.fortuneBasis,
    lines: hit.lines || [],
  }
}

module.exports = { listHexagrams, getHexagram }