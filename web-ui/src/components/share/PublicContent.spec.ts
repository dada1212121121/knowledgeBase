// 公开页正文:单篇文档、文件夹逐级、合集的根列表(笔记标题限量取)、离开前确认。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { PublicActive, ShareTarget } from '@/api/share'

const call = vi.hoisted(() => vi.fn())
vi.mock('@/api/share', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // 打开别人的内容全经这个:记下每次调用,断言走的是 /share/{token}/call
  linkAccess: (token: string, can: object) => ({ call: (...args: unknown[]) => call(token, ...args), rawUrl: () => '', can }),
}))
const ask = vi.hoisted(() => vi.fn(async (_options: { title: string }) => true))
vi.mock('@kb-ui/index', async (original) => ({ ...(await original<Record<string, unknown>>()), useConfirm: () => ({ ask }) }))

const docState = vi.hoisted(() => ({ dirty: false }))
vi.mock('./SharedDoc.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      props: { target: { type: Object, required: true }, access: { type: Object, required: true }, myId: { type: String, default: '' } },
      emits: ['dirty', 'loaded'],
      setup(props, { expose }) {
        expose({ get dirty() { return docState.dirty } })
        return () => h('div', { class: 'doc-stub', 'data-myid': props.myId }, `${(props.target as ShareTarget).kind}:${(props.target as ShareTarget).id ?? (props.target as ShareTarget).path}`)
      },
    }),
  }
})
vi.mock('./SharedFolder.vue', () => ({
  __esModule: true,
  default: { name: 'SharedFolder', props: { target: { type: Object, default: () => ({}) } }, emits: ['open'], template: `<div class="folder-stub"><button class="open-file" @click="$emit('open', { kind: 'file', space_id: 'sp', collection: '_global', path: 'docs/a.md' }, 'a.md')">打开</button>{{ target.kind }}</div>` },
}))

import PublicContent from './PublicContent.vue'

const note: ShareTarget = { kind: 'insight', space_id: 'sp', collection: '_global', id: 'ins_1' }
const dir: ShareTarget = { kind: 'dir', space_id: 'sp', collection: '_global', path: 'docs' }
const file: ShareTarget = { kind: 'file', space_id: 'sp', collection: '_global', path: 'guide.md' }
const info = (extra: Partial<PublicActive> = {}): PublicActive => ({
  state: 'active', requires_password: false, site: { name: '知识库' }, space_id: 'sp', bundle: false, title: null, roots: [note], role: 'viewer',
  can: { view: true, comment: false, edit: false, download: true }, allow_download: true, watermark: null, visitor: { kind: 'guest', nickname: '访客 3fa9' }, owner: null, audience: 'anyone', ...extra,
})
async function mountContent(data: PublicActive) {
  const wrapper = mount(PublicContent, { props: { info: data, token: 'tok' }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  call.mockReset()
  call.mockImplementation(async (_token: string, name: string, args: { id?: string }) => (name === 'get_item' ? { item: { title: args.id === 'ins_a' ? '部署清单' : null } } : {}))
  ask.mockReset()
  ask.mockResolvedValue(true)
  docState.dirty = false
  document.body.innerHTML = ''
})

describe('单个链接', () => {
  it('指向一篇文档:直接显示它,不出现面包屑;游客没有 myId,登录用户有', async () => {
    const guest = await mountContent(info())
    expect(guest.find('.doc-stub').text()).toBe('insight:ins_1')
    expect(guest.find('.kb-pcon-crumb').exists()).toBe(false)
    expect(guest.find('.doc-stub').attributes('data-myid')).toBeUndefined()
    const user = await mountContent(info({ visitor: { kind: 'user', id: 'usr_me', display_name: '我' } }))
    expect(user.find('.doc-stub').attributes('data-myid')).toBe('usr_me')
  })

  it('指向文件夹:显示目录;点一篇进入它,出现面包屑,点面包屑回目录', async () => {
    const wrapper = await mountContent(info({ roots: [dir] }))
    expect(wrapper.find('.folder-stub').exists()).toBe(true)
    expect(wrapper.find('.kb-pcon-crumb').exists()).toBe(false)
    await wrapper.find('.open-file').trigger('click')
    await flushPromises()
    expect(wrapper.find('.doc-stub').text()).toBe('file:docs/a.md')
    expect(wrapper.find('.kb-pcon-crumb').text()).toContain('a.md')
    await wrapper.find('.kb-pcon-crumb-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.folder-stub').exists()).toBe(true)
  })

  it('有未保存的修改时离开要确认;选「继续编辑」就留下', async () => {
    const wrapper = await mountContent(info({ roots: [dir] }))
    await wrapper.find('.open-file').trigger('click')
    await flushPromises()
    docState.dirty = true
    ask.mockResolvedValueOnce(false)
    await wrapper.find('.kb-pcon-crumb-btn').trigger('click')
    await flushPromises()
    expect(ask.mock.calls[0]![0].title).toBe('放弃未保存的修改?')
    expect(wrapper.find('.doc-stub').exists()).toBe(true)
    await wrapper.find('.kb-pcon-crumb-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.folder-stub').exists()).toBe(true)
  })
})

