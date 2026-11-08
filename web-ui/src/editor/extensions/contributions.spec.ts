/**
 * 注册表里的贡献 → Chrome 的数据形状（设计规范）
 *
 * 起内置工具栏也在注册表里（`builtin/*.ext.ts`），所以这里最重要的一条是「迁移前后逐项一致」：
 * 每个内容面 / 格式 / 方案取到的分组与动作，必须和 `text.ts` 里那份静态声明（迁移前 Host 直接用的）完全相同。
 */
import { describe, expect, it } from 'vitest'
import { defineExtension } from '../api'
import { PAGE_EDIT_VIEW_EXTRA, PAGE_READ_VIEW_EXTRA } from './builtin/page.ext'
import { CODE_TOOLBAR, contributionFor, FIND_ONLY_TOOLBAR, PAGE_EDIT_CONTRIBUTION, TEXT_SLASH_ACTIONS, type ToolbarGroup } from './builtin/text'
import { barActionsFor, contributionWith, mergeContribution, mergeSlashActions, slashAction, visibleAiTools } from './contributions'
import { ExtensionRegistry } from './registry'
import { manifestFor } from './__fixtures__/testkit'
import { installBuiltinExtensions } from './builtin'

/** 装好全部内置扩展的注册表（和页面里的单例一样） */
function builtinRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry()
  installBuiltinExtensions(registry)
  return registry
}

/** 迁移前文本面的「视图」分组：以前由 的内置扩展注入，数据就是这三项 */
const TEXT_VIEW_GROUP = {
  id: 'view',
  label: '视图',
  actions: [
    { id: 'find', label: '查找替换', icon: '🔍', command: 'search.open', shortcut: 'Ctrl+F', ui: true },
    { id: 'source', label: '源码', icon: '</>', command: 'view.toggleSource', write: true, check: { kind: 'toggle', name: 'source' } },
    { id: 'outline', label: '大纲', icon: '☰', command: 'view.toggleOutline', ui: true },
  ],
}

function registryWith(items: Array<{ id: string; group?: string; kinds?: ('text' | 'code')[] }>) {
  const registry = builtinRegistry()
  void registry.install(
    manifestFor({ id: 'kb.m', permissions: ['ui'], contributes: { commands: [{ id: 'kb.m.run', title: 'r' }], toolbar: items.map((item) => ({ id: `kb.m.${item.id}` })), slash: [{ id: 'kb.m.slash' }] } }),
    defineExtension({
      activate(ctx) {
        ctx.registerCommand('kb.m.run', () => undefined)
        for (const item of items) {
          ctx.registerToolbarItem({ id: `kb.m.${item.id}`, label: item.id, command: 'kb.m.run', ...(item.group ? { group: item.group } : {}), ...(item.kinds ? { kinds: item.kinds } : {}) })
        }
        ctx.registerSlashItem({ id: 'kb.m.slash', label: '扩展斜杠', command: 'kb.m.run', keywords: ['ext'] })
      },
    }),
  )
  return registry
}

