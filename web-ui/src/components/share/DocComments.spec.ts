// 评论:加载 / 空 / 报错 / 发表(可评论才有输入框)/ 发表失败保留内容。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ShareAccess } from '@/api/share'
import DocComments from './DocComments.vue'

const call = vi.fn()
const access = (comment: boolean): ShareAccess => ({ call: call as ShareAccess['call'], rawUrl: () => '', can: { edit: false, comment, download: true } })
const props = (comment: boolean) => ({ access: access(comment), collection: '_global', source: 'insight:ins_1' })

const annotations = [
  { id: 'a2', body: '第二条', author: 'guest:小王#3fa9c1(经链接 Zp9a)', created_at: 2000 },
  { id: 'a1', body: '第一条', author: 'usr_me', created_at: 1000 },
]

beforeEach(() => {
  setActivePinia(createPinia())
  call.mockReset()
  call.mockImplementation(async (name: string) => (name === 'list_annotations' ? { annotations } : {}))
  document.body.innerHTML = ''
})

async function mountComments(comment = true) {
  const wrapper = mount(DocComments, { props: { ...props(comment), myId: 'usr_me' }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('DocComments', () => {
  it('旧的在上新的在下;游客显示「访客 昵称」,自己显示「我」,不露内部编号和用户 id', async () => {
    const wrapper = await mountComments()
    const rows = wrapper.findAll('[data-testid=comment]')
    expect(rows.map((row) => row.find('.kb-cmt-body').text())).toEqual(['第一条', '第二条'])
    expect(rows[0]!.text()).toContain('我')
    expect(rows[1]!.text()).toContain('访客 小王')
    expect(wrapper.text()).not.toContain('3fa9c1')
    expect(wrapper.text()).not.toContain('usr_me')
    expect(call).toHaveBeenCalledWith('list_annotations', { collection: '_global', source: 'insight:ins_1' })
  })

  it('没有评论:空状态;能评论的人给他提示,不能评论的人不给输入框', async () => {
    call.mockResolvedValue({ annotations: [] })
    const can = await mountComments(true)
    expect(can.find('[data-testid=comments-empty]').text()).toContain('写下第一条')
    expect(can.find('[data-testid=comment-input]').exists()).toBe(true)
    const cannot = await mountComments(false)
    expect(cannot.find('[data-testid=comments-empty]').text()).toBe('还没有评论。')
    expect(cannot.find('[data-testid=comment-input]').exists()).toBe(false)
    expect(cannot.text()).toContain('你现在的权限不能评论')
  })

  it('加载失败:可重试', async () => {
    call.mockRejectedValueOnce({ status: 500, message: 'internal: x' })
    const wrapper = await mountComments()
    expect(wrapper.find('[data-testid=comments-error]').text()).toContain('评论没有加载出来')
    await wrapper.find('[data-testid=comments-error] button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid=comment]')).toHaveLength(2)
  })

  it('发表:带集合和来源;成功后清空输入并重读;空白内容发不出去', async () => {
    const wrapper = await mountComments()
    const send = wrapper.find('[data-testid=comment-send]')
    expect(send.attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid=comment-input]').setValue('  写得好  ')
    await send.trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('add_annotation', { collection: '_global', source: 'insight:ins_1', body: '写得好' })
    expect((wrapper.find('[data-testid=comment-input]').element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.emitted('posted')).toHaveLength(1)
    expect(call.mock.calls.filter(([name]) => name === 'list_annotations')).toHaveLength(2)
  })

  it('发表失败(例如管理员刚关了游客评论):就近显示原因,内容留在输入框里', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'add_annotation') throw { status: 403, message: 'forbidden: 这个链接的权限是「可查看」,不能执行这个操作' }
      return { annotations: [] }
    })
    const wrapper = await mountComments()
    await wrapper.find('[data-testid=comment-input]').setValue('想说两句')
    await wrapper.find('[data-testid=comment-send]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=comment-error]').text()).toBe('这个链接的权限是「可查看」,不能执行这个操作')
    expect((wrapper.find('[data-testid=comment-input]').element as HTMLTextAreaElement).value).toBe('想说两句')
  })

  it('超过 2000 字不能发', async () => {
    const wrapper = await mountComments()
    await wrapper.find('[data-testid=comment-input]').setValue('字'.repeat(2001))
    expect(wrapper.find('[data-testid=comment-send]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('2001 / 2000,太长了')
  })
})

// ---------------------------------------------------------------- 评论串:回复、作者资料、四种状态
const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id: `usr_${id}`, username: id, display_name: name, avatar: null, ...extra })
const threadData = {
  annotations: [
    { id: 'r2', body: '第二条回复', author: 'usr_alice', parent_id: 'a1', created_at: 4000 },
    { id: 'a2', body: '另一串', author: 'guest:小王#3fa9c1', created_at: 3000 },
    { id: 'a1', body: '顶层评论', author: 'usr_bob', created_at: 1000, mentions: [] },
    { id: 'r1', body: '第一条回复', author: 'usr_me', parent_id: 'a1', created_at: 2000 },
  ],
  authors: { usr_bob: person('bob', 'Bob', { avatar: 'b1.png' }), usr_alice: person('alice', 'Alice') },
}

