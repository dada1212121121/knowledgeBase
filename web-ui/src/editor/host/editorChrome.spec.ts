/**
 * EditorChrome 单测
 *
 * Chrome 的职责边界很窄：渲染贡献数据 + 发语义事件。这里逐条钉住：
 * - 按钮来自贡献而不是硬编码模板，写操作在只读时整颗消失；
 * - 高亮来自 Surface 上报的 formatState，不在前端猜；
 * - 查找条的数字来自 findState，键盘行为符合桌面编辑器习惯；
 * - AI / 评论 / 导出只在宿主声明有能力时出现；它们和字数一样是内置扩展的贡献，
 *   这里按 Host 的做法从真实的注册表取出再交给 Chrome，不手写假数据。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import EditorChrome from './EditorChrome.vue'
import { barActionsFor, contributionWith, visibleAiTools, type CapabilityFlags } from '../extensions/contributions'
import { getExtensionRegistry } from '../extensions/runtime'
import type { SurfaceKindName } from '../extensions/api'
import { pickHeading } from './chromeTestKit'
import type { Anchor, EditorPermissions } from '../types'

const FULL: EditorPermissions = { read: true, write: true, comment: true, ai: true, export: true }
const READONLY: EditorPermissions = { read: true, write: false, comment: false, ai: false, export: true }
const ANCHOR = { kind: 'text', block: 'h2:0', offset: 0 } as Anchor

/** 工具栏 = 内置静态数据 + 注册表里的贡献（「查找替换」「大纲」已由内置扩展注册） */
const contributionFor = (kind: SurfaceKindName, format?: string) => contributionWith(kind, getExtensionRegistry(), format)

/** 和 EditorHost 一样：能力 → 操作区按钮 + AI 工具；字数 → 状态栏项 */
function hostData(kind: SurfaceKindName, capabilities: CapabilityFlags, words: number, unitLabel: string) {
  const registry = getExtensionRegistry()
  const state = { kind, format: 'md', words, unitLabel, readonly: false, dirty: false, phase: 'ready' as const }
  return {
    barActions: barActionsFor(kind, registry, capabilities),
    aiTools: visibleAiTools(registry, { page: capabilities.ai === true, suggestion: false }),
    statusItems: registry.statusTexts(kind, 'chrome', state),
  }
}

function mountChrome(overrides: Record<string, unknown> = {}) {
  const { capabilities, wordCount, unitLabel, ...rest } = overrides as { capabilities?: CapabilityFlags; wordCount?: number; unitLabel?: string }
  const kind = ((rest as { kind?: SurfaceKindName }).kind ?? 'text') as SurfaceKindName
  return mount(EditorChrome, {
    props: {
      ...hostData(kind, capabilities ?? { ai: true, comment: true, export: true }, wordCount ?? 42, unitLabel ?? ''),
      kind: 'text',
      format: 'md',
      title: '周报.md',
      phase: 'ready',
      permissions: FULL,
      readonly: false,
      contribution: contributionFor('text'),
      formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false } },
      outline: [
        { level: 1, text: '一', anchor: ANCHOR },
        { level: 2, text: '二', anchor: ANCHOR },
      ],
      ...rest,
    },
  })
}

