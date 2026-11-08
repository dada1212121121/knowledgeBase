// 文件展示小工具:大小文案、扩展名徽标(拖放区的格式标签与「添加数据」文件列表共用同一套颜色)。

/** 4.2 MB / 860 KB / 48 MB:KB 取整,MB 以上保留一位小数(整数不带 .0) */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const unit = bytes < 1024 ** 3 ? { size: 1024 ** 2, name: 'MB' } : { size: 1024 ** 3, name: 'GB' }
  const value = Math.round((bytes / unit.size) * 10) / 10
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit.name}`
}

export type ChipTone = 'danger' | 'c1' | 'success' | 'warning' | 'c2' | 'c3' | 'c4' | 'm' | 't2'

const GROUPS: [RegExp, string, ChipTone][] = [
  [/^pdf$/, 'PDF', 'danger'],
  [/^(doc|docx|odt|rtf)$/, 'DOC', 'c1'],
  [/^(xls|xlsx|ods|csv|tsv)$/, 'XLS', 'success'],
  [/^(ppt|pptx|odp|key)$/, 'PPT', 'warning'],
  [/^(html|htm|mhtml)$/, 'WEB', 'c2'],
  [/^epub$/, 'EPUB', 'c1'],
  [/^(eml|msg|mbox)$/, 'EML', 'c2'],
  [/^(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/, 'IMG', 'c3'],
  [/^(mp3|m4a|wav|flac|ogg|aac|opus)$/, 'AUD', 'c4'],
  [/^(mp4|mov|mkv|avi|webm|m4v)$/, 'VID', 'c4'],
  [/^(zip|tar|gz|tgz|7z|rar)$/, 'ZIP', 'm'],
  [/^(md|markdown|txt|text|log|rst|adoc)$/, 'MD', 't2'],
]

/** 按文件名给出 3–4 个字母的类型徽标;认不出的用扩展名本身(无扩展名显示「文件」) */
export function fileChip(name: string): { label: string; tone: ChipTone } {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  for (const [pattern, label, tone] of GROUPS) if (pattern.test(ext)) return { label, tone }
  return { label: ext ? ext.slice(0, 4).toUpperCase() : '文件', tone: 'm' }
}

/** 拖放区下方的格式标签(设计稿顺序);颜色只做区分 */
export const FORMAT_CHIPS: { label: string; tone: ChipTone }[] = [
  { label: 'PDF', tone: 'danger' },
  { label: 'DOC', tone: 'c1' },
  { label: 'XLS', tone: 'success' },
  { label: 'PPT', tone: 'warning' },
  { label: 'WEB', tone: 'c2' },
  { label: 'EPUB', tone: 'c1' },
  { label: 'EML', tone: 'c2' },
  { label: 'IMG', tone: 'c3' },
  { label: 'AUD', tone: 'c4' },
  { label: 'VID', tone: 'c4' },
  { label: 'ZIP', tone: 'm' },
  { label: 'MD', tone: 't2' },
]

const GROUP_NAMES: Record<string, string> = {
  PDF: 'PDF',
  DOC: 'Word',
  XLS: 'Excel',
  PPT: 'PPT',
  WEB: '网页',
  EPUB: '电子书',
  EML: '邮件',
  IMG: '图片',
  AUD: '音频',
  VID: '视频',
  ZIP: '压缩包',
  MD: '文本 / MD',
}
/** 目录预览里「按类型」的固定排序(与格式标签同序),不在其中的扩展名排在后面 */
export const GROUP_ORDER = GROUPS.map(([, label]) => label)

/** 文件所属类型分组:徽标缩写 + 中文名 + 颜色 */
export function fileGroup(name: string): { key: string; name: string; tone: ChipTone } {
  const { label, tone } = fileChip(name)
  return { key: label, name: GROUP_NAMES[label] ?? label, tone }
}

/** 块在原文里的位置:p.7 / 评测汇总! / slide 3 / 31:40–32:40 / L12-30(与后端 Anchor 的 JSON 一致) */
export function anchorText(anchor: {
  kind: string
  start?: number
  end?: number
  page?: number
  sheet?: string
  cell?: string
  slide?: number
  start_ms?: number
  end_ms?: number
} | null | undefined): string {
  if (!anchor) return ''
  const clock = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
  switch (anchor.kind) {
    case 'page':
      return `p.${anchor.page ?? 1}`
    case 'cell':
      return `${anchor.sheet ?? ''}!${anchor.cell ?? ''}`
    case 'slide':
      return `slide ${anchor.slide ?? 1}`
    case 'time':
      return `${clock(anchor.start_ms ?? 0)}–${clock(anchor.end_ms ?? 0)}`
    case 'line':
      return `L${anchor.start ?? 1}${anchor.end && anchor.end !== anchor.start ? `-${anchor.end}` : ''}`
    default:
      return ''
  }
}

/* ---------------- 预览用的格式分组(组件与页面共用一份,避免三处各写一套后漂移) ---------------- */

/** 浏览器能直接内联播放 / 显示的格式(`GET /api/v1/raw` 的 `inline` 白名单与它对齐) */
export const INLINE_FORMATS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif',
  // 浏览器能不能解取决于平台(Safari 能放 heic / tiff):先试,放不了就退回识别文本
  'tif', 'tiff', 'heic', 'heif',
  // 音视频元素不受 Content-Disposition: attachment 影响,所以后端 `inline` 白名单外的格式也能直接播
  'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'opus',
  'mp4', 'webm', 'mov', 'm4v', 'mkv',
])

/** 音视频(含浏览器放不了、只能下载的):决定预览走「播放条 + 转写」还是别的 */
export const MEDIA_FORMATS = new Set([
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus',
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi',
])

/** 表格类 */
export const SHEET_FORMATS = new Set(['xlsx', 'xls', 'xlsb', 'xlsm', 'xltx', 'xltm', 'csv', 'tsv', 'ods', 'fods', 'numbers'])
/** 幻灯片类 */
export const SLIDE_FORMATS = new Set(['pptx', 'ppt', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'odp'])
/** 图片类(含浏览器放不了的 tif / heic,预览只显示 OCR 文本) */
export const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'svg', 'ico', 'avif'])

/** 文字是怎么来的(设计稿「类型」一行的后半段) */
export function fileLayers(format: string): string {
  const value = format.toLowerCase()
  if (value === 'pdf') return '文字层'
  if (SHEET_FORMATS.has(value)) return '表格'
  if (SLIDE_FORMATS.has(value)) return '幻灯片'
  if (IMAGE_FORMATS.has(value)) return 'OCR'
  if (MEDIA_FORMATS.has(value)) return '转写'
  return '文本层'
}

/** 抽取器 id(`application/pdf` 这类 MIME 样式)在 340px 的信息栏里太长,换成可读标签 */
export function extractorLabel(id: string | null | undefined): string {
  if (!id) return ''
  const map: Record<string, string> = {
    'application/pdf': 'PDF 文字层',
    'text/plain': '纯文本',
    'text/markdown': 'Markdown',
    'text/x-code': '代码',
    'text/x-log': '日志',
    'text/csv': 'CSV',
    'text/tab-separated-values': 'TSV',
    'text/html': 'HTML',
    'application/epub+zip': 'EPUB',
    'message/rfc822': '邮件',
    'application/x-ipynb+json': 'Notebook',
    'application/vnd.oasis.opendocument.text': 'ODT',
    'application/rtf': 'RTF',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
    'image/*': '图片 OCR',
    'audio|video/*': '音视频转写',
  }
  return map[id] ?? id
}

/* ---------------- 转 Markdown 副本编辑 ---------------- */

// 后端抽取器认得、又不能直接当文本改的格式。改的是转出来的 Markdown 副本,原件不动
const COPY_EDIT_EXT = new Set(['docx', 'pptx', 'xlsx', 'odt', 'rtf', 'epub', 'pdf'])

/** 这个文件能不能"转成 Markdown 副本再编辑"。 */
export function canEditAsMarkdown(source: string): boolean {
  const at = source.lastIndexOf('.')
  // 点要在最后一段文件名里:`a.b/readme` 和就叫 `docx` 的文件都没有扩展名
  if (at < 0 || at < source.lastIndexOf('/')) return false
  return COPY_EDIT_EXT.has(source.slice(at + 1).toLowerCase())
}

/** 副本在集合里的路径:只换扩展名,目录不变(与后端 `derived_path` 一致)。 */
export function markdownCopyPath(source: string): string {
  const at = source.lastIndexOf('.')
  return `${at > source.lastIndexOf('/') ? source.slice(0, at) : source}.md`
}

/** 转换前给人看的说明:副本是什么、会写在哪、丢什么。 */
export function copyEditNotice(source: string): string {
  const name = source.split('/').pop() ?? source
  const copy = markdownCopyPath(source).split('/').pop()
  const ext = (source.split('.').pop() ?? '').toLowerCase()
  const lost =
    ext === 'xlsx'
      ? '表格会变成 Markdown 表格,只保留单元格的值,公式、图表、样式不会保留。'
      : ext === 'pdf'
        ? '只保留文字层,排版和扫描页里的图片不会保留。'
        : '标题、段落、表格和图片会保留;字体、页眉页脚、批注和修订痕迹不会保留。'
  return `会在原文件旁边生成 ${copy}(图片放在同名的 .assets 文件夹里),你改的是这份 Markdown 副本,${name} 本身不会被改动。${lost}`
}
