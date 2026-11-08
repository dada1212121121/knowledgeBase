// ⌘K 命令面板:过滤、键盘移动、Esc 关闭。
//
// 为什么单独写这份:截图脚本为了对齐设计稿,直接改输入框的 DOM value(不派发 input 事件),
// 那个「摆拍」不覆盖真实的过滤逻辑;此前仓库里没有任何 ⌘K 的自动化用例,
// 所以这里把「输入即过滤 / ↑↓ 选择(含首尾回绕)/ Enter 执行 / Esc 关闭」钉住。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { PaletteCall } from './palette'

const push = vi.hoisted(() => vi.fn())
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

// 面板不再自己调应用层 api / 读路由表,能力调用与地址都由外壳注入(见 palette.ts)。
// 这里用字面量当桩:地址与真实 PATHS 一致,把契约钉在测试里。
// 泛型调用桩:按名字返回夹具(list_projects / list_items),其余能力回空对象
const call = vi.fn(async (name: string) => {
  if (name === 'list_projects') {
    return { projects: [{ project: { name: 'demo', slug: 'demo' } }] }
  }
  if (name === 'list_items') {
    return { items: [{ id: 'ins_1', title: 'UDS 断线后降级', source: 'insight:ins_1', kind: 'insight' }] }
  }
  return {}
}) as unknown as PaletteCall
const paths = {
  search: '/search', review: '/review', kb: '/kb', eval: '/admin/eval', me: '/me',
  system: '/admin/system', appearance: '/me/appearance', guide: '/guide',
  projects: '/admin/projects', import: '/import', audit: '/admin/audit',
}

import KbCommandPalette from './KbCommandPalette.vue'

// 默认注入 call / paths;用例只需传自己要覆盖的 prop
const mountPalette = async (extra: Record<string, unknown> = {}) => {
  const wrapper = mount(KbCommandPalette, { attachTo: document.body, props: { call, paths, ...extra } })
  await flushPromises()
  return wrapper
}

