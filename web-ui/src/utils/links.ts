// 文档里的链接 → 知识库里的目标。
//
// Markdown 原文里的相对链接(`./图.png`、`../资料/表.xlsx`)是相对**文件所在目录**的,
// 浏览器却会把它当成站点根下的路径,预览里必然 404。这里只负责解析出目标路径和「显示用地址」,
// 不改原文;保存时写回去的仍然是作者写的那一串。
//
// 三种写法:
//   - 相对路径:按当前文件所在目录解析(笔记按 collection 根);
//   - `kb://<collection>/<path>[?download=1][#anchor]`:collection 根,可跨集合;
//   - `kb://note/<id>`:笔记没有文件路径,用 id 引用。
//
// 安全边界与后端 `file_raw` 一致:目标必须在 collection 内,`..` 不能跑到根外面;
// 绝对路径、Windows 盘符、`file:` 一律不当作知识库文件,只提示「原电脑路径」。
export interface LinkContext {
  /** 当前文档所在的 collection。 */
  collection: string
  /** 当前文档在 collection 里的路径。笔记没有文件路径时为空,相对链接按 collection 根解析。 */
  sourcePath?: string | null
  /** 管理员只读查看的目标用户(显示地址要带上,否则会去管理员自己的库里找)。 */
  adminView?: string
  /** collection 内的路径 → 原件预览地址。 */
  rawUrl: (collection: string, path: string) => string
  /** collection 内的路径 → 流式下载地址;没有就退回 `rawUrl`。 */
  downloadUrl?: (collection: string, path: string) => string
}

export type LinkKind = 'external' | 'anchor' | 'raw' | 'file' | 'note' | 'absolute' | 'invalid'
export type LinkState = 'ok' | 'missing' | 'outside' | 'invalid' | 'unknown'

export interface ResolvedLink {
  kind: LinkKind
  /** 目标 collection(文件 / 本站原件地址才有)。 */
  collection?: string
  /** 解析后的 collection 内路径(文件 / 本站原件地址才有)。 */
  target?: string
  /** 笔记 id(`kind === 'note'` 才有)。 */
  noteId?: string
  /** 显示 / 打开用地址;文件链接指向 `/api/v1/raw`,保留原来的 query 和 `#fragment`。 */
  href: string
  /** 原文里的 href(去掉首尾空白),用于展示和回写。 */
  raw: string
  fragment?: string
  query?: string
  /** 是否按「下载」处理:显式 `?download=1`、下载接口、模板扩展名。 */
  download?: boolean
  /** 不能打开时给用户看的原因。 */
  reason?: string
}

export interface LinkCheckItem {
  /** 目标类型;老服务只返回文件,缺省按文件处理。 */
  kind?: 'file' | 'note'
  collection: string
  path: string
  noteId?: string
  /** 正文里的原始 href(可能是相对路径);缺省表示没有可回写的原文。 */
  href?: string
  state: LinkState
  reason?: string
  size?: number | null
  name?: string | null
}

/** 相对链接的解析基准:当前文件所在目录。 */
function baseDir(sourcePath: string | null | undefined): string[] {
  if (!sourcePath) return []
  return sourcePath.replace(/\\/g, '/').split('/').slice(0, -1).filter(Boolean)
}

/** 把 `a/./b/../c` 规整成 `a/c`;跑出集合根(或出现控制字符)返回 null。 */
export function normalizeLinkPath(path: string, base: string[] = []): string | null {
  const parts = [...base]
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) return null
      parts.pop()
      continue
    }
    // NUL / 控制字符不可能出现在知识库路径里,不要把它们送进后端
    if (/[\u0000-\u001f]/.test(segment)) return null
    parts.push(segment)
  }
  return parts.length ? parts.join('/') : null
}

function isWindowsPath(value: string): boolean {
  // Markdown 解析器会把反斜杠编码成 %5C;盘符和 UNC 都要在解码前后各认一次。
  const decoded = value.replace(/%5c/gi, '\\').replace(/%3a/gi, ':')
  return /^[a-zA-Z]:[\\/]/.test(decoded) || decoded.startsWith('\\\\')
}