describe('工具栏：数据驱动与只读收敛', () => {
  it('1. 按贡献渲染全部分组与按钮，带 aria-label / data-action', () => {
    const wrapper = mountChrome()
    const actions = wrapper.findAll('[data-action]')
    // 段落格式 / 插入是下拉，各算一个按钮；子项在下拉里（打开才渲染）。引用进了段落格式下拉，多了格式刷和清除格式
    expect(actions.length).toBe(19)
    expect(actions.map((button) => button.attributes('data-action'))).toContain('bold')
    const bold = wrapper.find('[data-action="bold"]')
    // 图标按钮的可访问名称包含可见字形，axe 的 label-content-name-mismatch 才不会报
    expect(bold.attributes('aria-label')).toBe('B 加粗')
    expect(bold.attributes('title')).toBe('加粗（Ctrl+B）')
    expect(bold.attributes('aria-keyshortcuts')).toBe('Control+B')
  })

  it('2. 只读时写操作整颗不渲染，视图类仍可用', () => {
    const wrapper = mountChrome({ readonly: true, permissions: READONLY })
    expect(wrapper.find('[data-action="bold"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="table"]').exists()).toBe(false)
    // 查找/大纲是只读动作，保留
    expect(wrapper.find('[data-action="find"]').exists()).toBe(true)
    expect(wrapper.find('[data-action="outline"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-undo"]').exists()).toBe(false)
  })

  it('3. 没有贡献时只显示通用按钮，不报错', () => {
    const wrapper = mountChrome({ contribution: null })
    expect(wrapper.findAll('[data-action]').length).toBe(0)
    expect(wrapper.find('[data-testid="editor-close"]').exists()).toBe(true)
  })

  it('4. 点击内容面按钮 → command 事件带命令类型与参数', async () => {
    const wrapper = mountChrome()
    await pickHeading(wrapper, 'heading.2')
    await wrapper.find('[data-action="bold"]').trigger('click')
    expect(wrapper.emitted('command')?.[0]).toEqual(['block.setHeading', { level: 2 }])
    expect(wrapper.emitted('command')?.[1]).toEqual(['mark.toggle', { mark: 'strong' }])
  })

  it('5. 高亮来自 formatState：加粗、二级标题、任务列表各自独立', async () => {
    const wrapper = mountChrome({
      formatState: {
        marks: ['strong'],
        block: 'heading',
        level: 2,
        inBlockquote: false,
        lists: { bullet: true, ordered: false, task: true },
      },
    })
    expect(wrapper.find('[data-action="bold"]').attributes('aria-pressed')).toBe('true')
    // 标题是下拉：按钮本身高亮（当前在标题里），打开后选中项是 H2，H1 不是
    expect(wrapper.find('[data-action="heading"]').classes()).toContain('is-active')
    await wrapper.find('[data-action="heading"]').trigger('click')
    expect(wrapper.find('[data-action="heading.2"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.find('[data-action="heading.1"]').attributes('aria-checked')).toBe('false')
    expect(wrapper.find('[data-action="task"]').attributes('aria-pressed')).toBe('true')
    // 任务列表也是 bullet_list，但高亮应落在任务按钮上，不能两个都亮
    expect(wrapper.find('[data-action="bullet"]').attributes('aria-pressed')).toBe('false')
  })

  it('6. 字数与状态文案', () => {
    const wrapper = mountChrome({ wordCount: 42 })
    expect(wrapper.find('[data-testid="editor-chrome-count"]').text()).toBe('42 字')
    expect(wrapper.find('[data-testid="editor-status"]').text()).toBe('已就绪')
    const dirty = mountChrome({ dirty: true })
    expect(dirty.find('[data-testid="editor-status"]').text()).toBe('有未保存的改动')
  })
})

describe('查找条', () => {
  it('7. 点查找按钮 → 出现输入框并聚焦，输入即发 find-change', async () => {
    const wrapper = mountChrome({ attachTo: document.body })
    await wrapper.find('[data-action="find"]').trigger('click')
    const input = wrapper.find('[data-testid="editor-find-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('周报')
    expect(wrapper.emitted('find-change')?.at(-1)).toEqual(['周报'])
    wrapper.unmount()
  })

  it('8. 命中数如实显示，无命中显示「无匹配」', async () => {
    const wrapper = mountChrome({
      findState: { open: true, query: '周', total: 3, index: 1 },
    })
    expect(wrapper.find('[data-testid="editor-find-count"]').text()).toBe('2/3')
    await wrapper.setProps({ findState: { open: true, query: '周', total: 0, index: -1 } })
    expect(wrapper.find('[data-testid="editor-find-count"]').text()).toBe('无匹配')
  })

  it('9. Enter/Shift+Enter 切换下一个/上一个，Esc 关闭并发 find-close', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="find"]').trigger('click')
    const input = wrapper.find('[data-testid="editor-find-input"]')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('find-next')?.length).toBe(1)
    expect(wrapper.emitted('find-prev')?.length).toBe(1)
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('find-close')?.length).toBe(1)
    expect(wrapper.find('[data-testid="editor-find-bar"]').exists()).toBe(false)
  })

  it('10. Tab 展开替换行，替换 / 全部替换带替换文本', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="find"]').trigger('click')
    await wrapper.find('[data-testid="editor-find-input"]').trigger('keydown', { key: 'Tab' })
    await wrapper.find('[data-testid="editor-find-replace-input"]').setValue('月报')
    await wrapper.find('[data-testid="editor-find-replace"]').trigger('click')
    await wrapper.find('[data-testid="editor-find-replace-all"]').trigger('click')
    expect(wrapper.emitted('find-replace')?.[0]).toEqual(['月报'])
    expect(wrapper.emitted('find-replace-all')?.[0]).toEqual(['月报'])
  })

  it('11. findState.open 由 false → true 时自动展开（Host 的 Ctrl+F 走这条）', async () => {
    const wrapper = mountChrome({ findState: { open: false, query: '', total: 0, index: -1 } })
    await wrapper.setProps({ findState: { open: true, query: '周', total: 1, index: 0 } })
    expect(wrapper.find('[data-testid="editor-find-bar"]').exists()).toBe(true)
    expect((wrapper.find('[data-testid="editor-find-input"]').element as HTMLInputElement).value).toBe('周')
  })
})

