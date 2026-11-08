// 存储与用量:AI 总开关关掉后没有「AI 额度」一页、页头没有 AI 字样,旧的 ?tab=ai 链接回到「存储」;没有功能点时说明原因。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const route = reactive<{ query: Record<string, string> }>({ query: {} })
const replace = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ replace, push: vi.fn() }),
  RouterLink: { props: ['to'], template: '<a><slot /></a>' },
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@/components/admin/StoragePanel.vue', () => ({ default: { template: '<div data-testid="storage-stub">存储面板</div>' } }))
vi.mock('@/components/admin/LlmUsagePanel.vue', () => ({ default: { template: '<div data-testid="llm-stub">额度面板</div>' } }))
vi.mock('@/components/admin/ShareAdminPanel.vue', () => ({ default: { template: '<div data-testid="share-stub">分享面板</div>' } }))

import StorageUsage from './StorageUsage.vue'
import { useSessionStore } from '@/stores/session'

const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const tabLabels = () => [...document.body.querySelectorAll('[role=tab]')].map((el) => el.textContent!.trim())

let wrapper: VueWrapper | null = null
async function open(options: { ai?: boolean; features?: string[]; tab?: string } = {}) {
  const session = useSessionStore()
  session.features = new Set(options.features ?? ['sys.ops'])
  session.aiEnabled = options.ai ?? true
  session.loaded = true
  route.query = options.tab ? { tab: options.tab } : {}
  wrapper = mount(StorageUsage, { attachTo: document.body })
  await flushPromises()
}
beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  replace.mockReset()
})

describe('存储与用量 · AI 总开关', () => {
  it('开着:存储 / AI 额度 / 分享链接三页,页头提到 AI 额度', async () => {
    await open()
    expect(tabLabels()).toEqual(['存储', 'AI 额度', '分享链接'])
    expect(text()).toContain('当天用了多少 AI 额度')
  })

  it('关掉:只有存储和分享链接两页,整页没有「AI」', async () => {
    await open({ ai: false })
    expect(tabLabels()).toEqual(['存储', '分享链接'])
    expect(text()).not.toMatch(/AI/)
  })

  it('关掉时打开旧链接 ?tab=ai:显示「存储」,不显示额度面板', async () => {
    await open({ ai: false, tab: 'ai' })
    expect($('[data-testid=storage-stub]')).not.toBeNull()
    expect($('[data-testid=llm-stub]')).toBeNull()
  })

  it('开着时 ?tab=ai 显示额度面板', async () => {
    await open({ tab: 'ai' })
    expect($('[data-testid=llm-stub]')).not.toBeNull()
  })
})

describe('存储与用量 · 没有功能点', () => {
  it('没有「系统运维」:整页说明没有开通,不渲染任何面板', async () => {
    await open({ features: [] })
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=storage-stub]')).toBeNull()
    expect(tabLabels()).toEqual([])
  })
})
