// 链接页:创建(范围受功能点限制)、完整地址只显示一次、改设置、重置 / 删除要确认、访问统计,以及四种状态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { LinkInfo, ShareTarget } from '@/api/share'

const api = vi.hoisted(() => ({
  linkCreate: vi.fn(),
  linkGet: vi.fn(),
  linkUpdate: vi.fn(),
  linkReset: vi.fn(),
  linkRevoke: vi.fn(),
  linkStats: vi.fn(),
}))
vi.mock('@/api/share', () => api)
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; tone?: string; confirmText?: string }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    // 和真实的确认框一样:确认后才执行 action,失败时不关闭
    ask: async (options: { title: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))

import ShareLink from './ShareLink.vue'
import { useSessionStore } from '@/stores/session'

const note: ShareTarget = { kind: 'insight', space_id: 'sp_me', collection: '_global', id: 'ins_1' }
const dirA: ShareTarget = { kind: 'dir', space_id: 'sp_me', collection: '_global', path: 'a' }
const dirB: ShareTarget = { kind: 'dir', space_id: 'sp_me', collection: '_global', path: 'b' }
const TOKEN_URL = 'https://kbase.example.com/s/q7Hk2xAbCdEfGhIjKlMn'

const link = (extra: Partial<LinkInfo> = {}): LinkInfo => ({
  id: 'lnk_1', hint: 'KlMn', title: '部署清单', bundle: false, roots: [note], audience: 'logged_in', role: 'viewer', has_password: false,
  expires_at: null, allow_download: true, watermark: false, allow_reshare: false, enabled: true, state: 'active', views: 0, last_view_at: null,
  created_at: 1, guest_role: null, ...extra,
})

function signIn(features: string[] = ['collab.share', 'collab.link_users', 'collab.link_guest']) {
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 'sp_me', must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
}

