/**
 * EditorChrome 的「带选项动作」：字号 / 颜色 / 表格大小这类点开选值的工具栏项。
 * Chrome 不认识"字号"，只负责渲染选项菜单、打勾当前值、置灰不可用项并把选中的参数发出去。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import EditorChrome from './EditorChrome.vue'
import { PAGE_EDIT_CONTRIBUTION } from '../extensions/builtin/text'
import type { EditorPermissions } from '../types'

const FULL: EditorPermissions = { read: true, write: true, comment: false, ai: false, export: false }

function mountWord(overrides: Record<string, unknown> = {}) {
  return mount(EditorChrome, {
    attachTo: document.body,
    props: {
      kind: 'page',
      format: 'docx',
      phase: 'ready',
      permissions: FULL,
      readonly: false,
      contribution: PAGE_EDIT_CONTRIBUTION,
      formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: {}, unavailable: {} },
      outline: [],
      statusItems: [{ id: 'count', extensionId: 'kb.builtin.stats', text: '0 页' }],
      ...overrides,
    },
  })
}

describe('Word 编辑工具栏', () => {
  it('点字号展开菜单，选 14 发出 docx.fontSize {points:14}，菜单收起', async () => {
    const wrapper = mountWord()
    await wrapper.find('[data-action="docx.fontSize"]').trigger('click')
    expect(wrapper.find('[data-testid="choices-docx.fontSize"]').exists()).toBe(true)
    await wrapper.find('[data-testid="choices-docx.fontSize"] [data-choice="14"]').trigger('click')
    expect(wrapper.emitted('command')).toEqual([['docx.fontSize', { points: 14 }]])
    expect(wrapper.find('[data-testid="choices-docx.fontSize"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('当前值打勾：字号 12 在菜单里亮，对齐按钮按 values.alignment 亮', async () => {
    const wrapper = mountWord({
      formatState: { marks: ['bold'], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: { fontSizePt: 12, alignment: 'center' }, unavailable: {} },
    })
    expect(wrapper.find('[data-action="docx.bold"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-action="docx.italic"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-action="docx.align.center"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-action="docx.align.left"]').attributes('aria-pressed')).toBe('false')
    await wrapper.find('[data-action="docx.fontSize"]').trigger('click')
    expect(wrapper.find('[data-choice="12"]').classes()).toContain('is-active')
    expect(wrapper.find('[data-choice="14"]').classes()).not.toContain('is-active')
    wrapper.unmount()
  })

  it('不可用的命令置灰并在 title 里说明原因；点击不发命令、不展开菜单', async () => {
    const reason = '请先把光标放进表格'
    const wrapper = mountWord({
      formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: {}, unavailable: { 'docx.table.row': reason, 'docx.table.borders': reason } },
    })
    const row = wrapper.find('[data-action="docx.table.rowAbove"]')
    expect(row.attributes('disabled')).toBeDefined()
    expect(row.attributes('title')).toBe(reason)
    await row.trigger('click')
    const borders = wrapper.find('[data-action="docx.table.borders"]')
    expect(borders.attributes('disabled')).toBeDefined()
    await borders.trigger('click')
    expect(wrapper.find('[data-testid="choices-docx.table.borders"]').exists()).toBe(false)
    expect(wrapper.emitted('command')).toBeUndefined()
    // 同一类的另一个命令（插入表格）不受影响
    expect(wrapper.find('[data-action="docx.table.insert"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('颜色选项带色块；"自动"清除颜色（args.color === null）', async () => {
    const wrapper = mountWord()
    await wrapper.find('[data-action="docx.textColor"]').trigger('click')
    const red = wrapper.find('[data-testid="choices-docx.textColor"] [data-choice="红色"]')
    expect(red.find('.kb-editor-swatch').exists()).toBe(true)
    await wrapper.find('[data-testid="choices-docx.textColor"] [data-choice="自动"]').trigger('click')
    expect(wrapper.emitted('command')).toEqual([['docx.textColor', { color: null }]])
    wrapper.unmount()
  })

  it('同一时间只开一个选项菜单；点菜单外收起', async () => {
    const wrapper = mountWord()
    await wrapper.find('[data-action="docx.fontSize"]').trigger('click')
    await wrapper.find('[data-action="docx.fontFamily"]').trigger('click')
    expect(wrapper.find('[data-testid="choices-docx.fontSize"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="choices-docx.fontFamily"]').exists()).toBe(true)
    // jsdom 没有 PointerEvent；Chrome 的监听器只看 target，普通事件即可
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="choices-docx.fontFamily"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('只读：写操作（含修订模式）整颗消失；查找 / 大纲 / 审阅 / 导出保留（查看者要能看评论和修订）', () => {
    const wrapper = mountWord({ readonly: true, permissions: { read: true, write: false, comment: false, ai: false, export: false } })
    const ids = wrapper.findAll('[data-action]').map((node) => node.attributes('data-action'))
    // 只读也保留的非写动作：审阅（看评论 / 修订）、导出和打印（下载 / 打印别人没改的文档不需要写权限）
    expect(ids.filter((id) => id?.startsWith('docx.') && !['docx.review', 'docx.export', 'docx.print'].includes(id))).toEqual([])
    expect(ids).toEqual(expect.arrayContaining(['find', 'docx.review', 'docx.export', 'docx.print']))
    expect(ids).not.toContain('docx.trackChanges')
    wrapper.unmount()
  })

  it('Word 画布工具栏里的非写命令集合是固定的——它们在只读文档里会被放行，新增一个必须有意识地改这里', () => {
    // 命令守卫对「声明里没标 write 的工具栏动作」放行（见 commandFeedback.isReadonlySafeToolbarCommand）。
    // 漏标 write 的"会改文档的动作"会因此在只读下可用：这条测试让这种疏漏出现在评审里，而不是线上
    const nonWrite = PAGE_EDIT_CONTRIBUTION.toolbar.flatMap((group) => group.actions.filter((action) => !action.write).map((action) => action.command))
    expect([...new Set(nonWrite)].sort()).toEqual(['export.docx', 'file.print', 'search.open', 'view.toggleOutline', 'view.toggleReview'])
  })

  it('收进「更多」的带选项动作只占一行（带当前值），点开才列出选项；选一项发命令并收起菜单', async () => {
    // 模拟窄工具栏：每个按钮 32px、工具栏只有 240px，字号 / 字体 / 颜色这些都会被收进「更多」。
    // 测试环境没有 ResizeObserver，外壳挂载时会跳过测量；给一个空实现，让挂载时那一次测量照常发生
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(32)
    const clientSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240)
    const wrapper = mountWord({
      formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: { fontSizePt: 12 }, unavailable: {} },
    })
    await nextTick()
    await wrapper.find('[data-testid="editor-toolbar-more"]').trigger('click')
    const menu = () => wrapper.find('[data-testid="editor-toolbar-more-menu"]')
    const row = menu().find('[data-action="docx.fontSize"]:not([data-choice])')
    expect(row.exists()).toBe(true)
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(row.find('.kb-editor-menu-current').text()).toBe('12')
    // 没点开之前一个选项都不平铺（以前十五个字号全摊在菜单里）
    expect(menu().findAll('[data-choice]')).toHaveLength(0)
    await row.trigger('click')
    expect(menu().find('[data-action="docx.fontSize"]:not([data-choice])').attributes('aria-expanded')).toBe('true')
    expect(menu().findAll('[data-action="docx.fontSize"][data-choice]')).toHaveLength(15)
    expect(menu().findAll('[data-action="docx.fontFamily"][data-choice]')).toHaveLength(0)
    await menu().find('[data-action="docx.fontSize"][data-choice="14"]').trigger('click')
    expect(wrapper.emitted('command')).toEqual([['docx.fontSize', { points: 14 }]])
    expect(wrapper.find('[data-testid="editor-toolbar-more-menu"]').exists()).toBe(false)
    // 再打开时选项是收着的
    await wrapper.find('[data-testid="editor-toolbar-more"]').trigger('click')
    expect(menu().findAll('[data-choice]')).toHaveLength(0)
    widthSpy.mockRestore()
    clientSpy.mockRestore()
    vi.unstubAllGlobals()
    wrapper.unmount()
  })

  it('修订 / 审阅按钮按开关高亮', () => {
    const wrapper = mountWord({
      formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: {}, unavailable: {}, toggles: ['trackChanges'] },
    })
    expect(wrapper.find('[data-action="docx.trackChanges"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-action="docx.review"]').attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('工具栏里每个按钮的命令都是本内容面认得的 docx.* 或 docx.image.pick（防止声明了没人处理的按钮）', async () => {
    const { isDocxCommandType } = await import('../surfaces/page/commands/intents')
    const commands = PAGE_EDIT_CONTRIBUTION.toolbar.flatMap((group) => group.actions.map((action) => action.command))
    for (const command of commands) {
      const handled =
        isDocxCommandType(command) || ['docx.image.pick', 'search.open', 'view.toggleOutline', 'view.toggleReview', 'docx.trackChanges.toggle', 'export.docx', 'file.print'].includes(command)
      expect(handled, command).toBe(true)
    }
  })
})
