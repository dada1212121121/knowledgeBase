// 文档正文里的链接:渲染成 DOM 之后统一改写一次(阅读态 / 预览共用)。
//
// 为什么不放在组件里:阅读态(MarkdownRead,markdown-it)和编辑器外壳的文本面(ProseMirror 装饰)
// 是两条渲染管线,但「双链怎么变成可点节点」「相对路径怎么解析」「缺目标怎么提示」必须完全一致,
// 否则同一篇笔记在两种视图里行为不同。这里只依赖 DOM 和 utils/links,不依赖任何渲染器。
//
// 边界:
// 1. 只改 DOM 的 href / src,原文一个字都不动;保存写回去的仍是作者写的那串。
// 2. 链接体检结果只用来加样式和提示,不偷偷删节点。
// 3. 点击拦截只在真正能打开(笔记 / 库内文件)时做;下载交回浏览器,外链照旧新窗口。
import {
  isNoteLinkId,
  linkKey,
  noteHref,
  noteLinkKey,
  resolveDocHref,
  type LinkContext,
  type LinkState,
} from './links'

export interface DocLinkOptions {
  /** 当前文档的位置;没有它就不改写(分享页以外的场景都该给)。 */
  context: LinkContext
  /** 链接体检结果:collection + path / noteKey → 在不在。 */
  linkStates: Record<string, LinkState>
  /** 是否允许打开笔记双链;分享页只显示标题。 */
  allowNotes: boolean
  /** 「没有访问权限」的措辞:分享页范围更窄,要单独说一句。 */
  outsideMessage?: string
}

/** 目标不可用时给用户看的一句话(和旧预览的措辞保持一致)。 */
export function docLinkProblem(
  kind: string,
  state: LinkState | undefined,
  reason: string | undefined,
  target: string | undefined,
  outsideMessage = '这个链接不在本次分享的范围内',
): string {
  if (state === 'missing') return `链接指向的目标不在知识库里：${target ?? ''}`
  if (state === 'outside') return outsideMessage
  if (kind === 'absolute') return reason ?? '这是原电脑上的路径,文件没有同步到知识库'
  if (kind === 'invalid') return reason ?? '这个链接不可用'
  return reason ?? `这个链接打不开：${target ?? ''}`
}

function applyNoteState(anchor: HTMLAnchorElement, id: string, options: DocLinkOptions, outsideMessage?: string): void {
  const state = options.linkStates[noteLinkKey(id)]
  const broken = state === 'missing' || state === 'outside' || state === 'invalid'
  anchor.classList.toggle('kb-link-missing', broken)
  if (broken) {
    const reason = docLinkProblem('note', state, undefined, id, outsideMessage)
    anchor.dataset.kbProblem = reason
    anchor.title = reason
  } else {
    delete anchor.dataset.kbProblem
  }
}

/**
 * 双链在 Markdown 里只是文本:把 `[[id|标题]]` 换成可点节点,代码块 / 已有链接里不动。
 * 文本节点拆分后才能替换,所以用 TreeWalker 收集再改(边遍历边改会让 walker 失效)。
 */
export function decorateWikilinks(root: DocLinkRoot, options: DocLinkOptions): void {
  // 绝大多数正文里没有双链：先用一次原生的 textContent 判断，没有就不建 TreeWalker。
  // TreeWalker 的 acceptNode 对每个文本节点都要从原生进 JS 一趟，200 KB 的笔记（上万个文本节点）光这一步就是 70 ms 级的长任务（4× 降速）。
  if (!root.textContent?.includes('[[')) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || !node.nodeValue?.includes('[[')) return NodeFilter.FILTER_REJECT
      if (parent.closest('a, code, pre, script, style, .kb-wikilink')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    const text = node.nodeValue ?? ''
    const matches = [...text.matchAll(/\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?]]/g)]
    if (!matches.length) continue
    const frag = document.createDocumentFragment()
    let last = 0
    for (const match of matches) {
      const index = match.index ?? 0
      if (index > last) frag.append(document.createTextNode(text.slice(last, index)))
      const id = (match[1] ?? '').trim()
      const label = (match[2] ?? '').trim() || id
      if (!id) {
        frag.append(document.createTextNode(match[0]))
      } else if (isNoteLinkId(id)) {
        if (!options.allowNotes) {
          const span = document.createElement('span')
          span.className = 'kb-wikilink is-text'
          span.textContent = label
          frag.append(span)
        } else {
          const anchor = document.createElement('a')
          anchor.className = 'kb-wikilink'
          anchor.href = noteHref(id) || '#'
          anchor.dataset.kbNote = id
          anchor.textContent = label
          applyNoteState(anchor, id, options, options.outsideMessage)
          frag.append(anchor)
        }
      } else {
        // 文件双链按 collection 根解析;`rewriteDocLinks` 会用 dataset.kbRoot 选择解析基准
        const anchor = document.createElement('a')
        anchor.className = 'kb-wikilink'
        anchor.href = id
        anchor.dataset.kbHref = id
        anchor.dataset.kbRoot = '1'
        anchor.textContent = label
        frag.append(anchor)
      }
      last = index + match[0].length
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)))
    node.parentNode?.replaceChild(frag, node)
  }
}

