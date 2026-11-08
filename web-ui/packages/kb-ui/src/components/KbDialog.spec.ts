// 对话框的键盘行为:Tab 在卡片内循环(最后一个可聚焦元素按 Tab 回到第一个,第一个按 Shift+Tab 到最后一个)。
// 本项目的表单对话框用「隐藏的提交按钮」实现回车提交(<button type="submit" hidden tabindex="-1">):
// 它在 DOM 里排在可见按钮之后,但 Tab 永远走不到它——循环的边界必须按「Tab 真的能走到的元素」算。
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import KbDialog from './KbDialog.vue'

let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** 和 Me.vue 的注销对话框同构:头部「关闭」按钮 + 输入框、取消、隐藏提交按钮、(可禁用的)主按钮 */
function mountForm(submitDisabled: boolean) {
  const Host = defineComponent({
    render: () =>
      h(KbDialog, { title: '注销账号' }, () =>
        h('form', [
          h('input', { id: 'pw', type: 'password' }),
          h('button', { type: 'button', id: 'cancel' }, '取消'),
          h('button', { type: 'submit', hidden: true, tabindex: -1, id: 'hidden-submit' }),
          h('button', { type: 'button', id: 'go', disabled: submitDisabled }, '申请注销'),
        ]),
      ),
  })
  wrapper = mount(Host, { attachTo: document.body })
  return nextTick().then(() => nextTick())
}
const press = (key: string, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  return event
}
const focusOn = (id: string) => (document.getElementById(id) as HTMLElement).focus()
/** 当前焦点是谁:头部的「关闭」按钮没有 id,用文字认 */
const activeName = () => {
  const el = document.activeElement as HTMLElement | null
  return el?.id || el?.textContent?.trim() || el?.tagName.toLowerCase() || ''
}

describe('KbDialog 的 Tab 循环', () => {
  it('主按钮被禁用时,最后一个能 Tab 到的是「取消」:在它上面按 Tab 要回到输入框(而不是跑出对话框)', async () => {
    await mountForm(true)
    focusOn('cancel')
    const event = press('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(activeName()).toBe('关闭')
  })

  it('主按钮可用时,最后一个是「申请注销」;隐藏提交按钮不算', async () => {
    await mountForm(false)
    focusOn('go')
    const event = press('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(activeName()).toBe('关闭')
  })

  it('在第一个(头部的「关闭」)上按 Shift+Tab,回到最后一个能 Tab 到的(不是隐藏提交按钮)', async () => {
    await mountForm(true)
    ;(document.querySelector('.kb-dialog-head button') as HTMLElement).focus()
    const event = press('Tab', true)
    expect(event.defaultPrevented).toBe(true)
    expect(activeName()).toBe('cancel')
  })

  it('不在边界上时 Tab 不拦截(交给浏览器按顺序走)', async () => {
    await mountForm(false)
    focusOn('pw')
    expect(press('Tab').defaultPrevented).toBe(false)
  })
})
