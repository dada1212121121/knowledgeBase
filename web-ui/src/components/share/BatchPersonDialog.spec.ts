// 批量改角色 / 移除某个人:只动他已经有权限的那几项,不顺手把他加到别的项上。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SharedByMeItem } from '@/api/share'

const api = vi.hoisted(() => ({ grantBatch: vi.fn() }))
vi.mock('@/api/share', () => api)
vi.mock('@kb-ui/index', async (original) => {
  const real = await original<Record<string, unknown>>()
  const { ref } = await import('vue')
  return { ...real, useMedia: () => ref(false) }
})

import BatchPersonDialog from './BatchPersonDialog.vue'

const user = (id: string, name: string) => ({ id: `usr_${id}`, username: id, display_name: name, avatar: null })
const zhang = user('zhang', '张三')
const li = user('li', '李四')
const item = (id: string, grantees: SharedByMeItem['grantees']): SharedByMeItem => ({
  target: { kind: 'file', space_id: 'sp_me', collection: '_global', path: `${id}.md` },
  key: id,
  title: id,
  grantees,
  inherit_broken: false,
})
const ITEMS = [item('a', [{ user: zhang, role: 'viewer' }, { user: li, role: 'editor' }]), item('b', [{ user: zhang, role: 'editor' }]), item('c', [{ user: li, role: 'viewer' }])]

async function open(mode: 'role' | 'remove', items = ITEMS) {
  const wrapper = mount(BatchPersonDialog, { props: { mode, items }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const body = () => document.body
const submit = () => (body().querySelector('[data-testid=batch-person-submit]') as HTMLButtonElement)

beforeEach(() => {
  setActivePinia(createPinia())
  api.grantBatch.mockReset()
  api.grantBatch.mockResolvedValue({ changed: 2, unchanged: 0, removed: 0 })
  document.body.innerHTML = ''
})

describe('BatchPersonDialog', () => {
  it('改角色:只把他已有权限的那几项交给后端(张三在 a、b 上,不含 c)', async () => {
    const wrapper = await open('role')
    // 选项按名字排,第一个是李四;切到张三
    const select = wrapper.findComponent({ name: 'KbSelect' })
    select.vm.$emit('update:modelValue', zhang.id)
    await flushPromises()
    expect(body().querySelector('[data-testid=batch-person-scope]')?.textContent).toContain('只改他已经有权限的 2 / 3 项')
    wrapper.findAllComponents({ name: 'KbSelect' })[1]!.vm.$emit('update:modelValue', 'manager')
    await flushPromises()
    submit().click()
    await flushPromises()
    expect(api.grantBatch).toHaveBeenCalledWith([ITEMS[0]!.target, ITEMS[1]!.target], [{ user_id: zhang.id, role: 'manager' }])
    expect(wrapper.emitted('done')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('移除:不带 role(后端用缺省的 role 表示移除),并写明后果', async () => {
    const wrapper = await open('remove')
    wrapper.findComponent({ name: 'KbSelect' }).vm.$emit('update:modelValue', li.id)
    await flushPromises()
    expect(body().textContent).toContain('移除后他会立刻失去通过这些项得到的权限')
    expect(submit().textContent).toContain('移除')
    submit().click()
    await flushPromises()
    expect(api.grantBatch).toHaveBeenCalledWith([ITEMS[0]!.target, ITEMS[2]!.target], [{ user_id: li.id }])
  })

  it('选中的项都没有协作者:说明,没有提交按钮', async () => {
    await open('role', [item('x', [])])
    expect(body().querySelector('[data-testid=batch-person-none]')?.textContent).toContain('都还没有协作者')
    expect(submit()).toBeNull()
  })

  it('失败:就近显示原因,不关对话框', async () => {
    api.grantBatch.mockRejectedValueOnce({ status: 403, message: 'forbidden: 你最多只能授予「可编辑」' })
    const wrapper = await open('role')
    submit().click()
    await flushPromises()
    expect(body().querySelector('[data-testid=batch-person-error]')?.textContent).toBe('你最多只能授予「可编辑」')
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