/**
 * 改写的作用范围：整篇正文的容器，或者还没挂上 DOM 的一段片段（DocumentFragment）。
 * 分段渲染时先在 `<template>` 的片段里改好再挂上去：片段里的 <img> 不会提前按原始相对路径发请求。
 */
export type DocLinkRoot = ParentNode & Node

/** 把正文里的相对链接 / 图片解析成知识库地址,并标出体检状态。幂等:重复调用不会再改一次。 */
export function rewriteDocLinks(root: DocLinkRoot, options: DocLinkOptions): void {
  const ctx = options.context
  decorateWikilinks(root, options)
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    // 双链笔记:已经由 decorateWikilinks 标好状态,这里只防止把 kb://note/... 再当文件解析
    if (anchor.dataset.kbNote) {
      applyNoteState(anchor, anchor.dataset.kbNote, options, options.outsideMessage)
      continue
    }
    const original = anchor.dataset.kbHref ?? anchor.getAttribute('href') ?? ''
    if (!original) continue
    anchor.dataset.kbHref = original
    const resolveCtx = anchor.dataset.kbRoot ? { ...ctx, sourcePath: null } : ctx
    const resolved = resolveDocHref(original, resolveCtx)
    if (resolved.kind === 'note' && resolved.noteId) {
      anchor.dataset.kbNote = resolved.noteId
      anchor.href = resolved.href
      applyNoteState(anchor, resolved.noteId, options, options.outsideMessage)
    } else if (resolved.kind === 'file' || resolved.kind === 'raw') {
      if (!resolved.collection || !resolved.target) continue
      const state = options.linkStates[linkKey(resolved.collection, resolved.target)]
      anchor.setAttribute('href', resolved.href)
      anchor.dataset.kbCollection = resolved.collection
      anchor.dataset.kbPath = resolved.target
      if (resolved.fragment) anchor.dataset.kbFragment = resolved.fragment
      else delete anchor.dataset.kbFragment
      if (resolved.download) anchor.dataset.kbDownload = '1'
      else delete anchor.dataset.kbDownload
      const broken = state === 'missing' || state === 'outside' || state === 'invalid'
      anchor.classList.toggle('kb-link-missing', broken)
      if (broken) {
        anchor.dataset.kbProblem = docLinkProblem(resolved.kind, state, resolved.reason, resolved.target, options.outsideMessage)
        anchor.title = anchor.dataset.kbProblem
      } else {
        delete anchor.dataset.kbProblem
        anchor.removeAttribute('title')
      }
    } else if (resolved.kind === 'absolute' || resolved.kind === 'invalid') {
      const reason = docLinkProblem(resolved.kind, undefined, resolved.reason, resolved.target, options.outsideMessage)
      anchor.dataset.kbProblem = reason
      anchor.title = reason
      anchor.classList.add('kb-link-missing')
    } else if (resolved.kind === 'external' && /^https?:/i.test(resolved.href)) {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer nofollow')
    }
  }
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const original = image.dataset.kbSrc ?? image.getAttribute('src') ?? ''
    if (!original) continue
    image.dataset.kbSrc = original
    const resolved = resolveDocHref(original, ctx)
    if ((resolved.kind === 'file' || resolved.kind === 'raw') && resolved.collection && resolved.target) {
      image.src = ctx.rawUrl(resolved.collection, resolved.target)
      const state = options.linkStates[linkKey(resolved.collection, resolved.target)]
      const broken = state === 'missing' || state === 'outside'
      image.classList.toggle('kb-img-missing', broken)
      if (broken) image.title = `图片不在知识库里：${resolved.target}`
    }
  }
}

/** 点击结果:调用方只处理 note / file / problem,其余(null / external / download)交回浏览器。 */
export type DocLinkClick =
  | { kind: 'problem'; message: string }
  | { kind: 'note'; id: string }
  | { kind: 'file'; collection: string; path: string; fragment?: string }

/** 判断这次点击落在哪种目标上;不认识的返回 null(外部链接、下载、页内锚点都归浏览器)。 */
export function resolveDocLinkClick(target: EventTarget | null, allowNotes = true): DocLinkClick | null {
  const anchor = (target as HTMLElement | null)?.closest('a') as HTMLAnchorElement | null
  if (!anchor) return null
  if (anchor.dataset.kbProblem) return { kind: 'problem', message: anchor.dataset.kbProblem }
  if (anchor.dataset.kbNote) {
    // 分享页不允许跳笔记:点击不拦截,但也打不开(链接没有实际 href),保持原行为
    return allowNotes ? { kind: 'note', id: anchor.dataset.kbNote } : null
  }
  if (anchor.dataset.kbDownload) return null
  const collection = anchor.dataset.kbCollection
  const path = anchor.dataset.kbPath
  if (!collection || !path) return null
  return { kind: 'file', collection, path, fragment: anchor.dataset.kbFragment }
}
