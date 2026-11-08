import { dayKey } from './time'
// 笔记附件:存进笔记所在集合的 `_attachments/<年-月>/<随机前缀>-<文件名>`,走现有的分片上传 + 解析队列
// (所以 PDF / Word 等附件也会被检索到);笔记里引用的是同源的 `/api/v1/raw?collection=…&path=…`。
//   图片:`![文件名](原件地址)`
//   其它:`[📎 文件名](原件地址 "大小")`(📎 前缀让编辑器认出这是附件卡片,其它工具里也读得懂)
import { humanSize } from './hexdump'
import { parseFileUrl, resolveDocHref } from './links'

export const ATTACHMENT_DIR = '_attachments'
export const ATTACHMENT_MARK = '📎'
/** 单个附件上限(与服务端 `upload.max_file_mb` 默认值一致的保守值) */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'jfif', 'jpe', 'pjpeg', 'pjp', 'apng', 'ico'])
/** JPEG 的几种老扩展名：服务端只认 jpg / jpeg 给 image/jpeg，上传前统一改成 jpg（见 imageUploadName） */
const LEGACY_JPEG_EXT = new Set(['jfif', 'jpe', 'pjpeg', 'pjp'])
/** 浏览器给出的图片 MIME → 规范扩展名（文件名没有可用扩展名时靠它判断是不是图片、并补上扩展名） */
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/apng': 'png',
  'image/jpeg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

export function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  return at > 0 ? name.slice(at + 1).toLowerCase() : ''
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.has(extensionOf(name))
}

/**
 * 上传的文件是图片吗？是的话返回存进库的文件名（带规范扩展名），不是返回 null。
 *
 * 以前只看文件名扩展名：Gemini 导出的 `….jfif`（JPEG 的另一个扩展名）、没有扩展名的截图（`image`）、
 * 名字里带点的截图（`Screenshot 17.58.12`，被当成扩展名 `58.12`）都当成了附件。现在先认扩展名，
 * 认不出再看浏览器给的 MIME；老 JPEG 扩展名改成 jpg（服务端只给 jpg / jpeg 发 image/jpeg）；
 * 名字里没有可用的图片扩展名时按 MIME 补一个。
 */
export function imageUploadName(file: { name: string; type?: string }): string | null {
  const ext = extensionOf(file.name)
  if (LEGACY_JPEG_EXT.has(ext)) return `${file.name.slice(0, file.name.length - ext.length)}jpg`
  if (IMAGE_EXT.has(ext)) return file.name
  const fromMime = IMAGE_MIME_EXT[(file.type ?? '').toLowerCase()]
  return fromMime ? `${file.name}.${fromMime}` : null
}

// 浏览器能直接播放、且服务端 `/api/v1/raw` 会内联下发的音视频(与 kb-web 的内联类型白名单一致)。
// mkv / avi / wmv 这类浏览器不认的不在里面:仍是普通附件卡片,点开走预览页。
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg'])

