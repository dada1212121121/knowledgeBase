// 拉黑名单:四种状态、取消拉黑、只露最少的信息。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import { CapabilityError } from '@/api/client'
import { useFriendsStore } from '@/stores/friends'
import BlockList from './BlockList.vue'

const row = (id: string, name: string) => ({ user: { id: `usr_${id}`, username: id, display_name: name, avatar: null, email: `${id}@example.com` }, since: Date.now() - 5 * 60_000 })
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]

let wrapper: VueWrapper | null = null
async function show(reply: unknown) {
  if (reply instanceof Error) callCapability.mockRejectedValueOnce(reply)
  else callCapability.mockResolvedValueOnce(reply)
  wrapper = mount(BlockList, { attachTo: document.body })
  await useFriendsStore().loadBlocks()
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  setActivePinia(createPinia())
})

describe('BlockList', () => {
  it('加载中:骨架屏', () => {
    wrapper = mount(BlockList, { attachTo: document.body })
    expect($('.kb-skel')).not.toBeNull()
  })

  it('空:说明被拉黑的人不会知道,并告诉用户去哪里拉黑', async () => {
    await show({ blocked: [] })
    const text = $('[data-testid="blocks-empty"]')!.textContent!
    expect(text).toContain('没有拉黑任何人')
    expect(text).toContain('他们不会知道')
  })

  it('出错:原因 + 重新加载', async () => {
    await show(new CapabilityError('internal: x', 'internal', 500))
    expect($('[data-testid="blocks-error"]')!.textContent).toContain('没能加载拉黑名单')
    callCapability.mockResolvedValueOnce({ blocked: [row('spam', '骚扰')] })
    $$('[data-testid="blocks-error"] button').find((button) => button.textContent?.trim() === '重新加载')!.click()
    await flushPromises()
    expect($$('[data-testid="block-row"]')).toHaveLength(1)
  })

  it('每行只有头像、昵称、@用户名和拉黑时间,不出现邮箱等别的信息', async () => {
    await show({ blocked: [row('spam', '骚扰')] })
    const text = $('[data-testid="block-row"]')!.textContent!
    expect(text).toContain('骚扰')
    expect(text).toContain('@spam')
    expect(text).toContain('拉黑于 5 分钟前')
    expect(document.body.textContent).not.toContain('spam@example.com')
    expect(document.body.textContent).toContain('被拉黑的人不会收到通知')
  })

  it('取消拉黑:发 unblock,这一行消失;失败时原因写在列表上方,这一行还在', async () => {
    await show({ blocked: [row('a', '甲'), row('b', '乙')] })
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    $$('[data-testid="block-undo"]')[0]!.click()
    await flushPromises()
    expect($('[data-testid="block-error"]')!.textContent).toContain('没能取消拉黑')
    expect($$('[data-testid="block-row"]')).toHaveLength(2)
    callCapability.mockResolvedValueOnce({ unblocked: true })
    $$('[data-testid="block-undo"]')[0]!.click()
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('unblock', { user_id: 'usr_a' })
    expect($$('[data-testid="block-row"]')).toHaveLength(1)
    expect($('[data-testid="block-error"]')).toBeNull()
  })

  it('取消拉黑的按钮读屏名字带上对方是谁', async () => {
    await show({ blocked: [row('a', '甲')] })
    expect($('[data-testid="block-undo"]')!.getAttribute('aria-label')).toBe('取消拉黑甲')
  })
})