function isSiteFileUrl(value: string): boolean {
  return value.startsWith('/api/v1/raw') || value.startsWith('/api/v1/download') || value.startsWith('/api/v1/share/')
}

/** 本站原件 / 下载 / 分享链接 → collection + path;不是返回 null。 */
export function parseFileUrl(href: string): { kind: 'raw' | 'download' | 'share-raw' | 'share-download'; collection: string; path: string } | null {
  if (!href.startsWith('/') && !/^https?:\/\//i.test(href)) return null
  try {
    const url = new URL(href, 'http://local.invalid')
    // 只认同源地址;`//evil` 虽然以 `/` 开头,但 origin 不是本机
    if (url.origin !== 'http://local.invalid') return null
    let kind: 'raw' | 'download' | 'share-raw' | 'share-download'
    if (url.pathname === '/api/v1/raw') kind = 'raw'
    else if (url.pathname === '/api/v1/download') kind = 'download'
    else {
      const match = /^\/api\/v1\/share\/[^/]+\/(raw|download)$/.exec(url.pathname)
      if (!match) return null
      kind = match[1] === 'raw' ? 'share-raw' : 'share-download'
    }
    const collection = url.searchParams.get('collection')
    const path = url.searchParams.get('path')
    return collection && path ? { kind, collection, path } : null
  } catch {
    return null
  }
}

/** `?download=1` / `?download=true` / 空值都算下载;`0` / `false` 明确不算。 */
function downloadRequested(query: string): boolean {
  if (!query) return false
  const value = new URLSearchParams(query).get('download')
  return value !== null && !/^(?:0|false|no)$/i.test(value)
}

/** 去掉 `download` 参数,其余 query 原样保留(下载地址不需要再带一次下载意图)。 */
function withoutDownload(query: string): string {
  if (!query) return ''
  const params = new URLSearchParams(query)
  params.delete('download')
  return params.toString()
}

function withSuffix(url: string, query: string, fragment: string): string {
  let out = url
  if (query) out += (out.includes('?') ? '&' : '?') + query
  if (fragment) out += `#${fragment}`
  return out
}

/** Word / Excel / PowerPoint 模板与启用宏的模板:即使作者没写 `?download=1`,点击也直接下载。 */
export function isTemplatePath(path: string): boolean {
  return /\.(?:dotx|dotm|xltx|xltm|potx|potm)$/i.test(path)
}

/**
 * 双链里的 id 是不是笔记 id。
 *
 * 与编辑器的既有约定保持一致:带 `/` 或文件扩展名的按文件路径,否则按笔记 id。
 * 笔记 id 目前是 uuid(`01a1…`),历史上也出现过 `ins_…`;这个判断不能只认前缀。
 */
export function isNoteLinkId(value: string): boolean {
  const id = (value ?? '').trim()
  return !!id && !/[\\/]/.test(id) && !/\.[a-z0-9]{1,8}$/i.test(id)
}

/** 笔记体检结果的键(与文件路径的键分开,避免空 collection 撞车)。 */
export function noteLinkKey(id: string): string {
  return `note\u0000${id}`
}

/** 从解析结果取体检键;没有目标(外链 / 锚点)返回 null。 */
export function resolvedLinkKey(link: ResolvedLink): string | null {
  if (link.kind === 'note' && link.noteId) return noteLinkKey(link.noteId)
  if ((link.kind === 'file' || link.kind === 'raw') && link.collection && link.target) return linkKey(link.collection, link.target)
  return null
}

/** 生成可移植的 `kb://` 文件引用;每段单独编码,`#` 只做锚点。 */
export function kbFileHref(collection: string, path: string, options: { download?: boolean; fragment?: string } = {}): string {
  const clean = normalizeLinkPath(path)
  if (!collection || !clean) return ''
  const encoded = clean.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  let out = `kb://${encodeURIComponent(collection)}/${encoded}`
  if (options.download) out += '?download=1'
  if (options.fragment) out += `#${options.fragment}`
  return out
}

/** 引用选择器返回的一个文件(字段与 `list_files` 能力对齐)。 */
export interface FileHit {
  collection: string
  path: string
  name: string
  size?: number
  updated_at?: number
  kind?: string
  template?: boolean
  indexed?: boolean
}

/**
 * 同一 collection 里从 `fromPath` 指向 `toPath` 的相对地址。
 *
 * 写进正文的是相对路径,换了域名 / 导出离线仍然能用;目标跑出集合根时返回 null,
 * 让调用方退回 `kb://`(解析器两边用同一套 `..` 边界)。
 */
export function relativeFileHref(fromPath: string | null | undefined, toPath: string): string | null {
  const target = normalizeLinkPath(toPath)
  if (!target || !fromPath) return null
  const from = baseDir(fromPath)
  const to = target.split('/')
  let same = 0
  while (same < from.length && same < to.length && from[same] === to[same]) same += 1
  const parts = [...from.slice(same).map(() => '..'), ...to.slice(same)]
  if (!parts.length) return null
  return parts.map((part) => encodeURIComponent(part)).join('/')
}

/** 上传完成后的正文地址:优先相对路径,新笔记(还没有路径)或跨集合时用 `kb://`。 */
export function hrefForTarget(
  fromCollection: string,
  fromPath: string | null | undefined,
  targetCollection: string,
  targetPath: string,
  options: { download?: boolean } = {},
): string {
  if (fromCollection === targetCollection) {
    const relative = relativeFileHref(fromPath, targetPath)
    if (relative) return relative
  }
  return kbFileHref(targetCollection, targetPath, options)
}

/** 生成 `kb://note/<id>`;id 只允许字母、数字、下划线和连字符。 */
export function noteHref(id: string): string {
  const clean = (id ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(clean)) return ''
  return `kb://note/${clean}`
}

type ParsedKb =
  | { kind: 'file'; collection: string; path: string; query: string; fragment: string; download: boolean }
  | { kind: 'note'; noteId: string; raw: string }
  | { kind: 'invalid'; raw: string; reason: string }

/**
 * 解析 `kb://`。不是 `kb://` 返回 null;是但写错返回 invalid。
 *
 * 注意不能在解析前把整串 `decodeURIComponent`:文件名里的 `%2F` 必须保持分段语义,
 * 否则 `a%2F..%2Fb` 会绕过 `..` 检查。
 */
function parseKbHref(raw: string): ParsedKb | null {
  if (!/^kb:\/\//i.test(raw)) return null
  let rest = raw.slice(5)
  let fragment = ''
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    fragment = rest.slice(hash + 1)
    rest = rest.slice(0, hash)
  }
  let query = ''
  const q = rest.indexOf('?')
  if (q >= 0) {
    query = rest.slice(q + 1)
    rest = rest.slice(0, q)
  }
  const slash = rest.indexOf('/')
  const hostRaw = slash >= 0 ? rest.slice(0, slash) : rest
  const pathRaw = slash >= 0 ? rest.slice(slash + 1) : ''
  let host: string
  try {
    host = decodeURIComponent(hostRaw)
  } catch {
    return { kind: 'invalid', raw, reason: '链接编码不合法' }
  }
  if (host === 'note') {
    if (!pathRaw) return { kind: 'invalid', raw, reason: '笔记链接缺少 id' }
    let id: string
    try {
      id = decodeURIComponent(pathRaw)
    } catch {
      return { kind: 'invalid', raw, reason: '链接编码不合法' }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return { kind: 'invalid', raw, reason: '笔记 id 不合法' }
    return { kind: 'note', noteId: id, raw }
  }
  // collection 的命名规则(后端 ids.rs):`_global` / `proj_<slug>` / `ext_<slug>`
  if (!/^(?:_global|(?:proj|ext)_[a-z0-9_]+)$/.test(host)) return { kind: 'invalid', raw, reason: '集合名不合法' }
  if (!pathRaw) return { kind: 'invalid', raw, reason: '链接缺少文件路径' }
  const segments: string[] = []
  for (const part of pathRaw.split('/')) {
    if (!part) return { kind: 'invalid', raw, reason: '路径不合法' }
    let segment: string
    try {
      segment = decodeURIComponent(part)
    } catch {
      return { kind: 'invalid', raw, reason: '链接编码不合法' }
    }
    // 解码后仍要挡 `..` / `.` / 分隔符和控制字符;`%2F` 不能把一段拆成两层
    if (!segment || segment === '.' || segment === '..' || /[\\/\u0000-\u001f]/.test(segment)) {
      return { kind: 'invalid', raw, reason: '路径不合法' }
    }
    segments.push(segment)
  }
  return {
    kind: 'file',
    collection: host,
    path: segments.join('/'),
    query,
    fragment,
    download: downloadRequested(query),
  }
}

/**
 * 解析一个 href。
 *
 * 外链 / 锚点原样返回;相对路径按当前文件目录解析成 `rawUrl` 地址;
 * 解析不到(绝对路径、跑出集合、空路径)返回 `invalid` / `absolute`,由渲染器显示成不可点。
 */
export function resolveDocHref(href: string, ctx: LinkContext): ResolvedLink {
  const raw = (href ?? '').trim()
  if (!raw) return { kind: 'invalid', href: '', raw, reason: '空链接' }
  if (raw.startsWith('#')) return { kind: 'anchor', href: raw, raw, fragment: raw.slice(1) }

  const kb = parseKbHref(raw)
  if (kb) {
    if (kb.kind === 'invalid') return { kind: 'invalid', href: raw, raw, reason: kb.reason }
    if (kb.kind === 'note') return { kind: 'note', noteId: kb.noteId, href: raw, raw }
    const download = kb.download || isTemplatePath(kb.path)
    const url = download ? (ctx.downloadUrl ?? ctx.rawUrl)(kb.collection, kb.path) : ctx.rawUrl(kb.collection, kb.path)
    return {
      kind: 'file',
      collection: kb.collection,
      target: kb.path,
      href: withSuffix(url, download ? withoutDownload(kb.query) : kb.query, kb.fragment),
      raw,
      query: kb.query,
      fragment: kb.fragment,
      download,
    }
  }

  const file = parseFileUrl(raw)
  if (file) {
    const target = normalizeLinkPath(file.path)
    if (!target) return { kind: 'invalid', href: raw, raw, reason: '路径不合法' }
    let query = ''
    let fragment = ''
    try {
      const url = new URL(raw, 'http://local.invalid')
      query = url.search.slice(1)
      fragment = url.hash.slice(1)
      // 分享地址的 token 在 pathname 里;`href` 要保持原样,不能换成当前上下文的地址
      const explicitDownload = file.kind === 'download' || file.kind === 'share-download'
      const download = explicitDownload || downloadRequested(url.search) || isTemplatePath(target)
      if (explicitDownload) {
        return { kind: 'raw', collection: file.collection, target, href: raw, raw, query, fragment, download: true }
      }
      if (download) {
        const urlBuilder = ctx.downloadUrl ?? ctx.rawUrl
        return {
          kind: 'raw',
          collection: file.collection,
          target,
          href: withSuffix(urlBuilder(file.collection, target), withoutDownload(url.search.slice(1)), fragment),
          raw,
          query,
          fragment,
          download: true,
        }
      }
    } catch {
      return { kind: 'invalid', href: raw, raw, reason: '链接不合法' }
    }
    return {
      kind: 'raw',
      collection: file.collection,
      target,
      href: withSuffix(ctx.rawUrl(file.collection, target), '', fragment),
      raw,
      query,
      fragment,
    }
  }

  // Windows 盘符 / UNC:来自作者原来的电脑,知识库里没有这个文件
  if (isWindowsPath(raw) || /^file:/i.test(raw)) {
    return {
      kind: 'absolute',
      href: raw,
      raw,
      reason: '这是原电脑上的路径,文件没有同步到知识库',
    }
  }
  if (/^(?:javascript|vbscript):/i.test(raw)) {
    return { kind: 'invalid', href: raw, raw, reason: '不安全的链接' }
  }
  // 带协议的(http / mailto / data / obsidian …)和站点根路径都不属于 collection
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//') || raw.startsWith('/') || raw.startsWith('?')) {
    return { kind: 'external', href: raw, raw }
  }

  const hash = raw.indexOf('#')
  const beforeHash = hash >= 0 ? raw.slice(0, hash) : raw
  const fragment = hash >= 0 ? raw.slice(hash + 1) : ''
  const queryAt = beforeHash.indexOf('?')
  const pathPart = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : ''
  if (!pathPart) return { kind: 'anchor', href: raw, raw, fragment }

  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return { kind: 'invalid', href: raw, raw, reason: '链接编码不合法' }
  }
  // 站点根路径在解码后再挡一次(`%2Fapi/...`)
  if (decoded.startsWith('/') || decoded.startsWith('\\')) return { kind: 'external', href: raw, raw }
  const target = normalizeLinkPath(decoded, baseDir(ctx.sourcePath))
  if (!target) {
    return {
      kind: 'invalid',
      href: raw,
      raw,
      reason: isSiteFileUrl(decoded) ? '路径不合法' : '链接指向了 collection 外面',
    }
  }
  // 模板 / 显式下载意图:链接指向下载接口,点击不再进预览
  const download = downloadRequested(query) || isTemplatePath(target)
  const urlBuilder = download ? (ctx.downloadUrl ?? ctx.rawUrl) : ctx.rawUrl
  return {
    kind: 'file',
    collection: ctx.collection,
    target,
    href: withSuffix(urlBuilder(ctx.collection, target), download ? withoutDownload(query) : query, fragment),
    raw,
    query,
    fragment,
    download,
  }
}