describe('合并工具栏与斜杠菜单', () => {
  it('1. 空注册表没有任何贡献；装好内置扩展后每个内容面 / 格式 / 方案与迁移前的静态声明逐项一致', () => {
    expect(contributionWith('text', new ExtensionRegistry())).toBeNull()
    expect(mergeContribution(null, 'ext:kb.x', builtinRegistry())).toBeNull()
    const registry = builtinRegistry()
    const groups = (kind: Parameters<typeof contributionWith>[0], format?: string, profile?: string) => contributionWith(kind, registry, format, profile)?.toolbar
    expect(groups('text', 'md')).toEqual([...contributionFor('text')!.toolbar, TEXT_VIEW_GROUP])
    expect(groups('code', 'rs')).toEqual(CODE_TOOLBAR)
    expect(groups('pdf', 'pdf')).toEqual(FIND_ONLY_TOOLBAR)
    // 表格：xlsx 只有查找；csv / tsv 另有「行」操作（按格式限定，不是按内容面）
    expect(groups('grid', 'xlsx')).toEqual(FIND_ONLY_TOOLBAR)
    expect(groups('grid', 'csv')).toEqual(contributionFor('grid', 'csv')!.toolbar)
    expect(groups('grid', 'tsv')).toEqual(contributionFor('grid', 'tsv')!.toolbar)
    expect(groups('grid')).toEqual(FIND_ONLY_TOOLBAR)
    // Word：预览与画布编辑是同一个内容面上的两套方案；「视图」分组末尾多出页内置扩展自己加的按钮（缩略图 / 高保真查看， 补全）
    const withViewExtra = (base: readonly ToolbarGroup[], extra: readonly ToolbarGroup[]) =>
      base.map((group) => (group.id === 'view' ? { ...group, actions: [...group.actions, ...extra.flatMap((item) => item.actions)] } : group))
    expect(groups('page', 'docx')).toEqual(withViewExtra(contributionFor('page')!.toolbar, PAGE_READ_VIEW_EXTRA))
    expect(groups('page', 'docx', 'edit')).toEqual(withViewExtra(PAGE_EDIT_CONTRIBUTION.toolbar, PAGE_EDIT_VIEW_EXTRA))
    // 演示文稿：PPTX 阶段 5 往 CONTRIBUTIONS.slide 放了查找 / 大纲，经 kb.builtin.slide 注册后与静态声明一致
    expect(groups('slide', 'pptx')).toEqual(contributionFor('slide')!.toolbar)
    // 斜杠菜单：只有文本面有，内容与迁移前（TEXT_SLASH_ACTIONS）一致
    expect(contributionWith('text', registry, 'md')!.slash).toEqual(TEXT_SLASH_ACTIONS.map((action) => slashAction({ extensionId: 'kb.builtin.text', spec: action })))
    for (const kind of ['code', 'pdf', 'grid', 'page', 'slide'] as const) expect(contributionWith(kind, registry)!.slash).toEqual([])
  })

  it('2. 迁到注册表的内置按钮在 Chrome 的数据里原样出现：id、文案、命令、快捷键、高亮判定都和迁移前一致', () => {
    const registry = builtinRegistry()
    const view = contributionWith('text', registry)!.toolbar.at(-1)!
    expect(view.label).toBe('视图')
    expect(view.actions).toEqual(TEXT_VIEW_GROUP.actions)
    // 下拉与带选项的按钮连子项、选项一起带过来
    const heading = contributionWith('text', registry)!.toolbar.flatMap((group) => group.actions).find((action) => action.id === 'heading')!
    // 「引用」也在段落格式下拉里（给格式刷 / 清除格式腾位置）；子项的快捷键跟着带过来
    expect(heading.children?.map((child) => child.id)).toEqual(['paragraph', 'heading.1', 'heading.2', 'heading.3', 'heading.4', 'heading.5', 'heading.6', 'quote'])
    expect(heading.children?.map((child) => child.shortcut)).toEqual(['Ctrl+Alt+0', 'Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3', 'Ctrl+Alt+4', 'Ctrl+Alt+5', 'Ctrl+Alt+6', 'Ctrl+Shift+B'])
    const fontSize = contributionWith('page', registry, 'docx', 'edit')!.toolbar.flatMap((group) => group.actions).find((action) => action.id === 'docx.fontSize')!
    expect(fontSize.choices?.[0]).toEqual({ label: '8', args: { points: 8 }, current: { name: 'fontSizePt', value: 8 } })
  })

  it('3. 扩展按钮：放进它声明的已有分组末尾，未声明分组则落在最后新建的「扩展」分组', () => {
    const registry = registryWith([{ id: 'a', group: 'insert' }, { id: 'b' }, { id: 'c', group: 'mine' }])
    const groups = contributionWith('text', registry)!.toolbar
    expect(groups.find((group) => group.id === 'insert')!.actions.at(-1)!.id).toBe('kb.m.a')
    expect(groups.slice(-2).map((group) => [group.id, group.label])).toEqual([['ext', '扩展'], ['mine', 'mine']])
    expect(groups.find((group) => group.id === 'ext')!.actions.map((action) => action.id)).toEqual(['kb.m.b'])
    // 不改内置数据本身
    expect(contributionFor('text')!.toolbar.find((group) => group.id === 'insert')!.actions.some((action) => action.id === 'kb.m.a')).toBe(false)
  })

  it('4. kinds 过滤；扩展不能靠重名顶掉内置按钮', () => {
    const registry = registryWith([{ id: 'only-code', kinds: ['code'] }, { id: 'both' }])
    expect(contributionWith('text', registry)!.toolbar.flatMap((group) => group.actions).map((action) => action.id)).not.toContain('kb.m.only-code')
    expect(contributionWith('code', registry)!.toolbar.flatMap((group) => group.actions).map((action) => action.id)).toContain('kb.m.only-code')

    const base = contributionFor('text')!
    const dup = new ExtensionRegistry()
    dup.installBuiltin(manifestFor({ id: 'kb.builtin.dup', permissions: ['ui'] }), {
      activate: (ctx) => void ctx.registerToolbarItem({ id: 'bold', label: '假加粗', command: 'evil.run' }),
    })
    const bold = mergeContribution(base, 'text', dup)!.toolbar.flatMap((group) => group.actions).filter((action) => action.id === 'bold')
    expect(bold).toHaveLength(1)
    expect(bold[0]!.command).toBe('mark.toggle')
  })

  it('5. 扩展的斜杠项并入斜杠菜单，标记为会改文档；不重复已有 id', () => {
    const registry = registryWith([])
    const merged = mergeSlashActions(TEXT_SLASH_ACTIONS, 'text', registry)
    expect(merged.length).toBe(TEXT_SLASH_ACTIONS.length + 1)
    expect(merged.at(-1)).toEqual({ id: 'kb.m.slash', label: '扩展斜杠', command: 'kb.m.run', write: true, keywords: ['ext'] })
    expect(mergeSlashActions(merged, 'text', registry)).toHaveLength(merged.length)
    // 代码面没有斜杠菜单
    expect(mergeSlashActions([], 'code', registry)).toEqual([])
  })

  it('6. 卸载后合并结果立刻回到内置数据', async () => {
    const registry = registryWith([{ id: 'a' }])
    await Promise.resolve()
    expect(contributionWith('text', registry)!.toolbar.some((group) => group.id === 'ext')).toBe(true)
    await registry.uninstall('kb.m')
    expect(contributionWith('text', registry)!.toolbar).toEqual([...contributionFor('text')!.toolbar, TEXT_VIEW_GROUP])
  })

  it('7. 第三方按钮可以带 formats / profile：只在对应格式、对应工具栏方案里出现', async () => {
    const registry = builtinRegistry()
    await registry.install(
      manifestFor({ id: 'kb.scope', permissions: ['ui'], contributes: { commands: [{ id: 'kb.scope.run', title: 'r' }], toolbar: [{ id: 'kb.scope.csv' }, { id: 'kb.scope.edit' }] } }),
      {
        activate(ctx) {
          ctx.registerCommand('kb.scope.run', () => undefined)
          ctx.registerToolbarItem({ id: 'kb.scope.csv', label: '仅 CSV', command: 'kb.scope.run', kinds: ['grid'], formats: ['csv'] })
          ctx.registerToolbarItem({ id: 'kb.scope.edit', label: '仅 Word 编辑', command: 'kb.scope.run', kinds: ['page'], profile: 'edit' })
        },
      },
    )
    const ids = (kind: Parameters<typeof contributionWith>[0], format?: string, profile?: string) =>
      contributionWith(kind, registry, format, profile)!.toolbar.flatMap((group) => group.actions.map((action) => action.id))
    expect(ids('grid', 'csv')).toContain('kb.scope.csv')
    expect(ids('grid', 'xlsx')).not.toContain('kb.scope.csv')
    expect(ids('page', 'docx')).not.toContain('kb.scope.edit')
    expect(ids('page', 'docx', 'edit')).toContain('kb.scope.edit')
    // 格式限制的按钮在没有格式信息时不出现
    expect(ids('grid')).not.toContain('kb.scope.csv')
  })

  it('8. 下拉与带选项的第三方按钮：children / choices 原样带到 Chrome，命令必须是自己的', async () => {
    const registry = builtinRegistry()
    await registry.install(
      manifestFor({ id: 'kb.menu', permissions: ['ui'], contributes: { commands: [{ id: 'kb.menu.run', title: 'r' }], toolbar: [{ id: 'kb.menu.drop' }, { id: 'kb.menu.pick' }] } }),
      {
        activate(ctx) {
          ctx.registerCommand('kb.menu.run', () => undefined)
          ctx.registerToolbarItem({ id: 'kb.menu.drop', label: '下拉', command: 'kb.menu.run', children: [{ id: 'kb.menu.a', label: 'A', command: 'kb.menu.run', args: { n: 1 } }] })
          ctx.registerToolbarItem({ id: 'kb.menu.pick', label: '选项', command: 'kb.menu.run', choices: [{ label: '红', args: { c: 'red' }, swatch: '#f00' }] })
        },
      },
    )
    const actions = contributionWith('text', registry)!.toolbar.flatMap((group) => group.actions)
    expect(actions.find((action) => action.id === 'kb.menu.drop')!.children).toEqual([{ id: 'kb.menu.a', label: 'A', command: 'kb.menu.run', args: { n: 1 } }])
    expect(actions.find((action) => action.id === 'kb.menu.pick')!.choices).toEqual([{ label: '红', args: { c: 'red' }, swatch: '#f00' }])
  })
})

