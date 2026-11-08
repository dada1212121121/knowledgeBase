import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import EditorHost from './EditorHost.vue'
import { createRoomStatusFeed } from '../collab/OfficeTransport'
import { resetSurfaceRegistry } from '../surfaces/registry'
import { resetBuiltinSurfaces } from '../surfaces/builtin'
import type { SessionTransport } from '../session/DocumentSession'
import type { EditorOpenRequest, EditorPermissions, Surface, SurfaceContext } from '../types'

/** 轮询等待：动态 import 的 chunk 解析时间不确定，固定次数 flush 会随机假红 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时')
}

const FULL: EditorPermissions = { read: true, write: true, comment: true, ai: true, export: true }

function makeRequest(overrides: Partial<EditorOpenRequest> = {}): EditorOpenRequest {
  return {
    fileId: 'note_1',
    collection: 'c1',
    format: 'md',
    source: { kind: 'text', text: '# 周报\n今天做了什么', name: '周报.md' },
    readonly: false,
    revision: 4,
    permissions: FULL,
    ...overrides,
  }
}

/** 最小可用 Surface：mount 时把上下文拿住，方便测试里远程驱动 dirty / selection */
function createFakeSurface(options: { failOnMount?: Error; words?: number } = {}) {
  let ctx: SurfaceContext | null = null
  const surface: Surface = {
    mount: async (_el, context) => {
      if (options.failOnMount) throw options.failOnMount
      ctx = context
    },
    unmount: vi.fn(),
    resize: vi.fn(),
    focus: vi.fn(),
    setReadonly: vi.fn(),
    command: vi.fn(async () => ({ ok: true })),
    query: vi.fn(async () => ({ words: options.words ?? 12 })),
    capture: () => ({ kind: 'text' }),
    restore: vi.fn(),
  }
  return {
    surface,
    context: () => ctx,
    markDirty: (value = true) => ctx?.onDirtyChange?.(value),
  }
}

function makeTransport(result = { ok: true, revision: 5, sha256: 'sha5' }) {
  const calls: unknown[] = []
  const transport: SessionTransport = {
    save: async (request) => {
      calls.push(request)
      return result
    },
  }
  return { transport, calls }
}