describe('大纲 / 链接 / 能力入口', () => {
  it('12. 大纲按钮展开条目，点击发 outline-jump', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="outline"]').trigger('click')
    const items = wrapper.findAll('.kb-editor-outline-item')
    expect(items.map((item) => item.text())).toEqual(['一', '二'])
    expect(items[1].classes()).toContain('is-h2')
    await items[1].trigger('click')
    expect(wrapper.emitted('outline-jump')?.[0]).toEqual([ANCHOR])
  })

  it('13. 链接：确定发 text.link.apply，移除发空地址', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="link"]').trigger('click')
    await wrapper.find('[data-testid="editor-link-input"]').setValue('./a.md')
    await wrapper.find('[data-testid="editor-link-apply"]').trigger('click')
    expect(wrapper.emitted('command')?.[0]).toEqual(['text.link.apply', { href: './a.md' }])

    await wrapper.find('[data-action="link"]').trigger('click')
    await wrapper.find('[data-testid="editor-link-remove"]').trigger('click')
    expect(wrapper.emitted('command')?.[1]).toEqual(['text.link.apply', { href: '' }])
  })

  it('14. 图片按钮只能通过 file input 选文件并发 image-request', async () => {
    const wrapper = mountChrome()
    const file = new File(['x'], 'p.png', { type: 'image/png' })
    const input = wrapper.find('[data-testid="editor-image-input"]')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    expect(wrapper.emitted('image-request')?.[0]?.[0]).toBe(file)
  })

  it('15. AI / 评论 / 导出只在宿主声明能力时出现；AI 菜单发工具 id，操作区按钮发命令（都是内置扩展的贡献）', async () => {
    const wrapper = mountChrome({ capabilities: { ai: false, comment: false, export: false } })
    expect(wrapper.find('[data-testid="editor-ai"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-comment"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-export"]').exists()).toBe(false)

    const full = mountChrome()
    await full.find('[data-testid="editor-ai"]').trigger('click')
    expect(full.find('[data-testid="editor-ai-menu"]').exists()).toBe(true)
    expect(full.findAll('[data-testid="editor-ai-menu"] [role="menuitem"]').map((item) => item.text())).toEqual(['润色选中', '总结选中', '翻译选中'])
    await full.findAll('[data-testid="editor-ai-menu"] [role="menuitem"]')[1].trigger('click')
    expect(full.emitted('ai-tool')?.[0]).toEqual(['summary'])
    await full.find('[data-testid="editor-comment"]').trigger('click')
    expect(full.emitted('command')?.at(-1)).toEqual(['comment.open', undefined])
    await full.find('[data-testid="editor-export"]').trigger('click')
    expect(full.emitted('command')?.at(-1)).toEqual(['export.open', undefined])
    expect(full.find('[data-testid="editor-export"]').attributes('aria-label')).toBe('导出 Markdown')
  })

  it('16b. 版本冲突 / 保存失败之后保存按钮仍可点（改动还在编辑器里，重试是唯一出路）；保存中、只读、没改动仍不可点', () => {
    const save = (props: Record<string, unknown>) => mountChrome(props).find('[data-testid="editor-save"]').attributes('disabled')
    expect(save({ dirty: true, phase: 'conflict' })).toBeUndefined()
    expect(save({ dirty: true, phase: 'error' })).toBeUndefined()
    // 其它阶段不放开：保存中（防重复提交）、加载中、没有改动、只读
    expect(save({ dirty: true, phase: 'saving' })).toBeDefined()
    expect(save({ dirty: true, phase: 'loading' })).toBeDefined()
    expect(save({ dirty: false, phase: 'conflict' })).toBeDefined()
    expect(mountChrome({ dirty: true, phase: 'conflict', readonly: true }).find('[data-testid="editor-save"]').exists()).toBe(false)
    // 冲突时撤销 / 重做仍按原来的规则灰着：只放开保存
    expect(mountChrome({ dirty: true, phase: 'conflict' }).find('[data-testid="editor-undo"]').attributes('disabled')).toBeDefined()
  })

  it('16. 保存/撤销/重做按钮的可用态跟随会话阶段与脏标记', async () => {
    const clean = mountChrome()
    expect(clean.find('[data-testid="editor-save"]').attributes('disabled')).toBeDefined()
    const dirty = mountChrome({ dirty: true })
    expect(dirty.find('[data-testid="editor-save"]').attributes('disabled')).toBeUndefined()
    const saving = mountChrome({ dirty: true, phase: 'saving' })
    expect(saving.find('[data-testid="editor-save"]').attributes('disabled')).toBeDefined()
    expect(saving.find('[data-testid="editor-undo"]').attributes('disabled')).toBeDefined()
    // 协同连接时保存交给协同层，不显示保存按钮
    const collab = mountChrome({ collabState: { status: 'connected', peers: 1 } })
    expect(collab.find('[data-testid="editor-save"]').exists()).toBe(false)
  })
})

