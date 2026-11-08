// 登录页的两步验证一步:进入 / 输错 / 挑战过期 / 成功,以及「挑战和验证码不落地」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { AccountError } from '@/api/client'

const push = vi.fn()
const login = vi.fn()
const loginTotp = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  authStatus: vi.fn(async () => ({ password_set: true, logged_in: false, registration_open: false, require_invite: false, mail_ready: true, site: { name: '知识库', tagline: '' } })),
  health: vi.fn(async () => ({ version: '0.4.0' })),
  login: (...args: unknown[]) => login(...args),
  loginTotp: (...args: unknown[]) => loginTotp(...args),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a :href="to"><slot /></a>' },
}))

import Login from './Login.vue'

// 页面里用的是全局注册的 <router-link>,测试里换成普通链接
const mountLogin = () => mount(Login, { attachTo: document.body, global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })

const bad = (status: number, code: string, message = '后端的话') => new AccountError(message, status, 0, code)

async function toCodeStep() {
  login.mockResolvedValueOnce({ kind: 'totp', challenge: 'chal-secret' })
  const wrapper = mountLogin()
  await flushPromises()
  await wrapper.find('#login-user').setValue('alice')
  await wrapper.find('#login-pass').setValue('Correct-Horse-9')
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  push.mockClear()
  login.mockReset()
  loginTotp.mockReset()
  window.history.replaceState({}, '', '/login')
})

