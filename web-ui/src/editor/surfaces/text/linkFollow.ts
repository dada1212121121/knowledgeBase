/**
 * 正文里点击链接 / 双链 / 附件卡片时「该去哪」的判定
 *
 * 为什么是纯函数：判定必须和历史行为（之前旧编辑器 onClick 里的那份）一模一样，
 * 逻辑逐条照搬并用单测锁住。
 * 纯函数还有一个好处：不用挂 DOM 就能把每一种链接、每一种体检结论测全。
 */
import { parseRawUrl } from '@/utils/attachments'
import { linkKey, noteLinkKey, resolveDocHref, type LinkState, type ResolvedLink } from '@/utils/links'
import type { TextServices } from '../../types'

/** 点击要执行的动作；null = 什么都不做（交给浏览器 / 编辑器默认行为） */
export type FollowAction =
  | { type: 'openLink'; id: string }
  | { type: 'openAttachment'; target: { collection: string; path: string; fragment?: string } }
  | { type: 'openWindow'; href: string }
  | { type: 'error'; message: string }

export interface FollowResult {
  /** 是否拦下浏览器默认行为 */
  preventDefault: boolean
  action: FollowAction | null
}

const NOTHING: FollowResult = { preventDefault: false, action: null }

/** 一个 href 的解析结果与体检结论；上下文不全（没有 linkContext）时返回 null */
export function linkStateOf(
  href: string,
  services: Pick<TextServices, 'linkContext' | 'linkStates'>,
): { resolved: ResolvedLink; state: LinkState | undefined } | null {
  const ctx = services.linkContext()
  if (!ctx || !href) return null
  const resolved = resolveDocHref(href, ctx)
  const states = services.linkStates()
  if (resolved.kind === 'note' && resolved.noteId) return { resolved, state: states[noteLinkKey(resolved.noteId)] }
  if ((resolved.kind !== 'file' && resolved.kind !== 'raw') || !resolved.collection || !resolved.target) {
    return { resolved, state: undefined }
  }
  return { resolved, state: states[linkKey(resolved.collection, resolved.target)] }
}

/** 体检结论为「不可用」的几种 */
function isBroken(state: LinkState | undefined): state is 'missing' | 'outside' | 'invalid' {
  return state === 'missing' || state === 'outside' || state === 'invalid'
}

function brokenFileMessage(state: 'missing' | 'outside' | 'invalid', target: string | undefined): string {
  if (state === 'missing') return `链接指向的文件不在知识库里：${target}`
  if (state === 'outside') return '这个链接不在本次分享的范围内'
  return `链接不可用：${target}`
}

/** 文件 / 原件目标：不可用给提示；模板与下载地址新窗口打开；其余进预览 */
function fileAction(resolved: ResolvedLink, state: LinkState | undefined): FollowAction | null {
  if (isBroken(state)) return { type: 'error', message: brokenFileMessage(state, resolved.target) }
  if (resolved.download) return { type: 'openWindow', href: resolved.href }
  if (resolved.collection && resolved.target) {
    return { type: 'openAttachment', target: { collection: resolved.collection, path: resolved.target, fragment: resolved.fragment } }
  }
  return null
}

/**
 * 解析一次点击。
 * @param target 被点的元素（事件目标）
 * @param follow 这次点击是否「跟随链接」：只读时直接点，编辑时要按住 Ctrl / ⌘（否则是在编辑文字）
 */
export function resolveFollow(target: HTMLElement, services: TextServices, follow: boolean): FollowResult {
  if (!follow) return NOTHING
  const wiki = target.closest<HTMLElement>('.kb-wikilink')
  if (wiki) {
    const id = wiki.dataset.id ?? ''
    // Obsidian 风格的文件双链 `[[docs/规范.md]]`：按文件打开；只有 `ins_…` 才当笔记 id
    if (services.linkContext() && (/[\\/]/.test(id) || /\.[a-z0-9]{1,8}$/i.test(id))) {
      const ctx = services.linkContext()!
      // 文件双链按知识库根解析（Obsidian 习惯）；普通 Markdown 链接才按当前文件目录解析
      const resolved = resolveDocHref(id, { ...ctx, sourcePath: null })
      if (resolved.kind === 'file' || resolved.kind === 'raw') {
        const state = resolved.collection && resolved.target ? services.linkStates()[linkKey(resolved.collection, resolved.target)] : undefined
        return { preventDefault: true, action: fileAction(resolved, state) }
      }
      return { preventDefault: true, action: { type: 'error', message: resolved.reason ?? `打不开这个链接:${id}` } }
    }
    return { preventDefault: true, action: { type: 'openLink', id } }
  }

  const attach = target.closest<HTMLElement>('.kb-attach')
  const anchor = target.closest<HTMLAnchorElement>('a')
  if (!attach && !anchor) return NOTHING
  const href = anchor?.getAttribute('href') ?? ''
  const info = linkStateOf(href, services)
  if (info) {
    const { resolved, state } = info
    if (resolved.kind === 'note' && resolved.noteId) {
      if (isBroken(state)) {
        const message = state === 'missing' ? '链接指向的笔记不在知识库里' : state === 'outside' ? '这个链接不在本次分享的范围内' : '链接不可用'
        return { preventDefault: true, action: { type: 'error', message } }
      }
      return { preventDefault: true, action: { type: 'openLink', id: resolved.noteId } }
    }
    if (resolved.kind === 'file' || resolved.kind === 'raw') {
      return { preventDefault: true, action: fileAction(resolved, state) }
    }
    if (resolved.kind === 'absolute' || resolved.kind === 'invalid') {
      return { preventDefault: true, action: { type: 'error', message: resolved.reason ?? '这个链接打不开' } }
    }
  }
  const raw = parseRawUrl(href)
  if (raw) return { preventDefault: true, action: { type: 'openAttachment', target: raw } }
  // 只读时外链新窗口打开（编辑时按住 Ctrl 点外链交给浏览器默认行为，不额外处理）
  return NOTHING
}

/** 外链在只读状态下新窗口打开：单独判定，因为它依赖「只读」而不是 Ctrl */
export function resolveExternalOpen(target: HTMLElement, readonly: boolean): FollowResult {
  if (!readonly) return NOTHING
  const anchor = target.closest<HTMLAnchorElement>('a')
  const href = anchor?.getAttribute('href') ?? ''
  if (anchor && /^https?:/i.test(href)) return { preventDefault: true, action: { type: 'openWindow', href } }
  return NOTHING
}
