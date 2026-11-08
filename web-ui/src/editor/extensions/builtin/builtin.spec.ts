/**
 * 内置扩展
 *
 * 钉住几件事：
 * 1. 内置扩展清单合法（id 唯一、入口标 builtin）、安装顺序固定、重复安装幂等；
 * 2. 每个内置扩展装进一个空注册表都能独立工作，卸掉它只少它自己的那部分入口，别的不受影响；
 * 3. 后合并的分支（Word 编辑 / PPTX）只要往 `text.ts` 的常量里加数据，不改注册代码就会生效；
 * 4. Host / Chrome / Status 的源码里没有写死导出 / 评论 / AI / 字数入口（防止有人把它们塞回去）。
 */
import { describe, expect, it } from 'vitest'
import EDITOR_CHROME_SOURCE from '../../host/EditorChrome.vue?raw'
import EDITOR_STATUS_SOURCE from '../../host/EditorStatus.vue?raw'
import { defineExtension } from '../../api'
import { ExtensionRegistry } from '../registry'
import { BUILTIN_EXTENSIONS, installBuiltinExtensions } from './index'
import { builtinManifest, registerContribution, registerToolbarGroups } from './register'
import { BUILTIN_AI_ACTIONS } from './ai.ext'
import { PAGE_EDIT_VIEW_EXTRA, PAGE_READ_VIEW_EXTRA } from './page.ext'
import { CODE_TOOLBAR, CSV_ROW_TOOLBAR, FIND_ONLY_TOOLBAR, PAGE_EDIT_TOOLBAR, PAGE_TOOLBAR, TEXT_SLASH_ACTIONS, TEXT_TOOLBAR, type ToolbarGroup } from './text'

const IDS = BUILTIN_EXTENSIONS.map(({ manifest }) => manifest.id)

/** 一个注册表里所有内置入口的快照（用来比较「卸掉某个扩展后少了什么」） */
function snapshot(registry: ExtensionRegistry): Record<string, string[]> {
  const toolbar = (kind: 'text' | 'code' | 'pdf' | 'grid' | 'page' | 'slide', format?: string, profile?: string) =>
    registry.toolbarItemsFor(kind, { ...(format ? { format } : {}), ...(profile ? { profile } : {}) }).map((entry) => entry.spec.id)
  const state = { kind: 'text' as const, format: 'md', words: 1, unitLabel: '', readonly: false, dirty: false, phase: 'ready' as const }
  return {
    text: toolbar('text', 'md'),
    code: toolbar('code', 'rs'),
    pdf: toolbar('pdf', 'pdf'),
    xlsx: toolbar('grid', 'xlsx'),
    csv: toolbar('grid', 'csv'),
    pageRead: toolbar('page', 'docx'),
    pageEdit: toolbar('page', 'docx', 'edit'),
    slide: toolbar('slide', 'pptx'),
    slash: registry.slashItemsFor('text').map((entry) => entry.spec.id),
    bar: registry.barItemsFor('text').map((entry) => entry.spec.id),
    ai: registry.aiTools().map((tool) => tool.id),
    statusChrome: registry.statusTexts('text', 'chrome', state).map((item) => item.id),
    statusBottom: registry.statusTexts('text', 'status', state).map((item) => item.id),
    commands: ['export.open', 'comment.open'].filter((id) => registry.hasCommand(id)),
  }
}

function fullRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry()
  installBuiltinExtensions(registry)
  return registry
}