async function mountLink(targets: ShareTarget[] = [note]) {
  const wrapper = mount(ShareLink, { props: { targets }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const switchOf = (wrapper: ReturnType<typeof mount>, testid: string) => wrapper.find(`[data-testid=${testid}]`)
const selectOf = (wrapper: ReturnType<typeof mount>, testid: string) => wrapper.find(`[data-testid=${testid}]`).findComponent({ name: 'KbSelect' })

beforeEach(() => {
  setActivePinia(createPinia())
  signIn()
  for (const fn of Object.values(api)) fn.mockReset()
  confirmState.answer = true
  confirmState.calls = []
  api.linkGet.mockResolvedValue({ target: note, links: [] })
  api.linkCreate.mockResolvedValue({ link: link(), url: TOKEN_URL })
  api.linkUpdate.mockImplementation(async (args: { id: string }) => ({ link: link({ ...args }) }))
  api.linkReset.mockResolvedValue({ link: link(), url: `${TOKEN_URL}X` })
  api.linkRevoke.mockResolvedValue({ revoked: true })
  api.linkStats.mockResolvedValue({ views: 3, last_view_at: 1, visitors: [], anonymous_note: '匿名访客只统计次数' })
  document.body.innerHTML = ''
})

describe('四种状态', () => {
  it('加载中:骨架屏', async () => {
    api.linkGet.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(ShareLink, { props: { targets: [note] } })
    await flushPromises()
    expect(wrapper.find('[aria-busy=true]').exists()).toBe(true)
  })

  it('还没有链接:空状态 + 创建表单(创建是明确的动作,不在选下拉时悄悄发生)', async () => {
    const wrapper = await mountLink()
    expect(wrapper.find('[data-testid=share-link-create]').text()).toContain('还没有分享链接')
    expect(api.linkCreate).not.toHaveBeenCalled()
  })

  it('加载失败:可重试;没有权限:显示无权限', async () => {
    api.linkGet.mockRejectedValueOnce({ status: 500, message: 'internal: x' })
    const failed = await mountLink()
    expect(failed.find('[data-testid=share-error]').text()).toContain('没有加载出来')
    await failed.find('[data-testid=share-error] button').trigger('click')
    await flushPromises()
    expect(api.linkGet).toHaveBeenCalledTimes(2)

    api.linkGet.mockRejectedValueOnce({ status: 403, message: 'forbidden: x' })
    const denied = await mountLink()
    expect(denied.find('[data-testid=share-denied]').exists()).toBe(true)
    expect(denied.find('[data-testid=share-create-submit]').exists()).toBe(false)
  })
})

describe('创建', () => {
  it('访问范围按功能点:没开通游客链接的账号选不到「任何人」,并说明', async () => {
    signIn(['collab.share', 'collab.link_users'])
    const wrapper = await mountLink()
    const options = (selectOf(wrapper, 'share-create-audience').props('options') as { value: string }[]).map((o) => o.value)
    expect(options).toEqual(['collaborators', 'logged_in'])
    expect(wrapper.text()).toContain('你的账号没有开通:任何人(含游客)')
  })

  it('默认选「登录用户」(比「任何人」安全);都没开通就是「仅协作者」', async () => {
    const wrapper = await mountLink()
    expect(selectOf(wrapper, 'share-create-audience').props('modelValue')).toBe('logged_in')
    signIn(['collab.share'])
    const plain = await mountLink()
    expect(selectOf(plain, 'share-create-audience').props('modelValue')).toBe('collaborators')
  })

  it('创建:带范围 / 角色;永久有效不带 expires_days;不带 allow_reshare;拿到地址后明说只显示一次', async () => {
    const wrapper = await mountLink()
    await wrapper.find('[data-testid=share-create-submit]').trigger('click')
    await flushPromises()
    expect(api.linkCreate).toHaveBeenCalledWith({ target: note, audience: 'logged_in', role: 'viewer' })
    expect(JSON.stringify(api.linkCreate.mock.calls[0])).not.toContain('allow_reshare')
    expect(wrapper.find('[data-testid=share-url]').text()).toBe(TOKEN_URL)
    expect(wrapper.find('[data-testid=share-fresh-url]').text()).toContain('只显示这一次')
    expect(wrapper.find('[data-testid=share-link-create]').exists()).toBe(false)
  })

  it('选了有效期和「任何人」:一并带上', async () => {
    const wrapper = await mountLink()
    selectOf(wrapper, 'share-create-audience').vm.$emit('update:modelValue', 'anyone')
    await flushPromises()
    expect(wrapper.text()).toContain('请只把链接发给你信任的人')
    expect(wrapper.find('[data-testid=share-create-role]').exists()).toBe(true)
    selectOf(wrapper, 'share-create-role').vm.$emit('update:modelValue', 'editor')
    const expiry = wrapper.findAllComponents({ name: 'KbSelect' }).find((c) => c.attributes('aria-label') === undefined && (c.props('options') as { value: string }[]).some((o) => o.value === 'custom'))!
    expiry.vm.$emit('update:modelValue', '7')
    await flushPromises()
    await wrapper.find('[data-testid=share-create-submit]').trigger('click')
    await flushPromises()
    expect(api.linkCreate).toHaveBeenCalledWith({ target: note, audience: 'anyone', role: 'editor', expires_days: 7 })
  })

  it('自定义有效期不合法:就近报错,不发请求', async () => {
    const wrapper = await mountLink()
    const expiry = wrapper.findAllComponents({ name: 'KbSelect' }).find((c) => (c.props('options') as { value: string }[]).some((o) => o.value === 'custom'))!
    expiry.vm.$emit('update:modelValue', 'custom')
    await flushPromises()
    await wrapper.find('input[inputmode=numeric]').setValue('99999')
    await flushPromises()
    expect(wrapper.text()).toContain('1–3650')
    expect(wrapper.find('[data-testid=share-create-submit]').attributes('disabled')).toBeDefined()
    expect(api.linkCreate).not.toHaveBeenCalled()
  })

  it('创建失败(例如链接数到上限):就近显示服务端的话', async () => {
    api.linkCreate.mockRejectedValueOnce({ status: 403, message: 'forbidden: 你的账号没有开通这种链接' })
    const wrapper = await mountLink()
    await wrapper.find('[data-testid=share-create-submit]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=share-create-error]').text()).toBe('你的账号没有开通这种链接')
    expect(wrapper.find('[data-testid=share-link-create]').exists()).toBe(true)
  })

  it('多选 = 合集链接:用 targets 和名称,说明合集的行为', async () => {
    const wrapper = await mountLink([dirA, dirB])
    expect(wrapper.text()).toContain('合集链接')
    expect(wrapper.text()).toContain('自动不显示')
    expect(api.linkGet).not.toHaveBeenCalled()
    await wrapper.find('input[aria-label="合集名称"]').setValue('我的合集')
    await wrapper.find('[data-testid=share-create-submit]').trigger('click')
    await flushPromises()
    expect(api.linkCreate).toHaveBeenCalledWith({ targets: [dirA, dirB], title: '我的合集', audience: 'logged_in', role: 'viewer' })
  })
})

describe('已有链接', () => {
  beforeEach(() => {
    api.linkGet.mockResolvedValue({ target: note, links: [link({ views: 23, last_view_at: Date.now() - 600_000 })] })
  })

  it('只显示后四位的掩码,说明为什么;不显示可复制的完整地址', async () => {
    const wrapper = await mountLink()
    expect(wrapper.find('[data-testid=share-masked-url]').text()).toContain('KlMn')
    expect(wrapper.find('[data-testid=share-masked-url]').text()).toContain('完整地址只在创建或重置时显示一次')
    expect(wrapper.find('[data-testid=share-url]').exists()).toBe(false)
    expect(wrapper.find('[data-testid=share-stats-line]').text()).toContain('已被打开 23 次')
  })

  it('已撤销的链接不算,当作还没有;其余状态(含已关闭)仍可管理', async () => {
    api.linkGet.mockResolvedValue({ target: note, links: [link({ state: 'revoked' }), link({ id: 'lnk_2', state: 'closed', enabled: false })] })
    const wrapper = await mountLink()
    expect(wrapper.find('[data-testid=share-link-create]').exists()).toBe(false)
    expect(wrapper.text()).toContain('已关闭')
  })

  it('改访问范围 → link_update(audience + enabled:true);选「关闭链接」→ enabled:false', async () => {
    const wrapper = await mountLink()
    selectOf(wrapper, 'share-access').vm.$emit('update:modelValue', 'anyone')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', audience: 'anyone', enabled: true })
    selectOf(wrapper, 'share-access').vm.$emit('update:modelValue', 'off')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', enabled: false })
  })

  it('改角色;「仅协作者」链接不显示角色(它不给额外权限)', async () => {
    const wrapper = await mountLink()
    selectOf(wrapper, 'share-role').vm.$emit('update:modelValue', 'commenter')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', role: 'commenter' })

    api.linkGet.mockResolvedValue({ target: note, links: [link({ audience: 'collaborators' })] })
    const only = await mountLink()
    expect(only.find('[data-testid=share-role]').exists()).toBe(false)
  })

  it('下拉里的范围:没开通的不能新选,但链接当前已经是它时仍显示(否则会显示成别的)', async () => {
    signIn(['collab.share', 'collab.link_users'])
    api.linkGet.mockResolvedValue({ target: note, links: [link({ audience: 'anyone' })] })
    const wrapper = await mountLink()
    const values = (selectOf(wrapper, 'share-access').props('options') as { value: string }[]).map((o) => o.value)
    expect(values).toContain('anyone')
    expect(selectOf(wrapper, 'share-access').props('modelValue')).toBe('anyone')
    signIn(['collab.share', 'collab.link_users'])
    api.linkGet.mockResolvedValue({ target: note, links: [link({ audience: 'logged_in' })] })
    const other = await mountLink()
    expect((selectOf(other, 'share-access').props('options') as { value: string }[]).map((o) => o.value)).not.toContain('anyone')
  })

  it('有效期:选「永久」→ clear_expiry;选天数 → expires_days;「保持不变」不发请求', async () => {
    api.linkGet.mockResolvedValue({ target: note, links: [link({ expires_at: Date.now() + 86_400_000 * 10 })] })
    const wrapper = await mountLink()
    const expiry = selectOf(wrapper, 'share-expiry')
    expect(expiry.props('modelValue')).toBe('keep')
    expiry.vm.$emit('update:modelValue', 'keep')
    await flushPromises()
    expect(api.linkUpdate).not.toHaveBeenCalled()
    expiry.vm.$emit('update:modelValue', '30')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', expires_days: 30 })
    selectOf(wrapper, 'share-expiry').vm.$emit('update:modelValue', 'forever')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', clear_expiry: true })
  })

  it('已过期:提示怎么恢复', async () => {
    api.linkGet.mockResolvedValue({ target: note, links: [link({ state: 'expired', expires_at: Date.now() - 1000 })] })
    const wrapper = await mountLink()
    expect(wrapper.text()).toContain('链接已过期')
    expect(wrapper.text()).toContain('选一个新的有效期就能恢复')
  })

  it('访问密码:打开开关出现输入框;4–12 位校验;设置成功后提示旧解锁失效;关开关 = clear_password', async () => {
    const wrapper = await mountLink()
    await switchOf(wrapper, 'share-password-switch').trigger('click')
    expect(wrapper.find('[data-testid=share-password-row]').exists()).toBe(true)
    await wrapper.find('[data-testid=share-password-row] input').setValue('abc')
    await wrapper.find('[data-testid=share-password-save]').trigger('click')
    expect(wrapper.find('[data-testid=share-password-error]').text()).toContain('4–12')
    expect(api.linkUpdate).not.toHaveBeenCalled()
    await wrapper.find('[data-testid=share-password-row] input').setValue('sesame1')
    await wrapper.find('[data-testid=share-password-save]').trigger('click')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', password: 'sesame1' })
    expect(wrapper.find('[data-testid=share-password-error]').exists()).toBe(false)
  })

  it('已有密码:开关是开的,输入框不回显密码;关掉 = clear_password', async () => {
    api.linkGet.mockResolvedValue({ target: note, links: [link({ has_password: true })] })
    api.linkUpdate.mockResolvedValue({ link: link({ has_password: false }) })
    const wrapper = await mountLink()
    expect(switchOf(wrapper, 'share-password-switch').attributes('aria-checked')).toBe('true')
    expect((wrapper.find('[data-testid=share-password-row] input').element as HTMLInputElement).value).toBe('')
    await switchOf(wrapper, 'share-password-switch').trigger('click')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', clear_password: true })
    expect(wrapper.find('[data-testid=share-password-row]').exists()).toBe(false)
  })

  it('下载 / 水印开关各发一次 link_update', async () => {
    const wrapper = await mountLink()
    await switchOf(wrapper, 'share-download').trigger('click')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', allow_download: false })
    await switchOf(wrapper, 'share-watermark').trigger('click')
    await flushPromises()
    expect(api.linkUpdate).toHaveBeenLastCalledWith({ id: 'lnk_1', watermark: true })
  })

  it('管理员关了游客评论 / 编辑:告诉所有者游客实际只有什么权限', async () => {
    api.linkGet.mockResolvedValue({ target: note, links: [link({ audience: 'anyone', role: 'editor', guest_role: 'viewer' })] })
    const wrapper = await mountLink()
    expect(wrapper.find('[data-testid=share-guest-note]').text()).toContain('只允许游客「可查看」')
  })

  it('界面上没有「编辑者可再分享」(allow_reshare 后端只存不用)', async () => {
    const wrapper = await mountLink()
    expect(wrapper.text()).not.toContain('再分享')
    expect(wrapper.text()).not.toContain('reshare')
  })

  it('修改失败:提示原因,界面仍是服务器上的状态', async () => {
    api.linkUpdate.mockRejectedValueOnce({ status: 403, message: 'forbidden: 你的账号没有开通这种链接' })
    const wrapper = await mountLink()
    selectOf(wrapper, 'share-access').vm.$emit('update:modelValue', 'anyone')
    await flushPromises()
    expect(selectOf(wrapper, 'share-access').props('modelValue')).toBe('logged_in')
  })
})

describe('重置 / 删除 / 统计', () => {
  beforeEach(() => {
    api.linkGet.mockResolvedValue({ target: note, links: [link({ views: 3, last_view_at: Date.now() - 60_000 })] })
  })

  it('重置要先确认并写明后果;成功后显示新地址(只此一次)', async () => {
    const wrapper = await mountLink()
    await wrapper.find('[data-testid=share-reset]').trigger('click')
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '重置链接?', tone: 'danger', confirmText: '重置' })
    expect(confirmState.calls[0]!.message).toContain('旧地址立刻打不开')
    expect(api.linkReset).toHaveBeenCalledWith('lnk_1')
    expect(wrapper.find('[data-testid=share-url]').text()).toBe(`${TOKEN_URL}X`)
  })

  it('用户取消:不重置', async () => {
    confirmState.answer = false
    const wrapper = await mountLink()
    await wrapper.find('[data-testid=share-reset]').trigger('click')
    await flushPromises()
    expect(api.linkReset).not.toHaveBeenCalled()
  })

  it('删除链接:红色确认,写明不可恢复和协作者不受影响;成功后回到创建状态', async () => {
    const wrapper = await mountLink()
    await wrapper.find('[data-testid=share-revoke]').trigger('click')
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ tone: 'danger', confirmText: '删除链接' })
    expect(confirmState.calls[0]!.message).toContain('永久失效')
    expect(confirmState.calls[0]!.message).toContain('协作者不受影响')
    expect(api.linkRevoke).toHaveBeenCalledWith('lnk_1')
    expect(wrapper.find('[data-testid=share-link-create]').exists()).toBe(true)
  })

  it('访问统计:登录访问者名单 + 匿名只计次数', async () => {
    api.linkStats.mockResolvedValue({
      views: 3, last_view_at: 1, anonymous_note: '匿名访客只统计次数',
      visitors: [{ user: { id: 'usr_b', username: 'bob', display_name: 'Bob', avatar: null }, first_at: 1, last_at: Date.now() - 120_000, visits: 2 }],
    })
    const wrapper = await mountLink()
    await wrapper.find('.kb-share-statsbox button').trigger('click')
    await flushPromises()
    const stats = wrapper.find('[data-testid=share-stats]')
    expect(stats.text()).toContain('Bob')
    expect(stats.text()).toContain('打开 2 次')
    expect(stats.text()).toContain('匿名访客只统计次数')
  })

  it('exposed.pendingUrl:刚生成的地址还没复制 = true(关面板前要提醒)', async () => {
    const wrapper = await mountLink()
    expect((wrapper.vm as unknown as { pendingUrl: boolean }).pendingUrl).toBe(false)
    await wrapper.find('[data-testid=share-reset]').trigger('click')
    await flushPromises()
    expect((wrapper.vm as unknown as { pendingUrl: boolean }).pendingUrl).toBe(true)
  })
})