describe('EditorHost：会话 / 命令 / 状态栏串联', () => {
  it('73. 挂载后建立会话并渲染状态栏；字数由 Surface 上报', async () => {
    const fake = createFakeSurface({ words: 37 })
    const { transport } = makeTransport()
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest(), transport, loadSurface: async () => fake.surface },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="editor-status-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-status-count"]').text()).toBe('37 字')
    expect(wrapper.find('[data-testid="editor-surface-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-status-text"]').text()).toBe('已保存')

    wrapper.unmount()
  })

  it('74. Surface 置脏后顶栏与状态栏同步，Ctrl+⌘+S 发出真实保存请求', async () => {
    const fake = createFakeSurface()
    const { transport, calls } = makeTransport()
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest(), transport, loadSurface: async () => fake.surface },
      attachTo: document.body,
    })
    await flushPromises()

    fake.markDirty()
    await flushPromises()
    expect(wrapper.find('[data-testid="editor-status-text"]').text()).toBe('有未保存的改动')
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(true)
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([true])

    // 焦点在编辑器内部时才接管快捷键
    const stage = wrapper.find('[data-testid="editor-stage"]').element
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    stage.dispatchEvent(event)
    await flushPromises()

    expect(calls).toHaveLength(1)
    // 第三个参数是保存后少了的部件（Office 保存才有；这里的保存结果里没有）
    expect(wrapper.emitted('saved')?.[0]).toEqual([5, 'sha5', undefined])
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([false])
    expect(wrapper.find('[data-testid="editor-status-text"]').text()).toBe('已保存')

    wrapper.unmount()
  })

  it('74b. 保存结果里的 partsRemoved（文件里少了的部件）随 saved 事件交给外层，外层据此提醒用户', async () => {
    const fake = createFakeSurface()
    const { transport } = makeTransport({ ok: true, revision: 6, sha256: 'sha6', partsRemoved: ['word/media/a.png'] } as never)
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest(), transport, loadSurface: async () => fake.surface },
      attachTo: document.body,
    })
    await flushPromises()
    fake.markDirty()
    await flushPromises()
    const stage = wrapper.find('[data-testid="editor-stage"]').element
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('saved')?.[0]).toEqual([6, 'sha6', ['word/media/a.png']])
    wrapper.unmount()
  })

  it('74b. 协同房间不注册本地保存：Ctrl/⌘+S 不拿旧骨架覆盖正文', async () => {
    const fake = createFakeSurface()
    const { transport, calls } = makeTransport()
    const collabText = {
      toString: () => 'a,b\n1,2\n',
      observe: () => {},
      unobserve: () => {},
      insert: () => {},
      delete: () => {},
    }
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest({ collabText }), transport, loadSurface: async () => fake.surface },
      attachTo: document.body,
    })
    await flushPromises()

    fake.markDirty()
    await flushPromises()
    const stage = wrapper.find('[data-testid="editor-stage"]').element
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
    await flushPromises()

    expect(calls).toHaveLength(0)
    expect(wrapper.emitted('saved')).toBeUndefined()

    wrapper.unmount()
  })

  it('74c. Office 协同请求带房间状态来源：状态栏跟着房间走，右侧不再写死「正在连接协同…」', async () => {
    const fake = createFakeSurface()
    const room = createRoomStatusFeed(true)
    const wrapper = mount(EditorHost, {
      props: {
        request: makeRequest({
          fileId: 'xlsx_1',
          format: 'xlsx',
          source: { kind: 'bytes', name: '月报.xlsx', bytes: new Uint8Array([1]) },
          collab: { url: 'ws://x/api/v1/office/collab?doc=d', userName: '爱丽丝' },
          collabStatus: room.source,
        }),
        loadSurface: async () => fake.surface,
      },
    })
    await flushPromises()
    const text = () => wrapper.find('[data-testid="editor-status-text"]').text()
    const tone = () => wrapper.find('[data-testid="editor-status-bar"]').attributes('data-tone')

    expect(text()).toBe('正在连接协同…')
    // 引擎的连接状态依次推过来：状态栏每一步都对应，而且右侧的协同文案一直不出现
    const steps: Array<[string, boolean, string, string]> = [
      ['connected', false, '正在同步…', 'warning'],
      ['connected', true, '已同步', 'success'],
      ['disconnected', true, '离线，改动先留在本页', 'warning'],
      ['connecting', false, '正在连接协同…', 'warning'],
      ['connected', true, '已同步', 'success'],
    ]
    for (const [status, synced, want, wantTone] of steps) {
      room.update(status, synced)
      await flushPromises()
      expect(text()).toBe(want)
      expect(tone()).toBe(wantTone)
      expect(wrapper.find('[data-testid="editor-status-collab"]').exists()).toBe(false)
    }
    // 服务端主动结束后，引擎补发的断开不能把「协同已结束」改回「离线」
    room.close()
    room.update('disconnected', false)
    await flushPromises()
    expect(text()).toBe('协同已结束')
    expect(tone()).toBe('danger')
    expect(wrapper.text()).not.toContain('已保存')

    wrapper.unmount()
  })

  it('75. 加载器返回 null 时显示中性提示而不是错误边界（格式尚未接入的合法状态）', async () => {
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest(), loadSurface: async () => null },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="editor-status-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-fallback"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-surface-notice"]').text()).toContain('尚未接入')

    wrapper.unmount()
  })

  it('75a. 内置格式表不认识的扩展名（.cs）：声明 plainText 的整份文本按纯文本进代码面；没声明仍是「不支持」兜底', async () => {
    const unknown = { format: 'cs', source: { kind: 'text' as const, text: 'class A {}', name: 'A.cs' } }

    const fake = createFakeSurface()
    const kinds: string[] = []
    const loader = async (kind: string) => {
      kinds.push(kind)
      return fake.surface
    }
    const accepted = mount(EditorHost, {
      props: { request: makeRequest({ ...unknown, plainText: true }), transport: makeTransport().transport, loadSurface: loader },
    })
    await flushPromises()
    expect(kinds).toEqual(['code'])
    expect(accepted.attributes('data-surface-kind')).toBe('code')
    expect(accepted.find('[data-testid="editor-fallback"]').exists()).toBe(false)
    accepted.unmount()

    // 不声明 plainText（例如二进制）：不能被当成文本打开，维持原来的兜底
    const refused = mount(EditorHost, { props: { request: makeRequest(unknown), loadSurface: loader } })
    await flushPromises()
    expect(kinds).toEqual(['code'])
    expect(refused.attributes('data-surface-kind')).toBe('unsupported')
    expect(refused.find('[data-testid="editor-fallback"]').text()).toContain('暂不支持直接打开 .cs 格式')
    refused.unmount()

    // 声明了 plainText 但内容是字节（不是文本）：同样不进代码面
    const bytes = mount(EditorHost, {
      props: { request: makeRequest({ format: 'cs', plainText: true, source: { kind: 'bytes', bytes: new Uint8Array([1, 2]), name: 'A.cs' } }), loadSurface: loader },
    })
    await flushPromises()
    expect(bytes.attributes('data-surface-kind')).toBe('unsupported')
    bytes.unmount()
  })

  it('75b. 不传 loadSurface 时走内置注册表：Text Surface 真的打开笔记（已打通）', async () => {
    resetSurfaceRegistry()
    resetBuiltinSurfaces()
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest(), transport: makeTransport().transport },
    })
    // Surface 是动态 import：不止微任务，chunk 解析完才有实例
    await waitFor(() => wrapper.find('.kb-text-prose').exists())

    expect(wrapper.find('[data-testid="editor-surface-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-fallback"]').exists()).toBe(false)
    expect(wrapper.find('.kb-text-prose h1').text()).toBe('周报')
    // 字数走 Surface 的 wordCount 查询：8 = 「周报」(2) + 「今天做了什么」(6)
    expect(wrapper.find('[data-testid="editor-status-count"]').text()).toContain('8')
    expect(wrapper.find('.kb-editor-chrome-title').text()).toBe('周报.md')

    wrapper.unmount()
    resetSurfaceRegistry()
    resetBuiltinSurfaces()
  })

  it('76. Surface 挂载抛错时进入错误边界并带上原因，不白屏', async () => {
    const fake = createFakeSurface({ failOnMount: new Error('渲染内核初始化失败') })
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest(), transport: makeTransport().transport, loadSurface: async () => fake.surface },
    })
    await flushPromises()

    const fallback = wrapper.find('[data-testid="editor-fallback"]')
    expect(fallback.exists()).toBe(true)
    expect(fallback.text()).toContain('渲染内核初始化失败')
    // 回退原因要带上 surface_error 前缀，便于上层区分「格式不支持」与「渲染故障」
    await wrapper.find('[data-testid="editor-fallback-btn"]').trigger('click')
    expect(wrapper.emitted('fallback')?.[0]?.[0]).toContain('surface_error')

    wrapper.unmount()
  })

  it('77. 卸载时销毁会话：Registry 自建的会话不残留', async () => {
    const { SessionRegistry } = await import('../session')
    const registry = new SessionRegistry()
    const fake = createFakeSurface()
    const wrapper = mount(EditorHost, {
      props: {
        request: makeRequest(),
        registry,
        transport: makeTransport().transport,
        loadSurface: async () => fake.surface,
      },
    })
    await flushPromises()
    const session = registry.get('note_1')
    expect(session).not.toBeNull()

    wrapper.unmount()
    expect(session?.phase).toBe('destroyed')
  })

  it('78. 只读会话不渲染写按钮，写命令被守卫拒绝', async () => {
    const fake = createFakeSurface()
    const wrapper = mount(EditorHost, {
      props: {
        request: makeRequest({ readonly: true }),
        transport: makeTransport().transport,
        loadSurface: async () => fake.surface,
      },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-undo"]').exists()).toBe(false)
    const vm = wrapper.vm as unknown as {
      executeCommand: (cmd: { id: string; type: string; source: 'user' }) => Promise<{ ok: boolean }>
    }
    expect((await vm.executeCommand({ id: 'c', type: 'text.insert', source: 'user' })).ok).toBe(false)

    wrapper.unmount()
  })
})

