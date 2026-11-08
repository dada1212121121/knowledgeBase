// 回收站页:30 天期限、恢复调用、空 / 错状态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
const push = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@kb-ui/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kb-ui/index')>()),
  useToast: () => ({ push }),
}))

import Trash from './Trash.vue'

const DAY = 86_400_000
const entry = (id: string, mode: 'trash' | 'unindex' = 'trash') => ({
  id,
  op_id: 'fop_1',
  collection: 'kb',
  original_path: `docs/${id}.md`,
  trash_path: mode === 'trash' ? `/kb/trash/fop_1/${id}/a.md` : null,
  source_id: null,
  metadata_key: `trash:${id}`,
  mode,
  size: 2048,
  created_at: Date.now() - DAY,
  expires_at: Date.now() + 10 * DAY,
  restored_at: null,
  purged_at: null,
})

let wrapper: VueWrapper | null = null
async function open(reply: unknown = { entries: [entry('tr_1'), entry('tr_2', 'unindex')] }) {
  callCapability.mockImplementation(async (name: string) => {
    if (name === 'list_trash') {
      if (reply instanceof Error) throw reply
      return reply
    }
    return { id: 'fop_2', collection: 'kb', kind: 'restore', state: 'done', total: 1, done: 1, failed: 0, error: null, created_at: 1, finished_at: 2 }
  })
  wrapper = mount(Trash, { attachTo: document.body })
  await flushPromises()
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  push.mockReset()
  setActivePinia(createPinia())
})

describe('回收站', () => {
  it('列出条目:来源模式、大小、剩余天数和原路径', async () => {
    await open()
    const text = document.querySelector('[data-testid=trash-list]')!.textContent!
    expect(text).toContain('docs/tr_1.md')
    expect(text).toContain('回收站')
    expect(text).toContain('仅移除索引')
    expect(text).toContain('2.0 KB')
    expect(text).toContain('10 天后自动清理')
  })

  it('恢复带上 trash_id,成功后重读列表并提示', async () => {
    await open()
    document.querySelector<HTMLButtonElement>('[data-testid=trash-tr_1] button')!.click()
    await flushPromises()
    expect(callCapability).toHaveBeenCalledWith('restore_trash', { trash_id: 'tr_1' })
    expect(push).toHaveBeenCalledWith('已恢复 docs/tr_1.md')
    expect(callCapability.mock.calls.filter((call) => call[0] === 'list_trash')).toHaveLength(2)
  })

  it('空回收站给出下一步,不画空表格', async () => {
    await open({ entries: [] })
    expect(document.body.textContent).toContain('回收站是空的')
  })

  it('读取失败显示原因和重试,重试会再请求一次', async () => {
    await open(new Error('boom'))
    expect(document.body.textContent).toContain('没能读取回收站')
    expect(document.body.textContent).toContain('boom')
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '重试')
    retry!.click()
    await flushPromises()
    expect(callCapability.mock.calls.filter((call) => call[0] === 'list_trash')).toHaveLength(2)
  })
})
