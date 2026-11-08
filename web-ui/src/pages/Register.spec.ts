// 注册页里「用邀请码注册自动加邀请人为好友」的提示:注册前的说明 + 注册后以好友列表为准的确认。
// 只测这一块;注册表单本身的其它行为不在这里重复。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { AccountError } from '@/api/client'

const authStatus = vi.fn()
const checkInvite = vi.fn()
const registerAccount = vi.fn()
const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  authStatus: () => authStatus(),
  checkInvite: (...args: unknown[]) => checkInvite(...args),
  registerAccount: (...args: unknown[]) => registerAccount(...args),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn(async () => undefined)
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), RouterLink: { props: ['to'], template: '<a><slot /></a>' } }))

import { toasts } from '@kb-ui/components/useToast'
import Register from './Register.vue'

const CODE = 'KB-7H2K-9QXA'
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)

let wrapper: VueWrapper | null = null
async function mountPage(search = `?invite=${CODE}`, requireInvite = true) {
  window.history.replaceState({}, '', `/register${search}`)
  authStatus.mockResolvedValue({ registration_open: true, require_invite: requireInvite, mail_ready: true, site: { name: '知识库', tagline: '' } })
  wrapper = mount(Register, { attachTo: document.body })
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 520)) // 邀请码核对有 450ms 的去抖
  await flushPromises()
}
async function fillAndSubmit() {
  const set = async (selector: string, value: string) => {
    const el = $<HTMLInputElement>(selector)!
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
  }
  await set('#reg-email', 'new@example.com')
  await set('#reg-code', '123456')
  await set('#reg-user', 'new_user')
  await set('#reg-pass', 'a-Strong-pass-123')
  const submit = [...document.body.querySelectorAll('button')].find((button) => button.textContent!.trim() === '注册') as HTMLButtonElement
  submit.click()
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  toasts.splice(0)
  authStatus.mockReset()
  checkInvite.mockReset()
  registerAccount.mockReset()
  callCapability.mockReset()
  push.mockClear()
})

describe('注册前:邀请码有效时的好友提示', () => {
  it('接口没说这个码有没有开「自动加好友」(目前如此):用条件句如实说', async () => {
    checkInvite.mockResolvedValue({ valid: true, code: CODE })
    await mountPage()
    expect($('[data-testid="invite-friend-hint"]')!.textContent).toBe('如果邀请人开启了「自动加好友」,注册后你们会自动成为好友,之后可以在「好友」里改备注或删除。')
  })

  it('接口告诉我们开了:确定的说法;告诉我们没开:不提示', async () => {
    checkInvite.mockResolvedValue({ valid: true, code: CODE, auto_friend: true })
    await mountPage()
    expect($('[data-testid="invite-friend-hint"]')!.textContent).toContain('注册后你会自动和邀请人成为好友')
    wrapper!.unmount()
    document.body.innerHTML = ''
    checkInvite.mockResolvedValue({ valid: true, code: CODE, auto_friend: false })
    await mountPage()
    expect($('[data-testid="invite-friend-hint"]')).toBeNull()
  })

  it('邀请码无效:只有「无效」的说明,没有好友提示', async () => {
    checkInvite.mockResolvedValue({ valid: false, reason: '邀请码无效、已过期或已用完' })
    await mountPage()
    expect($('[data-testid="invite-friend-hint"]')).toBeNull()
    expect(document.body.textContent).toContain('邀请码无效、已过期或已用完')
  })
})

