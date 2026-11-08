// 公开页的几个小组件:密码页、状态页、游客改名。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { toasts } from '@kb-ui/components/useToast'

const api = vi.hoisted(() => ({ publicUnlock: vi.fn(), publicRename: vi.fn() }))
vi.mock('@/api/share', () => api)

import GuestNickname from './GuestNickname.vue'
import PublicPassword from './PublicPassword.vue'
import PublicStatus from './PublicStatus.vue'
import PublicWatermark from './PublicWatermark.vue'
import { statusFromError } from '@/utils/publicShare'
import { WATERMARK_TILES } from '@/utils/publicShare'

beforeEach(() => {
  setActivePinia(createPinia())
  api.publicUnlock.mockReset()
  api.publicRename.mockReset()
  toasts.splice(0)
  document.body.innerHTML = ''
})

describe('PublicPassword', () => {
  const mountGate = () => mount(PublicPassword, { props: { token: 'tok' }, attachTo: document.body })
  const type = async (wrapper: ReturnType<typeof mountGate>, text: string) => {
    const input = wrapper.find('[data-testid=public-password-input]')
    ;(input.element as HTMLInputElement).value = text
    await input.trigger('input')
  }

  it('什么都不透露:只有标题、说明、密码框;没输密码按钮是灰的', () => {
    const wrapper = mountGate()
    expect(wrapper.text()).toContain('这个链接需要访问密码')
    expect(wrapper.find('[data-testid=public-password-submit]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('input').attributes('type')).toBe('password')
  })

  it('输对:发出 unlock 并通知上层重取状态', async () => {
    api.publicUnlock.mockResolvedValue({ unlocked: true })
    const wrapper = mountGate()
    await type(wrapper, 'sesame1')
    await wrapper.find('[data-testid=public-password-submit]').trigger('click')
    await flushPromises()
    expect(api.publicUnlock).toHaveBeenCalledWith('tok', 'sesame1')
    expect(wrapper.emitted('unlocked')).toHaveLength(1)
  })

  it('密码不对:就近提示可以再试,密码留在框里方便改一个字', async () => {
    api.publicUnlock.mockRejectedValue({ status: 401, code: 'wrong_password', message: '访问密码不正确' })
    const wrapper = mountGate()
    await type(wrapper, 'sesame')
    await wrapper.find('[data-testid=public-password-submit]').trigger('click')
    await flushPromises()
    const error = wrapper.find('[data-testid=public-password-error]')
    expect(error.text()).toContain('访问密码不对')
    expect(error.attributes('data-locked')).toBe('false')
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('sesame')
    expect(wrapper.emitted('unlocked')).toBeUndefined()
  })

  it('被锁了(429):是另一种文案,用服务端的原话,并清掉密码框', async () => {
    api.publicUnlock.mockRejectedValue({ status: 429, code: 'locked', message: '输错次数太多,请 10 分钟后再试' })
    const wrapper = mountGate()
    await type(wrapper, 'sesame1')
    await wrapper.find('[data-testid=public-password-submit]').trigger('click')
    await flushPromises()
    const error = wrapper.find('[data-testid=public-password-error]')
    expect(error.text()).toBe('输错次数太多,请 10 分钟后再试')
    expect(error.attributes('data-locked')).toBe('true')
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
  })
})

describe('PublicStatus', () => {
  it('需要登录:给「登录」,登录后回到这个链接;失效类不给重试', () => {
    const login = mount(PublicStatus, { props: { view: statusFromError({ code: 'login_required', status: 401 }), token: 'tok123' } })
    expect(login.find('[data-testid=public-login]').attributes('href')).toBe('/login?next=%2Fs%2Ftok123')
    const gone = mount(PublicStatus, { props: { view: statusFromError({ code: 'link_expired', status: 410 }), token: 'tok' } })
    expect(gone.text()).toContain('这个链接已过期')
    expect(gone.find('[data-testid=public-retry]').exists()).toBe(false)
    expect(gone.find('[data-testid=public-login]').exists()).toBe(false)
  })

  it('连不上 / 限流:给「重试」,点了通知上层', async () => {
    const wrapper = mount(PublicStatus, { props: { view: statusFromError({ code: 'network', status: 0 }), token: 'tok' } })
    await wrapper.find('[data-testid=public-retry]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('用通用的状态页外壳(和 404 / 服务不可用同一套外观),不是各写各的', () => {
    const wrapper = mount(PublicStatus, { props: { view: statusFromError({ code: 'link_expired', status: 410 }), token: 'tok' } })
    expect(wrapper.find('[data-testid=public-status] [data-testid=status-page]').exists()).toBe(true)
  })

  it('记着后端错误码(给排查用,界面上不显示)', () => {
    const wrapper = mount(PublicStatus, { props: { view: statusFromError({ code: 'link_revoked', status: 410 }), token: 'tok' } })
    expect(wrapper.find('[data-testid=public-status]').attributes('data-code')).toBe('link_revoked')
    expect(wrapper.text()).not.toContain('link_revoked')
  })
})

describe('GuestNickname', () => {
  const mountName = () => mount(GuestNickname, { props: { token: 'tok', nickname: '访客 3fa9' }, attachTo: document.body })
  const typeName = async (wrapper: ReturnType<typeof mountName>, text: string) => {
    const input = wrapper.find('[data-testid=guest-input]')
    ;(input.element as HTMLInputElement).value = text
    await input.trigger('input')
  }

  it('默认显示昵称和「改名」;点改名出现输入框并聚焦当前昵称', async () => {
    const wrapper = mountName()
    expect(wrapper.find('[data-testid=guest-name]').text()).toBe('访客 3fa9')
    await wrapper.find('[data-testid=guest-rename]').trigger('click')
    await flushPromises()
    expect((wrapper.find('[data-testid=guest-input]').element as HTMLInputElement).value).toBe('访客 3fa9')
    expect(document.activeElement).toBe(wrapper.find('[data-testid=guest-input]').element)
  })

  it('改名:发给服务端(去掉首尾空格),成功后通知上层并提示', async () => {
    api.publicRename.mockResolvedValue({ nickname: '小王' })
    const wrapper = mountName()
    await wrapper.find('[data-testid=guest-rename]').trigger('click')
    await typeName(wrapper, '  小王 ')
    await wrapper.find('[data-testid=guest-save]').trigger('click')
    await flushPromises()
    expect(api.publicRename).toHaveBeenCalledWith('tok', '小王')
    expect(wrapper.emitted('renamed')![0]).toEqual(['小王'])
    expect(toasts[0]!.message).toBe('现在你是「小王」')
    expect(wrapper.find('[data-testid=guest-input]').exists()).toBe(false)
  })

  it('不合法的名字前端先拦(空 / 超过 20 字 / 含 < >),不发请求', async () => {
    const wrapper = mountName()
    await wrapper.find('[data-testid=guest-rename]').trigger('click')
    for (const [text, word] of [['   ', '不能为空'], ['字'.repeat(21), '最多 20 个字'], ['<b>x</b>', '不能包含']] as const) {
      await typeName(wrapper, text)
      await wrapper.find('[data-testid=guest-save]').trigger('click')
      expect(wrapper.find('[data-testid=guest-error]').text()).toContain(word)
    }
    expect(api.publicRename).not.toHaveBeenCalled()
  })

  it('服务端拒绝:显示它的话(去掉英文前缀),留在编辑里;Esc 取消', async () => {
    api.publicRename.mockRejectedValue({ status: 400, message: 'invalid input: 昵称已被占用' })
    const wrapper = mountName()
    await wrapper.find('[data-testid=guest-rename]').trigger('click')
    await typeName(wrapper, '小王')
    await wrapper.find('[data-testid=guest-save]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=guest-error]').text()).toBe('昵称已被占用')
    expect(wrapper.emitted('renamed')).toBeUndefined()
    await wrapper.find('[data-testid=guest-input]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid=guest-input]').exists()).toBe(false)
  })
})

describe('PublicWatermark', () => {
  it('铺满固定数量的水印文字;不挡点击、读屏软件跳过', () => {
    const wrapper = mount(PublicWatermark, { props: { text: '访客 · 2026-10-28 16:00' } })
    expect(wrapper.findAll('.kb-wm-tile')).toHaveLength(WATERMARK_TILES)
    expect(wrapper.find('.kb-wm-tile').text()).toBe('访客 · 2026-10-28 16:00')
    expect(wrapper.attributes('aria-hidden')).toBe('true')
  })
})
