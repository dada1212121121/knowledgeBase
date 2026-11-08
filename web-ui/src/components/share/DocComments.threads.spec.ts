// 评论串的 @ 提及、已解决、筛选(接口行为见 crates/kb-cli/tests/e2e_comments.rs)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ShareAccess } from '@/api/share'
import DocComments from './DocComments.vue'

const call = vi.fn()
const global = vi.hoisted(() => ({ callCapability: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<object>()), callCapability: global.callCapability }))

const access = (comment: boolean, guest = false): ShareAccess => ({ call: call as ShareAccess['call'], rawUrl: () => '', can: { edit: false, comment, download: true }, guest })
const authors = {
  usr_me: { id: 'usr_me', username: 'me', display_name: '我自己' },
  usr_bob: { id: 'usr_bob', username: 'bob', display_name: '鲍勃' },
}
const items = [
  { id: 't1', body: '待解决的问题', author: 'usr_bob', created_at: 1000 },
  { id: 'r1', body: '已回复', author: 'usr_me', created_at: 1500, parent_id: 't1' },
  { id: 't2', body: '已经解决了', author: 'usr_bob', created_at: 2000, resolved_at: 3000, resolved_by: 'usr_me' },
]

beforeEach(() => {
  setActivePinia(createPinia())
  call.mockReset()
  global.callCapability.mockReset()
  call.mockImplementation(async (name: string) => (name === 'list_annotations' ? { annotations: items, authors } : { annotation: {} }))
  global.callCapability.mockImplementation(async (name: string) => (name === 'friend_list' ? { friends: [{ id: 'usr_carol', username: 'carol', display_name: '卡罗', remark: '老卡' }] } : {}))
  document.body.innerHTML = ''
})

async function mountComments(comment = true, guest = false, extra: Record<string, unknown> = {}) {
  const wrapper = mount(DocComments, { props: { access: access(comment, guest), collection: '_global', source: 'insight:ins_1', myId: guest ? null : 'usr_me', ...extra }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('提及', () => {
  it('输入 @ 弹出候选(显示好友备注),选中后插入的是用户名,发送时带 mentions', async () => {
    const wrapper = await mountComments()
    const input = wrapper.find('[data-testid=comment-input]')
    const textarea = input.element as HTMLTextAreaElement
    textarea.value = '麻烦 @ca'
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    await input.trigger('input')
    await input.trigger('keyup')
    const options = wrapper.findAll('[data-testid=comment-mentions] button')
    expect(options.map((option) => option.text())).toEqual([expect.stringContaining('老卡')])
    await options[0]!.trigger('mousedown')
    expect(textarea.value).toBe('麻烦 @carol ')
    await wrapper.find('[data-testid=comment-send]').trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('add_annotation', { collection: '_global', source: 'insight:ins_1', body: '麻烦 @carol', mentions: ['carol'] })
  })

  it('不提 @ 的评论不带 mentions 字段;正文里的 @用户名 在列表里高亮', async () => {
    call.mockImplementation(async (name: string) => (name === 'list_annotations' ? { annotations: [{ id: 'x', body: '请 @bob 看', author: 'usr_me', created_at: 1 }], authors } : {}))
    const wrapper = await mountComments()
    expect(wrapper.find('[data-testid=comment-mention]').text()).toBe('@bob')
    const textarea = wrapper.find('[data-testid=comment-input]')
    await textarea.setValue('普通评论')
    await wrapper.find('[data-testid=comment-send]').trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('add_annotation', { collection: '_global', source: 'insight:ins_1', body: '普通评论' })
  })

  it('游客没有 @ 候选,也不去查好友', async () => {
    const wrapper = await mountComments(true, true)
    const textarea = wrapper.find('[data-testid=comment-input]')
    ;(textarea.element as HTMLTextAreaElement).value = '你好 @b'
    await textarea.trigger('input')
    await textarea.trigger('keyup')
    expect(wrapper.find('[data-testid=comment-mentions]').exists()).toBe(false)
    expect(global.callCapability).not.toHaveBeenCalled()
  })
})

describe('已解决', () => {
  it('已解决的评论串折成一行,写明谁标记的;展开后能看到,再收起', async () => {
    const wrapper = await mountComments()
    const collapsed = wrapper.findAll('[data-testid=comment-thread]').find((thread) => thread.attributes('data-resolved') === 'true')!
    expect(collapsed.find('[data-testid=thread-collapsed]').text()).toContain('已解决 · 我')
    expect(collapsed.text()).not.toContain('已经解决了')
    await collapsed.find('[data-testid=thread-expand]').trigger('click')
    expect(wrapper.text()).toContain('已经解决了')
    await wrapper.find('[data-testid=thread-collapse]').trigger('click')
    expect(wrapper.text()).not.toContain('已经解决了')
  })

  it('标记已解决 / 重新打开:调 resolve_annotation 并带上文档;失败给提示不改状态', async () => {
    const wrapper = await mountComments()
    await wrapper.find('[data-testid=thread-resolve]').trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('resolve_annotation', { collection: '_global', source: 'insight:ins_1', id: 't1', resolved: true })
    // 标成已解决后通知上层重读评论列表：正文里的批注高亮要跟着变成“已解决”的样式
    expect(wrapper.emitted('posted')).toHaveLength(1)
    call.mockImplementation(async (name: string) => {
      if (name === 'resolve_annotation') throw { status: 403, message: 'forbidden' }
      return { annotations: items, authors }
    })
    await wrapper.find('[data-testid=thread-resolve]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=resolve-error]').exists()).toBe(true)
    // 失败时什么都没变，不通知
    expect(wrapper.emitted('posted')).toHaveLength(1)
  })

  it('删除评论成功后通知上层重读列表（正文里那条批注的高亮不能还留着，）', async () => {
    const wrapper = await mountComments(true, false, { deletable: true })
    await wrapper.find('[data-testid=comment-delete]').trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('delete_annotation', { id: 't1' })
    expect(wrapper.emitted('posted')).toHaveLength(1)
  })

  it('游客和只读的人看不到「标记已解决」', async () => {
    expect((await mountComments(true, true)).find('[data-testid=thread-resolve]').exists()).toBe(false)
    expect((await mountComments(false)).find('[data-testid=thread-resolve]').exists()).toBe(false)
  })

  it('「未解决」筛选只留没解决的串;没有已解决的评论时不出现筛选', async () => {
    const wrapper = await mountComments()
    await wrapper.find('[data-testid=filter-open]').trigger('click')
    expect(wrapper.findAll('[data-testid=comment-thread]')).toHaveLength(1)
    call.mockImplementation(async (name: string) => (name === 'list_annotations' ? { annotations: [items[0]], authors } : {}))
    const fresh = await mountComments()
    expect(fresh.find('[data-testid=comment-filter]').exists()).toBe(false)
  })

  it('从通知点进来(focus)的评论串即使已解决也展开并高亮', async () => {
    const wrapper = await mountComments(true, false, { focus: 't2' })
    const target = wrapper.find('.kb-cmt-thread.is-target')
    expect(target.exists()).toBe(true)
    expect(target.text()).toContain('已经解决了')
  })
})