describe('合集链接', () => {
  const bundle = (roots: ShareTarget[]) => info({ bundle: true, title: '本周评审', roots })

  it('根列表:标题 + 共几项;笔记取到标题就显示,没取到显示「笔记」(不露 id);其它按名字', async () => {
    const wrapper = await mountContent(bundle([{ ...note, id: 'ins_a' }, { ...note, id: 'ins_b' }, dir, file]))
    expect(wrapper.find('[data-testid=public-title]').text()).toBe('本周评审')
    expect(wrapper.text()).toContain('共 4 项')
    const names = wrapper.findAll('.kb-sfold-main b').map((el) => el.text())
    expect(names).toEqual(['部署清单', '笔记', 'docs', 'guide.md'])
    expect(wrapper.text()).not.toContain('ins_a')
    // 标题走链接的白名单能力,令牌在第一个参数里
    expect(call).toHaveBeenCalledWith('tok', 'get_item', { id: 'ins_a' })
  })

  it('点一项进去:文档显示文档,文件夹显示目录;面包屑从合集名开始,点合集名回根列表', async () => {
    const wrapper = await mountContent(bundle([{ ...note, id: 'ins_a' }, dir]))
    await wrapper.find('[data-testid="public-root-docs"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.folder-stub').text()).toContain('dir')
    expect(wrapper.find('.kb-pcon-crumb').text()).toContain('本周评审')
    await wrapper.find('.open-file').trigger('click')
    await flushPromises()
    expect(wrapper.find('.kb-pcon-crumb').text()).toContain('docs')
    expect(wrapper.find('.kb-pcon-crumb').text()).toContain('a.md')
    await wrapper.find('[data-testid=public-crumb-root]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=public-roots]').exists()).toBe(true)
  })

  it('合集里只有一项:当成单个链接,直接打开', async () => {
    const wrapper = await mountContent(bundle([note]))
    expect(wrapper.find('.doc-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid=public-roots]').exists()).toBe(false)
  })

  it('取标题最多取前 60 个笔记,每次 6 个并发——合集有几百项也不会一口气发几百个请求', async () => {
    const roots = Array.from({ length: 100 }, (_, index): ShareTarget => ({ ...note, id: `ins_${index}` }))
    let running = 0
    let peak = 0
    call.mockImplementation(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running -= 1
      return { item: { title: 't' } }
    })
    await mountContent(bundle(roots))
    // 等 10 轮取完(机器忙时每轮不止 1ms),最多等 5 秒
    const taken = () => call.mock.calls.filter(([, name]) => name === 'get_item').length
    for (let waited = 0; taken() < 60 && waited < 5000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 50)) // 再多等一会儿,确认不会超过 60
    expect(taken()).toBe(60)
    expect(peak).toBeLessThanOrEqual(6)
  })

  it('某个标题取不到(例如没权限了):只是显示「笔记」,不报错、不影响其它项', async () => {
    call.mockRejectedValue({ status: 404 })
    const wrapper = await mountContent(bundle([note, dir]))
    expect(wrapper.findAll('.kb-sfold-main b').map((el) => el.text())).toEqual(['笔记', 'docs'])
  })
})
