// 办公文档在线编辑（外壳）：编辑权与心跳、协同准备、无损预检的结论展示、保存通道的接线、项目目录文件不让改。
// 起旧的 React 编辑岛已删除，这里原来用「假岛」守的那些链路改用「假外壳 + 假内容面」守同一批行为：
// 外壳（EditorHost）和内容面都是桩，只验证 OfficeEditor 这一圈怎么把请求、保存通道、脏标记和提示接起来。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

const roundtripCheck = vi.fn()
const acquireLock = vi.fn()
const releaseLock = vi.fn()
const prepareOfficeSession = vi.fn()
const fetchOfficeBase = vi.fn()
const fetchOfficeSeed = vi.fn()
vi.mock('@/api/officeEdit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/officeEdit')>()),
  roundtripCheck: (...args: unknown[]) => roundtripCheck(...args),
  acquireLock: (...args: unknown[]) => acquireLock(...args),
  releaseLock: (...args: unknown[]) => releaseLock(...args),
  prepareOfficeSession: (...args: unknown[]) => prepareOfficeSession(...args),
  fetchOfficeBase: (...args: unknown[]) => fetchOfficeBase(...args),
  fetchOfficeSeed: (...args: unknown[]) => fetchOfficeSeed(...args),
  newSessionId: () => 'tab-test',
}))

/** 假外壳：记下每一次被挂载时收到的 props / 事件处理器，卸载时计数 */
interface HostCall {
  props: { request: Record<string, unknown> & { readonly: boolean; collab?: { url: string; userName: string; initialUpdate?: Uint8Array }; source: { bytes: Uint8Array } }; transport?: unknown; toolbarProfile?: string; loadSurface?: (kind: string, format?: string) => Promise<unknown> }
  attrs: { onSaved?: (revision: number, sha256: string, partsRemoved?: string[]) => void; onDirty?: (value: boolean) => void; onClose?: () => void }
}
const shell = vi.hoisted(() => ({ calls: [] as unknown[], unmounted: 0, order: [] as string[] }))
vi.mock('@/editor/host/EditorHost.vue', async () => {
  const { defineComponent, h, onBeforeUnmount } = await import('vue')
  return {
    default: defineComponent({
      props: { request: { type: Object, required: true }, transport: { type: Object, default: undefined }, loadSurface: { type: Function, default: undefined }, toolbarProfile: { type: String, default: undefined } },
      setup(props, { attrs }) {
        shell.calls.push({ props, attrs })
        shell.order.push('host')
        onBeforeUnmount(() => (shell.unmounted += 1))
        return () => h('div', { 'data-testid': 'fake-host' })
      },
    }),
  }
})
const hostCalls = () => shell.calls as HostCall[]

/** 假内容面与保存通道：xlsx / docx 各一对；保存通道工厂记下 OfficeEditor 交给它的参数 */
type TransportArgs = { collection: string; path: string; expectedSha256: () => string; sessionId: string; maxBytes: number; label: string }
const surfaceOptions: { xlsx?: unknown; docx?: unknown } = {}
const transportArgs: TransportArgs[] = []
vi.mock('@/editor/surfaces/grid/xlsxSurface', () => ({
  createXlsxEditSurface: (options?: unknown) => {
    surfaceOptions.xlsx = options
    return {}
  },
}))
vi.mock('@/editor/codecs/xlsx', () => ({
  createXlsxSaveTransport: (args: TransportArgs) => {
    transportArgs.push(args)
    shell.order.push('transport')
    return { save: async () => ({ ok: true }) }
  },
}))
/** 假 Word 编辑面：记下 OfficeEditor 交给它的选项（含 onEngineReady），并让「放开只读」可观察 */
const docxSurface = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, readonlyCalls: [] as boolean[] }))
vi.mock('@/editor/surfaces/page/edit/docxEditSurface', () => ({
  createDocxEditSurface: (options: Record<string, unknown>) => {
    docxSurface.options.push(options)
    return { setReadonly: (value: boolean) => docxSurface.readonlyCalls.push(value) }
  },
}))
/** 假 Word 引擎：预热与无损探针都只记账；真引擎在 e2e（docx-lossless）里验证 */
const docxEngine = vi.hoisted(() => ({ prefetch: 0, probes: [] as Uint8Array[], signals: [] as Array<AbortSignal | undefined> }))
vi.mock('@/editor/engines/docx', () => ({
  prefetchDocxEngine: () => {
    docxEngine.prefetch += 1
    return true
  },
  probeDocxSave: async (bytes: Uint8Array, _marker: string, signal?: AbortSignal) => {
    docxEngine.probes.push(bytes)
    docxEngine.signals.push(signal)
    return new Uint8Array([6, 6])
  },
}))
const wasmPrefetch = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/editor/engines/docxWasm', () => ({
  prefetchDocxWasm: () => {
    wasmPrefetch.calls += 1
  },
}))
/** 无损判定本身（缓存 + 探针 + 服务端 + 清点）有自己的单测；这里只控制它的结论与时机 */
const verdictControl = vi.hoisted(() => ({ cached: null as unknown, pending: [] as Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; input: Record<string, unknown> }> }))
vi.mock('@/editor/codecs/docxRoundtrip', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/editor/codecs/docxRoundtrip')>()),
  defaultRoundtripCache: () => ({ get: () => verdictControl.cached, set: () => undefined }),
  roundtripVerdict: (input: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      verdictControl.pending.push({ resolve, reject, input })
    }),
}))
vi.mock('@/editor/codecs/docx', () => ({ createDocxSaveTransport: () => ({ save: async () => ({ ok: true }) }) }))
vi.mock('@/editor/surfaces/page/edit/docx-collab', () => ({
  createDocxCollabOptions: (join: unknown) => {
    surfaceOptions.docx = join
    return { join }
  },
}))

