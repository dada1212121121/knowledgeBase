import { describe, expect, it } from 'vitest'
import { hitCandidates } from './hit'

describe('检索命中 → 查找候选', () => {
  it('空文本没有候选', () => {
    expect(hitCandidates('')).toEqual([])
    expect(hitCandidates('  …… ')).toEqual([])
  })

  it('整句优先，其次第一行、分隔后的小段、截短的前缀', () => {
    const list = hitCandidates('多格式解析与编辑 · 批次 1 PDF Office HTML 邮件 ...')
    expect(list[0]).toBe('多格式解析与编辑 · 批次 1 PDF Office HTML 邮件')
    expect(list).toContain('多格式解析与编辑')
    expect(list).toContain('批次 1 PDF Office HTML 邮件')
  })

  it('多行文本拆出第一行', () => {
    const list = hitCandidates('第一行标题\n第二行要点\n第三行')
    expect(list[0]).toBe('第一行标题\n第二行要点\n第三行')
    expect(list[1]).toBe('第一行标题')
  })

  it('过长的第一行按 48 / 24 / 12 字截短；候选不重复、不短于 2 个字', () => {
    const long = '这是一句非常长的命中文字'.repeat(8)
    const list = hitCandidates(long)
    expect(list).toContain(long.slice(0, 48))
    expect(list).toContain(long.slice(0, 24))
    expect(list).toContain(long.slice(0, 12))
    expect(new Set(list).size).toBe(list.length)
    expect(hitCandidates('a').length).toBe(0)
  })
})
