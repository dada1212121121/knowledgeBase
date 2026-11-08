// 文档链接体检:正文里的相对链接解析成 collection 内路径后,批量问后端「在不在」。
//
// 只做提示,不自动改正文、不自动猜同名文件;检查失败(旧服务、没有权限)时保持“未知”,
// 不能让一个可选的体检把正文渲染 / 编辑拦住。
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { extractDocLinksAsync } from '@/utils/markdownChunksAsync'
import {
  linkKey,
  noteLinkKey,
  resolvedLinkKey,
  resolveDocHref,
  type LinkCheckItem,
  type LinkContext,
  type LinkState,
} from '@/utils/links'

export interface UnsupportedLink {
  href: string
  line: number
  reason: string
}

export interface DocLinkReport {
  states: Record<string, LinkState>
  items: LinkCheckItem[]
  missing: LinkCheckItem[]
  outside: LinkCheckItem[]
  unsupported: UnsupportedLink[]
  checked: number
  /** 体检本身失败了(不是“文件不存在”):页面不显示缺失横幅。 */
  error: string
}

export function emptyLinkReport(): DocLinkReport {
  return { states: {}, items: [], missing: [], outside: [], unsupported: [], checked: 0, error: '' }
}

interface Options {
  /** 当前正文(Markdown)。 */
  source: () => string
  /** 当前文档上下文;没有 collection 就不体检。 */
  context: () => LinkContext | null
  /** 调 `check_links`;分享页传 access.call。第三个参数用于管理员只读请求头。 */
  call: (capability: string, args?: Record<string, unknown>, options?: { adminView?: string }) => Promise<unknown>
  /** 笔记 id(如果有;后端只用于展示,不参与路径解析)。 */
  noteId?: () => string | null | undefined
  /** 输入时防抖;预览可以给 0。 */
  delay?: number
  /** 分享页不体检笔记:笔记不在分享 root 里,查了反而会泄露目标是否存在。 */
  checkNotes?: boolean
}

interface CheckResponse {
  items?: Array<{
    kind?: 'file' | 'note'
    collection?: string
    path?: string
    note_id?: string
    state?: LinkState
    reason?: string
    size?: number | null
    name?: string | null
  }>
}

