import { describe, expect, it } from 'vitest'
import { featureHint, featureLabel, stripAi, visibleFeatures } from './featureText'

describe('stripAi', () => {
  it('「AI 工具」换成「外部工具」,其余的 AI 直接去掉', () => {
    expect(stripAi('创建个人访问令牌,接入 AI 工具')).toBe('创建个人访问令牌,接入外部工具')
    expect(stripAi('AI 助手')).toBe('助手')
    expect(stripAi('没有那个词')).toBe('没有那个词')
  })
})

describe('featureLabel / featureHint', () => {
  const tokens = { id: 'api.tokens', label: 'API 令牌与 MCP', hint: '创建个人访问令牌,接入 AI 工具' }
  it('访问令牌那一条不再叫 API 令牌', () => {
    expect(featureLabel(tokens, true)).toBe('访问令牌与 MCP')
  })
  it('AI 开着:说明原样;AI 关掉:不含「AI」', () => {
    expect(featureHint(tokens, true)).toContain('AI 工具')
    expect(featureHint(tokens, false)).not.toMatch(/AI/)
    expect(featureLabel({ id: 'ai.assistant', label: 'AI 助手' }, false)).not.toMatch(/AI/)
  })
})

describe('visibleFeatures', () => {
  const list = [{ id: 'a', ai: false }, { id: 'b', ai: true }]
  it('AI 开着全列;关掉后不列 AI 功能点,原数组不动', () => {
    expect(visibleFeatures(list, true)).toHaveLength(2)
    expect(visibleFeatures(list, false).map((item) => item.id)).toEqual(['a'])
    expect(list).toHaveLength(2)
  })
})