describe('DocComments · 评论串', () => {
  beforeEach(() => {
    call.mockImplementation(async (name: string) => (name === 'list_annotations' ? threadData : {}))
  })

  it('回复挂在顶层评论下面,按时间;作者名字和头像来自 authors,自己是「我」,游客是「访客 昵称」', async () => {
    const wrapper = await mountComments()
    const threads = wrapper.findAll('[data-testid=comment-thread]')
    expect(threads).toHaveLength(2)
    const first = threads[0]!
    expect(first.find('.kb-cmt-body').text()).toBe('顶层评论')
    const replies = first.findAll('[data-testid=comment-replies] [data-testid=comment]')
    expect(replies.map((row) => row.find('.kb-cmt-body').text())).toEqual(['第一条回复', '第二条回复'])
    expect(first.findAll('[data-testid=comment-author]').map((node) => node.text())).toEqual(['Bob', '我', 'Alice'])
    expect(threads[1]!.find('[data-testid=comment-author]').text()).toBe('访客 小王')
    expect(wrapper.find('[data-testid=comment-threads]').element.querySelectorAll('[data-testid=comment]')).toHaveLength(4)
    expect(wrapper.find('.kb-cmt-count').text()).toBe('4')
    // 有头像文件的画图片,没有的画首字母;游客不画图片
    expect(wrapper.find('img').attributes('src')).toBe('/api/v1/users/usr_bob/avatar?v=b1.png')
    expect(wrapper.findAll('img')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('usr_')
    expect(wrapper.text()).not.toContain('3fa9c1')
  })

  it('authors 缺失(老后端)或没有这个人:显示「协作者」,不露用户 id;匿名访客的资料没有 username 也照常显示', async () => {
    call.mockResolvedValue({ annotations: [{ id: 'a1', body: '好', author: 'usr_gone', created_at: 1 }, { id: 'a2', body: '嗯', author: 'usr_anon', created_at: 2 }], authors: { usr_anon: { id: 'usr_anon', display_name: '匿名可见', avatar: null } } })
    const wrapper = await mountComments()
    expect(wrapper.findAll('[data-testid=comment-author]').map((node) => node.text())).toEqual(['协作者', '匿名可见'])
    call.mockResolvedValue({ annotations: [{ id: 'a1', body: '好', author: 'usr_gone', created_at: 1 }] })
    const bare = await mountComments()
    expect(bare.find('[data-testid=comment-author]').text()).toBe('协作者')
  })

  it('匿名访客(access.guest)不请求头像图片:头像接口对没登录的人回 401', async () => {
    const guest: ShareAccess = { ...access(true), guest: true }
    const wrapper = mount(DocComments, { props: { access: guest, collection: '_global', source: 'insight:ins_1' }, attachTo: document.body })
    await flushPromises()
    expect(wrapper.findAll('[data-testid=comment]').length).toBeGreaterThan(0)
    expect(wrapper.findAll('img')).toHaveLength(0)
  })

  it('回复:点「回复」展开回复框并聚焦;发出时带 parent_id、不带 mentions;成功后收起并重读', async () => {
    const wrapper = await mountComments()
    expect(wrapper.findAll('[data-testid=reply-open]')).toHaveLength(2)
    await wrapper.findAll('[data-testid=reply-open]')[0]!.trigger('click')
    expect(wrapper.findAll('[data-testid=reply-form]')).toHaveLength(1)
    expect(document.activeElement).toBe(wrapper.find('[data-testid=reply-input]').element)
    await wrapper.find('[data-testid=reply-input]').setValue('  收到  ')
    await wrapper.find('[data-testid=reply-send]').trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('add_annotation', { collection: '_global', source: 'insight:ins_1', body: '收到', parent_id: 'a1' })
    expect(wrapper.find('[data-testid=reply-form]').exists()).toBe(false)
    expect(call.mock.calls.filter(([name]) => name === 'list_annotations')).toHaveLength(2)
    expect(wrapper.emitted('posted')).toHaveLength(1)
  })

  it('一次只开一个回复框;取消(按钮或 Esc)收起,已写的内容不发出去', async () => {
    const wrapper = await mountComments()
    await wrapper.findAll('[data-testid=reply-open]')[0]!.trigger('click')
    await wrapper.find('[data-testid=reply-input]').setValue('写到一半')
    await wrapper.findAll('[data-testid=reply-open]')[0]!.trigger('click')
    expect(wrapper.findAll('[data-testid=reply-form]')).toHaveLength(1)
    await wrapper.find('[data-testid=reply-input]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid=reply-form]').exists()).toBe(false)
    await wrapper.findAll('[data-testid=reply-open]')[1]!.trigger('click')
    await wrapper.find('[data-testid=reply-cancel]').trigger('click')
    expect(wrapper.find('[data-testid=reply-form]').exists()).toBe(false)
    expect(call.mock.calls.some(([name]) => name === 'add_annotation')).toBe(false)
  })

  it('回复发不出去(例如评论刚被删):就近显示原因,回复框和内容留着', async () => {
    call.mockImplementation(async (name: string) => {
      if (name === 'add_annotation') throw { status: 404, message: 'not found: 评论 a1' }
      return threadData
    })
    const wrapper = await mountComments()
    await wrapper.findAll('[data-testid=reply-open]')[0]!.trigger('click')
    await wrapper.find('[data-testid=reply-input]').setValue('还在吗')
    await wrapper.find('[data-testid=reply-send]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=reply-error]').text()).toBe('这条评论或这篇文档已经不在了,可能刚被删除或移走。刷新页面后再试。')
    expect(wrapper.find('[data-testid=reply-error]').text()).not.toContain('a1')
    expect((wrapper.find('[data-testid=reply-input]').element as HTMLTextAreaElement).value).toBe('还在吗')
  })

  it('只能看的人:没有「回复」按钮,也没有输入框', async () => {
    const wrapper = await mountComments(false)
    expect(wrapper.findAll('[data-testid=comment]')).toHaveLength(4)
    expect(wrapper.find('[data-testid=reply-open]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=comment-input]').exists()).toBe(false)
  })

  it('回复的评论比较早、不在这次结果里:回复归成一串并说明,仍可继续回复到原评论', async () => {
    call.mockResolvedValue({ annotations: [{ id: 'r9', body: '孤儿回复', author: 'usr_bob', parent_id: 'old1', created_at: 5 }], authors: {} })
    const wrapper = await mountComments()
    expect(wrapper.find('[data-testid=comment-orphan]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=comment-replies] .kb-cmt-body').text()).toBe('孤儿回复')
    await wrapper.find('[data-testid=reply-open]').trigger('click')
    await wrapper.find('[data-testid=reply-input]').setValue('补充')
    await wrapper.find('[data-testid=reply-send]').trigger('click')
    await flushPromises()
    expect(call).toHaveBeenCalledWith('add_annotation', expect.objectContaining({ parent_id: 'old1', body: '补充' }))
  })

  it('没有权限(403 / 404):单独的无权限状态,不是「网络错误」,也没有重试按钮和输入框', async () => {
    for (const status of [403, 404]) {
      call.mockRejectedValueOnce({ status, message: 'forbidden: x' })
      const wrapper = await mountComments()
      expect(wrapper.find('[data-testid=comments-denied]').text()).toContain('没有权限查看评论')
      expect(wrapper.find('[data-testid=comments-error]').exists()).toBe(false)
      expect(wrapper.find('[data-testid=comment-input]').exists()).toBe(false)
    }
  })

  it('发表成功但刷新列表失败:评论已发出的事实要说,旧列表留着,可以重新加载', async () => {
    const wrapper = await mountComments()
    call.mockImplementation(async (name: string) => {
      if (name === 'list_annotations') throw { status: 500, message: 'internal' }
      return {}
    })
    await wrapper.find('[data-testid=comment-input]').setValue('再来一条')
    await wrapper.find('[data-testid=comment-send]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=comments-stale]').text()).toContain('评论已发出,但列表没有刷新')
    expect(wrapper.findAll('[data-testid=comment]')).toHaveLength(4)
    expect((wrapper.find('[data-testid=comment-input]').element as HTMLTextAreaElement).value).toBe('')
    call.mockImplementation(async () => threadData)
    await wrapper.find('[data-testid=comments-stale] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=comments-stale]').exists()).toBe(false)
  })

  it('切换文档时旧请求晚到,不覆盖新文档的评论', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined
    call.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
    const wrapper = mount(DocComments, { props: { ...props(true), source: 'insight:old' }, attachTo: document.body })
    await wrapper.setProps({ source: 'insight:new' })
    await flushPromises()
    releaseFirst({ annotations: [{ id: 'old', body: '旧文档的评论', author: 'usr_bob', created_at: 1 }], authors: {} })
    await flushPromises()
    expect(wrapper.text()).not.toContain('旧文档的评论')
    expect(wrapper.findAll('[data-testid=comment]')).toHaveLength(4)
  })

  it('评论总数通知父组件(含回复);列表满 100 条时提示只显示了最近的', async () => {
    const wrapper = await mountComments()
    expect(wrapper.emitted('counted')?.at(-1)).toEqual([4])
    call.mockResolvedValue({ annotations: Array.from({ length: 100 }, (_, index) => ({ id: `c${index}`, body: `评论 ${index}`, author: 'usr_bob', created_at: index + 1 })), authors: {} })
    const many = await mountComments()
    expect(many.find('[data-testid=comments-truncated]').text()).toContain('最近的 100 条')
    expect(wrapper.find('[data-testid=comments-truncated]').exists()).toBe(false)
  })
})