export function useDocLinks(options: Options): { report: Ref<DocLinkReport>; reload: () => void } {
  const report = ref<DocLinkReport>(emptyLinkReport())
  let timer = 0
  let sequence = 0

  async function refresh(): Promise<void> {
    // 先占序号:正文改成「没有链接」时也要让在途请求作废,否则旧结果会覆盖新状态
    const current = ++sequence
    const source = options.source()
    const ctx = options.context()
    if (!source || !ctx) {
      report.value = emptyLinkReport()
      return
    }
    // 大文档的解析在 Worker 里做（主线程再解析一遍 200 KB 正文是一条 60 ms 级的长任务）；小文档同步算,不多一次异步往返
    const links = await extractDocLinksAsync(source)
    // 等解析的这段时间里正文又变了：这一轮作废（新的一轮已经占了序号）
    if (current !== sequence) return
    const states: Record<string, LinkState> = {}
    const unsupported: UnsupportedLink[] = []
    const files = new Map<string, { collection: string; path: string; href: string }>()
    const notes = new Map<string, { note_id: string; href: string }>()
    for (const link of links) {
      // 双链 `[[path]]` 按 collection 根解析;普通链接按当前文件目录
      const value = resolveDocHref(link.href, link.fromRoot ? { ...ctx, sourcePath: null } : ctx)
      if (value.kind === 'note' && value.noteId) {
        if (options.checkNotes !== false) notes.set(value.noteId, { note_id: value.noteId, href: link.href })
      } else if (value.kind === 'file' || value.kind === 'raw') {
        if (value.collection && value.target) {
          // 记住正文里的原始写法:页面要替换坏链接时,得知道该改哪一段 href
          files.set(linkKey(value.collection, value.target), { collection: value.collection, path: value.target, href: link.href })
        }
      } else if (value.kind === 'absolute' || value.kind === 'invalid') {
        // Markdown 解析器会把反斜杠 / 中文编码;清单里给人看的是解码后的原文
        let href = link.href
        try {
          href = decodeURIComponent(href)
        } catch {
          /* 保留原样 */
        }
        unsupported.push({ href, line: link.line, reason: value.reason ?? '不能打开' })
      }
    }
    // 请求体不能带 href(那是给页面回写用的内部字段),只发目标身份
    const targets = [
      ...[...files.values()].map(({ collection, path }) => ({ collection, path })),
      ...[...notes.values()].map(({ note_id }) => ({ note_id })),
    ]
    if (!targets.length) {
      report.value = {
        ...emptyLinkReport(),
        unsupported,
        checked: 0,
      }
      return
    }
    try {
      const request = { targets }
      const response = (ctx.adminView
        ? await options.call('check_links', request, { adminView: ctx.adminView })
        : await options.call('check_links', request)) as CheckResponse
      if (current !== sequence) return
      const items: LinkCheckItem[] = []
      for (const raw of response?.items ?? []) {
        const isNote = raw.kind === 'note' || !!raw.note_id
        const noteId = raw.note_id
        if (!isNote && (!raw.collection || !raw.path)) continue
        if (isNote && !noteId) continue
        const state: LinkState = raw.state ?? 'unknown'
        const item: LinkCheckItem = {
          kind: isNote ? 'note' : 'file',
          collection: raw.collection ?? '',
          path: raw.path ?? '',
          noteId,
          // 后端只回目标,不回原文;这里用请求前的映射补回,供「从库中选择」精确替换
          href: isNote ? notes.get(noteId!)?.href : files.get(linkKey(raw.collection ?? '', raw.path ?? ''))?.href,
          state,
          reason: raw.reason,
          size: raw.size,
          name: raw.name,
        }
        items.push(item)
        states[isNote ? noteLinkKey(noteId!) : linkKey(item.collection, item.path)] = state
      }
      // 后端没返回的目标按“未知”处理,不误报缺失
      for (const target of files.values()) {
        const key = linkKey(target.collection, target.path)
        if (!states[key]) states[key] = 'unknown'
      }
      for (const id of notes.keys()) {
        const key = noteLinkKey(id)
        if (!states[key]) states[key] = 'unknown'
      }
      report.value = {
        states,
        items,
        missing: items.filter((item) => item.state === 'missing'),
        outside: items.filter((item) => item.state === 'outside'),
        unsupported,
        checked: targets.length,
        error: '',
      }
    } catch (error) {
      if (current !== sequence) return
      report.value = {
        ...emptyLinkReport(),
        unsupported,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  function schedule(): void {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void refresh(), options.delay ?? 180)
  }

  watch(
    [() => options.source(), () => options.context(), () => options.noteId?.()],
    schedule,
    { immediate: true },
  )
  onScopeDispose(() => window.clearTimeout(timer))

  return { report, reload: schedule }
}

/** 供页面显示:笔记项没有 path,退回标题 / id。 */
export function linkItemLabel(item: LinkCheckItem): string {
  if (item.kind === 'note') return item.name || item.noteId || '笔记'
  return item.path
}

/** 供页面删除 / 复制:笔记用 note id,文件用 collection/path。 */
export function linkItemKey(item: LinkCheckItem): string {
  return item.kind === 'note' && item.noteId ? noteLinkKey(item.noteId) : linkKey(item.collection, item.path)
}

/** 解析结果对应的体检键;没有目标返回 null。 */
export function linkStateOf(link: ReturnType<typeof resolveDocHref>, states?: Record<string, LinkState>): LinkState | undefined {
  const key = resolvedLinkKey(link)
  return key ? states?.[key] : undefined
}