describe('顶栏操作区、AI 菜单与状态栏项（内置扩展提供）', () => {
  it('9. 导出 / 评论按钮来自注册表，页面没接入的能力不出现；手机收起标记随数据带过来', () => {
    const registry = builtinRegistry()
    const ids = (caps: Parameters<typeof barActionsFor>[2]) => barActionsFor('text', registry, caps).map((action) => action.id)
    expect(ids({})).toEqual([])
    expect(ids({ export: true })).toEqual(['export'])
    expect(ids({ export: true, comment: true, ai: true })).toEqual(['export', 'comment'])
    const exportAction = barActionsFor('text', registry, { export: true })[0]!
    expect(exportAction).toEqual({ id: 'export', label: '导出', description: '导出 Markdown', command: 'export.open', compact: 'hide' })
    // 顶栏操作区的按钮不会混进格式工具栏
    expect(contributionWith('text', registry)!.toolbar.flatMap((group) => group.actions).map((action) => action.id)).not.toContain('export')
  })

  it('10. AI 菜单：内置三项由页面接管（页面接入 AI 才有），第三方工具看文档的 AI 权限', async () => {
    const registry = builtinRegistry()
    await registry.install(
      manifestFor({ id: 'kb.ai3', permissions: ['ai', 'document.read'], contributes: { aiTools: [{ id: 'kb.ai3.up', title: '大写' }] } }),
      { activate: (ctx) => void ctx.registerAITool({ id: 'kb.ai3.up', title: '大写', run: (input) => input.text.toUpperCase() }) },
    )
    const titles = (gates: Parameters<typeof visibleAiTools>[1]) => visibleAiTools(registry, gates).map((tool) => tool.title)
    expect(titles({ page: true, suggestion: true })).toEqual(['润色选中', '总结选中', '翻译选中', '大写'])
    expect(titles({ page: false, suggestion: true })).toEqual(['大写'])
    expect(titles({ page: true, suggestion: false })).toEqual(['润色选中', '总结选中', '翻译选中'])
    expect(titles({ page: false, suggestion: false })).toEqual([])
  })

  it('11. 字数：顶栏任何内容面都有，底部状态栏有单位用单位、没单位只有文本面显示「N 字」', () => {
    const registry = builtinRegistry()
    const state = (kind: 'text' | 'grid' | 'pdf', words: number, unitLabel = '') => ({ kind, format: 'x', words, unitLabel, readonly: false, dirty: false, phase: 'ready' as const })
    const texts = (area: 'chrome' | 'status', value: ReturnType<typeof state>) => registry.statusTexts(value.kind, area, value).map((item) => item.text)
    expect(texts('chrome', state('text', 42))).toEqual(['42 字'])
    expect(texts('chrome', state('grid', 800, '格'))).toEqual(['800 格'])
    expect(texts('chrome', state('pdf', 0))).toEqual(['0 字'])
    expect(texts('status', state('text', 37))).toEqual(['37 字'])
    expect(texts('status', state('grid', 8, '格'))).toEqual(['8 格'])
    expect(texts('status', state('pdf', 12))).toEqual([])
  })
})
