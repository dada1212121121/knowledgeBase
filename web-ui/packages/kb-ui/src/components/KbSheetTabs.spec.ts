// 底部弹层(含下滑关闭)与可滑动标签页(渐隐提示 + 更多)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import KbSheet from './KbSheet.vue'
import KbDialog from './KbDialog.vue'
import KbTabs from './KbTabs.vue'

beforeEach(() => {
  document.body.innerHTML = ''
})

const sheet = () => document.body.querySelector<HTMLElement>('[data-testid="sheet"]')
const grab = () => document.body.querySelector<HTMLElement>('[data-testid="sheet-grab"]')!

function pointer(el: HTMLElement, type: string, clientY: number, timeStamp = 0) {
  const event = new Event(type, { bubbles: true }) as Event & { clientY: number; pointerId: number; pointerType: string; button: number }
  Object.assign(event, { clientY, pointerId: 1, pointerType: 'touch', button: 0 })
  Object.defineProperty(event, 'timeStamp', { value: timeStamp })
  el.dispatchEvent(event)
}

describe('KbSheet', () => {
  it('是 dialog(aria-modal + 标题关联),内容在 body 上,有把手和安全区', async () => {
    const wrapper = mount(KbSheet, { props: { title: '筛选' }, slots: { default: '<input class="in" />', footer: '<button class="ok">确定</button>' }, attachTo: document.body })
    await flushPromises()
    expect(sheet()!.getAttribute('role')).toBe('dialog')
    expect(sheet()!.getAttribute('aria-modal')).toBe('true')
    const labelled = sheet()!.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelled)!.textContent).toBe('筛选')
    expect(sheet()!.querySelector('.kb-sheet-handle')).not.toBeNull()
    expect(sheet()!.querySelector('.kb-sheet-foot .ok')).not.toBeNull()
    // 打开后焦点进弹层(优先第一个输入框)
    expect(document.activeElement).toBe(sheet()!.querySelector('.in'))
    wrapper.unmount()
  })

  it('Esc、点遮罩、点关闭按钮都发出 close', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.querySelector<HTMLElement>('.kb-sheet-scrim')!.click()
    document.body.querySelector<HTMLElement>('.kb-sheet-head button')!.click()
    expect(wrapper.emitted('close')).toHaveLength(3)
    wrapper.unmount()
  })

  it('弹层里有展开的下拉菜单时,Esc 只留给菜单,不关弹层;菜单收起后 Esc 才关弹层', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    const layer = document.createElement('div')
    layer.className = 'kb-pop-layer'
    layer.dataset.open = 'true'
    document.body.appendChild(layer)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    layer.dataset.open = 'false'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('对话框同样:展开的下拉菜单优先吃掉 Esc', async () => {
    const wrapper = mount(KbDialog, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    const layer = document.createElement('div')
    layer.className = 'kb-pop-layer'
    layer.dataset.open = 'true'
    document.body.appendChild(layer)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toBeUndefined()
    layer.dataset.open = 'false'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('上面压着确认框时,Esc 归确认框(取消它),不把下面的弹层一起关掉', async () => {
    for (const component of [KbSheet, KbDialog]) {
      const wrapper = mount(component, { props: { title: 'x' }, attachTo: document.body })
      await flushPromises()
      const confirm = document.createElement('div')
      confirm.className = 'kb-dlg-wrap kb-confirm-wrap'
      document.body.appendChild(confirm)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(wrapper.emitted('close')).toBeUndefined()
      confirm.remove()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(wrapper.emitted('close')).toHaveLength(1)
      wrapper.unmount()
    }
  })

  it('noAutofocus:有输入框也不抢焦点(手机上不要一打开就弹软键盘),焦点落在弹层上', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x', noAutofocus: true }, slots: { default: '<input class="in" />' }, attachTo: document.body })
    await flushPromises()
    expect(document.activeElement).toBe(sheet())
    wrapper.unmount()
  })

  it('closeOnScrim=false 时点遮罩不关', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x', closeOnScrim: false }, attachTo: document.body })
    await flushPromises()
    document.body.querySelector<HTMLElement>('.kb-sheet-scrim')!.click()
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })

  it('下滑关闭:把手向下拖超过 96px 就关闭', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    pointer(grab(), 'pointerdown', 100, 0)
    pointer(grab(), 'pointermove', 140, 100)
    await nextTick()
    expect(sheet()!.style.transform).toContain('translateY(40px)')
    pointer(grab(), 'pointermove', 230, 600)
    pointer(grab(), 'pointerup', 230, 600)
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('拖得不够远且不够快就弹回,不关闭', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    pointer(grab(), 'pointerdown', 100, 0)
    pointer(grab(), 'pointermove', 150, 800)
    pointer(grab(), 'pointerup', 150, 1600)
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(sheet()!.style.transform).toBe('')
    wrapper.unmount()
  })

  it('快速轻扫(距离不大但速度够)也关闭;向上拖不关闭', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    pointer(grab(), 'pointerdown', 100, 0)
    pointer(grab(), 'pointermove', 150, 40)
    pointer(grab(), 'pointerup', 150, 50)
    expect(wrapper.emitted('close')).toHaveLength(1)
    pointer(grab(), 'pointerdown', 300, 1000)
    pointer(grab(), 'pointermove', 100, 1100)
    pointer(grab(), 'pointerup', 100, 1200)
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('向上拖带阻尼(只动一点点,表示到头了),不会真的把弹层拖上去', async () => {
    const wrapper = mount(KbSheet, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    pointer(grab(), 'pointerdown', 300, 0)
    pointer(grab(), 'pointermove', 200, 100)
    await nextTick()
    expect(sheet()!.style.transform).toBe('translateY(-15px)')
    wrapper.unmount()
  })

  it('关闭后焦点还给打开前的元素', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = mount(KbSheet, { props: { title: 'x' }, attachTo: document.body })
    await flushPromises()
    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
  })
})

describe('KbTabs 更多与渐隐', () => {
  const tabs = ['概览', '用户', '角色', '邀请码', '审计', '设置'].map((label, index) => ({ value: `t${index}`, label }))
  const mountTabs = (props: Record<string, unknown> = {}) =>
    mount(KbTabs, { props: { modelValue: 't0', tabs, ...props }, attachTo: document.body })
  const labels = (wrapper: ReturnType<typeof mountTabs>) => wrapper.findAll('[role="tab"]:not(.kb-tabs-more)').map((tab) => tab.text())

  it('不设 maxVisible 时全部直接显示,没有「更多」', () => {
    const wrapper = mountTabs()
    expect(labels(wrapper)).toHaveLength(6)
    expect(wrapper.find('[data-testid="tabs-more"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('maxVisible=4:前 3 个 + 「更多」,其余在菜单里;点菜单项切换页签', async () => {
    const wrapper = mountTabs({ maxVisible: 4 })
    expect(labels(wrapper)).toEqual(['概览', '用户', '角色'])
    await wrapper.find('[data-testid="tabs-more"]').trigger('click')
    const items = [...document.body.querySelectorAll<HTMLElement>('.kb-tabs-menu-item')]
    expect(items.map((item) => item.textContent?.trim())).toEqual(['邀请码', '审计', '设置'])
    items[1]!.click()
    expect(wrapper.emitted('update:modelValue')).toEqual([['t4']])
    wrapper.unmount()
  })

  it('当前页签在「更多」里时,换到可见区(换掉最后一个可见的),不让人看不到自己在哪', async () => {
    const wrapper = mountTabs({ maxVisible: 4, modelValue: 't4' })
    expect(labels(wrapper)).toEqual(['概览', '用户', '审计'])
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('审计')
    // 被换下去的「角色」进了菜单,「审计」不会在菜单和可见区各出现一次
    await wrapper.find('[data-testid="tabs-more"]').trigger('click')
    const menu = [...document.body.querySelectorAll<HTMLElement>('.kb-tabs-menu-item')].map((item) => item.textContent?.trim())
    expect(menu).toEqual(['角色', '邀请码', '设置'])
    wrapper.unmount()
  })

  it('页签数没超过 maxVisible 就不收进「更多」', () => {
    const wrapper = mountTabs({ maxVisible: 6 })
    expect(labels(wrapper)).toHaveLength(6)
    expect(wrapper.find('[data-testid="tabs-more"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('页签条靠近屏幕底部、菜单放不下时,翻到按钮上方(不让选项落在屏幕外点不到)', async () => {
    const wrapper = mountTabs({ maxVisible: 3 })
    const rectOf = (top: number, bottom: number, height: number) => ({ top, bottom, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }) as DOMRect
    vi.stubGlobal('innerHeight', 800)
    const button = wrapper.find('[data-testid="tabs-more"]').element as HTMLElement
    button.getBoundingClientRect = () => rectOf(740, 776, 36)
    const original = HTMLElement.prototype.getBoundingClientRect
    // 菜单自己的外框:放在按钮下面会超出屏幕(下缘 776+4+120 = 900 > 792)
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList?.contains('kb-tabs-menu') ? rectOf(parseInt(this.style.top, 10), parseInt(this.style.top, 10) + 120, 120) : original.call(this)
    }
    await wrapper.find('[data-testid="tabs-more"]').trigger('click')
    await flushPromises()
    const menu = document.body.querySelector<HTMLElement>('.kb-tabs-menu')!
    expect(parseInt(menu.style.top, 10)).toBe(740 - 120 - 4)
    HTMLElement.prototype.getBoundingClientRect = original
    vi.unstubAllGlobals()
    wrapper.unmount()
  })

  it('点菜单外面收起菜单', async () => {
    const wrapper = mountTabs({ maxVisible: 3 })
    await wrapper.find('[data-testid="tabs-more"]').trigger('click')
    expect(document.body.querySelector('.kb-tabs-menu')).not.toBeNull()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('.kb-tabs-menu')).toBeNull()
    wrapper.unmount()
  })

  it('放不下时滑动:右边还有 → 右侧渐隐;滑到中间两侧渐隐;滑到头左侧渐隐', async () => {
    const wrapper = mountTabs()
    const bar = wrapper.element as HTMLElement
    Object.defineProperty(bar, 'clientWidth', { value: 300, configurable: true })
    Object.defineProperty(bar, 'scrollWidth', { value: 600, configurable: true })
    bar.scrollLeft = 0
    await wrapper.trigger('scroll')
    expect(wrapper.classes()).toContain('is-scroll')
    expect(wrapper.classes()).toContain('has-fade-right')
    expect(wrapper.classes()).not.toContain('has-fade-left')
    bar.scrollLeft = 150
    await wrapper.trigger('scroll')
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['has-fade-left', 'has-fade-right']))
    bar.scrollLeft = 300
    await wrapper.trigger('scroll')
    expect(wrapper.classes()).toContain('has-fade-left')
    expect(wrapper.classes()).not.toContain('has-fade-right')
    wrapper.unmount()
  })

  it('放得下时没有渐隐', async () => {
    const wrapper = mountTabs()
    const bar = wrapper.element as HTMLElement
    Object.defineProperty(bar, 'clientWidth', { value: 600, configurable: true })
    Object.defineProperty(bar, 'scrollWidth', { value: 600, configurable: true })
    await wrapper.trigger('scroll')
    expect(wrapper.classes()).not.toContain('is-scroll')
    expect(wrapper.classes()).not.toContain('has-fade-left')
    expect(wrapper.classes()).not.toContain('has-fade-right')
    wrapper.unmount()
  })

  it('原有行为不变:← → 切换页签', async () => {
    const wrapper = mountTabs({ modelValue: 't1' })
    await wrapper.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['t2'])
    wrapper.unmount()
  })
})
void vi