describe('注册后:以好友列表为准的确认', () => {
  it('用邀请码注册成功、好友列表里真的有邀请人:跳到首页并提示已成为好友', async () => {
    checkInvite.mockResolvedValue({ valid: true, code: CODE })
    registerAccount.mockResolvedValue({ registered: true })
    callCapability.mockResolvedValue({ friends: [{ id: 'usr_inviter', username: 'lin', display_name: '林一', avatar: null, remark: null, group_name: null, since: 1 }] })
    await mountPage()
    await fillAndSubmit()
    expect(registerAccount).toHaveBeenCalledWith(expect.objectContaining({ invite: CODE }))
    expect(push).toHaveBeenCalledWith('/home')
    expect(callCapability).toHaveBeenCalledWith('friend_list', {})
    expect(toasts.map((toast) => toast.message)).toEqual(['已和林一成为好友,可以在「好友」里查看'])
  })

  it('好友列表是空的(邀请码没开自动加好友):不提示', async () => {
    checkInvite.mockResolvedValue({ valid: true, code: CODE })
    registerAccount.mockResolvedValue({ registered: true })
    callCapability.mockResolvedValue({ friends: [] })
    await mountPage()
    await fillAndSubmit()
    expect(push).toHaveBeenCalledWith('/home')
    expect(toasts).toHaveLength(0)
  })

  it('好友不止一位(新账号不该这样):猜不出谁是邀请人,宁可不提示', async () => {
    checkInvite.mockResolvedValue({ valid: true, code: CODE })
    registerAccount.mockResolvedValue({ registered: true })
    const friend = (id: string) => ({ id: `usr_${id}`, username: id, display_name: id, avatar: null, remark: null, group_name: null, since: 1 })
    callCapability.mockResolvedValue({ friends: [friend('a'), friend('b')] })
    await mountPage()
    await fillAndSubmit()
    expect(callCapability).toHaveBeenCalledWith('friend_list', {})
    expect(toasts).toHaveLength(0)
  })

  it('取好友列表失败(角色没有好友功能 403 / 断网):安静地跳过,注册本身不受影响', async () => {
    checkInvite.mockResolvedValue({ valid: true, code: CODE })
    registerAccount.mockResolvedValue({ registered: true })
    callCapability.mockRejectedValue(new Error('forbidden'))
    await mountPage()
    await fillAndSubmit()
    expect(push).toHaveBeenCalledWith('/home')
    expect(toasts).toHaveLength(0)
  })

  it('没有用邀请码注册:不去查好友列表', async () => {
    registerAccount.mockResolvedValue({ registered: true })
    await mountPage('', false)
    await fillAndSubmit()
    expect(registerAccount).toHaveBeenCalled()
    expect(callCapability).not.toHaveBeenCalled()
  })
})

describe('注册失败的报错写成「发生了什么 + 怎么办」', () => {
  it('断网:不把浏览器的英文 Failed to fetch 原样显示在表单上', async () => {
    registerAccount.mockRejectedValue(new TypeError('Failed to fetch'))
    await mountPage('', false)
    await fillAndSubmit()
    const alert = $('.auth-error')!.textContent!
    expect(alert).not.toContain('Failed to fetch')
    expect(alert).toContain('连不上服务器')
    expect(push).not.toHaveBeenCalled()
  })

  it('服务端没说原因(只有状态码):换成带下一步的话,不露状态码', async () => {
    registerAccount.mockRejectedValue(new AccountError('请求失败(502)', 502))
    await mountPage('', false)
    await fillAndSubmit()
    const alert = $('.auth-error')!.textContent!
    expect(alert).not.toContain('502')
    expect(alert).toContain('请稍后再试')
  })

  it('服务端给了中文原因:原样显示(例如验证码不对)', async () => {
    registerAccount.mockRejectedValue(new AccountError('验证码不对,或者已经过期。', 400))
    await mountPage('', false)
    await fillAndSubmit()
    expect($('.auth-error')!.textContent).toContain('验证码不对,或者已经过期。')
  })
})

describe('取站点状态失败:整页不能只剩一句话', () => {
  it('连不上时说清楚并给「重试」,点了重新取,取到后显示注册表单', async () => {
    window.history.replaceState({}, '', '/register')
    authStatus.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    authStatus.mockResolvedValue({ registration_open: true, require_invite: false, mail_ready: true, site: { name: '知识库', tagline: '' } })
    wrapper = mount(Register, { attachTo: document.body })
    await flushPromises()
    const alert = $('.auth-box [role=alert]')!.textContent!
    expect(alert).toContain('连不上服务器')
    expect(alert).not.toContain('Failed to fetch')
    expect($('#reg-email')).toBeNull()
    $<HTMLButtonElement>('[data-testid=auth-retry]')!.click()
    await flushPromises()
    expect(authStatus).toHaveBeenCalledTimes(2)
    expect($('[data-testid=auth-retry]')).toBeNull()
    expect($('#reg-email')).not.toBeNull()
  })
})
