// 新用户引导与快捷键表的纯逻辑。
import { describe, expect, it } from 'vitest'
import { GOTO, GOTO_TARGETS, SHORTCUTS, gotoTargets, guideKey, guideSteps, isHelpKey, shortcutRows, shouldShowGuide } from './guide'

const all = ['docs.notes', 'docs.upload', 'search.basic', 'collab.friends', 'ai.assistant']
const input = (extra: Partial<Parameters<typeof guideSteps>[0]> = {}) => ({ has: (feature: string) => all.includes(feature), aiEnabled: true, insights: 0, sources: 0, ...extra })

describe('guideSteps', () => {
  it('五步齐全,顺序是 笔记 → 导入 → 搜索 → 好友 → 助手', () => {
    expect(guideSteps(input()).map((step) => step.id)).toEqual(['note', 'import', 'search', 'friends', 'assistant'])
  })
  it('没开通的功能不出现', () => {
    const ids = guideSteps(input({ has: (feature: string) => ['docs.notes', 'search.basic'].includes(feature) })).map((step) => step.id)
    expect(ids).toEqual(['note', 'search'])
  })
  it('AI 总开关关掉:助手那一步不出现,所有文案里没有「AI」', () => {
    const steps = guideSteps(input({ aiEnabled: false }))
    expect(steps.map((step) => step.id)).not.toContain('assistant')
    expect(JSON.stringify(steps)).not.toMatch(/AI/)
  })
  it('有 AI 总开关但角色没有助手权限:同样不出现', () => {
    expect(guideSteps(input({ has: (feature: string) => feature !== 'ai.assistant' })).map((step) => step.id)).not.toContain('assistant')
  })
  it('做过的标完成:有笔记 → 写笔记完成;有数据源 → 导入完成;取不到数据源数不算完成', () => {
    const done = (extra: Partial<Parameters<typeof guideSteps>[0]>) => Object.fromEntries(guideSteps(input(extra)).map((step) => [step.id, step.done]))
    expect(done({ insights: 3 }).note).toBe(true)
    expect(done({ insights: 0 }).note).toBe(false)
    expect(done({ sources: 2 }).import).toBe(true)
    expect(done({ sources: null }).import).toBe(false)
    // 没法从数据判断的,永远不标完成
    expect(done({ insights: 9, sources: 9 })).toMatchObject({ search: false, friends: false, assistant: false })
  })
  it('每一步要么有去处要么是动作;写笔记直接进新建表单', () => {
    const steps = guideSteps(input())
    expect(steps.find((step) => step.id === 'note')!.to).toBe('/kb?new=1')
    expect(steps.find((step) => step.id === 'assistant')!.to).toBeUndefined()
    for (const step of steps.filter((step) => step.id !== 'assistant')) expect(step.to, step.id).toMatch(/^\//)
  })
})

describe('shouldShowGuide', () => {
  const base = { loaded: true, dismissed: false, insights: 0, steps: 3 }
  it('新用户(没有笔记、没关过)显示', () => {
    expect(shouldShowGuide(base)).toBe(true)
  })
  it('数据还没取到不显示(免得闪一下)、点过「不再显示」不显示、已经有笔记不显示、没有可做的步骤不显示', () => {
    expect(shouldShowGuide({ ...base, loaded: false })).toBe(false)
    expect(shouldShowGuide({ ...base, dismissed: true })).toBe(false)
    expect(shouldShowGuide({ ...base, insights: 1 })).toBe(false)
    expect(shouldShowGuide({ ...base, steps: 0 })).toBe(false)
  })
})

describe('guideKey', () => {
  it('按用户分开', () => {
    expect(guideKey('usr_a')).not.toBe(guideKey('usr_b'))
    expect(guideKey('usr_a')).toContain('usr_a')
  })
})

describe('快捷键表', () => {
  it('跳转表是单一来源:按键处理用的 GOTO 与表里的说明一致,没有漏写(以前 D 系统概览没写进表)', () => {
    expect(Object.keys(GOTO).sort()).toEqual(GOTO_TARGETS.map((target) => target.key).sort())
    const row = SHORTCUTS.find((entry) => entry.label.startsWith('跳转'))!
    for (const target of GOTO_TARGETS) {
      expect(row.label, target.label).toContain(target.label)
      expect(row.keys.join(' '), target.key).toContain(target.key.toUpperCase())
    }
  })
  it('产品承诺的跳转键一个不少(独立于源表写死:H 首页 B 知识库 S 搜索 R 审核 J 任务 D 系统概览 E 评测)', () => {
    expect(Object.fromEntries(GOTO_TARGETS.map((target) => [target.key, target.to]))).toEqual({
      h: '/home',
      b: '/kb',
      s: '/search',
      r: '/review',
      j: '/tasks',
      d: '/admin/overview',
      e: '/admin/eval',
    })
  })
  it('跳转的按键互不重复,目标都是站内路径', () => {
    expect(new Set(GOTO_TARGETS.map((target) => target.key)).size).toBe(GOTO_TARGETS.length)
    for (const target of GOTO_TARGETS) expect(target.to).toMatch(/^\//)
  })
  it('每一行都有说明和按键,说明不重复;包含「?」这一条', () => {
    expect(new Set(SHORTCUTS.map((row) => row.label)).size).toBe(SHORTCUTS.length)
    for (const row of SHORTCUTS) {
      expect(row.label.length).toBeGreaterThan(1)
      expect(row.keys.length).toBeGreaterThan(0)
    }
    expect(SHORTCUTS.some((row) => row.keys.includes('?'))).toBe(true)
  })
})

describe('快捷键表按功能点过滤', () => {
  const AI_WORD = /(?<![A-Za-z])AI(?![A-Za-z])/
  /** AI 总开关关闭时后端折算出的功能列表:没有任何 ai.* 与深度检索,其余都在 */
  const aiOff = (feature: string | undefined) => !feature || (!feature.startsWith('ai.') && feature !== 'search.deep')
  const textOf = (rows: { label: string; keys: string[] }[]) => rows.map((row) => `${row.label} ${row.keys.join(' ')}`).join('\n')

  it('功能齐全:和完整表一致', () => {
    expect(shortcutRows(() => true)).toEqual(SHORTCUTS)
    expect(gotoTargets(() => true)).toEqual([...GOTO_TARGETS])
  })

  it('AI 总开关关闭:没有「呼出 AI 助手」,整张表没有 AI 字样,跳转行里没有审核(G R 也不响应)', () => {
    const rows = shortcutRows(aiOff)
    expect(rows.some((row) => row.keys.includes('⌘J'))).toBe(false)
    expect(textOf(rows)).not.toMatch(AI_WORD)
    const jump = rows.find((row) => row.label.startsWith('跳转'))!
    expect(jump.label).not.toContain('审核')
    expect(jump.keys.join(' ')).not.toContain('R')
    expect(gotoTargets(aiOff).map((target) => target.key)).not.toContain('r')
    // 其它跳转照常
    expect(gotoTargets(aiOff).map((target) => target.key)).toEqual(['h', 'b', 's', 'j', 'd', 'e'])
  })

  it('AI 开着、角色只有 ai.assistant:有 ⌘J,没有 G R', () => {
    const has = (feature: string | undefined) => !feature || feature === 'ai.assistant'
    expect(shortcutRows(has).some((row) => row.keys.includes('⌘J'))).toBe(true)
    expect(gotoTargets(has).map((target) => target.key)).not.toContain('r')
  })

  it('普通用户(没有系统、评测、搜索功能):跳转行只列 首页 / 知识库 / 任务,搜索页的键也不列', () => {
    const has = (feature: string | undefined) => !feature
    const rows = shortcutRows(has)
    expect(rows.find((row) => row.label.startsWith('跳转'))!.label).toBe('跳转:首页 / 知识库 / 任务')
    expect(rows.some((row) => row.label.startsWith('搜索页'))).toBe(false)
    expect(rows.some((row) => row.keys.includes('?'))).toBe(true)
  })
})

describe('isHelpKey', () => {
  it('认出 ?:key 是 ?,或者按着 Shift 的斜杠键(不同键盘布局 / 输入方式)', () => {
    expect(isHelpKey({ key: '?', code: 'Slash', shiftKey: true })).toBe(true)
    expect(isHelpKey({ key: '?', code: '', shiftKey: false })).toBe(true)
    expect(isHelpKey({ key: '/', code: 'Slash', shiftKey: true })).toBe(true)
  })
  it('单按斜杠(搜索页聚焦搜索框用)和别的键不算', () => {
    expect(isHelpKey({ key: '/', code: 'Slash', shiftKey: false })).toBe(false)
    expect(isHelpKey({ key: 'h', code: 'KeyH', shiftKey: true })).toBe(false)
    expect(isHelpKey({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBe(false)
  })
})