/**
 * 渲染 `<a href>` 前的协议白名单。
 *
 * Milkdown 默认只放行 http(s)/mailto/tel/ftp,知识库内部链接用的 `kb://` 会被清成空串,
 * 结果正文里的文件引用、附件卡片全都点不动(图片不走这里,`<img src>` 不过滤)。
 * 这里只额外放行 `kb://`,其它协议仍按默认白名单处理,不能让 `javascript:` 混进来。
 */
export function sanitizeRenderHref(href: string | null | undefined): string {
  const value = (href ?? '').trim()
  if (!value) return ''
  if (/^kb:\/\//i.test(value)) return value
  // 与 Milkdown 的 sanitizeLinkHref 一致:去掉不可见字符后再判断协议,防止 `java\u0000script:` 绕过
  const normalized = [...value].filter((char) => {
    const code = char.codePointAt(0) ?? 0
    return !(code <= 32 || (code >= 127 && code <= 160) || (code >= 8203 && code <= 8205) || code === 8232 || code === 8233 || code === 65279)
  }).join('')
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLowerCase()
  if (!scheme) return value
  return ['http', 'https', 'mailto', 'tel', 'ftp'].includes(scheme) ? value : ''
}

/** 体检结果的键:collection + 路径。 */
export function linkKey(collection: string, path: string): string {
  return `${collection}\u0000${path}`
}

/** 目标是不是能在页面里直接预览的图片 / 音视频(决定链接点击走预览还是下载)。 */
export function fileSizeText(size: number | null | undefined): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 打开文档后滚到 `#fragment` 指向的标题 / 锚点;找不到就算了。 */
export function scrollToFragment(fragment: string | undefined, root: ParentNode = document): void {
  if (!fragment) return
  let id = fragment
  try {
    id = decodeURIComponent(fragment)
  } catch {
    /* 保持原样 */
  }
  const element = (root as Document).getElementById?.(id)
    ?? [...root.querySelectorAll<HTMLElement>('[id], [name]')].find((node) => node.id === id || node.getAttribute('name') === id)
  element?.scrollIntoView({ block: 'start' })
}
