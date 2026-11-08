// 公开分享页:状态机(加载 / 密码 / 失效 / 正文)、游客与登录用户的顶栏、提示、noindex 与标题。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { PublicActive } from '@/api/share'

const api = vi.hoisted(() => ({ publicInfo: vi.fn(), publicUnlock: vi.fn(), publicRename: vi.fn() }))
vi.mock('@/api/share', async (original) => ({ ...(await original<Record<string, unknown>>()), ...api }))
const route = vi.hoisted(() => ({ params: { token: 'tok123' } as { token: string } }))
vi.mock('vue-router', () => ({ useRoute: () => route }))
// 正文由 PublicContent 负责(各有单测),这里只看页面把什么交给它
vi.mock('@/components/share/PublicContent.vue', () => ({
  __esModule: true,
  default: { name: 'PublicContent', props: { info: { type: Object, default: () => ({}) }, token: { type: String, default: '' } }, emits: ['title', 'dirty'], template: '<div class="content-stub" :data-token="token">{{ info.roots.length }}</div>' },
}))

import PublicShare from './PublicShare.vue'

const active = (extra: Partial<PublicActive> = {}): PublicActive => ({
  state: 'active', requires_password: false, site: { name: '团队知识库' }, space_id: 'sp', bundle: false, title: '部署清单',
  roots: [{ kind: 'insight', space_id: 'sp', collection: '_global', id: 'ins_1' }], role: 'viewer',
  can: { view: true, comment: false, edit: false, download: true }, allow_download: true, watermark: null,
  visitor: { kind: 'guest', nickname: '访客 3fa9' }, owner: { id: 'usr_a', display_name: 'Alice', avatar: null }, audience: 'anyone', ...extra,
})
async function mountPage() {
  const wrapper = mount(PublicShare, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  Object.values(api).forEach((fn) => fn.mockReset())
  api.publicInfo.mockResolvedValue(active())
  route.params.token = 'tok123'
  document.head.querySelectorAll('meta[name=robots]').forEach((el) => el.remove())
  document.title = '原标题'
  document.body.innerHTML = ''
})

describe('状态机', () => {
  it('加载中:骨架屏;取状态用路由里的令牌(只取一次,每次取算一次「打开」)', async () => {
    api.publicInfo.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(PublicShare)
    await flushPromises()
    expect(wrapper.find('[aria-busy=true]').exists()).toBe(true)
    expect(api.publicInfo).toHaveBeenCalledTimes(1)
    expect(api.publicInfo).toHaveBeenCalledWith('tok123')
  })

  it('可看:顶部一小行站点名;正文区拿到链接信息和令牌;来源写「谁分享给你」', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-brand]').text()).toBe('团队知识库')
    expect(wrapper.find('[data-testid=public-owner]').text()).toContain('Alice 分享给你')
    expect(wrapper.find('.content-stub').attributes('data-token')).toBe('tok123')
    expect(wrapper.find('[data-testid=public-role]').text()).toBe('可查看')
  })

  it('分享人有头像:用按链接校验的地址(游客没登录,/users/{id}/avatar 对他们是 401);没有头像:画首字母、不发图片请求', async () => {
    api.publicInfo.mockResolvedValueOnce(active({ owner: { id: 'usr_a', display_name: 'Alice', avatar: 'a1.png' } }))
    const withAvatar = await mountPage()
    expect(withAvatar.find('[data-testid=public-owner] img').attributes('src')).toBe('/api/v1/share/tok123/owner-avatar?v=a1.png')
    expect(withAvatar.html()).not.toContain('/api/v1/users/usr_a/avatar')
    api.publicInfo.mockResolvedValueOnce(active({ owner: { id: 'usr_a', display_name: 'Alice', avatar: null } }))
    const without = await mountPage()
    expect(without.find('[data-testid=public-owner] img').exists()).toBe(false)
    expect(without.find('[data-testid=public-owner]').text()).toContain('A')
  })

  it('需要密码:只显示密码页,不显示正文和任何内容信息;输对后重取状态再进入正文', async () => {
    api.publicInfo.mockResolvedValueOnce({ state: 'locked', requires_password: true, site: { name: '团队知识库' } })
    api.publicUnlock.mockResolvedValue({ unlocked: true })
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-password]').exists()).toBe(true)
    expect(wrapper.find('.content-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid=public-owner]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=public-role]').exists()).toBe(false)
    const input = wrapper.find('[data-testid=public-password-input]')
    ;(input.element as HTMLInputElement).value = 'sesame1'
    await input.trigger('input')
    await wrapper.find('[data-testid=public-password-submit]').trigger('click')
    await flushPromises()
    expect(api.publicUnlock).toHaveBeenCalledWith('tok123', 'sesame1')
    expect(api.publicInfo).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.content-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid=public-password]').exists()).toBe(false)
  })

  it('失效(410):显示状态页,不显示正文也不露英文;失效类没有「重试」', async () => {
    api.publicInfo.mockRejectedValue({ status: 410, code: 'link_expired', message: '这个链接已过期' })
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-status]').text()).toContain('这个链接已过期')
    expect(wrapper.find('.content-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid=public-retry]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=public-brand]').text()).toBe('知识库')
  })

  it('连不上:状态页给「重试」,点了重新取,成功后进入正文', async () => {
    api.publicInfo.mockRejectedValueOnce({ status: 0, code: 'network', message: '连不上服务器。' })
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-status]').attributes('data-code')).toBe('network')
    api.publicInfo.mockResolvedValueOnce(active())
    await wrapper.find('[data-testid=public-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.content-stub').exists()).toBe(true)
    expect(api.publicInfo).toHaveBeenCalledTimes(2)
  })
})

