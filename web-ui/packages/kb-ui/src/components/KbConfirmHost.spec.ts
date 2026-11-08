// 确认弹窗叠在对话框上面时的键盘行为:Esc 只取消确认,不会连发起确认的对话框一起关掉。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import KbConfirmHost from './KbConfirmHost.vue'
import KbDialog from './KbDialog.vue'
import { confirmState, useConfirm } from './useConfirm'

let wrappers: VueWrapper[] = []

beforeEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount())
  wrappers = []
  document.body.innerHTML = ''
  confirmState.open = false
})

describe('KbConfirmHost 叠在 KbDialog 上', () => {
  it('按 Esc:确认被取消(返回 false),下面的对话框仍然开着', async () => {
    const close = vi.fn()
    // 先挂确认宿主(外壳里它挂得最早),再打开对话框——和真实页面的顺序一样
    wrappers.push(mount(KbConfirmHost, { attachTo: document.body }))
    wrappers.push(mount(KbDialog, { props: { title: '好友', onClose: close }, attachTo: document.body }))
    const answer = useConfirm().ask({ title: '删除好友?', confirmText: '删除' })
    await flushPromises()
    expect(confirmState.open).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    await expect(answer).resolves.toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(document.body.querySelector('.kb-dialog')).not.toBeNull()
  })

  it('确认已经关掉以后,Esc 照常关闭对话框', async () => {
    const close = vi.fn()
    wrappers.push(mount(KbConfirmHost, { attachTo: document.body }))
    wrappers.push(mount(KbDialog, { props: { title: '好友', onClose: close }, attachTo: document.body }))
    await flushPromises()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
