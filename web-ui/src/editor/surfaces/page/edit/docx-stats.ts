/**
 * Word 字数与大纲：纯函数。
 *
 * 字数口径与 Word 的"字数"一致：每个中日韩汉字 / 假名 / 谚文算 1 个，连续的字母数字（含词内的连字符、撇号、小数点）算 1 个词，
 * 标点和空白不算。所以"你好 world"是 3，不是 8，也不是 2。这是给用户看的数字，口径变了就和 Word 里对不上。
 * 大纲来自段落的大纲级别（标题样式 / 段落大纲级别），点击跳转。
 */

export interface StatsParagraph {
  paraId: string
  text: string
  /** 样式解析后的大纲级别 0..8；null / undefined = 正文 */
  outlineLevel?: number | null
}

// 汉字（含扩展 A）、日文假名、韩文音节：一个字符算一个"字"
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/u
// 拉丁 / 数字词：词内允许 - ' ’ . , 连接（"don't"、"3.14"、"state-of-the-art" 各算 1 个）
const WORD = /[\p{L}\p{N}]+(?:[-'’.,][\p{L}\p{N}]+)*/gu

export function countWords(text: string): number {
  let count = 0
  // 先数 CJK，再把它们抹掉后数拉丁 / 数字词，两边不互相算
  for (const char of text) if (CJK.test(char)) count += 1
  const latin = text.replace(new RegExp(CJK.source, 'gu'), ' ')
  count += (latin.match(WORD) ?? []).length
  return count
}

/** 字符数（不含空白）——状态栏悬停提示用 */
export function countChars(text: string): number {
  return [...text.replace(/\s/g, '')].length
}

export interface DocumentStats {
  words: number
  chars: number
  paragraphs: number
}

export function documentStats(paragraphs: readonly StatsParagraph[]): DocumentStats {
  let words = 0
  let chars = 0
  let count = 0
  for (const paragraph of paragraphs) {
    if (!paragraph.text.trim()) continue
    words += countWords(paragraph.text)
    chars += countChars(paragraph.text)
    count += 1
  }
  return { words, chars, paragraphs: count }
}

export interface OutlineItem {
  /** 1 起（Word 的"标题 1"= 1） */
  level: number
  text: string
  paraId: string
}

/** 大纲：有大纲级别的段落，文字为空的（只有一个回车的标题）不列 */
export function outlineOf(paragraphs: readonly StatsParagraph[]): OutlineItem[] {
  return paragraphs.flatMap((paragraph) => {
    const level = paragraph.outlineLevel
    const text = paragraph.text.replace(/\s+/g, ' ').trim()
    return typeof level === 'number' && level >= 0 && level <= 8 && text ? [{ level: level + 1, text, paraId: paragraph.paraId }] : []
  })
}

/** 状态栏的计数文案：字数 + 页数；字数口径见文件头 */
export function statsLabel(stats: DocumentStats | null, pages: number): string {
  if (!stats) return pages ? `${pages} 页` : ''
  return `${stats.words} 字${pages ? ` · ${pages} 页` : ''}`
}

/* ---------------- 读取缓存 ---------------- */

export interface BodyRead {
  version: string
  paragraphs: StatsParagraph[]
  truncated: boolean
}

/**
 * 按文档版本缓存"读全文"的结果。
 * 为什么要缓存：状态栏的字数和大纲在每次选区移动 / 工具栏刷新时都会被问到，全文读取要走 Worker，
 * 在几百页的文档上不能每次都读。文档版本没变（只是光标动了）就直接用上次的；版本变了才重读。
 * 同一时刻只有一个读取在飞，期间来的请求共用它的结果（不排队重读）。
 */
export function createBodyCache(read: () => Promise<BodyRead>, currentVersion: () => number) {
  let cached: { at: number; value: BodyRead } | null = null
  let inflight: { at: number; promise: Promise<BodyRead> } | null = null
  return {
    async get(): Promise<BodyRead> {
      const at = currentVersion()
      if (cached && cached.at === at) return cached.value
      if (inflight && inflight.at === at) return inflight.promise
      const promise = read().then(
        (value) => {
          // 读的过程中文档又变了：这次结果已经是旧的，仍然返回给等它的人（比报错好），但不写缓存
          if (currentVersion() === at) cached = { at, value }
          return value
        },
        (error) => {
          throw error
        },
      )
      inflight = { at, promise }
      void promise.finally(() => {
        if (inflight?.promise === promise) inflight = null
      }).catch(() => undefined)
      return promise
    },
    invalidate(): void {
      cached = null
    },
  }
}

/** 纯文本导出：每段一行，段与段之间一个换行；空段落保留为空行（保持原文档的段落节奏） */
export function plainTextOf(paragraphs: readonly StatsParagraph[]): string {
  return `${paragraphs.map((paragraph) => paragraph.text).join('\n')}\n`
}