/** 假 PowerPoint 引擎：只关心「不改直接保存」的预检和放开只读 */
const pptx = vi.hoisted(() => ({ backends: [] as Array<{ readonlyCalls: boolean[]; disposed: number }> }))
vi.mock('@/editor/engines/pptxEdit', () => ({
  warmPptxEdit: () => undefined,
  openPptxEdit: async () => {
    const state = { readonlyCalls: [] as boolean[], disposed: 0 }
    pptx.backends.push(state)
    return {
      save: async () => new Uint8Array([4, 4]),
      setReadonly: (value: boolean) => state.readonlyCalls.push(value),
      dispose: async () => {
        state.disposed += 1
      },
      onFailure: () => undefined,
      recover: async () => null,
    }
  },
}))
vi.mock('@/editor/surfaces/slide/edit-surface', () => ({ createPptxEditSurface: () => ({}) }))
vi.mock('@/editor/codecs/pptx', () => ({ createPptxSaveTransport: () => ({ save: async () => ({ ok: true }) }) }))

import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '@/stores/session'
import OfficeEditor from './OfficeEditor.vue'

const SHA = 'a'.repeat(64)
const NEW_SHA = 'b'.repeat(64)
const GRANTED = { held: true, ttl_secs: 45, took_over_from: null }
const LOSSLESS = { valid: true, reason: null, lossless: true, changed_parts: [], removed_parts: [], added_parts: [], text_equal: true }

let wrapper: VueWrapper | null = null
const find = (id: string) => wrapper!.find(`[data-testid="${id}"]`)

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitFor 超时')
}

/** 打开一份 xlsx（默认）并等到外壳挂上；`mounted: false` 用于预期根本不会挂外壳的用例 */
async function open(origin = 'upload', options: { path?: string; mounted?: boolean } = {}) {
  callCapability.mockResolvedValue({ sha256: SHA, origin, max_replace_bytes: 64 * 1024 * 1024 })
  wrapper = mount(OfficeEditor, { props: { collection: '_global', path: options.path ?? '报表/月报.xlsx' }, attachTo: document.body })
  if (options.mounted === false) await flushPromises()
  else await waitFor(() => hostCalls().length > 0)
  await flushPromises()
}
const lastHost = () => hostCalls().at(-1)!

beforeEach(() => {
  setActivePinia(createPinia())
  // 登录用户:协同房间的键要用他的知识库 id
  useSessionStore().$patch({ user: { id: 'usr_a', username: 'alice', display_name: '爱丽丝', space_id: 'sp_alice' } as never })
  // 默认:服务端说只能单人编辑(下面的老用例都是单人编辑的行为);协同的用例自己改
  prepareOfficeSession.mockReset().mockResolvedValue({ mode: 'single', reason: '' })
  fetchOfficeBase.mockReset().mockResolvedValue(new Uint8Array([7, 7, 7]))
  fetchOfficeSeed.mockReset().mockResolvedValue(new Uint8Array([5, 5]))
  callCapability.mockReset()
  acquireLock.mockReset().mockResolvedValue(GRANTED)
  releaseLock.mockReset().mockResolvedValue(undefined)
  roundtripCheck.mockReset().mockResolvedValue(LOSSLESS)
  shell.calls.length = 0
  shell.order.length = 0
  shell.unmounted = 0
  transportArgs.length = 0
  surfaceOptions.xlsx = undefined
  surfaceOptions.docx = undefined
  pptx.backends.length = 0
  docxSurface.options.length = 0
  docxSurface.readonlyCalls.length = 0
  docxEngine.prefetch = 0
  docxEngine.probes.length = 0
  docxEngine.signals.length = 0
  wasmPrefetch.calls = 0
  verdictControl.cached = null
  verdictControl.pending.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 })))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