const press = (key: string) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('KbCommandPalette', () => {
  beforeEach(() => {
    push.mockClear()
  })

  it('默认列出跳转与操作,输入关键词后只留下匹配项', async () => {
    const wrapper = await mountPalette()
    const all = wrapper.findAll('.ni')
    expect(all.length).toBeGreaterThan(1)
    expect(wrapper.findAll('.ni').some((item) => item.text().startsWith('搜索'))).toBe(true)

    await wrapper.find('input').setValue('重建')
    const filtered = wrapper.findAll('.ni')
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.text()).toContain('重建索引')
    wrapper.unmount()
  })

  it('↑↓ 移动选中项,并在首尾回绕', async () => {
    const wrapper = await mountPalette()
    const items = wrapper.findAll('.ni')
    const first = items[0]!.text()
    const last = items[items.length - 1]!.text()

    press('ArrowDown')
    await flushPromises()
    expect(wrapper.find('.ni.on').text()).not.toBe(first)

    press('ArrowUp')
    await flushPromises()
    expect(wrapper.find('.ni.on').text()).toBe(first)

    // 首项再按 ↑ → 末项;末项再按 ↓ → 首项(回绕)
    press('ArrowUp')
    await flushPromises()
    expect(wrapper.find('.ni.on').text()).toBe(last)
    press('ArrowDown')
    await flushPromises()
    expect(wrapper.find('.ni.on').text()).toBe(first)
    wrapper.unmount()
  })

  it('Enter 执行选中项:选中「知识库」(旧称「浏览器」,仍可搜到)跳转到 /kb', async () => {
    const wrapper = await mountPalette()
    await wrapper.find('input').setValue('浏览器')
    await flushPromises()
    expect(wrapper.findAll('.ni')).toHaveLength(1)
    press('Enter')
    await flushPromises()
    expect(push).toHaveBeenCalledWith('/kb')
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  it('Esc 关闭面板(emit close)', async () => {
    const wrapper = await mountPalette()
    press('Escape')
    await flushPromises()
    expect(wrapper.emitted('close')).toBeTruthy()
    wrapper.unmount()
  })

  describe('按功能点过滤、手机、键盘与焦点', () => {
    const AI_WORD = /(?<![A-Za-z])AI(?![A-Za-z])/
    /** AI 总开关关闭时后端折算出的功能列表 */
    const aiOff = (feature: string) => !feature.startsWith('ai.') && feature !== 'search.deep'
    const texts = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.ni').map((item) => item.text())

    function setPhone(phone: boolean) {
      window.matchMedia = ((query: string) => ({
        matches: phone && query === '(max-width: 599px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia
    }

    beforeEach(() => {
      setPhone(false)
      Element.prototype.scrollIntoView = vi.fn()
    })

    it('默认全都有:列出审核收件箱,没有「进化」这种旧叫法', async () => {
      const wrapper = await mountPalette()
      expect(texts(wrapper).some((text) => text.startsWith('审核收件箱'))).toBe(true)
      expect(wrapper.text()).not.toContain('进化')
      wrapper.unmount()
    })

    it('AI 总开关关闭:没有审核收件箱,整个面板没有 AI 字样;其余命令照常', async () => {
      const wrapper = await mountPalette({ has: aiOff })
      await flushPromises()
      expect(texts(wrapper).some((text) => text.startsWith('审核收件箱'))).toBe(false)
      expect(texts(wrapper).some((text) => text.startsWith('搜索'))).toBe(true)
      expect(wrapper.text()).not.toMatch(AI_WORD)
      // 输入关键词也搜不出审核
      await wrapper.find('input').setValue('审核')
      expect(wrapper.findAll('.ni')).toHaveLength(0)
      wrapper.unmount()
    })

    it('没有对应功能的命令不出现:无评测功能没有「打开评测页」,无令牌功能没有「管理访问令牌」', async () => {
      const wrapper = await mountPalette({ admin: true, has: (feature: string) => feature !== 'search.tune' && feature !== 'api.tokens' })
      await flushPromises()
      expect(texts(wrapper).join('|')).not.toMatch(/评测|令牌/)
      wrapper.unmount()
    })

    it('没有「本机目录」功能(普通用户):没有「重建索引」,也搜不到项目与集合', async () => {
      const wrapper = await mountPalette({ has: (feature: string) => feature !== 'sources.local' })
      await flushPromises()
      expect(texts(wrapper).join('|')).not.toContain('重建索引')
      await wrapper.find('input').setValue('项目')
      expect(wrapper.findAll('.ni')).toHaveLength(0)
      wrapper.unmount()
    })

    it('「管理访问令牌」去个人设置(以前跳到管理员才能进的系统设置),「打开评测页」去评测', async () => {
      const wrapper = await mountPalette()
      await wrapper.find('input').setValue('令牌')
      press('Enter')
      await flushPromises()
      expect(push).toHaveBeenCalledWith('/me')
      push.mockClear()
      await wrapper.find('input').setValue('评测')
      press('Enter')
      await flushPromises()
      expect(push).toHaveBeenCalledWith('/admin/eval')
      wrapper.unmount()
    })

    it('# 搜笔记:分区叫「笔记」(不是 Insights),点开进 /kb 带上集合和条目', async () => {
      const wrapper = await mountPalette()
      await wrapper.find('input').setValue('#')
      await flushPromises()
      expect(wrapper.find('.sec').text()).toBe('笔记')
      expect(wrapper.text()).not.toMatch(/insight/i)
      press('Enter')
      await flushPromises()
      expect(push).toHaveBeenCalledWith({ path: '/kb', query: { collection: undefined, item: 'ins_1' } })
      wrapper.unmount()
    })

    it('没有写出来就没做的功能不写:重建索引一行没有 ⌘↵ 提示', async () => {
      const wrapper = await mountPalette({ admin: true })
      await flushPromises()
      const row = wrapper.findAll('.ni').find((item) => item.text().startsWith('重建索引'))!
      expect(row.find('.kbd').exists()).toBe(false)
      wrapper.unmount()
    })

    it('普通用户默认只列常用动作:新建笔记在首屏,重建索引 / 评测 / 令牌要输入关键词才出现', async () => {
      const wrapper = await mountPalette()
      expect(texts(wrapper).some((text) => text.startsWith('新建笔记'))).toBe(true)
      expect(texts(wrapper).join('|')).not.toMatch(/重建索引|评测|令牌/)
      await wrapper.find('input').setValue('重建')
      expect(wrapper.findAll('.ni')).toHaveLength(1)
      expect(wrapper.find('.ni').text()).toContain('重建索引')
      wrapper.unmount()
    })

    it('管理员:管理动作单独成「管理」区,排在常用操作之后', async () => {
      const wrapper = await mountPalette({ admin: true })
      await flushPromises()
      expect(wrapper.findAll('.sec').map((section) => section.text()).filter((text) => text !== '笔记')).toEqual(['跳转', '操作', '管理'])
      wrapper.unmount()
    })

    it('外壳注入的编辑器命令单独成区;关键词命中后回车执行,不抢普通跳转', async () => {
      const run = vi.fn()
      const wrapper = await mountPalette({ extraCommands: [{ id: 'bold', label: '加粗', icon: 'edit', section: '编辑器', keywords: 'bold 粗体', run }] })
      await flushPromises()
      expect(wrapper.findAll('.sec').map((section) => section.text())).toContain('编辑器')
      await wrapper.find('input').setValue('粗体')
      expect(wrapper.findAll('.ni')).toHaveLength(1)
      expect(wrapper.find('.ni').text()).toContain('加粗')
      press('Enter')
      await flushPromises()
      expect(run).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('输入 > 只留动作:普通操作 + 编辑器命令;跳转和笔记检索不混进来', async () => {
      const wrapper = await mountPalette({ extraCommands: [{ id: 'bold', label: '加粗', icon: 'edit', section: '编辑器', run: vi.fn() }] })
      await flushPromises()
      await wrapper.find('input').setValue('>')
      expect(wrapper.findAll('.sec').map((section) => section.text())).toEqual(['编辑器', '操作'])
      expect(wrapper.text()).not.toContain('跳转')
      wrapper.unmount()
    })

    it('新建笔记:普通用户和手机都能一眼看到,回车去 /kb 并带 new=1', async () => {
      const wrapper = await mountPalette()
      await wrapper.find('input').setValue('新建笔记')
      press('Enter')
      await flushPromises()
      expect(push).toHaveBeenCalledWith({ path: '/kb', query: { new: '1' } })
      expect(wrapper.emitted('close')).toBeTruthy()
      wrapper.unmount()
    })

    it('电脑:有快捷键提示(G S),没有「取消」按钮', async () => {
      const wrapper = await mountPalette()
      expect(wrapper.findAll('.ni .kbd').length).toBeGreaterThan(0)
      expect(wrapper.find('[data-testid=palette-close]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('手机:不显示快捷键提示,有看得见的「取消」按钮,点了关闭', async () => {
      setPhone(true)
      const wrapper = await mountPalette()
      expect(wrapper.findAll('.ni .kbd')).toHaveLength(0)
      const close = wrapper.find('[data-testid=palette-close]')
      expect(close.attributes('aria-label')).toBe('关闭命令面板')
      await close.trigger('click')
      expect(wrapper.emitted('close')).toBeTruthy()
      wrapper.unmount()
    })

    it('Tab 不跑到面板后面的页面上:电脑停在输入框,手机在输入框和取消之间循环', async () => {
      const wrapper = await mountPalette()
      const input = wrapper.find('input').element as HTMLInputElement
      expect(document.activeElement).toBe(input)
      const tab = (shiftKey = false) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))
      tab()
      expect(document.activeElement).toBe(input)
      wrapper.unmount()

      setPhone(true)
      const phone = await mountPalette()
      const field = phone.find('input').element as HTMLInputElement
      const close = phone.find('[data-testid=palette-close]').element as HTMLButtonElement
      expect(document.activeElement).toBe(field)
      tab()
      expect(document.activeElement).toBe(close)
      tab()
      expect(document.activeElement).toBe(field)
      tab(true)
      expect(document.activeElement).toBe(close)
      phone.unmount()
    })

    it('关闭后焦点回到打开它的按钮', async () => {
      const opener = document.createElement('button')
      document.body.append(opener)
      opener.focus()
      const wrapper = await mountPalette()
      expect(document.activeElement).not.toBe(opener)
      wrapper.unmount()
      expect(document.activeElement).toBe(opener)
      opener.remove()
    })

    it('用方向键走到下一行时把它滚进可视范围,输入框的 aria-activedescendant 跟着变', async () => {
      const wrapper = await mountPalette()
      const input = wrapper.find('input')
      expect(input.attributes('aria-activedescendant')).toBe('kb-pal-opt-0')
      press('ArrowDown')
      await flushPromises()
      expect(input.attributes('aria-activedescendant')).toBe('kb-pal-opt-1')
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
      expect(wrapper.find('#kb-pal-opt-1').attributes('aria-selected')).toBe('true')
      expect(wrapper.find('[role=listbox]').exists()).toBe(true)
      wrapper.unmount()
    })

    it('遮罩与面板 z-index 均高于顶栏(20),使顶栏与内容一同被虚化和遮盖', async () => {
      const wrapper = await mountPalette()
      const ov = wrapper.find('.pal-ov')
      expect(ov.attributes('style')).toContain('z-index: var(--z-palette-scrim, 50)')
      const pal = wrapper.find('.card.pal')
      expect(pal.attributes('style')).toContain('z-index: var(--z-palette, 51)')
      wrapper.unmount()
    })
  })
})