describe('内置扩展清单与安装', () => {
  it('1. id 唯一、都以 kb.builtin. 开头、入口标 builtin、api_version 与权限合法', () => {
    expect(new Set(IDS).size).toBe(IDS.length)
    for (const { manifest } of BUILTIN_EXTENSIONS) {
      expect(manifest.id).toMatch(/^kb\.builtin\.[a-z-]+$/)
      expect(manifest.entry).toBe('builtin')
      expect(manifest.apiVersion).toBe(1)
      expect(manifest.contributes).toEqual({ commands: [], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], aiTools: [] })
    }
    expect(IDS).toEqual([
      'kb.builtin.text',
      'kb.builtin.view',
      'kb.builtin.code',
      'kb.builtin.pdf',
      'kb.builtin.grid',
      'kb.builtin.page',
      'kb.builtin.slide',
      'kb.builtin.export',
      'kb.builtin.comment',
      'kb.builtin.ai',
      'kb.builtin.stats',
    ])
  })

  it('2. 全部装好后每个都登记为内置；重复安装幂等（不会出现重复按钮）', () => {
    const registry = fullRegistry()
    const before = snapshot(registry)
    installBuiltinExtensions(registry)
    installBuiltinExtensions(registry)
    expect(registry.list().map((item) => [item.manifest.id, item.builtin])).toEqual(IDS.map((id) => [id, true]))
    expect(snapshot(registry)).toEqual(before)
  })

  it('3. 内置扩展的入口都是同步的（activate 返回 undefined），首次渲染前就位', () => {
    for (const { manifest, extension } of BUILTIN_EXTENSIONS) {
      const registry = new ExtensionRegistry()
      expect(() => registry.installBuiltin(manifest, extension), manifest.id).not.toThrow()
    }
  })
})

describe('每个内置扩展各管各的：卸掉它只少它自己那部分', () => {
  const full = snapshot(fullRegistry())

  /** 卸载某个内置扩展后，哪些入口集合变了 */
  async function lostWhenRemoving(id: string): Promise<string[]> {
    const registry = fullRegistry()
    await registry.uninstall(id)
    const after = snapshot(registry)
    return Object.keys(full).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(full[key]))
  }

  it.each([
    ['kb.builtin.text', ['text', 'slash']],
    ['kb.builtin.view', ['text']],
    ['kb.builtin.code', ['code']],
    ['kb.builtin.pdf', ['pdf']],
    ['kb.builtin.grid', ['xlsx', 'csv']],
    ['kb.builtin.page', ['pageRead', 'pageEdit']],
    ['kb.builtin.export', ['bar', 'commands']],
    ['kb.builtin.comment', ['bar', 'commands']],
    ['kb.builtin.ai', ['ai']],
    ['kb.builtin.stats', ['statusChrome', 'statusBottom']],
    // 演示文稿的内置工具栏（查找 / 大纲）随 PPTX 阶段 5 落地，卸掉它只少幻灯片面那一份
    ['kb.builtin.slide', ['slide']],
  ] as const)('%s → 只影响 %j', async (id, expected) => {
    expect(await lostWhenRemoving(id)).toEqual([...expected])
  })

  it('4. 内置的入口 id 互不冲突：同一内容面 / 格式 / 方案下没有重复的按钮', () => {
    for (const [key, ids] of Object.entries(full)) expect(new Set(ids).size, key).toBe(ids.length)
  })

  it('5. 内容面 → 工具栏的内容与 text.ts 里的静态声明逐项一致（分组、顺序、动作 id）', () => {
    const ids = (groups: readonly ToolbarGroup[]) => groups.flatMap((group) => group.actions.map((action) => action.id))
    const nonView = (groups: readonly ToolbarGroup[]) => groups.filter((group) => group.id !== 'view')
    expect(full.text).toEqual([...ids(TEXT_TOOLBAR), 'find', 'source', 'outline'])
    expect(full.code).toEqual(ids(CODE_TOOLBAR))
    expect(full.pdf).toEqual(ids(FIND_ONLY_TOOLBAR))
    expect(full.xlsx).toEqual(ids(FIND_ONLY_TOOLBAR))
    expect(full.csv).toEqual([...ids(FIND_ONLY_TOOLBAR), ...ids(CSV_ROW_TOOLBAR)])
    // 内置的页工具栏 + 页内置扩展自己加的视图按钮（缩略图 / 高保真查看，page.ext.ts）
    expect(full.pageRead).toEqual([...ids(PAGE_TOOLBAR), ...ids(PAGE_READ_VIEW_EXTRA)])
    expect(full.pageEdit).toEqual([...ids(PAGE_EDIT_TOOLBAR), ...ids(PAGE_EDIT_VIEW_EXTRA)])
    expect(ids(PAGE_READ_VIEW_EXTRA)).toEqual(['page.thumbs', 'page.hifi'])
    expect(ids(PAGE_EDIT_VIEW_EXTRA)).toEqual(['page.thumbs'])
    expect(nonView(PAGE_EDIT_TOOLBAR).length).toBeGreaterThan(0)
    expect(full.slash).toEqual(TEXT_SLASH_ACTIONS.map((action) => action.id))
    expect(full.ai).toEqual(BUILTIN_AI_ACTIONS.map((action) => action.id))
  })
})