describe('外壳与页面整合', () => {
  it('页面自带保存时（showSave=false）不渲染第二个「保存」，撤销 / 重做照常', () => {
    const wrapper = mountChrome({ showSave: false, dirty: true })
    expect(wrapper.find('[data-testid="editor-save"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-undo"]').exists()).toBe(true)
  })

  it('PDF / 表格 / 代码工具栏上有看得见的「查找」，点了打开查找条', async () => {
    for (const kind of ['pdf', 'grid', 'code'] as const) {
      const wrapper = mountChrome({ kind, contribution: contributionFor(kind), readonly: kind === 'pdf', permissions: kind === 'pdf' ? READONLY : FULL })
      const find = wrapper.find('[data-action="find"]')
      expect(find.exists(), kind).toBe(true)
      await find.trigger('click')
      expect(wrapper.find('[data-testid="editor-find-bar"]').exists(), kind).toBe(true)
    }
  })

  it('CSV / TSV 表格有行操作按钮（上方 / 下方插入、删除、末尾加一行），xlsx 没有', () => {
    for (const format of ['csv', 'tsv']) {
      const wrapper = mountChrome({ kind: 'grid', format, contribution: contributionFor('grid', format), permissions: FULL, readonly: false, phase: 'ready' })
      const ids = wrapper.findAll('[data-action]').map((node) => node.attributes('data-action'))
      expect(ids, format).toEqual(expect.arrayContaining(['find', 'row.insertAbove', 'row.insertBelow', 'row.delete', 'row.append']))
    }
    const xlsx = mountChrome({ kind: 'grid', format: 'xlsx', contribution: contributionFor('grid', 'xlsx'), permissions: FULL, readonly: false, phase: 'ready' })
    expect(xlsx.find('[data-action="row.delete"]').exists()).toBe(false)
  })

  it('行操作按钮是写操作：只读时整颗不渲染；点击发出对应的网格命令', async () => {
    const readonly = mountChrome({ kind: 'grid', format: 'csv', contribution: contributionFor('grid', 'csv'), permissions: READONLY, readonly: true, phase: 'ready' })
    expect(readonly.find('[data-action="row.delete"]').exists()).toBe(false)
    const wrapper = mountChrome({ kind: 'grid', format: 'csv', contribution: contributionFor('grid', 'csv'), permissions: FULL, readonly: false, phase: 'ready' })
    await wrapper.find('[data-action="row.insertBelow"]').trigger('click')
    await wrapper.find('[data-action="row.delete"]').trigger('click')
    expect(wrapper.emitted('command')).toEqual([['grid.insertRowBelow', undefined], ['grid.deleteRows', undefined]])
  })

  it('按钮多时工具栏单独占一行（is-stacked），只有查找时不占', () => {
    expect(mountChrome().classes()).toContain('is-stacked')
    expect(mountChrome({ kind: 'pdf', contribution: contributionFor('pdf') }).classes()).not.toContain('is-stacked')
  })

  it('量不出宽度（无布局）时全部按钮留在工具栏上，不出现「更多」', () => {
    const wrapper = mountChrome()
    expect(wrapper.find('[data-testid="editor-toolbar-more"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="editor-toolbar-slot"] [data-action]').length).toBeGreaterThan(15)
  })
})

