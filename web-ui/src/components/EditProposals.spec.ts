// AI 的修改建议面板:只列当前文档还在等待的建议;接受 / 拒绝调 doc_proposal_decide;
// 应用失败如实说明;接受后没有并进房间时通知页面重新加载;切换文档重新拉;推送来了当前文档的事件就刷新。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
let live: ((event: { type: string; data: Record<string, unknown> }) => void) | null = null
vi.mock('@/composables/useLiveEvents', () => ({
  useLiveEvents: (listener: typeof live) => {
    live = listener
    return () => {}
  },
}))

import EditProposals from './EditProposals.vue'

const proposal = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  author: 'mcp:claude',
  note: '补上复盘',
  edits: [{ old: '第二步:执行', new: '第二步:执行并复盘' }],
  status: 'pending',
  created_at: Date.now() - 60_000,
  ...over,
})

let wrapper: VueWrapper | null = null
beforeEach(() => {
  callCapability.mockReset()
  live = null
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

async function mountFile(list = [proposal('p1')]) {
  callCapability.mockResolvedValueOnce({ proposals: list })
  wrapper = mount(EditProposals, { props: { collection: '_global', path: '计划/步骤.txt' } })
  await flushPromises()
  return wrapper
}

describe('EditProposals', () => {
  it('没有建议时什么都不显示;有建议时列出原文和新文字', async () => {
    const empty = await mountFile([])
    expect(callCapability).toHaveBeenCalledWith('doc_proposals', { collection: '_global', path: '计划/步骤.txt', status: 'pending' })
    expect(empty.find('[data-testid="edit-proposals"]').exists()).toBe(false)
    empty.unmount()
    wrapper = null

    const shown = await mountFile()
    expect(shown.text()).toContain('AI 提了 1 条修改建议')
    await shown.find('button').trigger('click')
    expect(shown.find('.kb-proposal-old').text()).toBe('第二步:执行')
    expect(shown.find('.kb-proposal-new').text()).toBe('第二步:执行并复盘')
    expect(shown.text()).toContain('AI(claude)')
    expect(shown.text()).toContain('补上复盘')
  })

  it('接受:调 doc_proposal_decide,没并进房间时通知页面重新加载,然后重新拉列表', async () => {
    const view = await mountFile()
    await view.find('button').trigger('click')
    callCapability.mockResolvedValueOnce({ id: 'p1', status: 'accepted', live: false })
    callCapability.mockResolvedValueOnce({ proposals: [] })
    await view.find('[data-action="accept"]').trigger('click')
    await flushPromises()
    expect(callCapability).toHaveBeenNthCalledWith(2, 'doc_proposal_decide', { id: 'p1', accept: true })
    expect(view.emitted('applied')).toEqual([[false]])
    expect(view.find('[data-testid="edit-proposals"]').exists()).toBe(false)
  })

  it('拒绝不通知页面;应用失败如实说明原因', async () => {
    const view = await mountFile([proposal('p1'), proposal('p2')])
    await view.find('button').trigger('click')
    callCapability.mockResolvedValueOnce({ id: 'p1', status: 'rejected' })
    callCapability.mockResolvedValueOnce({ proposals: [proposal('p2')] })
    await view.find('[data-proposal="p1"] [data-action="reject"]').trigger('click')
    await flushPromises()
    expect(view.emitted('applied')).toBeUndefined()
    callCapability.mockResolvedValueOnce({ id: 'p2', status: 'failed', error: '没找到要替换的原文:第二步' })
    callCapability.mockResolvedValueOnce({ proposals: [] })
    await view.find('[data-proposal="p2"] [data-action="accept"]').trigger('click')
    await flushPromises()
    expect(view.find('[role="alert"]').text()).toContain('没找到要替换的原文')
    expect(view.emitted('applied')).toBeUndefined()
  })

  it('别人分享给我的文档:经传进来的 call 调(带 X-KB-Space 的那条路)', async () => {
    const call = vi.fn().mockResolvedValueOnce({ proposals: [proposal('p1')] })
    wrapper = mount(EditProposals, { props: { collection: 'docs', path: 'a.md', call } })
    await flushPromises()
    expect(call).toHaveBeenCalledWith('doc_proposals', { collection: 'docs', path: 'a.md', status: 'pending' })
    expect(callCapability).not.toHaveBeenCalled()
    await wrapper.find('button').trigger('click')
    call.mockResolvedValueOnce({ id: 'p1', status: 'accepted', live: true }).mockResolvedValueOnce({ proposals: [] })
    await wrapper.find('[data-action="accept"]').trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('doc_proposal_decide', { id: 'p1', accept: true })
    expect(wrapper.emitted('applied')).toEqual([[true]])
  })

  it('笔记按 note_id 查;推送来当前文档的事件才刷新,换了文档重新拉', async () => {
    callCapability.mockResolvedValueOnce({ proposals: [] })
    wrapper = mount(EditProposals, { props: { noteId: 'n1' } })
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('doc_proposals', { note_id: 'n1', status: 'pending' })
    live?.({ type: 'proposal.changed', data: { collection: '_global', target: 'note:other' } })
    await flushPromises()
    expect(callCapability).toHaveBeenCalledTimes(1)
    callCapability.mockResolvedValueOnce({ proposals: [proposal('p9')] })
    live?.({ type: 'proposal.changed', data: { collection: '_global', target: 'note:n1' } })
    await flushPromises()
    expect(callCapability).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('AI 提了 1 条修改建议')
    callCapability.mockResolvedValueOnce({ proposals: [] })
    await wrapper.setProps({ noteId: 'n2' })
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('doc_proposals', { note_id: 'n2', status: 'pending' })
    expect(wrapper.find('[data-testid="edit-proposals"]').exists()).toBe(false)
  })

  it('每条修改旁有「在正文里找到」，点了把原文交给页面去定位', async () => {
    const shown = await mountFile()
    await shown.find('button').trigger('click')
    await shown.find('[data-action="locate"]').trigger('click')
    expect(shown.emitted('locate')).toEqual([['第二步:执行']])
  })
})