describe('别的分支往 text.ts 加数据，不改注册代码就生效', () => {
  it('6. registerToolbarGroups / registerContribution 逐项注册传入的分组（含下拉子项、选项、新增的未知可选字段原样带过去）', async () => {
    const registry = new ExtensionRegistry()
    const groups: ToolbarGroup[] = [
      {
        id: 'insert',
        label: '插入',
        actions: [
          { id: 'x.drop', label: '下拉', command: 'menu.x', write: true, children: [{ id: 'x.a', label: 'A', command: 'x.run', write: true }] },
          { id: 'x.pick', label: '选项', command: 'x.pick', write: true, ui: true, choices: [{ label: '一', args: { n: 1 } }] },
          // 将来 EditorAction 新增的可选字段：这里用一个当下并不存在的字段模拟，注册与翻译都不该把它丢掉
          { id: 'x.future', label: '将来', command: 'x.future', futureField: { a: 1 } } as never,
        ],
      },
    ]
    registry.installBuiltin(
      builtinManifest({ id: 'kb.builtin.slide-test', name: 't', description: 't', permissions: ['ui'] }),
      defineExtension({
        activate(ctx) {
          registerContribution(ctx, { kind: 'slide', toolbar: groups, slash: [{ id: 'x.slash', label: '斜杠', command: 'x.run', write: true, keywords: ['k'] }] }, { kinds: ['slide'] })
          registerToolbarGroups(ctx, groups.map((group) => ({ ...group, actions: group.actions.map((action) => ({ ...action, id: `${action.id}.edit` })) })), { kinds: ['slide'], profile: 'edit' })
        },
      }),
    )
    const { contributionWith } = await import('../contributions')
    const merged = contributionWith('slide', registry, 'pptx')!
    const actions = merged.toolbar.flatMap((group) => group.actions)
    expect(merged.toolbar.map((group) => [group.id, group.label])).toEqual([['insert', '插入']])
    expect(actions.map((action) => action.id)).toEqual(['x.drop', 'x.pick', 'x.future'])
    expect(actions[0]!.children).toEqual([{ id: 'x.a', label: 'A', command: 'x.run', write: true }])
    expect(actions[1]!.choices).toEqual([{ label: '一', args: { n: 1 } }])
    expect(actions[2]).toEqual({ id: 'x.future', label: '将来', command: 'x.future', futureField: { a: 1 } })
    // 斜杠项按 kinds 注册进了注册表；目前只有文本面会渲染斜杠菜单（见文档「已知限制」）
    expect(merged.slash.map((action) => action.id)).toEqual(['x.slash'])
    // 方案：edit 方案只在选了 edit 时出现
    expect(contributionWith('slide', registry, 'pptx', 'edit')!.toolbar.flatMap((group) => group.actions).map((action) => action.id)).toEqual(['x.drop', 'x.pick', 'x.future', 'x.drop.edit', 'x.pick.edit', 'x.future.edit'])
  })
})

describe('Host / Chrome / Status 不再写死这些入口', () => {
  it('7. EditorChrome 不再有导出 / 评论 / AI 菜单 / 字数的事件、常量与文案拼接', () => {
    for (const forbidden of ["(e: 'export')", "(e: 'comment')", "(e: 'ai',", 'AI_ACTIONS', 'countText', 'showExport', 'showComment', 'data-testid="editor-export"', 'data-testid="editor-comment"']) {
      expect(EDITOR_CHROME_SOURCE, forbidden).not.toContain(forbidden)
    }
  })

  it('8. EditorStatus 不再自己拼字数文案', () => {
    for (const forbidden of ['countText', 'wordCount', 'unitLabel']) expect(EDITOR_STATUS_SOURCE, forbidden).not.toContain(forbidden)
  })
})