describe('笔记工具栏补齐', () => {
  it('「更多插入」是下拉：点开列出旧编辑器 insert 菜单的全部项，选一项发对应命令', async () => {
    const wrapper = mountChrome()
    expect(wrapper.find('[data-testid="editor-dropdown-insertMore"]').exists()).toBe(false)
    await wrapper.find('[data-action="insertMore"]').trigger('click')
    const menu = wrapper.find('[data-testid="editor-dropdown-insertMore"]')
    expect(menu.exists()).toBe(true)
    const ids = menu.findAll('[data-action]').map((item) => item.attributes('data-action'))
    // 旧编辑器 insert 菜单的全部内容：代码块、流程图、公式、引用笔记 / 文件、附件、提示块 ×5、分隔线
    expect(ids).toEqual(['codeblock', 'diagram', 'math', 'mathInline', 'wikilink', 'filelink', 'attachment', 'callout.note', 'callout.tip', 'callout.important', 'callout.warning', 'callout.caution', 'hr'])
    await menu.find('[data-action="callout.warning"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['block.insertCallout', { type: 'warning' }])
    // 选完收起
    expect(wrapper.find('[data-testid="editor-dropdown-insertMore"]').exists()).toBe(false)
  })

  it('下拉里的「引用笔记」发 text.panel.open，由内容面转给 Host 的面板', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="insertMore"]').trigger('click')
    await wrapper.find('[data-action="wikilink"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['text.panel.open', { panel: 'wikilink' }])
  })

  it('只读时整个下拉消失', () => {
    const wrapper = mountChrome({ readonly: true, permissions: READONLY })
    expect(wrapper.find('[data-action="insertMore"]').exists()).toBe(false)
  })

  it('附件在插入下拉里，发 text.panel.open；H4 在标题下拉里；字色按钮存在', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="insertMore"]').trigger('click')
    await wrapper.find('[data-action="attachment"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['text.panel.open', { panel: 'attachment' }])
    await pickHeading(wrapper, 'heading.4')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['block.setHeading', { level: 4 }])
    expect(wrapper.find('[data-action="color"]').exists()).toBe(true)
  })

  it('图片按钮：Host 接管面板时发 text.panel.open，不用 Chrome 自带的单图 input', async () => {
    const wrapper = mountChrome({ textPanels: true })
    await wrapper.find('[data-action="image"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['text.panel.open', { panel: 'image' }])
  })

  it('字色：点按钮出现色板（7 种字色 + 7 种底色 + 两个清除），选色发 mark.color', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="color"]').trigger('click')
    const bar = wrapper.find('[data-testid="editor-color-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.findAll('.kb-editor-swatch')).toHaveLength(16)
    await wrapper.find('[data-testid="editor-color-fg-red"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'color', key: 'red' }])
    // 选完收起
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(false)
    await wrapper.find('[data-action="color"]').trigger('click')
    await wrapper.find('[data-testid="editor-color-bg-yellow"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'background-color', key: 'yellow' }])
    await wrapper.find('[data-action="color"]').trigger('click')
    await wrapper.find('[data-testid="editor-color-none"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'color', key: null }])
  })

  it('更多颜色：展开扩展色与自定义取色器，点扩展色 / 输入 hex 都发自定义色并收起', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="color"]').trigger('click')
    await wrapper.find('[data-testid="editor-color-custom-color"]').trigger('click')
    expect(wrapper.find('[data-testid="editor-color-picker"]').exists()).toBe(true)
    expect(wrapper.findAll('.kb-color-preset')).toHaveLength(32)
    await wrapper.find('[data-testid="editor-color-preset-1"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'color', key: '#374151' }])
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(false)

    await wrapper.find('[data-action="color"]').trigger('click')
    await wrapper.find('[data-testid="editor-color-custom-bg"]').trigger('click')
    const input = wrapper.find('[data-testid="editor-color-hex"]')
    expect((input.element as HTMLInputElement).value).toBe('#fff3a3')
    await input.setValue('#123456')
    await wrapper.find('[data-testid="editor-color-apply"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'background-color', key: '#123456' }])
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(false)
  })

  it('自定义字色：工具栏小条直接显示 hex，不再拼 is-fg-#… 类名', () => {
    const wrapper = mountChrome({
      formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: { noteColor: '#123456' } },
    })
    const bar = wrapper.find('.kb-color-bar')
    expect(bar.classes()).not.toContain('is-fg-#123456')
    expect(bar.attributes('style')).toContain('color: rgb(18, 52, 86)')
  })

  it('链接条：光标在已有链接里时回填它的地址', async () => {
    const wrapper = mountChrome({ queryLink: async () => 'https://a.example' })
    await wrapper.find('[data-action="link"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((wrapper.find('[data-testid="editor-link-input"]').element as HTMLInputElement).value).toBe('https://a.example')
  })

  it('链接条：没在链接里就空白起步', async () => {
    const wrapper = mountChrome({ queryLink: async () => '' })
    await wrapper.find('[data-action="link"]').trigger('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((wrapper.find('[data-testid="editor-link-input"]').element as HTMLInputElement).value).toBe('')
  })
})

describe('源码模式下的工具栏', () => {
  const inSource = { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, toggles: ['source'] }

  it('格式按钮收起，只剩“源码”开关（高亮）和查找以外的视图项', () => {
    const wrapper = mountChrome({ formatState: inSource })
    expect(wrapper.find('[data-action="bold"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="insertMore"]').exists()).toBe(false)
    expect(wrapper.find('[data-action="table"]').exists()).toBe(false)
    const source = wrapper.find('[data-action="source"]')
    expect(source.exists()).toBe(true)
    expect(source.attributes('aria-pressed')).toBe('true')
  })

  it('平时源码按钮存在但没按下；点它发 view.toggleSource', async () => {
    const wrapper = mountChrome()
    const source = wrapper.find('[data-action="source"]')
    expect(source.attributes('aria-pressed')).toBe('false')
    await source.trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['view.toggleSource', undefined])
  })

  it('只读时没有源码开关', () => {
    const wrapper = mountChrome({ readonly: true, permissions: READONLY })
    expect(wrapper.find('[data-action="source"]').exists()).toBe(false)
  })
})

describe('标题下拉与工具栏优先级', () => {
  it('标题下拉列出 正文 / H1–H6，选完收起', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="heading"]').trigger('click')
    const ids = wrapper.findAll('[data-testid="editor-dropdown-heading"] [data-action]').map((item) => item.attributes('data-action'))
    expect(ids).toEqual(['paragraph', 'heading.1', 'heading.2', 'heading.3', 'heading.4', 'heading.5', 'heading.6', 'quote'])
    await wrapper.find('[data-action="paragraph"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['block.setHeading', { level: 0 }])
    expect(wrapper.find('[data-testid="editor-dropdown-heading"]').exists()).toBe(false)
  })

  it('同一时间只开一个下拉：开插入时标题下拉收起', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="heading"]').trigger('click')
    await wrapper.find('[data-action="insertMore"]').trigger('click')
    expect(wrapper.find('[data-testid="editor-dropdown-heading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-dropdown-insertMore"]').exists()).toBe(true)
  })

  it('常用入口在“更多”之前：插入、查找、源码按钮都排在 16 个按钮之内，宽度不够时先收的是后面的', () => {
    const wrapper = mountChrome()
    const ids = wrapper.findAll('[data-testid="editor-toolbar-slot"] > [data-entry][data-action], [data-testid="editor-toolbar-slot"] > div[data-entry] [data-action]').map((el) => el.attributes('data-action'))
    const order = ['heading', 'insertMore', 'find', 'source']
    for (const id of order) expect(ids.indexOf(id), id).toBeGreaterThanOrEqual(0)
    // 大纲是最不常用的，排在最后（窄屏时第一个被收进“更多”）
    expect(ids.at(-1)).toBe('outline')
    expect(ids.indexOf('source')).toBeLessThan(ids.indexOf('outline'))
  })
})