/** 文件能不能在文档里直接播放:视频 / 音频 / 都不是。 */
export function mediaKind(name: string): 'video' | 'audio' | null {
  const ext = extensionOf(name)
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

/** 文件名清理:去掉路径分隔符和控制字符,留中文与空格;过长截断但保留扩展名。 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim() || 'file'
  if (cleaned.length <= 80) return cleaned
  const ext = extensionOf(cleaned)
  return `${cleaned.slice(0, 80 - ext.length - 1)}.${ext}`
}

/** `_attachments/2026-10/k3f9x2ab-报告.pdf`;随机前缀避免同名覆盖。 */
export function attachmentPath(name: string, now = Date.now(), random = Math.random): string {
  // 附件目录按站点时区的年月归档,和后台统计的“本月”一致
  const month = dayKey(now).slice(0, 7)
  const prefix = Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('')
  return `${ATTACHMENT_DIR}/${month}/${prefix}-${safeFileName(name)}`
}

export function rawUrl(collection: string, path: string, adminView = ''): string {
  const query = new URLSearchParams({ collection, path })
  // 管理员只读查看:图片 / 附件地址也要带目标用户,否则会去管理员的库里找同名文件
  if (adminView) query.set('admin_view', adminView)
  return `/api/v1/raw?${query.toString()}`
}

/** 流式下载地址:不走 `/raw` 的 64 MB 预览上限,大文件也能完整下发。 */
export function downloadUrl(collection: string, path: string, adminView = ''): string {
  const query = new URLSearchParams({ collection, path })
  if (adminView) query.set('admin_view', adminView)
  return `/api/v1/download?${query.toString()}`
}

/**
 * Markdown 文件里的图片 / 附件地址 → 能直接加载的原件地址。
 *
 * 项目里的 `.md` 常这样引用同目录的图:`![架构](./img/arch.png)`、`![](../shot.png)`。浏览器会把它当成
 * 站点根下的路径去请求(一定 404),预览和编辑里就是一个裂图。这里按"文件所在目录"解析成集合里的相对路径,
 * 再换成 `/api/v1/raw?collection=…&path=…`。
 *
 * 只改**显示用的地址**,Markdown 原文不动(保存时写回的还是 `./img/arch.png`)。
 * 以下情况原样返回:带协议的(http / data / blob …)、站点根路径(`/…`)、`#锚点`、`?查询`、空串;
 * 解析后跑到集合外面的(`../../..`)也原样返回,交给浏览器去失败,不替用户读集合以外的东西。
 */
export function assetUrl(
  href: string,
  collection: string | null | undefined,
  sourcePath: string | null | undefined,
  adminView = '',
  /** 分享页用分享链接自己的原件地址;不给就用当前登录用户的本站地址。 */
  makeRawUrl?: (collection: string, path: string) => string,
): string {
  const toRaw = (name: string, path: string) => (makeRawUrl ? makeRawUrl(name, path) : rawUrl(name, path, adminView))
  // 编辑器插入的图片本身就是本站原件地址:管理员查看时要补上目标用户
  const file = parseFileUrl(href)
  if (file) {
    if (file.kind === 'raw' || file.kind === 'share-raw') return adminView ? toRaw(file.collection, file.path) : href
    // 下载 / 分享下载地址嵌进 <img> 只会触发下载,换成预览地址
    return toRaw(file.collection, file.path)
  }
  // 没有文件路径的笔记里，上传的图片写成 `kb://集合/路径`（见 hrefForTarget）：它自带集合名，不依赖当前文件的目录，
  // 必须照样换成原件地址，否则 <img src="kb://…"> 会被 CSP 拦掉、显示成破图。其它相对地址在没有路径时无从解析，原样返回
  const selfContained = /^kb:\/\//i.test(href ?? '')
  if (!href || !collection || (!sourcePath && !selfContained)) return href
  const resolved = resolveDocHref(href, {
    collection,
    sourcePath,
    adminView,
    rawUrl: toRaw,
  })
  // 只把「解析到 collection 内文件」的换掉;外链 / 锚点 / 绝对路径 / 越界都原样返回
  return resolved.kind === 'file' && resolved.collection && resolved.target ? toRaw(resolved.collection, resolved.target) : href
}

/** 原件地址 → { collection, path };不是本站原件地址返回 null。 */
export function parseRawUrl(href: string): { collection: string; path: string } | null {
  const file = parseFileUrl(href)
  return file?.kind === 'raw' ? { collection: file.collection, path: file.path } : null
}

/** 显示用的文件名:去掉随机前缀。 */
export function displayName(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/^[a-z0-9]{8}-/, '')
}

const escapeLinkText = (value: string) => value.replace(/([[\]\\])/g, '\\$1')
const escapeTitle = (value: string) => value.replace(/"/g, '\\"')

export function imageMarkdown(name: string, url: string): string {
  return `![${escapeLinkText(name.replace(/\.[^.]+$/, ''))}](${url})`
}

export function attachmentMarkdown(name: string, url: string, size: number): string {
  return `[${ATTACHMENT_MARK} ${escapeLinkText(name)}](${url} "${escapeTitle(humanSize(size))}")`
}

/** 附件卡片图标块里的扩展名（最多 4 个字符，大写）；没有扩展名时用「FILE」 */
export function attachmentExt(name: string): string {
  const ext = extensionOf(name)
  return (ext || 'file').slice(0, 4).toUpperCase()
}

/** 附件卡片第二行：「PDF · 2.3 MB」；没有大小（手写的链接）只写类型 */
export function attachmentMeta(name: string, size: string): string {
  return [attachmentExt(name), size.trim()].filter(Boolean).join(' · ')
}

/** 附件卡片的图标分类(配色用) */
export function attachmentKind(name: string): 'pdf' | 'doc' | 'sheet' | 'slide' | 'archive' | 'media' | 'image' | 'code' | 'file' {
  const ext = extensionOf(name)
  if (ext === 'pdf') return 'pdf'
  if (['doc', 'docx', 'odt', 'rtf', 'pages', 'txt', 'md'].includes(ext)) return 'doc'
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods', 'numbers'].includes(ext)) return 'sheet'
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'slide'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)) return 'archive'
  if (['mp3', 'wav', 'm4a', 'flac', 'mp4', 'mov', 'mkv', 'webm'].includes(ext)) return 'media'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (['js', 'ts', 'py', 'rs', 'go', 'java', 'json', 'yaml', 'toml', 'sql', 'sh'].includes(ext)) return 'code'
  return 'file'
}
