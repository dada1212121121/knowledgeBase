/**
 * 斜杠菜单空查询时的分组：常用的在前、四到六级标题在最后一组、每个内置动作恰好出现一次（「最近使用」除外）、
 * 不认识的动作（第三方扩展）归到「扩展」组。
 */
import { describe, expect, it } from 'vitest'
import { AI_WRITE_COMMAND, groupSlashActions, SLASH_MARKDOWN_HINTS, SLASH_SECTIONS, TEXT_SLASH_ACTIONS, type EditorAction } from './text'

/** 页面没接 AI 写作时内容面看到的列表（TextSurface 按 `text.ai.open` 过滤掉 AI 项） */
const WITHOUT_AI = TEXT_SLASH_ACTIONS.filter((action) => action.command !== AI_WRITE_COMMAND)

describe('groupSlashActions', () => {
  it('没接 AI：按「基础 / 列表 / 插入 / 引用与附件 / 图表与公式 / 提示块 / 更多标题」排，正文打头', () => {
    const groups = groupSlashActions(WITHOUT_AI)
    expect(groups.map((group) => group.label)).toEqual(['基础', '列表', '插入', '引用与附件', '图表与公式', '提示块', '更多标题'])
    expect(groups[0]!.items[0]!.id).toBe('paragraph')
    // 第一屏（前 12 项）里就有列表、表格、图片、代码块
    const firstScreen = groups.flatMap((group) => group.items).slice(0, 12).map((item) => item.id)
    for (const id of ['bullet', 'task', 'table', 'image.upload', 'codeblock']) expect(firstScreen, id).toContain(id)
    expect(groups.at(-1)!.items.map((item) => item.id)).toEqual(['heading.4', 'heading.5', 'heading.6'])
  })

  it('接了 AI：「AI」组排在「基础」之后（空查询回车仍是「正文」，不会误触发一次 AI 调用）', () => {
    const groups = groupSlashActions(TEXT_SLASH_ACTIONS)
    expect(groups.map((group) => group.label).slice(0, 3)).toEqual(['基础', 'AI', '列表'])
    expect(groups[0]!.items[0]!.id).toBe('paragraph')
    expect(groups[1]!.items.map((item) => item.id)).toEqual(['ai.continue', 'ai.write'])
  })

  it('每个内置斜杠动作恰好出现一次（分组表没有漏项，也没有写了却不存在的 id）', () => {
    const ids = groupSlashActions(TEXT_SLASH_ACTIONS).flatMap((group) => group.items.map((item) => item.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(TEXT_SLASH_ACTIONS.map((action) => action.id).sort())
    const known = new Set(TEXT_SLASH_ACTIONS.map((action) => action.id))
    for (const section of SLASH_SECTIONS) for (const id of section.ids) expect(known.has(id), `${section.label}:${id}`).toBe(true)
    for (const id of Object.keys(SLASH_MARKDOWN_HINTS)) expect(known.has(id), id).toBe(true)
  })

  it('最近使用放最上面（最多 3 项，跳过已经不存在的 id），原来的组里照样有', () => {
    const groups = groupSlashActions(TEXT_SLASH_ACTIONS, ['table', 'gone', 'callout.tip', 'bullet', 'quote'])
    expect(groups[0]).toMatchObject({ id: 'recent', label: '最近使用' })
    expect(groups[0]!.items.map((item) => item.id)).toEqual(['table', 'callout.tip', 'bullet'])
    expect(groups.find((group) => group.id === 'insert')!.items.map((item) => item.id)).toContain('table')
  })

  it('第三方扩展的动作归到最后的「扩展」组', () => {
    const custom: EditorAction = { id: 'acme.todo', label: '待办卡片', command: 'acme.insertTodo', write: true }
    const groups = groupSlashActions([...TEXT_SLASH_ACTIONS, custom])
    expect(groups.at(-1)).toMatchObject({ id: 'extension', label: '扩展' })
    expect(groups.at(-1)!.items).toEqual([custom])
  })
})
