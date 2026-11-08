// 申请权限对话框:可选角色只列更高的、附言上限、发送成功/失败(24 小时内只能一次)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ShareTarget } from '@/api/share'

const api = vi.hoisted(() => ({ accessRequest: vi.fn() }))
vi.mock('@/api/share', () => api)
vi.mock('@kb-ui/index', async (original) => {
  const real = await original<Record<string, unknown>>()
  const { ref } = await import('vue')
  return { ...real, useMedia: () => ref(false) }
})

import RequestAccessDialog from './RequestAccessDialog.vue'

const target: ShareTarget = { kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'ins_1' }
const owner = { id: 'usr_a', username: 'alice', display_name: 'Alice', avatar: null }
const body = () => document.body

async function open(props: Record<string, unknown> = {}) {
  const wrapper = mount(RequestAccessDialog, { props: { target, title: '部署清单', owner, ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const select = (wrapper: ReturnType<typeof mount>) => wrapper.findComponent({ name: 'KbSelect' })

beforeEach(() => {
  setActivePinia(createPinia())
  api.accessRequest.mockReset()
  api.accessRequest.mockResolvedValue({ status: 'requested' })
  document.body.innerHTML = ''
})

describe('申请权限', () => {
  it('只读想编辑:默认选「可编辑」,下拉里只有比现在更高的', async () => {
    const wrapper = await open({ currentRole: 'viewer' })
    expect(select(wrapper).props('modelValue')).toBe('editor')
    expect((select(wrapper).props('options') as { value: string }[]).map((o) => o.value)).toEqual(['commenter', 'editor'])
    expect(body().textContent).toContain('申请更高的权限')
    expect(body().textContent).toContain('向 Alice 申请「部署清单」')
  })

  it('完全没有权限:三档都能选,标题是「申请访问权限」', async () => {
    const wrapper = await open({ currentRole: null })
    expect((select(wrapper).props('options') as { value: string }[]).map((o) => o.value)).toEqual(['viewer', 'commenter', 'editor'])
    expect(body().textContent).toContain('申请访问权限')
  })

  it('已经是可编辑(或更高):不用申请,只有一个「知道了」,没有发送按钮', async () => {
    await open({ currentRole: 'editor' })
    expect(body().querySelector('[data-testid=request-none]')?.textContent).toContain('你已经有「可编辑」权限')
    expect(body().querySelector('[data-testid=request-send]')).toBeNull()
    expect(body().textContent).toContain('知道了')
  })

  it('发送:带资源、角色、附言;成功后通知上层并关闭', async () => {
    const wrapper = await open({ currentRole: 'viewer' })
    const area = body().querySelector('[data-testid=request-message]') as HTMLTextAreaElement
    area.value = '想补充回滚步骤'
    area.dispatchEvent(new Event('input'))
    ;(body().querySelector('[data-testid=request-send]') as HTMLElement).click()
    await flushPromises()
    expect(api.accessRequest).toHaveBeenCalledWith(target, 'editor', '想补充回滚步骤')
    expect(wrapper.emitted('sent')![0]).toEqual(['editor'])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('附言超过 200 字:提示并禁用发送(按字数,不是字节)', async () => {
    await open({ currentRole: 'viewer' })
    const area = body().querySelector('[data-testid=request-message]') as HTMLTextAreaElement
    area.value = '字'.repeat(200)
    area.dispatchEvent(new Event('input'))
    await flushPromises()
    expect((body().querySelector('[data-testid=request-send]') as HTMLButtonElement).disabled).toBe(false)
    area.value = '字'.repeat(201)
    area.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(body().textContent).toContain('201 / 200,太长了')
    expect((body().querySelector('[data-testid=request-send]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('24 小时内重复申请:显示服务端的话,不关对话框,可以改了再试', async () => {
    api.accessRequest.mockRejectedValueOnce({ status: 403, message: 'forbidden: 24 小时内同一份内容只能申请一次' })
    const wrapper = await open({ currentRole: 'viewer' })
    ;(body().querySelector('[data-testid=request-send]') as HTMLElement).click()
    await flushPromises()
    expect(body().querySelector('[data-testid=request-error]')?.textContent).toBe('24 小时内同一份内容只能申请一次')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.emitted('sent')).toBeUndefined()
  })

  it('网络错误:给人话,不露英文', async () => {
    api.accessRequest.mockRejectedValueOnce(new Error('Failed to fetch'))
    await open({ currentRole: null })
    ;(body().querySelector('[data-testid=request-send]') as HTMLElement).click()
    await flushPromises()
    expect(body().querySelector('[data-testid=request-error]')?.textContent).toBe('申请没有发出去,请稍后再试。')
  })
})