describe('工具栏不抢正文焦点（，与旧编辑器 mousedown.prevent 一致）', () => {
  it('在工具栏按钮 / 下拉项 / “更多”上按下鼠标会被拦下（焦点留在正文），输入框不拦', async () => {
    const wrapper = mountChrome()
    const down = async (selector: string) => {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      wrapper.find(selector).element.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(await down('[data-action="bold"]')).toBe(true)
    expect(await down('[data-action="heading"]')).toBe(true)
    await wrapper.find('[data-action="heading"]').trigger('click')
    expect(await down('[data-action="heading.2"]')).toBe(true)
    // 链接输入框在工具栏容器之外：要能点进去打字
    await wrapper.find('[data-action="link"]').trigger('click')
    expect(await down('[data-testid="editor-link-input"]')).toBe(false)
  })
})

describe('查找条 / 链接条里的输入法组字', () => {
  const ime = (key: string) => new KeyboardEvent('keydown', { key, isComposing: true, keyCode: 229, bubbles: true, cancelable: true })

  it('查找框里组字时按 Esc（取消组字）不关查找条，按回车不跳下一个', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="find"]').trigger('click')
    const input = wrapper.find('[data-testid="editor-find-input"]')
    const esc = ime('Escape')
    const enter = ime('Enter')
    input.element.dispatchEvent(esc)
    input.element.dispatchEvent(enter)
    expect(wrapper.find('[data-testid="editor-find-bar"]').exists()).toBe(true)
    expect(esc.defaultPrevented).toBe(false)
    expect(enter.defaultPrevented).toBe(false)
    expect(wrapper.emitted('find-next')).toBeUndefined()
    // 组字结束后 Esc 照常关闭
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="editor-find-bar"]').exists()).toBe(false)
  })

  it('链接框里组字时回车（上屏）不应用链接、Esc（取消组字）不关输入条', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="link"]').trigger('click')
    const input = wrapper.find('[data-testid="editor-link-input"]')
    await input.setValue('https://example.com')
    input.element.dispatchEvent(ime('Enter'))
    input.element.dispatchEvent(ime('Escape'))
    expect(wrapper.emitted('command')?.some(([type]) => type === 'text.link.apply')).toBeFalsy()
    expect(wrapper.find('[data-testid="editor-link-bar"]').exists()).toBe(true)
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['text.link.apply', { href: 'https://example.com' }])
    expect(wrapper.find('[data-testid="editor-link-bar"]').exists()).toBe(false)
  })
})

