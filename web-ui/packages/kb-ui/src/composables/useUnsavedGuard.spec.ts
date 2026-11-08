// 未保存修改的离开确认:路由切换 + 关闭 / 刷新标签页。
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

let leaveGuard: (() => unknown) | null = null
vi.mock('vue-router', () => ({ onBeforeRouteLeave: (guard: () => unknown) => (leaveGuard = guard) }))

import { useUnsavedGuard } from './useUnsavedGuard'

function setup(dirty: boolean, confirm: () => boolean | Promise<boolean>) {
  const flag = ref(dirty)
  const Host = defineComponent({
    setup() {
      useUnsavedGuard(flag, confirm)
      return () => h('div')
    },
  })
  return { wrapper: mount(Host), flag }
}

describe('useUnsavedGuard', () => {
  it('没有修改时离开路由直接放行,不弹确认', async () => {
    const confirm = vi.fn(() => false)
    const { wrapper } = setup(false, confirm)
    expect(await leaveGuard!()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('有修改时离开路由要确认:确认 → 放行;取消 → 拦下', async () => {
    const yes = setup(true, () => true)
    expect(await leaveGuard!()).toBe(true)
    yes.wrapper.unmount()
    const no = setup(true, () => false)
    expect(await leaveGuard!()).toBe(false)
    no.wrapper.unmount()
  })
  it('确认可以是异步的(对话框)', async () => {
    const { wrapper } = setup(true, async () => false)
    expect(await leaveGuard!()).toBe(false)
    wrapper.unmount()
  })
  it('有修改时关闭 / 刷新标签页会触发浏览器自带的提示;没修改不会', () => {
    const { wrapper, flag } = setup(true, () => true)
    const dirtyEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyEvent)
    expect(dirtyEvent.defaultPrevented).toBe(true)
    flag.value = false
    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)
    wrapper.unmount()
    flag.value = true
    const afterUnmount = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterUnmount)
    expect(afterUnmount.defaultPrevented).toBe(false)
  })
})
