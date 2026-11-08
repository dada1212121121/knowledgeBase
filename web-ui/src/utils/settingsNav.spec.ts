import { describe, expect, it } from 'vitest'
import { SECTIONS, TAB_ALIASES, resolveTab, sectionLabel, visibleSections } from './settingsNav'
import { FIELD_GROUPS } from './settingsFields'

const all = () => true
const none = () => false
const ids = (list: readonly { id: string }[]) => list.map((section) => section.id)

describe('visibleSections', () => {
  it('AI 总开关开着:全部分区都在,顺序固定', () => {
    expect(ids(visibleSections({ aiOn: true, has: all }))).toEqual(['general', 'storage', 'search', 'model', 'components', 'ocr', 'skills', 'mcp', 'acp', 'backup'])
  })

  it('AI 总开关关闭:模型和编码代理整个分区不出现,其余照旧', () => {
    expect(ids(visibleSections({ aiOn: false, has: all }))).toEqual(['general', 'storage', 'search', 'components', 'ocr', 'skills', 'mcp', 'backup'])
  })

  it('AI 关闭时,留下的分区名里没有「AI」字样', () => {
    for (const section of visibleSections({ aiOn: false, has: all })) expect(section.label).not.toMatch(/AI/)
  })

  it('没有 sys.ops 就没有备份;没有 ai.acp 就没有编码代理', () => {
    const has = (feature: string) => feature !== 'sys.ops' && feature !== 'ai.acp'
    const shown = ids(visibleSections({ aiOn: true, has }))
    expect(shown).not.toContain('backup')
    expect(shown).not.toContain('acp')
    expect(shown).toContain('model')
  })

  it('账号什么功能都没有:只剩不要求额外功能的分区', () => {
    expect(ids(visibleSections({ aiOn: true, has: none }))).toEqual(['general', 'storage', 'search', 'model', 'components', 'ocr', 'skills', 'mcp'])
  })

  it('字段表里的每个分区都在导航里(不会有改不到的字段)', () => {
    const known = new Set(ids(SECTIONS))
    for (const group of FIELD_GROUPS) expect(known.has(group.section), group.id).toBe(true)
  })
})

describe('resolveTab', () => {
  const visible = visibleSections({ aiOn: true, has: all })
  const noAi = visibleSections({ aiOn: false, has: all })

  it('没写页签:进第一个分区,地址不用改', () => {
    expect(resolveTab(undefined, visible)).toEqual({ id: 'general', corrected: false })
    expect(resolveTab('', visible)).toEqual({ id: 'general', corrected: false })
  })

  it('认得的页签', () => {
    expect(resolveTab('backup', visible)).toEqual({ id: 'backup', corrected: false })
    expect(resolveTab('acp', visible)).toEqual({ id: 'acp', corrected: false })
    expect(resolveTab(['ocr', 'x'], visible)).toEqual({ id: 'ocr', corrected: false })
  })

  it('旧页签落到合并后的位置,并提示把地址改过来', () => {
    expect(resolveTab('tuning', visible)).toEqual({ id: 'search', corrected: true })
    expect(resolveTab('about', visible)).toEqual({ id: 'general', corrected: true })
    expect(resolveTab('llm', visible)).toEqual({ id: 'model', corrected: true })
  })

  it('搬走的页签:外观、访问令牌去它们现在的页面', () => {
    expect(resolveTab('appearance', visible)).toMatchObject({ redirect: 'appearance' })
    expect(resolveTab('tokens', visible)).toMatchObject({ redirect: 'tokens' })
  })

  it('认不出的页签回到第一个分区并纠正地址', () => {
    expect(resolveTab('nope', visible)).toEqual({ id: 'general', corrected: true })
  })

  it('AI 关闭时直接打开模型 / 编码代理的链接:回到常规,不暴露这些分区', () => {
    expect(resolveTab('model', noAi)).toEqual({ id: 'general', corrected: true })
    expect(resolveTab('acp', noAi)).toEqual({ id: 'general', corrected: true })
    expect(resolveTab('llm', noAi)).toEqual({ id: 'general', corrected: true })
  })

  it('别名都指向存在的分区', () => {
    const known = new Set(ids(SECTIONS))
    for (const target of Object.values(TAB_ALIASES)) expect(known.has(target)).toBe(true)
  })
})

describe('sectionLabel', () => {
  it('术语表的说法', () => {
    expect(sectionLabel('storage')).toBe('存储与索引')
    expect(sectionLabel('acp')).toBe('编码代理')
  })
})
