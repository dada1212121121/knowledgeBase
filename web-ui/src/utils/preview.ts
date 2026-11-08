// 预览相关的纯函数(浏览器页与组件共用,单测不需要挂组件)。
//
// 从 `Browser.vue` / `DocViewer.vue` 里抽出来的原因:这些判断(块位置标签、能不能导出字幕、
// 信息栏的计数行)是「有没有 bug 一眼看不出来」的那类逻辑,放在页面里只能靠像素比对,
// 抽出来才能用单测守住。
import { MEDIA_FORMATS, anchorText } from './files'
import { isPlaceholderAnchor, toSrt } from './srt'

export interface LabelChunk {
  ordinal: number
  anchor: {
    kind: string
    page?: number
    sheet?: string
    cell?: string
    slide?: number
    start_ms?: number
    end_ms?: number
    start?: number
    end?: number
  } | null
  text: string
}

export interface LabelBlock {
  anchor: LabelChunk['anchor']
  text: string
}

const squash = (text: string) => text.replace(/\s+/g, '')

/** 按页分组的抽取块(位置标签查表用;块多时不要在模板里逐块全量扫描)。 */
export function blocksByPage<T extends LabelBlock>(blocks: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>()
  for (const block of blocks) {
    if (block.anchor?.kind !== 'page') continue
    const page = block.anchor.page ?? 1
    const list = map.get(page) ?? []
    list.push(block)
    map.set(page, list)
  }
  return map
}

/**
 * 块的位置标签:PDF 用设计稿的 `#p7 ¶3`(该页只有一个块时不写 `¶`),
 * 其余格式沿用 `anchorText`(表格 / 幻灯片 / 时间轴);没有锚点就用序号。
 */
export function chunkPositionLabel(
  chunk: LabelChunk,
  blocks: LabelBlock[],
  index?: Map<number, LabelBlock[]>,
): string {
  const anchor = chunk.anchor
  if (!anchor) return `#${chunk.ordinal}`
  if (anchor.kind !== 'page') return anchorText(anchor)
  const page = anchor.page ?? 1
  const siblings = (index ?? blocksByPage(blocks)).get(page) ?? []
  if (siblings.length < 2) return `#p${page}`
  const needle = squash(chunk.text).slice(0, 24)
  const at = needle ? siblings.findIndex((block) => squash(block.text).includes(needle)) : -1
  return `#p${page}${at >= 0 ? ` ¶${at + 1}` : ''}`
}

/** 能不能导出字幕:只有音视频、且块里有**可信的逐段时间戳**时才有内容。 */
export function srtForFile(format: string, blocks: { text: string; anchor: LabelChunk['anchor'] }[]): string {
  if (!MEDIA_FORMATS.has(format.toLowerCase())) return ''
  return toSrt(blocks)
}

/** 预览区要先显示的提示:读不到原件时把原因显示出来。没有抽取结果的情况由页面自己的空态兜底。 */
export function previewNotice(preview: { read_error?: string | null } | null): string {
  if (!preview) return ''
  if (preview.read_error) return preview.read_error
  return ''
}

/** 信息栏的「页数 / 行数 / 转写」那一行:取不到就返回空标签(前端不显示这一行)。 */
export function fileCountLabel(
  format: string,
  blocks: LabelBlock[],
  chunkCount: number,
): { label: string; value: string } {
  const withAnchor = blocks.filter((block) => block.anchor)
  const kind = withAnchor[0]?.anchor?.kind
  const pageKeys = new Set(
    withAnchor
      .map((block) => block.anchor?.page ?? block.anchor?.slide ?? block.anchor?.sheet ?? null)
      .filter((key) => key !== null),
  )
  const suffix = `${chunkCount} 个内容片段`
  if (kind === 'time') {
    // 时间锚点没有页 / 表,不能走 pageKeys 的分支(旧实现的 `time` 分支是死代码）。
    // 占位锚点(0–60 秒整篇、0–0 提示)与空文本不算「转写了一段」
    // 「说过的内容」= 有文本、且锚点不是 0–0 那种退化提示块。
    // 缺 `end_ms` 的不算退化(与 `srt.ts` 的 `isPlaceholderAnchor` 同口径）
    const spoken = blocks.filter((block) => {
      if (block.anchor?.kind !== 'time' || block.text.trim().length === 0) return false
      const end = block.anchor.end_ms
      if (end === undefined || end === null) return true
      return end > (block.anchor.start_ms ?? 0)
    })
    const segments = spoken.filter((block) => !isPlaceholderAnchor(block.anchor, spoken.length === 1)).length
    if (segments === 0 && spoken.length > 0) {
      // 转写成功但只有一个整篇块(真实抽取器的形状):没有分段,不能说成「0 段」
      return { label: '转写', value: `整篇 · ${suffix}` }
    }
    return { label: '转写', value: `${segments} 段 · ${suffix}` }
  }
  if (!pageKeys.size) return { label: '', value: suffix }
  if (kind === 'cell') return { label: '表', value: `${pageKeys.size} 张表 · ${suffix}` }
  const numeric = [...pageKeys].filter((key): key is number => typeof key === 'number')
  const count = numeric.length ? Math.max(...numeric) : pageKeys.size
  return { label: '页数', value: `${count} 页 · ${suffix}` }
}