describe('Login 两步验证', () => {
  it('账号开着两步验证:进入验证码一步,密码框消失,验证码框聚焦', async () => {
    const wrapper = await toCodeStep()
    expect(wrapper.find('[data-testid="login-totp"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('两步验证')
    expect(wrapper.find('#login-pass').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.kb-otp-input').element)
    expect(push).not.toHaveBeenCalled()
  })

  it('没输满 6 位时不能提交;输满后用挑战 + 验证码提交,成功去首页', async () => {
    const wrapper = await toCodeStep()
    const submit = wrapper.find('.auth-submit')
    await wrapper.find('.kb-otp-input').setValue('12345')
    expect(submit.attributes('disabled')).toBeDefined()
    await wrapper.find('.kb-otp-input').setValue('123456')
    expect(submit.attributes('disabled')).toBeUndefined()
    loginTotp.mockResolvedValueOnce(undefined)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(loginTotp).toHaveBeenCalledWith('chal-secret', '123456')
    expect(push).toHaveBeenCalledWith('/home')
  })

  it('登录前带的 ?next= 在两步验证之后依然生效,但只认站内路径', async () => {
    window.history.replaceState({}, '', '/login?next=%2Fkb%3Fitem%3Dx')
    const wrapper = await toCodeStep()
    loginTotp.mockResolvedValueOnce(undefined)
    await wrapper.find('.kb-otp-input').setValue('123456')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(push).toHaveBeenCalledWith('/kb?item=x')
    push.mockClear()
    window.history.replaceState({}, '', '/login?next=%2F%2Fevil.example')
    const second = await toCodeStep()
    loginTotp.mockResolvedValueOnce(undefined)
    await second.find('.kb-otp-input').setValue('123456')
    await second.find('form').trigger('submit')
    await flushPromises()
    expect(push).toHaveBeenCalledWith('/home')
  })

  it('验证码不对:提示、清空输入、仍停在这一步', async () => {
    const wrapper = await toCodeStep()
    loginTotp.mockRejectedValueOnce(bad(401, 'bad_code'))
    await wrapper.find('.kb-otp-input').setValue('000000')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.auth-error').text()).toContain('验证码不对')
    expect((wrapper.find('.kb-otp-input').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-testid="login-totp"]').exists()).toBe(true)
    expect(push).not.toHaveBeenCalled()
  })

  it('次数太多(429):说等 15 分钟,不建议换恢复码,不退回密码页', async () => {
    const wrapper = await toCodeStep()
    loginTotp.mockRejectedValueOnce(bad(429, 'rate_limited'))
    await wrapper.find('.kb-otp-input').setValue('000000')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const text = wrapper.find('.auth-error').text()
    expect(text).toContain('15 分钟')
    expect(text).not.toContain('恢复码')
    expect(wrapper.find('[data-testid="login-totp"]').exists()).toBe(true)
  })

  it('挑战过期:退回密码一步,说明原因,密码框是空的,之后不会再拿旧挑战提交', async () => {
    const wrapper = await toCodeStep()
    loginTotp.mockRejectedValueOnce(bad(401, 'challenge_expired'))
    await wrapper.find('.kb-otp-input').setValue('123456')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="login-totp"]').exists()).toBe(false)
    expect(wrapper.find('.auth-error').text()).toContain('重新输入密码')
    expect((wrapper.find('#login-pass').element as HTMLInputElement).value).toBe('')
    // 重新登录拿到新挑战
    login.mockResolvedValueOnce({ kind: 'totp', challenge: 'chal-two' })
    await wrapper.find('#login-pass').setValue('Correct-Horse-9')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    loginTotp.mockResolvedValueOnce(undefined)
    await wrapper.find('.kb-otp-input').setValue('123456')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(loginTotp).toHaveBeenLastCalledWith('chal-two', '123456')
  })

  it('改用恢复码:大小写和空格规整,形状不对不能提交,提交的是规整后的恢复码', async () => {
    const wrapper = await toCodeStep()
    await wrapper.findAll('button').find((button) => button.text() === '使用恢复码')!.trigger('click')
    const input = wrapper.find('#login-recovery')
    expect(input.exists()).toBe(true)
    expect(wrapper.find('.kb-otp').exists()).toBe(false)
    await input.setValue(' abcd efgh j2t3 ')
    expect((input.element as HTMLInputElement).value).toBe('ABCDEFGHJ2T3')
    expect(wrapper.find('.auth-submit').attributes('disabled')).toBeUndefined()
    await input.setValue('ABCD-EFGH-J0T3')
    expect(wrapper.find('.auth-submit').attributes('disabled')).toBeDefined()
    await input.setValue('abcd-efgh-j2t3')
    loginTotp.mockResolvedValueOnce(undefined)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(loginTotp).toHaveBeenCalledWith('chal-secret', 'ABCD-EFGH-J2T3')
  })

  it('点「返回」:挑战作废,回到密码一步', async () => {
    const wrapper = await toCodeStep()
    await wrapper.findAll('button').find((button) => button.text().startsWith('返回'))!.trigger('click')
    expect(wrapper.find('#login-pass').exists()).toBe(true)
    expect((wrapper.find('#login-pass').element as HTMLInputElement).value).toBe('')
  })

  it('挑战和验证码不进地址栏,也不写本地存储', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem')
    const wrapper = await toCodeStep()
    loginTotp.mockRejectedValueOnce(bad(401, 'bad_code'))
    await wrapper.find('.kb-otp-input').setValue('654321')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const written = local.mock.calls.map((call) => call.join('='))
    expect(written.join('\n')).not.toMatch(/chal-secret|654321|Correct-Horse/)
    expect(window.location.href).not.toMatch(/chal-secret|654321/)
    expect(wrapper.html()).not.toContain('chal-secret')
    local.mockRestore()
  })

  it('密码错(没到第二步):沿用后端的话,不进验证码一步', async () => {
    login.mockRejectedValueOnce(bad(401, 'unauthorized', '用户名或密码不对'))
    const wrapper = mountLogin()
    await flushPromises()
    await wrapper.find('#login-pass').setValue('x')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.auth-error').text()).toBe('用户名或密码不对')
    expect(wrapper.find('[data-testid="login-totp"]').exists()).toBe(false)
  })
})

describe('Login 报错写成「发生了什么 + 怎么办」', () => {
  async function submitWith(failure: unknown) {
    login.mockRejectedValueOnce(failure)
    const wrapper = mountLogin()
    await flushPromises()
    await wrapper.find('#login-pass').setValue('x')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    return wrapper.find('.auth-error').text()
  }

  it('断网:fetch 抛的英文 TypeError 不原样显示,说连不上并让人检查网络', async () => {
    for (const english of ['Failed to fetch', 'Load failed']) {
      const text = await submitWith(new TypeError(english))
      expect(text).not.toContain(english)
      expect(text).toContain('连不上服务器')
      expect(text).toContain('检查网络')
    }
  })

  it('服务端没给原因(只有「登录失败」/「请求失败(502)」):换成带下一步的话,不露状态码', async () => {
    for (const bare of ['登录失败', '请求失败(502)']) {
      const text = await submitWith(new AccountError(bare, 502))
      expect(text).not.toContain('502')
      expect(text).toContain('请稍后再试')
    }
  })
})