describe('菜单不伸出屏幕', () => {
  it('靠右的菜单越过右边缘 → 向左平移到屏内；靠左的反之', async () => {
    vi.stubGlobal('innerWidth', 390)
    // 夹取用 offsetWidth / offsetLeft（布局尺寸，不受进场动画 scale 影响）；happy-dom 没有布局，
    // 这里把目标菜单模拟成 left=352 / width=132，即右边缘 484
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'editor-dropdown-insertMore' ? 132 : 0
    })
    const leftSpy = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'editor-dropdown-insertMore' ? 352 : 0
    })
    const parentSpy = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(null)
    const wrapper = mountChrome()
    await wrapper.find('[data-action="insertMore"]').trigger('click')
    const menu = wrapper.find('[data-testid="editor-dropdown-insertMore"]').element as HTMLElement
    // 越过右边缘 484 → 382（屏宽 390 − 8）：平移 −102（用独立的 translate 属性，不和进场动画的 transform 抢）
    expect(menu.style.translate).toBe('-102px 0')
    widthSpy.mockRestore()
    leftSpy.mockRestore()
    parentSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('手机上外壳压成一行（，设计规范第一行正文 ≤30% 屏高）', () => {
  function phone(width: number) {
    vi.stubGlobal('innerWidth', width)
  }

  it('手机宽度：状态 / 字数 / 导出收起，撤销重做挪进工具栏最前面；点它们照常发事件', async () => {
    phone(390)
    const wrapper = mountChrome({ dockable: true })
    expect(wrapper.classes()).toContain('is-compact')
    expect(wrapper.find('[data-testid="editor-chrome-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="editor-export"]').exists()).toBe(false)
    const undo = wrapper.find('[data-testid="editor-toolbar-slot"] [data-testid="editor-undo"]')
    expect(undo.exists()).toBe(true)
    await undo.trigger('click')
    await wrapper.find('[data-testid="editor-toolbar-slot"] [data-testid="editor-redo"]').trigger('click')
    expect(wrapper.emitted('undo')).toHaveLength(1)
    expect(wrapper.emitted('redo')).toHaveLength(1)
    // 每个 testid 只有一个元素（动作区里的那对不渲染）
    expect(wrapper.findAll('[data-testid="editor-undo"]')).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('桌面宽度 / 其它内容面：外壳不变（动作区有字数、导出、撤销重做）', () => {
    phone(1440)
    const desktop = mountChrome({ dockable: true })
    expect(desktop.classes()).not.toContain('is-compact')
    expect(desktop.find('[data-testid="editor-chrome-count"]').exists()).toBe(true)
    expect(desktop.find('.kb-editor-chrome-actions [data-testid="editor-undo"]').exists()).toBe(true)
    phone(390)
    // 没传 dockable（代码 / 表格 / PDF 等）：手机上也不压缩
    const other = mountChrome({ dockable: false })
    expect(other.classes()).not.toContain('is-compact')
    expect(other.find('[data-testid="editor-chrome-count"]').exists()).toBe(true)
    vi.unstubAllGlobals()
  })

  it('只读：没有撤销重做，压缩后也不出现', () => {
    phone(390)
    const wrapper = mountChrome({ dockable: true, readonly: true, permissions: READONLY })
    expect(wrapper.find('[data-testid="editor-undo"]').exists()).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('字体与颜色面板', () => {
  it('字体下拉：默认字体 + 表里的字体，每一项用自己的字体显示，选中发 mark.color(font-family)', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="font"]').trigger('click')
    const items = wrapper.findAll('[data-testid="choices-font"] [role="menuitem"]')
    expect(items.map((item) => item.attributes('data-choice'))).toEqual(['默认字体', '黑体', '宋体', '楷体', '仿宋', '等宽', 'Georgia', 'Arial'])
    expect(items[2]!.find('span').attributes('style')).toContain('Songti SC')
    await items[2]!.trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'font-family', key: 'serif' }])
    // 选中后收起；没设过字体时「默认字体」打勾
  })

  it('当前字体打勾：formatState 里有 noteFont 就标出那一项，没有就是「默认字体」', async () => {
    const withFont = mountChrome({ formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: { noteFont: 'kai' } } })
    await withFont.find('[data-action="font"]').trigger('click')
    expect(withFont.find('[data-testid="choices-font"] .is-active').attributes('data-choice')).toBe('楷体')
    const plain = mountChrome({ formatState: { marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, values: { noteFont: null } } })
    await plain.find('[data-action="font"]').trigger('click')
    expect(plain.find('[data-testid="choices-font"] .is-active').attributes('data-choice')).toBe('默认字体')
  })

  it('文字颜色：点按钮弹出悬浮面板（不再是顶部色板条），选色发 mark.color 并收起；再点按钮 / 点面板外收起', async () => {
    const wrapper = mountChrome()
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(false)
    await wrapper.find('[data-action="color"]').trigger('click')
    const panel = wrapper.find('[data-testid="editor-color-bar"]')
    expect(panel.exists()).toBe(true)
    expect(panel.classes()).toContain('kb-editor-chrome-menu')
    await wrapper.find('[data-testid="editor-color-fg-red"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'color', key: 'red' }])
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(false)
    await wrapper.find('[data-action="color"]').trigger('click')
    await wrapper.find('[data-testid="editor-color-bg-yellow"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['mark.color', { prop: 'background-color', key: 'yellow' }])
    await wrapper.find('[data-action="color"]').trigger('click')
    await wrapper.find('[data-action="color"]').trigger('click')
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(false)
  })

  it('鼠标悬停（有悬停能力的设备）：停一下就弹出面板，离开稍等再收起；触屏设备悬停不触发', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('hover: hover'), media: query, addEventListener() {}, removeEventListener() {} }))
    const wrapper = mountChrome()
    const wrap = wrapper.find('[data-panel-wrap="color"]')
    await wrap.trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(120)
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(true)
    await wrap.trigger('mouseleave')
    await vi.advanceTimersByTimeAsync(100)
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(wrapper.find('[data-testid="editor-color-bar"]').exists()).toBe(false)
    vi.unstubAllGlobals()
    vi.useRealTimers()
    wrapper.unmount()
  })
})