describe('OfficeEditor：Excel 单人编辑', () => {
  it('打开：问文件信息、申请编辑权、读原件字节，再挂外壳；请求可写、带单人保存通道，不在浏览器里做无损预检', async () => {
    await open()
    expect(callCapability).toHaveBeenCalledWith('file_info', { collection: '_global', path: '报表/月报.xlsx' })
    expect(hostCalls()).toHaveLength(1)
    expect(lastHost().props.request.readonly).toBe(false)
    expect([...lastHost().props.request.source.bytes]).toEqual([9, 9, 9])
    expect(lastHost().props.transport).toBeTruthy()
    // Excel 的无损由服务端替换文件时整包检查，浏览器端不做预检（Word / PowerPoint 的预检见下面）
    expect(roundtripCheck).not.toHaveBeenCalled()
    expect(find('office-veil').exists()).toBe(false)
    expect(find('office-concern').exists()).toBe(false)
    expect(find('office-readonly').exists()).toBe(false)
  })

  it('保存通道带着打开时的哈希、窗口编号和上限；保存成功后换成新哈希，清掉脏标记并向上通知', async () => {
    await open()
    const args = transportArgs[0]!
    expect(args).toMatchObject({ collection: '_global', path: '报表/月报.xlsx', sessionId: 'tab-test', maxBytes: 64 * 1024 * 1024, label: '月报.xlsx' })
    expect(args.expectedSha256()).toBe(SHA)

    lastHost().attrs.onDirty?.(true)
    await flushPromises()
    expect(find('office-dirty').exists()).toBe(true)
    expect((wrapper!.vm as unknown as { dirty: boolean }).dirty).toBe(true)
    expect(find('office-close').text()).toBe('不保存,关闭')

    lastHost().attrs.onSaved?.(2, NEW_SHA)
    await flushPromises()
    expect(wrapper!.emitted('saved')).toHaveLength(1)
    expect(find('office-dirty').exists()).toBe(false)
    // 再保存一次：通道现读哈希，带的是上一次保存后的新哈希
    expect(args.expectedSha256()).toBe(NEW_SHA)
  })

  it('打开阶段不算用户的改动：没有外壳通知就不脏', async () => {
    await open()
    expect(find('office-dirty').exists()).toBe(false)
    expect((wrapper!.vm as unknown as { dirty: boolean }).dirty).toBe(false)
    expect(find('office-close').text()).toBe('完成')
  })

  it('保存后文件里少了部件:提醒用户并说明怎么恢复;下一次保存没少就撤掉提醒', async () => {
    await open()
    lastHost().attrs.onSaved?.(2, NEW_SHA, ['word/media/a.png', 'word/media/b.png', 'word/media/c.png', 'word/media/d.png'])
    await flushPromises()
    expect(find('office-notice').text()).toContain('少了 4 个部件')
    expect(find('office-notice').text()).toContain('word/media/a.png')
    expect(find('office-notice').text()).toContain(' 等')
    expect(find('office-notice').text()).toContain('版本历史')

    lastHost().attrs.onSaved?.(3, 'c'.repeat(64), [])
    await flushPromises()
    expect(find('office-notice').exists()).toBe(false)
  })

  it('外壳的「关闭」交还给上层', async () => {
    await open()
    lastHost().attrs.onClose?.()
    expect(wrapper!.emitted('close')).toHaveLength(1)
    await find('office-close').trigger('click')
    expect(wrapper!.emitted('close')).toHaveLength(2)
  })

  it('项目目录里的文件不让改，也不去下载、不挂外壳、不申请编辑权', async () => {
    await open('project', { mounted: false })
    expect(hostCalls()).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(acquireLock).not.toHaveBeenCalled()
    expect(find('office-error').text()).toContain('项目目录')
  })

  it('读取原文件失败时报错,点重试能重新打开', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await open('upload', { mounted: false })
    expect(find('office-error').text()).toContain('500')
    expect(hostCalls()).toHaveLength(0)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })))
    const retry = wrapper!.findAll('button').find((button) => button.text() === '重试')
    expect(retry).toBeTruthy()
    await retry!.trigger('click')
    await waitFor(() => hostCalls().length === 1)
    expect(find('office-error').exists()).toBe(false)
    expect(find('office-veil').exists()).toBe(false)
  })

  it('组件卸载时拆掉外壳（释放引擎与房间连接）', async () => {
    await open()
    wrapper!.unmount()
    wrapper = null
    expect(shell.unmounted).toBe(1)
  })
})