describe('EditorHost：命令失败要让用户知道', () => {
  /** 让 Surface 的下一次命令返回指定结果，再模拟工具栏点击（EditorChrome 发 command 事件） */
  async function pressWith(result: { ok: boolean; reason?: string }) {
    const fake = createFakeSurface()
    ;(fake.surface.command as ReturnType<typeof vi.fn>).mockResolvedValue(result)
    const { transport } = makeTransport()
    const wrapper = mount(EditorHost, {
      props: { request: makeRequest(), transport, loadSurface: async () => fake.surface },
      attachTo: document.body,
    })
    await flushPromises()
    wrapper.findComponent({ name: 'EditorChrome' }).vm.$emit('command', 'file.print')
    await flushPromises()
    return { wrapper, fake }
  }

  it('失败且原因是中文：显示可关闭的提示，文档内容面仍在', async () => {
    const { wrapper } = await pressWith({ ok: false, reason: '浏览器拦截了打印窗口，请允许本站弹出窗口后再试' })
    const notice = wrapper.find('[data-testid="editor-command-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('拦截了打印窗口')
    expect(notice.attributes('role')).toBe('alert')
    // 非致命：内容面没有被藏掉，也没有触发 fallback
    expect(wrapper.find('[data-testid="editor-stage"]').isVisible()).toBe(true)
    expect(wrapper.emitted('fallback')).toBeUndefined()
    wrapper.unmount()
  })

  it('失败但原因是机器代码：不弹（不把 nothing_to_undo 之类展示给用户）', async () => {
    const { wrapper } = await pressWith({ ok: false, reason: 'nothing_to_undo' })
    expect(wrapper.find('[data-testid="editor-command-notice"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点「知道了」关闭', async () => {
    const { wrapper } = await pressWith({ ok: false, reason: '请先选中一张图片' })
    await wrapper.find('[data-testid="editor-command-notice-close"]').trigger('click')
    expect(wrapper.find('[data-testid="editor-command-notice"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('下一次命令成功：自动清掉上一条失败提示', async () => {
    const { wrapper, fake } = await pressWith({ ok: false, reason: '文档当前是只读的' })
    expect(wrapper.find('[data-testid="editor-command-notice"]').exists()).toBe(true)
    ;(fake.surface.command as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    wrapper.findComponent({ name: 'EditorChrome' }).vm.$emit('command', 'docx.bold')
    await flushPromises()
    expect(wrapper.find('[data-testid="editor-command-notice"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
