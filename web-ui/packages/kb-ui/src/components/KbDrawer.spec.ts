// 右侧抽屉(通知、数据来源详情):Esc 关闭、Tab 在抽屉内循环、关闭后焦点还给打开前的元素、标题关联、压着确认框时 Esc 让位。
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import KbDrawer from './KbDrawer.vue'

let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const body = '<button type="button" id="a">甲</button><input id="b" /><button type="button" id="c">丙</button>'
/** 抽屉在挂载后的下一个 tick 才挂键盘监听并把焦点放进来,所以要等两个 tick */
async function open() {
  wrapper = mount(KbDrawer, { props: { title: '通知' }, slots: { default: body }, attachTo: document.body })
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
  return wrapper
}
const key = (name: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra })
  document.dispatchEvent(event)
  return event
}
const panel = () => document.body.querySelector<HTMLElement>('.kb-drawer')!
const el = (id: string) => document.getElementById(id)!

describe('KbDrawer', () => {
  it('打开后焦点进抽屉;标题和抽屉用 aria-labelledby 关联', async () => {
    await open()
    expect(document.activeElement).toBe(panel())
    const title = document.body.querySelector('.kb-dialog-title')!
    expect(panel().getAttribute('aria-labelledby')).toBe(title.id)
    expect(title.textContent).toBe('通知')
  })

  it('Esc 关闭(emit close)并拦住事件,不再往下传(页面上别的 Esc 处理不会同时触发)', async () => {
    await open()
    let reached = false
    const spy = () => (reached = true)
    window.addEventListener('keydown', spy)
    key('Escape')
    window.removeEventListener('keydown', spy)
    expect(wrapper!.emitted('close')).toHaveLength(1)
    expect(reached).toBe(false)
  })

  it('抽屉上面压着确认框 / 下拉菜单时,Esc 留给它们,抽屉不跟着关', async () => {
    await open()
    const confirm = document.createElement('div')
    confirm.className = 'kb-confirm-wrap'
    document.body.append(confirm)
    key('Escape')
    expect(wrapper!.emitted('close')).toBeUndefined()
    confirm.remove()
    key('Escape')
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })

  it('Tab 在最后一个控件上绕回第一个,Shift+Tab 在第一个上绕到最后一个', async () => {
    await open()
    const buttons = [el('a'), el('b'), el('c')]
    // 抽屉自带的「关闭」按钮是第一个
    const close = panel().querySelector<HTMLElement>('.kb-drawer-head button')!
    buttons[2]!.focus()
    let event = key('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(close)
    close.focus()
    event = key('Tab', { shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(buttons[2])
  })

  it('中间的控件上按 Tab 不拦截(交给浏览器);刚打开时焦点在抽屉本身,Shift+Tab 也绕到最后一个', async () => {
    await open()
    el('b').focus()
    expect(key('Tab').defaultPrevented).toBe(false)
    panel().focus()
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(el('c'))
  })

  it('关闭(卸载)后焦点回到打开前的元素', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    await open()
    expect(document.activeElement).not.toBe(trigger)
    wrapper!.unmount()
    wrapper = null
    expect(document.activeElement).toBe(trigger)
  })
})