describe('表格：大小选择面板 + 工具栏下面的表格工具条（没有浮动工具条）', () => {
  const state = (inTable: boolean) => ({ marks: [], block: 'paragraph', inBlockquote: false, lists: { bullet: false, ordered: false, task: false }, inTable })

  it('点表格按钮弹出 8 × 8 的大小面板；划到哪格标题就写「行 × 列」；点一格按那个大小插入', async () => {
    const wrapper = mountChrome()
    expect(wrapper.find('[data-testid="table-grid"]').exists()).toBe(false)
    await wrapper.find('[data-action="table"]').trigger('click')
    expect(wrapper.find('[data-testid="table-grid"]').exists()).toBe(true)
    expect(wrapper.findAll('.kb-table-cell')).toHaveLength(64)
    expect(wrapper.find('[data-testid="table-grid-label"]').text()).toBe('3 × 3 表格')
    await wrapper.find('[data-testid="table-cell-2-4"]').trigger('mouseenter')
    expect(wrapper.find('[data-testid="table-grid-label"]').text()).toBe('2 × 4 表格')
    expect(wrapper.findAll('.kb-table-cell.is-on')).toHaveLength(8)
    await wrapper.find('[data-testid="table-cell-2-4"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['block.insertTable', { rows: 2, cols: 4 }])
    expect(wrapper.find('[data-testid="table-grid"]').exists()).toBe(false)
  })

  it('键盘：方向键移动，回车按当前大小插入', async () => {
    const wrapper = mountChrome()
    await wrapper.find('[data-action="table"]').trigger('click')
    const grid = wrapper.find('.kb-table-grid')
    await grid.trigger('keydown', { key: 'ArrowRight' })
    await grid.trigger('keydown', { key: 'ArrowDown' })
    await grid.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['block.insertTable', { rows: 4, cols: 4 }])
  })

  it('光标在表格里：工具栏下面出现表格工具条，按钮发 table.* 命令；离开表格 / 只读时没有', async () => {
    const outside = mountChrome({ formatState: state(false) })
    expect(outside.find('[data-testid="editor-table-tools"]').exists()).toBe(false)
    const inside = mountChrome({ formatState: state(true) })
    expect(inside.find('[data-testid="editor-table-tools"]').exists()).toBe(true)
    const run = async (id: string) => {
      await inside.find(`[data-testid="editor-table-tools"] [data-action="${id}"]`).trigger('click')
      return inside.emitted('command')?.at(-1)
    }
    expect(await run('row-below')).toEqual(['table.addRow', { where: 'after' }])
    expect(await run('col-left')).toEqual(['table.addColumn', { where: 'before' }])
    expect(await run('align-center')).toEqual(['table.align', { align: 'center' }])
    expect(await run('row-delete')).toEqual(['table.deleteRow', undefined])
    expect(await run('table-delete')).toEqual(['table.delete', undefined])
    const readonly = mountChrome({ formatState: state(true), readonly: true })
    expect(readonly.find('[data-testid="editor-table-tools"]').exists()).toBe(false)
  })

  it('链接条：光标在已有链接上时有「打开 / 复制地址」，新建链接时没有', async () => {
    const wrapper = mountChrome({ queryLink: async () => 'https://a.example' })
    await wrapper.find('[data-action="link"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="editor-link-input"]').element).toHaveProperty('value', 'https://a.example')
    await wrapper.find('[data-testid="editor-link-open"]').trigger('click')
    expect(wrapper.emitted('command')?.at(-1)).toEqual(['text.link.open-href', { href: 'https://a.example' }])
    expect(wrapper.find('[data-testid="editor-link-copy"]').exists()).toBe(true)
    const fresh = mountChrome({ queryLink: async () => '' })
    await fresh.find('[data-action="link"]').trigger('click')
    await flushPromises()
    expect(fresh.find('[data-testid="editor-link-open"]').exists()).toBe(false)
  })
})

describe('⌘K 命令面板：复用工具栏动作（UI-5）', () => {
  it('列出的命令就是工具栏能执行的写操作，点击真的发命令；需要浮层的动作不列', async () => {
    const wrapper = mountChrome()
    const actions = wrapper.vm.paletteActions()
    const ids = actions.map((action: { id: string }) => action.id)
    expect(ids).toContain('bold')
    expect(ids).toContain('bullet')
    // 表格 / 链接 / 图片要弹一个挂在工具栏上的浮层，面板已经关了，不该列
    expect(ids).not.toContain('table')
    expect(ids).not.toContain('link')
    expect(ids).not.toContain('image')
    // 搜索 / 大纲有自己的面板，可以列
    expect(ids).toContain('find')
    expect(ids).toContain('outline')
    const bold = actions.find((action: { id: string }) => action.id === 'bold')!
    await bold.run()
    await flushPromises()
    expect(wrapper.emitted('command')?.some(([type]) => type === 'mark.toggle')).toBe(true)
  })

  it('只读时只剩视图动作，不会列出打不出去的写命令', () => {
    const wrapper = mountChrome({ readonly: true, permissions: READONLY })
    const ids = wrapper.vm.paletteActions().map((action: { id: string }) => action.id)
    expect(ids).not.toContain('bold')
    expect(ids).toContain('find')
    expect(ids).toContain('outline')
  })
})
