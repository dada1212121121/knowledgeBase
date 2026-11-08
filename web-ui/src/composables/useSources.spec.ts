// 数据来源的数据与操作:列表、队列计数、同步 / 全部同步 / 移除(含确认)、失败时的表现。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; action?: () => Promise<unknown> }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string; message?: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'
import { CapabilityError } from '@/api/client'
import { useSources } from './useSources'

const source = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'web', name: `来源 ${id}`, uri: `https://${id}.example.com/`, collection: 'c', tags: [], include: [], exclude: [], depth: 1, allow_hosts: [], refresh_minutes: null, status: 'idle', last_synced_at: 1, last_error: null, files: 10, created_at: 1, ...extra })
let replies: Record<string, unknown> = {}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    list_sources: { sources: [source('a'), source('b')], items: [{ source: source('a'), stats: { total: 10, today: 2, failed: 1, quarantined: 0, pending: 0 } }, { source: source('b'), stats: null }] },
    list_collections: { collections: [{ name: 'proj/docs' }, { name: '_global' }] },
    list_ingest: { total: 100, files: [] },
    get_config: { upload: { max_file_mb: 2048 } },
    system_status: { components: [{ kind: 'ocr', id: 'rapidocr', ready: true, current: true }] },
    sync_source: { queued: 3, job_id: 'j1' },
    remove_source: { removed: true },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'list_ingest' && args?.state) return { total: { failed: 4, quarantined: 2, queued: 1, extracting: 1, chunking: 0, embedding: 0 }[String(args.state)] ?? 0, files: [] }
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const toastTexts = () => toasts.map((entry) => entry.message)

beforeEach(() => {
  callCapability.mockReset()
  confirmState.answer = true
  confirmState.calls = []
  toasts.splice(0)
  setActivePinia(createPinia())
  backend()
})

describe('useSources.refresh', () => {
  it('取列表、集合名、队列计数、上传上限和 OCR 状态;统计按来源编号索引(没有统计的来源不收)', async () => {
    const store = useSources()
    await store.refresh()
    await vi.waitFor(() => expect(store.counts.value).not.toBeNull())
    expect(store.sources.value.map((item) => item.id)).toEqual(['a', 'b'])
    expect(store.collections.value).toEqual(['proj/docs', '_global'])
    expect(Object.keys(store.statsById.value)).toEqual(['a'])
    expect(store.counts.value).toEqual({ total: 100, pending: 2, failed: 4, quarantined: 2 })
    await vi.waitFor(() => expect(store.maxFileMb.value).toBe(2048))
    expect(store.providers.value[0]!.id).toBe('rapidocr')
    expect(store.loading.value).toBe(false)
    expect(store.error.value).toBe('')
    expect(store.rate.value).toBe('94.0%') // (100 - 4 - 2) / 100
  })

  it('一次都没取成功:整块报错(有中文原因就用它,否则说人话),不是静默空白', async () => {
    backend({ list_sources: new CapabilityError('internal: boom', 'internal', 500) })
    const store = useSources()
    await store.refresh()
    expect(store.error.value).toContain('读取数据来源失败')
    expect(store.loading.value).toBe(false)
    backend({ list_sources: new CapabilityError('数据库暂时锁住了', 'internal', 500) })
    const again = useSources()
    await again.refresh()
    expect(again.error.value).toBe('数据库暂时锁住了')
  })

  it('取成功过之后再刷新失败:留着旧列表,只提示一句,不整块报错', async () => {
    const store = useSources()
    await store.refresh()
    backend({ list_sources: new CapabilityError('internal: boom', 'internal', 500) })
    await store.refresh()
    expect(store.sources.value).toHaveLength(2)
    expect(store.error.value).toBe('')
    expect(toastTexts().some((text) => text.includes('刷新数据来源失败'))).toBe(true)
  })

  it('某个队列计数取不到不影响其它;全部取不到时文件总数退回各来源文件数之和', async () => {
    callCapability.mockImplementation(async (name: string) => {
      if (name === 'list_ingest') throw new CapabilityError('x', 'internal', 500)
      return replies[name] ?? {}
    })
    const store = useSources()
    await store.refresh()
    await vi.waitFor(() => expect(store.counts.value).not.toBeNull())
    expect(store.counts.value).toEqual({ total: 20, pending: 0, failed: 0, quarantined: 0 })
  })
})

describe('useSources 操作', () => {
  it('同步一个来源:说清入队了几个文件,并刷新', async () => {
    const store = useSources()
    await store.refresh()
    const before = calls('list_sources').length
    await store.sync(store.sources.value[0]!)
    expect(calls('sync_source')[0]![1]).toEqual({ id: 'a' })
    expect(toastTexts()).toContain('已同步 来源 a:入队 3 个文件')
    expect(calls('list_sources').length).toBe(before + 1)
    expect(store.busy.value).toBe('')
  })

  it('没有新文件、同步失败各说各的;失败后按钮能再点(busy 清掉)', async () => {
    const store = useSources()
    await store.refresh()
    replies.sync_source = { queued: 0, job_id: null }
    await store.sync(store.sources.value[0]!)
    expect(toastTexts()).toContain('已同步 来源 a:没有新文件')
    replies.sync_source = new CapabilityError('网页打不开', 'internal', 502)
    await store.sync(store.sources.value[0]!)
    expect(toastTexts().some((text) => text.startsWith('同步失败:网页打不开'))).toBe(true)
    expect(store.busy.value).toBe('')
  })

  it('全部同步:逐个触发,一个失败不连累后面的,失败条数一并说', async () => {
    const store = useSources()
    await store.refresh()
    callCapability.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'sync_source' && args?.id === 'a') throw new CapabilityError('x', 'internal', 500)
      return replies[name] ?? {}
    })
    await store.syncAll()
    expect(calls('sync_source').map((call) => (call[1] as { id: string }).id)).toEqual(['a', 'b'])
    expect(toastTexts()).toContain('已触发同步,1 个失败')
  })

  it('全部同步可以只同步传进来的那一批(导入页只同步自己的来源)', async () => {
    const store = useSources()
    await store.refresh()
    await store.syncAll([store.sources.value[1]!])
    expect(calls('sync_source').map((call) => (call[1] as { id: string }).id)).toEqual(['b'])
    expect(toastTexts()).toContain('已触发 1 个数据源的同步')
  })

  it('移除本地目录时提示源文件不会被删,和托管副本区分开', async () => {
    backend({ list_sources: { sources: [source('a', { kind: 'local_dir' })], items: [] } })
    const store = useSources()
    await store.refresh()
    expect(await store.remove(store.sources.value[0]!)).toBe(true)
    expect(confirmState.calls[0]!.message).toContain('原始文件不会被删除')
  })

  it('移除要先确认:不确认就不发请求;确认后移除、提示、刷新,返回 true', async () => {
    const store = useSources()
    await store.refresh()
    confirmState.answer = false
    expect(await store.remove(store.sources.value[0]!)).toBe(false)
    expect(calls('remove_source')).toHaveLength(0)
    confirmState.answer = true
    expect(await store.remove(store.sources.value[0]!)).toBe(true)
    expect(confirmState.calls[0]!.title).toBe('移除数据源「来源 a」?')
    expect(calls('remove_source')[0]![1]).toEqual({ id: 'a' })
    expect(toastTexts()).toContain('已移除 来源 a')
    expect(store.busy.value).toBe('')
  })
})
