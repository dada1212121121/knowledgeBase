// Excel 原生协同：OfficeEditor 要把引擎的连接状态接成宿主状态栏的「房间状态来源」(collabStatus)。
// 以前 xlsx 的请求里没有这个来源，宿主只能按「有协同配置」写死成「正在连接协同…」，连上之后也不变。
// 宿主和内容面都用假的：这里只守「引擎状态 → 请求里的房间状态来源」这一段接线。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import type { CollabStatusSource } from '@/editor/types'
import type { XlsxCollabOptions } from '@/editor/engines/xlsx'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

const prepareOfficeSession = vi.fn()
vi.mock('@/api/officeEdit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/officeEdit')>()),
  prepareOfficeSession: (...args: unknown[]) => prepareOfficeSession(...args),
  fetchOfficeBase: async () => new Uint8Array([7, 7, 7]),
  fetchOfficeSeed: async () => new Uint8Array([5, 5]),
  acquireLock: async () => ({ held: true, ttl_secs: 45, took_over_from: null }),
  releaseLock: async () => undefined,
  newSessionId: () => 'tab-test',
}))

/** 假宿主：只把收到的请求和 loadSurface 记下来 */
const seen: { request?: { collabStatus?: CollabStatusSource; readonly: boolean; collab?: unknown }; loadSurface?: (kind: string, format?: string) => Promise<unknown> } = {}
vi.mock('@/editor/host/EditorHost.vue', () => ({
  default: defineComponent({
    props: { request: { type: Object, required: true }, loadSurface: { type: Function, required: true } },
    setup(props) {
      seen.request = props.request as never
      seen.loadSurface = props.loadSurface as never
      return () => h('div', { 'data-testid': 'fake-host' })
    },
  }),
}))

/** 假内容面：拿到 OfficeEditor 交给引擎的协同配置（onStatus / onClosed 就是引擎回调的入口） */
let engineOptions: XlsxCollabOptions | undefined
vi.mock('@/editor/surfaces/grid/xlsxSurface', () => ({
  createXlsxEditSurface: (options?: XlsxCollabOptions) => {
    engineOptions = options
    return {}
  },
}))
vi.mock('@/editor/codecs/xlsx', () => ({ createXlsxSaveTransport: () => ({ save: async () => ({ ok: true }) }) }))

import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '@/stores/session'
import OfficeEditor from './OfficeEditor.vue'

const COLLAB = { mode: 'collab', format: 'xlsx', base_sha: 'b'.repeat(64), size: 3, writable: true, room_writable: true, lossless: true, forceable: false, report: null }

let wrapper: VueWrapper | null = null

/** 打开并等到引擎拿到协同配置（宿主挂上、内容面被加载） */
async function openCollab(session: Record<string, unknown> = COLLAB) {
  prepareOfficeSession.mockResolvedValue(session)
  callCapability.mockResolvedValue({ sha256: 'a'.repeat(64), origin: 'upload', max_replace_bytes: 64 * 1024 * 1024 })
  wrapper = mount(OfficeEditor, { props: { collection: '_global', path: '报表/月报.xlsx' }, attachTo: document.body })
  // 宿主和内容面都是动态 import，首个用例要等模块解析；轮询比固定 flush 次数稳
  await waitFor(() => !!seen.loadSurface)
  await seen.loadSurface?.('grid', 'xlsx')
  await flushPromises()
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await flushPromises()
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor 超时：宿主没有挂上')
}

const room = () => seen.request!.collabStatus!
/** 引擎回调给 OfficeEditor 的连接状态（`peers` 是引擎的对端结构） */
const engineStatus = (status: 'connecting' | 'connected' | 'disconnected' | 'destroyed', synced: boolean) =>
  engineOptions!.onStatus!({ status, synced, peers: [] })

beforeEach(() => {
  // xlsx 一律走原生编辑器
  window.history.replaceState(null, '', '/')
  setActivePinia(createPinia())
  useSessionStore().$patch({ user: { id: 'usr_a', username: 'alice', display_name: '爱丽丝', space_id: 'sp_alice' } as never })
  seen.request = undefined
  seen.loadSurface = undefined
  engineOptions = undefined
  callCapability.mockReset()
  prepareOfficeSession.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 })))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

describe('OfficeEditor：Excel 原生协同的房间状态来源', () => {
  it('协同请求带房间状态来源，一开始是「连接中」；没有它宿主就会一直写「正在连接协同…」', async () => {
    await openCollab()
    expect(seen.request?.collab).toBeTruthy()
    expect(room()).toBeTruthy()
    expect(room().getState()).toEqual({ status: 'connecting', writable: true })
    expect(engineOptions).toBeTruthy()
  })

  it('引擎的连接状态翻成房间状态：同步中 → 已同步 → 断开离线 → 重连中 → 已同步', async () => {
    await openCollab()
    const states: string[] = []
    room().subscribe((state) => states.push(state.status))
    engineStatus('connected', false)
    engineStatus('connected', true)
    engineStatus('disconnected', true)
    engineStatus('connecting', false)
    engineStatus('connected', true)
    // 订阅时先推一次当前状态，之后每次变化一次；相同状态不重复通知
    expect(states).toEqual(['connecting', 'syncing', 'synced', 'offline', 'connecting', 'synced'])
    expect(room().getState().status).toBe('synced')
  })

  it('服务端主动结束（权限收回 4403 / 房间关了 4410 / 正常关闭 1000）：房间状态变「已结束」，之后引擎补发的断开不改它', async () => {
    await openCollab()
    engineStatus('connected', true)
    engineOptions!.onClosed!(4403, '你对这份文档的权限已被收回')
    engineStatus('disconnected', false)
    expect(room().getState().status).toBe('closed')
    await flushPromises()
    // 提示条沿用原来的行为
    expect(wrapper!.find('[data-testid="office-collab-closed"]').text()).toContain('权限已被收回')
  })

  it('普通掉线（1006 这类会重连的关闭码）不算结束：显示离线，连回来恢复已同步', async () => {
    await openCollab()
    engineStatus('connected', true)
    engineOptions!.onClosed!(1006, '')
    engineStatus('disconnected', true)
    expect(room().getState().status).toBe('offline')
    await flushPromises()
    expect(wrapper!.find('[data-testid="office-collab-closed"]').exists()).toBe(false)
    engineStatus('connected', true)
    expect(room().getState().status).toBe('synced')
  })

  it('只能查看的人：房间状态来源标成只读', async () => {
    await openCollab({ ...COLLAB, writable: false })
    expect(seen.request?.readonly).toBe(true)
    expect(room().getState()).toEqual({ status: 'connecting', writable: false })
  })

  it('外层工具条的协同文案照常更新（房间状态来源只是多了一条给状态栏的通道）', async () => {
    await openCollab()
    engineOptions!.onStatus!({ status: 'connected', synced: true, peers: [] })
    await flushPromises()
    expect(wrapper!.find('[data-testid="office-collab-status"]').text()).toContain('已同步')
  })
})