describe('访问者与提示', () => {
  it('游客:顶栏有昵称(可改名)和「登录」;提示「想参与编辑?登录」;没有评论 / 编辑权限时不提醒会记在名下', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=guest-name]').text()).toBe('访客 3fa9')
    expect(wrapper.find('[data-testid=public-login-link]').attributes('href')).toBe('/login?next=%2Fs%2Ftok123')
    expect(wrapper.find('[data-testid=public-login-hint]').text()).toContain('想参与编辑')
    expect(wrapper.find('[data-testid=public-guest-note]').exists()).toBe(false)
  })

  it('游客能评论 / 编辑:明说「会记在『访客 3fa9』名下,所有者能回退」;能编辑了就不再催登录', async () => {
    api.publicInfo.mockResolvedValue(active({ role: 'editor', can: { view: true, comment: true, edit: true, download: true } }))
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-guest-note]').text()).toContain('会记在「访客 3fa9」名下')
    expect(wrapper.find('[data-testid=public-login-hint]').exists()).toBe(false)
  })

  it('改名后顶栏和提示立刻用新名字,不必整页重取', async () => {
    api.publicInfo.mockResolvedValue(active({ can: { view: true, comment: true, edit: false, download: true } }))
    api.publicRename.mockResolvedValue({ nickname: '小王' })
    const wrapper = await mountPage()
    await wrapper.find('[data-testid=guest-rename]').trigger('click')
    const input = wrapper.find('[data-testid=guest-input]')
    ;(input.element as HTMLInputElement).value = '小王'
    await input.trigger('input')
    await wrapper.find('[data-testid=guest-save]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=guest-name]').text()).toBe('小王')
    expect(wrapper.find('[data-testid=public-guest-note]').text()).toContain('「小王」')
    expect(api.publicInfo).toHaveBeenCalledTimes(1)
  })

  it('登录用户:顶栏显示他的名字,没有改名和「登录」,也没有「想参与编辑」', async () => {
    api.publicInfo.mockResolvedValue(active({ visitor: { kind: 'user', id: 'usr_me', username: 'me', display_name: '我' } }))
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-user]').text()).toContain('我')
    expect(wrapper.find('[data-testid=guest-nickname]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=public-login-link]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=public-login-hint]').exists()).toBe(false)
  })

  it('开了水印才显示水印层', async () => {
    expect((await mountPage()).find('[data-testid=public-watermark]').exists()).toBe(false)
    api.publicInfo.mockResolvedValue(active({ watermark: '访客 · 2026-10-28 16:00' }))
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-watermark]').text()).toContain('访客 · 2026-10-28 16:00')
  })

  it('微信 / QQ 内置浏览器里能下载的链接:提示「在浏览器中打开」后再下载', async () => {
    const original = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone) MicroMessenger/8.0', configurable: true })
    const wrapper = await mountPage()
    expect(wrapper.find('[data-testid=public-inapp]').text()).toContain('在浏览器中打开')
    api.publicInfo.mockResolvedValue(active({ can: { view: true, comment: false, edit: false, download: false } }))
    expect((await mountPage()).find('[data-testid=public-inapp]').exists()).toBe(false)
    Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true })
  })
})

describe('页面外壳', () => {
  it('加 noindex 的 meta,离开时撤掉;标题跟着内容走,离开时还原', async () => {
    const wrapper = await mountPage()
    expect(document.head.querySelector('meta[name=robots]')?.getAttribute('content')).toContain('noindex')
    wrapper.unmount()
    expect(document.head.querySelector('meta[name=robots]')).toBeNull()
    expect(document.title).toBe('原标题')
  })

  it('页面自己挂提示条和确认框(独立页面没有外壳)', async () => {
    const wrapper = await mountPage()
    expect(wrapper.findComponent({ name: 'KbToastStack' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'KbConfirmHost' }).exists()).toBe(true)
  })
})
