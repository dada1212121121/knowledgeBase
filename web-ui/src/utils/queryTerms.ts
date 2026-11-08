// 检索词高亮用的纯函数:从查询里取出"该高亮的词"、把文字按词切开、围着第一个命中截摘要。
//
// 为什么在前端做:高亮只是展示,不需要和后端全文检索的分词一模一样;浏览器自带的 `Intl.Segmenter`
// 能把中文按词切开(Chrome / Safari / Firefox 都有),不用为了这个给后端加依赖、也不用多一次请求。
// 中文词典里不认识的词会被切成单字("超时" → "超" "时"),所以连续的单字要合成两字词再去匹配。

/** 一个查询最多高亮多少个词:再多只会把整页刷成一片。 */
export const MAX_TERMS = 12

/** 过滤前缀(`kind:code` `path:src/` …):它们是检索条件,不是要在正文里找的词。 */
const FILTER_PREFIX = /^[a-z_]+:/i

const CJK = /[㐀-鿿豈-﫿]/
const HAS_CJK = (value: string) => CJK.test(value)

/** 太常见、高亮出来只是噪声的词(问句里的虚词)。 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '吗', '呢', '吧', '啊', '呀', '也', '都', '就', '还', '把', '被', '对', '从', '到',
  '怎么', '怎样', '怎么样', '如何', '什么', '为什么', '为何', '哪个', '哪些', '哪里', '是否', '可以', '能否', '请问', '一个', '这个',
  '那个', '我们', '你们', '他们', '有没有', '能不能', '要不要', '应该', '需要', '关于', '一下',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'are', 'and', 'or', 'for', 'with', 'how', 'what', 'why',
])

interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>
}

function segmenter(): WordSegmenter | null {
  const Segmenter = (Intl as { Segmenter?: new (locale: string, options: { granularity: 'word' }) => WordSegmenter }).Segmenter
  if (!Segmenter) return null
  try {
    return new Segmenter('zh', { granularity: 'word' })
  } catch {
    return null
  }
}

/** 一段连续的汉字 / 其它文字,切成要高亮的词。 */
function wordsOf(chunk: string): string[] {
  const seg = segmenter()
  const pieces = seg
    ? [...seg.segment(chunk)].filter((entry) => entry.isWordLike !== false).map((entry) => entry.segment)
    : // 没有分词器:整段汉字当作一串单字,后面统一合成两字词
      [...chunk].filter((char) => char.trim())
  const out: string[] = []
  let run: string[] = []
  const flushRun = () => {
    if (run.length >= 2) {
      // 连续单字:两两相邻合成词("排查慢" → "排查" "查慢"),宁可多一个噪声词也不漏
      for (let at = 0; at + 1 < run.length; at += 1) out.push(run[at]! + run[at + 1]!)
    } else if (run.length === 1 && out.length === 0 && pieces.length === 1) {
      // 整个词只有一个汉字("猫"):单字查询,只能按单字高亮
      out.push(run[0]!)
    }
    run = []
  }
  for (const piece of pieces) {
    if (piece.length === 1 && HAS_CJK(piece)) {
      run.push(piece)
      continue
    }
    flushRun()
    out.push(piece)
  }
  flushRun()
  return out
}

/** 查询 → 要高亮的词:去掉过滤前缀和虚词,引号里的短语整句保留,按长度从长到短(长词先匹配)。 */
export function queryTerms(query: string): string[] {
  const found: string[] = []
  const quoted = /"([^"]+)"|“([^”]+)”/g
  const rest = query.replace(quoted, (_, a: string | undefined, b: string | undefined) => {
    const phrase = (a ?? b ?? '').trim()
    if (phrase.length >= 2) found.push(phrase)
    return ' '
  })
  for (const word of rest.split(/\s+/)) {
    if (!word || FILTER_PREFIX.test(word)) continue
    // 标点切开("rerank,超时" 不是一个词);保留字母数字、汉字和连字符 / 下划线 / 点(标识符、文件名)
    for (const part of word.split(/[^\p{L}\p{N}_.\-]+/u)) {
      if (!part) continue
      if (!HAS_CJK(part)) {
        if (part.length >= 2) found.push(part)
        continue
      }
      // 汉字和字母数字混在一起("rerank超时"):按文字类型切成几段再处理
      for (const chunk of part.match(/[㐀-鿿豈-﫿]+|[^㐀-鿿豈-﫿]+/g) ?? []) {
        if (HAS_CJK(chunk)) found.push(...wordsOf(chunk))
        else if (chunk.length >= 2) found.push(chunk)
      }
    }
  }
  const seen = new Set<string>()
  const terms: string[] = []
  for (const term of found) {
    const key = term.toLowerCase()
    if (STOPWORDS.has(key) || seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }
  return terms.sort((left, right) => right.length - left.length).slice(0, MAX_TERMS)
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matcher(terms: string[]): RegExp | null {
  return terms.length ? new RegExp(`(${[...terms].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})`, 'gi') : null
}

export interface Piece {
  text: string
  hit: boolean
}

/** 把文字按词切成"命中 / 没命中"的片段,给 `<mark>` 用。 */
export function splitByTerms(text: string, terms: string[]): Piece[] {
  const pattern = matcher(terms)
  if (!pattern || !text) return text ? [{ text, hit: false }] : []
  // split 带捕获组时,奇数位就是命中的词
  return text
    .split(pattern)
    .map((piece, index) => ({ text: piece, hit: index % 2 === 1 }))
    .filter((piece) => piece.text)
}

/**
 * 摘要窗口:围着第一个命中截 `max` 个字,而不是永远从开头截——命中在 240 字之后时,
 * 从开头截出来的摘要里根本没有那个词,高亮就成了摆设。
 */
export function snippetWindow(text: string, terms: string[], max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const pattern = matcher(terms)
  const first = pattern ? flat.search(new RegExp(pattern.source, 'i')) : -1
  if (first < 0) return `${flat.slice(0, max)}…`
  const start = Math.max(0, Math.min(first - Math.floor(max / 4), flat.length - max))
  const end = Math.min(flat.length, start + max)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/**
 * 这条结果里到底有没有出现查询词。纯语义命中(向量相似但字面上一个词都不沾)没有任何地方可高亮,
 * 界面据此标注"语义相关",免得用户以为高亮坏了。没有可高亮的词(只写了过滤前缀)时不下结论,按"有"处理。
 */
export function hasLiteralHit(texts: Array<string | null | undefined>, terms: string[]): boolean {
  if (!terms.length) return true
  const pattern = matcher(terms)
  if (!pattern) return true
  const probe = new RegExp(pattern.source, 'i')
  return texts.some((text) => !!text && probe.test(text))
}
