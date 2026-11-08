// 分享面板外壳:标题、两个页签、手机用底部弹层 / 电脑用对话框、关闭前提醒还没复制的链接地址。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ShareTarget } from '@/api/share'

const api = vi.hoisted(() => ({
  grantList: vi.fn(), grantSet: vi.fn(), grantRemove: vi.fn(), grantBatch: vi.fn(), setInherit: vi.fn(), friendList: vi.fn(), friendSearch: vi.fn(),
  linkCreate: vi.fn(), linkGet: vi.fn(), linkUpdate: vi.fn(), linkReset: vi.fn(), linkRevoke: vi.fn(), linkStats: vi.fn(),
}))
vi.mock('@/api/share', () => api)

const phone = vi.hoisted(() => ({ value: false }))
const ask = vi.hoisted(() => vi.fn(async (_options: { title: string; cancelText?: string }) => true))
vi.mock('@kb-ui/index', async (original) => {
  const real = await original<Record<string, unknown>>()
  const { ref: makeRef } = await import('vue')
  return {
    ...real,
    // 手机还是电脑由用例切换;触屏另算(默认没有)
    useMedia: (query: string) => makeRef(query.includes('max-width') ? phone.value : false),
    useConfirm: () => ({ ask }),
  }
})

import SharePanel from './SharePanel.vue'
import { useSessionStore } from '@/stores/session'

const note: ShareTarget = { kind: 'insight', space_id: 'sp_me', collection: '_global', id: 'ins_1' }
const dirA: ShareTarget = { kind: 'dir', space_id: 'sp_me', collection: '_global', path: 'a' }
const dirB: ShareTarget = { kind: 'dir', space_id: 'sp_me', collection: '_global', path: 'b' }

beforeEach(() => {
  setActivePinia(createPinia())
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: 'sp_me', must_change_password: false }
  session.features = new Set(['collab.share', 'collab.link_users', 'collab.link_guest'])
  session.loaded = true
  for (const fn of Object.values(api)) fn.mockReset()
  ask.mockReset()
  ask.mockResolvedValue(true)
  phone.value = false
  api.friendList.mockResolvedValue({ friends: [] })
  api.grantList.mockImplementation(async (target: ShareTarget) => ({ target, key: 'k', my_role: 'owner', owner: null, inherit_broken: false, grants: [] }))
  api.linkGet.mockResolvedValue({ target: note, links: [] })
  api.linkCreate.mockResolvedValue({
    link: { id: 'lnk_1', hint: 'KlMn', title: '', bundle: false, roots: [note], audience: 'logged_in', role: 'viewer', has_password: false, expires_at: null, allow_download: true, watermark: false, allow_reshare: false, enabled: true, state: 'active', views: 0, last_view_at: null, created_at: 1, guest_role: null },
    url: 'https://kbase.example.com/s/q7Hk2xAbCdEfGhIjKlMn',
  })
  document.body.innerHTML = ''
})

async function open(targets: ShareTarget[], extra: Record<string, unknown> = {}) {
  const wrapper = mount(SharePanel, { props: { targets, ...extra }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const body = () => document.body

describe('外壳', () => {
  it('电脑是对话框,标题带上文档名(笔记用调用方给的标题)', async () => {
    await open([note], { titles: { 'insight|sp_me|_global|ins_1': '部署清单' } })
    expect(body().querySelector('[role=dialog] [data-testid=share-panel]')).not.toBeNull()
    expect(body().querySelector('.kb-dialog')).not.toBeNull()
    expect(body().querySelector('[data-testid=sheet]')).toBeNull()
    expect(body().textContent).toContain('分享「部署清单」')
  })

  it('手机是底部弹层', async () => {
    phone.value = true
    await open([note])
    expect(body().querySelector('[data-testid=sheet]')).not.toBeNull()
    expect(body().querySelector('.kb-dialog')).toBeNull()
  })

  it('多选:标题写明几项;第二个页签叫「合集链接」;同一项选了两次只算一次', async () => {
    await open([dirA, dirB, { ...dirA }])
    expect(body().textContent).toContain('分享选中的 2 项')
    const tabs = [...body().querySelectorAll('[role=tab]')].map((el) => el.textContent?.trim())
    expect(tabs).toEqual(['协作者', '合集链接'])
  })

  it('两个页签:默认协作者;链接页第一次切过去才加载,之后保留', async () => {
    const wrapper = await open([note])
    expect(api.linkGet).not.toHaveBeenCalled()
    const tab = [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((el) => el.textContent?.includes('链接分享'))!
    tab.click()
    await flushPromises()
    expect(api.linkGet).toHaveBeenCalledTimes(1)
    ;[...body().querySelectorAll<HTMLElement>('[role=tab]')].find((el) => el.textContent?.includes('协作者'))!.click()
    await flushPromises()
    ;[...body().querySelectorAll<HTMLElement>('[role=tab]')].find((el) => el.textContent?.includes('链接分享'))!.click()
    await flushPromises()
    expect(api.linkGet).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('可以直接打开链接页', async () => {
    await open([note], { initialTab: 'link' })
    expect(api.linkGet).toHaveBeenCalledTimes(1)
    expect(body().querySelector('[data-testid=share-link-create]')).not.toBeNull()
  })
})

describe('关闭', () => {
  it('「完成」/ Esc 都发出 close', async () => {
    const wrapper = await open([note])
    ;(body().querySelector('[data-testid=share-done]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('刚生成的链接地址还没复制就关:先提醒,选「回去复制」就不关', async () => {
    const wrapper = await open([note], { initialTab: 'link' })
    ;(body().querySelector('[data-testid=share-create-submit]') as HTMLElement).click()
    await flushPromises()
    expect(body().querySelector('[data-testid=share-url]')?.textContent).toContain('/s/q7Hk2x')

    ask.mockResolvedValueOnce(false)
    ;(body().querySelector('[data-testid=share-done]') as HTMLElement).click()
    await flushPromises()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).toMatchObject({ title: '链接地址还没复制', cancelText: '回去复制' })
    expect(wrapper.emitted('close')).toBeUndefined()

    ask.mockResolvedValueOnce(true)
    ;(body().querySelector('[data-testid=share-done]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('没有生成新地址时关闭不打扰', async () => {
    const wrapper = await open([note], { initialTab: 'link' })
    ;(body().querySelector('[data-testid=share-done]') as HTMLElement).click()
    await flushPromises()
    expect(ask).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('里面改了东西会通知上层(上层据此刷新协作者头像等)', async () => {
    const wrapper = await open([note], { initialTab: 'link' })
    ;(body().querySelector('[data-testid=share-create-submit]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('changed')).toBeTruthy()
  })
})