describe('OfficeEditor：PowerPoint 的无损预检', () => {
  const openPptx = async () => {
    await open('upload', { path: '汇报/季度.pptx' })
    // 画面先以只读出来，预检在后台做；等预检有结论
    await waitFor(() => !find('office-checking').exists())
  }

  it('预检无损：放开编辑（先只读打开，再放开）', async () => {
    await openPptx()
    expect(roundtripCheck).toHaveBeenCalledWith('_global', '汇报/季度.pptx', new Uint8Array([4, 4]))
    expect(pptx.backends[0]!.readonlyCalls).toEqual([false])
    expect(find('office-readonly').exists()).toBe(false)
    expect(find('office-concern').exists()).toBe(false)
  })

  it('不无损但文字没变:只读,说明哪些部件会变,用户确认「仍然编辑」后才放开', async () => {
    roundtripCheck.mockResolvedValue({ ...LOSSLESS, lossless: false, changed_parts: ['ppt/theme/theme1.xml'] })
    await openPptx()
    expect(pptx.backends[0]!.readonlyCalls).toEqual([])
    expect(find('office-readonly').exists()).toBe(true)
    expect(find('office-concern').text()).toContain('ppt/theme/theme1.xml')
    expect(find('office-concern').text()).toContain('文字内容不会变')

    await find('office-force').trigger('click')
    expect(pptx.backends[0]!.readonlyCalls).toEqual([false])
    expect(find('office-force').exists()).toBe(false)
    expect(find('office-readonly').exists()).toBe(false)
  })

  it('文字都对不上或包不完整:只读,而且没有「仍然编辑」', async () => {
    roundtripCheck.mockResolvedValue({ ...LOSSLESS, lossless: false, text_equal: false, changed_parts: ['ppt/slides/slide1.xml'] })
    await openPptx()
    expect(find('office-concern').text()).toContain('不能在线编辑')
    expect(find('office-force').exists()).toBe(false)

    wrapper!.unmount()
    shell.calls.length = 0
    roundtripCheck.mockResolvedValue({ ...LOSSLESS, valid: false, lossless: false, reason: 'ppt/media/a.png 不在包里', removed_parts: ['ppt/media/a.png'], text_equal: false })
    await openPptx()
    expect(find('office-concern').text()).toContain('ppt/media/a.png 不在包里')
    expect(find('office-force').exists()).toBe(false)
    expect(pptx.backends.every((backend) => backend.readonlyCalls.length === 0)).toBe(true)
  })

  it('预检本身失败（网络 / 服务端）：保持只读并说明，不能在没验证的情况下放开编辑', async () => {
    roundtripCheck.mockRejectedValue(new Error('网络断了'))
    await openPptx()
    expect(find('office-error').text()).toContain('已保持只读')
    expect(find('office-readonly').exists()).toBe(true)
    expect(pptx.backends[0]!.readonlyCalls).toEqual([])
  })
})

