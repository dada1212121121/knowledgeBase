/**
 * 文本面单测夹具：假的页面桥 + 挂载器。仅供 *.spec.ts 引用，不进生产包。
 *
 * 页面桥（TextHostBridge）是内容面与页面之间的唯一通道，所以测试里把它换成可观测的假实现：
 * 记录「面板被请求了几次」「哪些文件交给了上传」「链接点击走向了哪里」，
 * 这样每条用户路径的断言都落在可见的结果上，而不是内部状态。
 */
import { vi } from 'vitest'
import { TextSurface } from './TextSurface'
import type { DocumentSession, EditorSource, SurfaceContext, TextHostBridge, TextPanelName, TextServices } from '../../types'
import type { LinkContext, LinkState } from '@/utils/links'

export interface FakeBridge extends TextHostBridge {
  panels: { panel: TextPanelName; from?: number }[]
  uploads: { files: File[]; pos?: number }[]
  notices: string[]
  opened: string[]
  attachments: { collection: string; path: string; fragment?: string }[]
  errors: string[]
  /** 可在用例里改：页面当前的链接体检结果 / 上下文 */
  states: Record<string, LinkState>
  context: LinkContext | null
}

export function makeBridge(overrides: Partial<TextServices> = {}): FakeBridge {
  const bridge: FakeBridge = {
    panels: [],
    uploads: [],
    notices: [],
    opened: [],
    attachments: [],
    errors: [],
    states: {},
    context: {
      collection: 'docs',
      sourcePath: 'guide/a.md',
      rawUrl: (collection, path) => `/raw/${collection}/${path}`,
    },
    services: {
      collection: () => 'docs',
      sourcePath: () => 'guide/a.md',
      adminView: () => '',
      linkContext: () => bridge.context,
      linkStates: () => bridge.states,
      fileCollections: () => [{ name: 'docs' }],
      openLink: (id) => bridge.opened.push(id),
      openAttachment: (target) => bridge.attachments.push(target),
      linkError: (message) => bridge.errors.push(message),
      ...overrides,
    },
    openPanel: (panel, options) => bridge.panels.push({ panel, from: options?.from }),
    uploadFiles: (files, pos) => bridge.uploads.push({ files, pos }),
    notify: (message) => bridge.notices.push(message),
  }
  return bridge
}

export interface Mounted {
  surface: TextSurface
  el: HTMLElement
  bridge: FakeBridge
  /** 会话保存时取到的正文 */
  snapshot: () => EditorSource | null
  dirty: boolean[]
  /** ProseMirror 视图（私有字段，测试里直接取） */
  view: import('prosemirror-view').EditorView
}

const mounted: TextSurface[] = []

export async function mountText(
  text: string,
  options: { readonly?: boolean; bridge?: FakeBridge | null; surface?: TextSurface; ctx?: Partial<SurfaceContext> } = {},
): Promise<Mounted> {
  let provider: (() => EditorSource | null) | null = null
  const dirty: boolean[] = []
  const session = {
    setSnapshotProvider(p: (() => EditorSource | null) | null) {
      provider = p
    },
  } as unknown as DocumentSession
  const el = document.createElement('div')
  document.body.append(el)
  const bridge = options.bridge === null ? undefined : (options.bridge ?? makeBridge())
  const ctx: SurfaceContext = {
    session,
    document: { kind: 'text', format: 'md', revision: 1, payload: { kind: 'text', text, name: 'note.md' } },
    permissions: { read: true, write: !options.readonly, comment: false, ai: false, export: true },
    readonly: options.readonly ?? false,
    textHost: bridge,
    onDirtyChange: (value) => dirty.push(value),
    ...options.ctx,
  }
  const surface = options.surface ?? new TextSurface()
  mounted.push(surface)
  await surface.mount(el, ctx)
  return {
    surface,
    el,
    bridge: bridge as FakeBridge,
    snapshot: () => (provider ? provider() : null),
    dirty,
    view: (surface as unknown as { view: Mounted['view'] }).view,
  }
}

export function cleanupText(): void {
  for (const surface of mounted) surface.unmount()
  mounted.length = 0
  document.body.innerHTML = ''
  vi.useRealTimers()
}

/** 在 view 的 DOM 上派发一次点击；返回事件（可看 defaultPrevented） */
export function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

/** 造一个带文件的 paste / drop 事件（jsdom 没有 DataTransfer，手工塞一个够用的） */
export function fileEvent(type: 'paste' | 'drop', files: File[], extra: { text?: string; html?: string } = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const data = {
    files,
    items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
    types: ['Files'],
    getData: (kind: string) => (kind === 'text/plain' ? (extra.text ?? '') : kind === 'text/html' ? (extra.html ?? '') : ''),
  }
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data })
  return event
}