describe('OfficeEditor：编辑权与心跳', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }))
  afterEach(() => vi.useRealTimers())
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  afterEach(() => setHidden(false))

  it('打开时先申请编辑权(在读文件、挂外壳之前),之后每 ttl/3 秒一次心跳,用同一个窗口编号', async () => {
    acquireLock.mockImplementation(async () => {
      shell.order.push('lock')
      return GRANTED
    })
    await open()
    expect(acquireLock).toHaveBeenNthCalledWith(1, '_global', '报表/月报.xlsx', 'tab-test', false)
    expect(shell.order.indexOf('lock')).toBeLessThan(shell.order.indexOf('host'))
    expect(acquireLock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(acquireLock).toHaveBeenCalledTimes(2)
    expect(acquireLock).toHaveBeenLastCalledWith('_global', '报表/月报.xlsx', 'tab-test')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(acquireLock).toHaveBeenCalledTimes(4)
    expect(find('office-lost').exists()).toBe(false)
  })

  it('标签页隐藏时不发心跳,回来立刻补一次并继续', async () => {
    await open()
    setHidden(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(acquireLock).toHaveBeenCalledTimes(1) // 隐藏期间一次都没发
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(acquireLock).toHaveBeenCalledTimes(2) // 回来立刻补一次
    await vi.advanceTimersByTimeAsync(15_000)
    expect(acquireLock).toHaveBeenCalledTimes(3) // 然后恢复节奏
  })

  it('别人持有着:只读查看,说清楚是谁、多久之前还有动静;不做无损检查、没有保存通道、不发心跳', async () => {
    acquireLock.mockResolvedValue({ held: false, ttl_secs: 45, same_user: false, holder: { actor: '李四', session: 'tab-x', since_ms: 1, idle_secs: 12 } })
    await open()
    expect(lastHost().props.request.readonly).toBe(true)
    expect(lastHost().props.transport).toBeUndefined()
    expect(find('office-locked').text()).toContain('李四正在编辑这份文档(最近 12 秒前还有动静)')
    expect(find('office-readonly').exists()).toBe(true)
    expect(roundtripCheck).not.toHaveBeenCalled()
    expect(find('office-veil').exists()).toBe(false)
    expect(find('office-force').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(acquireLock).toHaveBeenCalledTimes(1) // 没拿到就不续
    wrapper!.unmount()
    wrapper = null
    expect(releaseLock).not.toHaveBeenCalled() // 没持有过,不能替别人交还
  })

  it('持有者是自己的另一个窗口:用「你在另一个窗口里」', async () => {
    acquireLock.mockResolvedValue({ held: false, ttl_secs: 45, same_user: true, holder: { actor: 'alice', session: 'tab-x', since_ms: 1, idle_secs: 3 } })
    await open()
    expect(find('office-locked').text()).toContain('你在另一个窗口里正在编辑这份文档')
  })

  it('重新检查:对方已经走了就能编辑;「接手」要先确认,确认后带 take_over 重新打开', async () => {
    acquireLock.mockResolvedValueOnce({ held: false, ttl_secs: 45, same_user: false, holder: { actor: '李四', session: 'tab-x', since_ms: 1, idle_secs: 40 } })
    await open()
    expect(find('office-takeover-confirm').exists()).toBe(false)
    // 对方走了:重新检查就拿到了,并且重新读最新的文件、挂新的外壳（旧的先拆掉）
    await find('office-recheck').trigger('click')
    await waitFor(() => hostCalls().length === 2)
    expect(find('office-locked').exists()).toBe(false)
    expect(shell.unmounted).toBe(1)
    expect(hostCalls()[1]!.props.request.readonly).toBe(false)
    wrapper!.unmount()
    wrapper = null

    // 接手
    acquireLock.mockReset().mockResolvedValueOnce({ held: false, ttl_secs: 45, same_user: false, holder: { actor: '王五', session: 'tab-y', since_ms: 1, idle_secs: 2 } }).mockResolvedValue({ ...GRANTED, took_over_from: { actor: '王五', session: 'tab-y', since_ms: 1, idle_secs: 2 } })
    await open()
    await find('office-takeover').trigger('click')
    expect(find('office-locked').text()).toContain('对方没保存的改动会丢')
    expect(acquireLock).toHaveBeenCalledTimes(1) // 还没确认,没有动作
    const before = hostCalls().length
    await find('office-takeover-confirm').trigger('click')
    await waitFor(() => hostCalls().length > before)
    expect(acquireLock).toHaveBeenLastCalledWith('_global', '报表/月报.xlsx', 'tab-test', true)
    expect(find('office-locked').exists()).toBe(false)
    expect(lastHost().props.request.readonly).toBe(false)
  })

  it('心跳发现编辑权被别人接手了:显示只读状态与原因,不再续约,可以重新打开', async () => {
    await open()
    lastHost().attrs.onDirty?.(true)
    await flushPromises()
    expect(find('office-dirty').exists()).toBe(true)
    acquireLock.mockResolvedValueOnce({ held: false, ttl_secs: 45, same_user: false, holder: { actor: '李四', session: 'tab-x', since_ms: 1, idle_secs: 0 } })
    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    expect(find('office-readonly').exists()).toBe(true)
    expect(find('office-lost').text()).toContain('李四接手了这份文档的编辑')
    expect(find('office-lost').text()).toContain('没保存的改动不会被保存')
    expect(find('office-force').exists()).toBe(false)
    const callsAfterLoss = acquireLock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(acquireLock.mock.calls.length).toBe(callsAfterLoss) // 丢了就不再续
    wrapper!.unmount()
    wrapper = null
    expect(releaseLock).not.toHaveBeenCalled() // 已经不是持有者,不去交还别人的
  })

  it('心跳连着两次失败提醒与服务器断了联系,恢复后自动撤掉;单次失败不吓人', async () => {
    await open()
    acquireLock.mockRejectedValueOnce(new Error('网络断了'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(find('office-offline').exists()).toBe(false)
    acquireLock.mockRejectedValueOnce(new Error('网络断了'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(find('office-offline').exists()).toBe(true)
    expect(find('office-offline').text()).toContain('45 秒')
    await vi.advanceTimersByTimeAsync(15_000) // mock 默认又成功了
    expect(find('office-offline').exists()).toBe(false)
    expect(find('office-lost').exists()).toBe(false)
  })

  it('关掉编辑器就交还编辑权,带窗口编号', async () => {
    await open()
    wrapper!.unmount()
    wrapper = null
    expect(releaseLock).toHaveBeenCalledWith('_global', '报表/月报.xlsx', 'tab-test')
  })

  it('关页面(pagehide)时也交还', async () => {
    await open()
    window.dispatchEvent(new Event('pagehide'))
    expect(releaseLock).toHaveBeenCalledWith('_global', '报表/月报.xlsx', 'tab-test')
  })

  it('项目目录里的文件根本不申请编辑权', async () => {
    await open('project', { mounted: false })
    expect(acquireLock).not.toHaveBeenCalled()
  })
})

describe('OfficeEditor：多人协同', () => {
  const COLLAB = { mode: 'collab', format: 'xlsx', base_sha: 'b'.repeat(64), size: 3, writable: true, room_writable: true, lossless: true, forceable: false, report: null }
  type EngineCollab = { onStatus: (s: unknown) => void; onClosed: (code: number, reason: string) => void }
  /** 引擎拿到的协同配置：onStatus / onClosed 就是引擎回调 OfficeEditor 的入口（外壳加载内容面时才创建，所以要先替外壳加载一次） */
  const engine = () => surfaceOptions.xlsx as EngineCollab
  const loadXlsxSurface = async () => {
    await lastHost().props.loadSurface?.('grid', 'xlsx')
    await flushPromises()
  }

  it('能协同:从房间底稿打开、连上房间;不申请编辑权、不做浏览器端的无损检查、没有整包保存通道', async () => {
    prepareOfficeSession.mockResolvedValue(COLLAB)
    await open()
    const docKey = 'doc:sp_alice/_global/f/%E6%8A%A5%E8%A1%A8/%E6%9C%88%E6%8A%A5.xlsx'
    expect(prepareOfficeSession).toHaveBeenCalledWith(docKey, false)
    expect(fetchOfficeBase).toHaveBeenCalledWith(docKey, 'b'.repeat(64))
    expect(fetchOfficeSeed).not.toHaveBeenCalled()
    expect(acquireLock).not.toHaveBeenCalled()
    expect(roundtripCheck).not.toHaveBeenCalled()
    const request = lastHost().props.request
    expect(request.readonly).toBe(false)
    expect(request.collab?.url).toMatch(/\/api\/v1\/office\/collab\?doc=doc%3Asp_alice/)
    expect(request.collab?.userName).toBe('爱丽丝')
    expect(lastHost().props.transport).toBeUndefined()
    expect(find('office-collab-status').text()).toContain('多人协同')
    // 连上、同步、有人加入:状态条说清楚
    await loadXlsxSurface()
    engine().onStatus({ status: 'connected', synced: true, peers: [{ name: '鲍勃' }] })
    await flushPromises()
    expect(find('office-collab-status').text()).toContain('已同步')
    expect(find('office-collab-status').text()).toContain('另有 1 人在编辑:鲍勃')
  })

  it('docx 还要取服务端的初始状态', async () => {
    prepareOfficeSession.mockResolvedValue({ ...COLLAB, format: 'docx' })
    await open('upload', { path: '报告.docx' })
    await waitFor(() => !!surfaceOptions.docx)
    expect(fetchOfficeSeed).toHaveBeenCalled()
    expect([...((surfaceOptions.docx as { initialUpdate?: Uint8Array }).initialUpdate ?? [])]).toEqual([5, 5])
  })

  it('只能查看的人:只读打开,也看得到别人的修改', async () => {
    prepareOfficeSession.mockResolvedValue({ ...COLLAB, writable: false })
    await open()
    expect(lastHost().props.request.readonly).toBe(true)
    expect(find('office-readonly').exists()).toBe(true)
    expect(find('office-force').exists()).toBe(false)
  })

  it('不无损但文字没少:只读并说明;点「仍然编辑」带 force 重新准备', async () => {
    prepareOfficeSession.mockResolvedValueOnce({ ...COLLAB, writable: false, room_writable: false, lossless: false, forceable: true, report: { valid: true, reason: null, changed_parts: ['xl/styles.xml'], removed_parts: [], added_parts: [] } })
    await open()
    expect(find('office-concern').text()).toContain('xl/styles.xml')
    prepareOfficeSession.mockResolvedValueOnce(COLLAB)
    const before = hostCalls().length
    await find('office-force').trigger('click')
    await waitFor(() => hostCalls().length > before)
    expect(prepareOfficeSession).toHaveBeenLastCalledWith(expect.any(String), true)
    expect(lastHost().props.request.readonly).toBe(false)
  })

  it('服务端把连接关了(权限被收回):说明原因,可以重新打开', async () => {
    prepareOfficeSession.mockResolvedValue(COLLAB)
    await open()
    await loadXlsxSurface()
    engine().onClosed(4403, '你不再有编辑权限')
    await flushPromises()
    expect(find('office-collab-closed').text()).toContain('你不再有编辑权限')
    // 网络断开(1006)不算:传输会自己重连
    engine().onClosed(1006, '')
    await flushPromises()
  })

  it('别人分享给我的文件(spaceId 是对方的知识库):直接按对方的资源键准备协同,不调自己知识库的 file_info', async () => {
    prepareOfficeSession.mockResolvedValue(COLLAB)
    wrapper = mount(OfficeEditor, { props: { collection: '_global', path: '报表/月报.xlsx', spaceId: 'sp_bob' }, attachTo: document.body })
    await waitFor(() => hostCalls().length > 0)
    expect(callCapability).not.toHaveBeenCalled()
    expect(prepareOfficeSession).toHaveBeenCalledWith('doc:sp_bob/_global/f/%E6%8A%A5%E8%A1%A8/%E6%9C%88%E6%8A%A5.xlsx', false)
    expect(lastHost().props.request.collab?.url).toMatch(/doc%3Asp_bob/)
    expect(lastHost().props.request.readonly).toBe(false)
  })

  it('别人分享给我的文件不能协同时:说明原因,不退回单人编辑(编辑权和替换文件只在自己的知识库里)', async () => {
    prepareOfficeSession.mockResolvedValue({ mode: 'single', reason: '表格有 2.2 MB,超过多人协同支持的 1.5 MB' })
    wrapper = mount(OfficeEditor, { props: { collection: '_global', path: '报表/月报.xlsx', spaceId: 'sp_bob' }, attachTo: document.body })
    await flushPromises()
    expect(acquireLock).not.toHaveBeenCalled()
    expect(hostCalls()).toHaveLength(0)
    expect(find('office-error').text()).toContain('超过多人协同支持的 1.5 MB')
  })

  it('不能协同(比如表格太大):说明原因,退回单人编辑(编辑权)', async () => {
    prepareOfficeSession.mockResolvedValue({ mode: 'single', reason: '表格有 2.2 MB,超过多人协同支持的 1.5 MB' })
    await open()
    expect(find('office-single-reason').text()).toContain('超过多人协同支持的 1.5 MB')
    expect(acquireLock).toHaveBeenCalled()
    expect(lastHost().props.request.collab).toBeUndefined()
    expect(lastHost().props.transport).toBeTruthy()
  })
})

describe('OfficeEditor：Word 单人编辑（无损检查在后台做，画面先出来）', () => {
  const VERDICT = (editable: 'yes' | 'force' | 'no') => ({ editable, losses: editable === 'no' ? ['word/diagrams/data1.xml'] : [], rewritten: editable === 'force' ? ['word/settings.xml'] : [], valid: true, reason: null })
  const openWord = () => open('upload', { path: '报告.docx' })
  /** 取出外壳让它加载的 Word 编辑面（真外壳会这么做），再模拟「编辑引擎就绪」 */
  async function engineReady() {
    await lastHost().props.loadSurface?.('page', 'docx')
    ;(docxSurface.options.at(-1)!.onEngineReady as () => void)()
    await flushPromises()
  }

  it('没有本机缓存：先以只读挂载（不挡遮罩、保存通道已就绪），引擎就绪后才起检查，yes 就放开编辑和编辑面', async () => {
    await openWord()
    expect(lastHost().props.request.readonly).toBe(true)
    expect(lastHost().props.transport).toBeTruthy()
    expect(find('office-veil').exists()).toBe(false)
    expect(find('office-checking').exists()).toBe(true)
    // 引擎还没就绪：不能提前起检查（它要再开一个引擎会话，会和首屏抢带宽）
    expect(verdictControl.pending).toHaveLength(0)

    await engineReady()
    expect(verdictControl.pending).toHaveLength(1)
    expect(find('office-checking').exists()).toBe(true)
    expect(lastHost().props.request.readonly).toBe(true)
    expect(docxSurface.readonlyCalls).toEqual([])

    verdictControl.pending[0]!.resolve({ verdict: VERDICT('yes'), cached: false })
    await flushPromises()
    expect(docxSurface.readonlyCalls).toEqual([false])
    expect(lastHost().props.request.readonly).toBe(false)
    expect(find('office-checking').exists()).toBe(false)
    expect(find('office-readonly').exists()).toBe(false)
  })

  it('检查用的是打开时的哈希与原件字节；探针带取消信号（关掉编辑器时能一起停）', async () => {
    await openWord()
    await engineReady()
    const input = verdictControl.pending[0]!.input as { sha256: string; original: Uint8Array; probe: (original: Uint8Array) => Promise<Uint8Array>; check: (resaved: Uint8Array) => Promise<unknown> }
    expect(input.sha256).toBe(SHA)
    expect([...input.original]).toEqual([9, 9, 9])
    await input.probe(input.original)
    expect(docxEngine.signals[0]).toBeInstanceOf(AbortSignal)
    await input.check(new Uint8Array([6, 6]))
    expect(roundtripCheck).toHaveBeenCalledWith('_global', '报告.docx', new Uint8Array([6, 6]))
  })

  it('force：保持只读并说明会改写什么，出现「仍然编辑」；no：保持只读，没有「仍然编辑」', async () => {
    await openWord()
    await engineReady()
    verdictControl.pending[0]!.resolve({ verdict: VERDICT('force'), cached: false })
    await flushPromises()
    expect(docxSurface.readonlyCalls).toEqual([])
    expect(lastHost().props.request.readonly).toBe(true)
    expect(find('office-readonly').exists()).toBe(true)
    expect(find('office-concern').text()).toContain('word/settings.xml')
    expect(find('office-force').exists()).toBe(true)
    wrapper!.unmount()

    hostCalls().length = 0
    verdictControl.pending.length = 0
    await openWord()
    await engineReady()
    verdictControl.pending[0]!.resolve({ verdict: VERDICT('no'), cached: false })
    await flushPromises()
    expect(docxSurface.readonlyCalls).toEqual([])
    expect(find('office-concern').text()).toContain('不能在线编辑')
    expect(find('office-force').exists()).toBe(false)
  })

  it('检查本身失败：保持只读并说明原因，不能当成没问题', async () => {
    await openWord()
    await engineReady()
    verdictControl.pending[0]!.reject(new Error('网络断了'))
    await flushPromises()
    expect(docxSurface.readonlyCalls).toEqual([])
    expect(lastHost().props.request.readonly).toBe(true)
    expect(find('office-readonly').exists()).toBe(true)
    expect(find('office-checking').exists()).toBe(false)
    expect(wrapper!.text()).toContain('没能完成')
    expect(wrapper!.text()).toContain('网络断了')
  })

  it('命中本机缓存：不起检查，按结论直接挂载（yes → 一开始就可写；force → 只读）', async () => {
    verdictControl.cached = VERDICT('yes')
    await openWord()
    expect(lastHost().props.request.readonly).toBe(false)
    expect(find('office-checking').exists()).toBe(false)
    expect(docxSurface.options.at(-1)).toBeUndefined() // 外壳还没加载内容面
    await lastHost().props.loadSurface?.('page', 'docx')
    expect(docxSurface.options.at(-1)!.onEngineReady).toBeUndefined()
    expect(verdictControl.pending).toHaveLength(0)
    wrapper!.unmount()

    hostCalls().length = 0
    verdictControl.cached = VERDICT('force')
    await openWord()
    expect(lastHost().props.request.readonly).toBe(true)
    expect(find('office-force').exists()).toBe(true)
    expect(verdictControl.pending).toHaveLength(0)
  })

  it('检查还没出结果就被关掉：探针被取消，迟到的结论不会再去放开编辑', async () => {
    await openWord()
    await engineReady()
    const input = verdictControl.pending[0]!.input as { probe: (original: Uint8Array) => Promise<Uint8Array>; original: Uint8Array }
    await input.probe(input.original)
    const signal = docxEngine.signals[0]!
    expect(signal.aborted).toBe(false)
    const surfaceCalls = docxSurface.readonlyCalls
    wrapper!.unmount()
    wrapper = null
    // 卸载时探针的取消信号触发（临时引擎会话随之销毁），迟到的结论也不能再动编辑面
    expect(signal.aborted).toBe(true)
    verdictControl.pending[0]!.resolve({ verdict: VERDICT('yes'), cached: false })
    await flushPromises()
    expect(surfaceCalls).toEqual([])
  })

  it('「仍然编辑」重挂成可编辑：旧检查的代数作废，不会再回头改它', async () => {
    verdictControl.cached = VERDICT('force')
    await openWord()
    expect(lastHost().props.request.readonly).toBe(true)
    await find('office-force').trigger('click')
    await waitFor(() => hostCalls().length === 2)
    expect(lastHost().props.request.readonly).toBe(false)
    expect(verdictControl.pending).toHaveLength(0)
  })

  it('点开 Word 在线编辑就预热引擎（WASM 下载、Worker、编辑面代码块）；Excel 不触发', async () => {
    await openWord()
    expect(wasmPrefetch.calls).toBeGreaterThan(0)
    await waitFor(() => docxEngine.prefetch > 0)
    wrapper!.unmount()

    wasmPrefetch.calls = 0
    docxEngine.prefetch = 0
    await open()
    await flushPromises()
    expect(wasmPrefetch.calls).toBe(0)
    expect(docxEngine.prefetch).toBe(0)
  })
})
