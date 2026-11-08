import { describe, expect, it } from 'vitest'
import { projectOptions, refLink, restoreEntries, sessionLabel, timeAgo } from './agent'

describe('sessionLabel', () => {
  it('空标题回退到「新会话」', () => {
    expect(sessionLabel('')).toBe('新会话')
    expect(sessionLabel('   ')).toBe('新会话')
  })
  it('长标题截断到 40 字并加省略号', () => {
    const long = '一'.repeat(50)
    expect(sessionLabel(long)).toBe(`${'一'.repeat(40)}…`)
  })
  it('短标题原样返回', () => {
    expect(sessionLabel('帮我总结一下')).toBe('帮我总结一下')
  })
})

describe('timeAgo', () => {
  const now = 1_700_000_000_000
  it('一分钟内是「刚刚」', () => {
    expect(timeAgo(now - 30_000, now)).toBe('刚刚')
  })
  it('分钟 / 小时 / 天', () => {
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2 天前')
  })
  it('超过一周显示月-日', () => {
    const at = Date.UTC(2026, 9, 3, 4) // 上海 10-03 12:00
    expect(timeAgo(at, at + 30 * 86_400_000)).toBe('10-03')
  })
  it('没有时间返回空串', () => {
    expect(timeAgo(0, now)).toBe('')
  })
})

describe('refLink', () => {
  it('条目落到浏览器并带上 collection / item', () => {
    expect(refLink({ kind: 'item', id: 'abc', label: 'PLAN.md', collection: 'proj_demo' })).toEqual({
      path: '/kb',
      query: { collection: 'proj_demo', item: 'abc' },
    })
  })
  it('集合落到浏览器并切到该集合', () => {
    expect(refLink({ kind: 'collection', id: 'proj_demo', label: 'proj_demo' })).toEqual({
      path: '/kb',
      query: { collection: 'proj_demo' },
    })
  })
  it('项目 / 批次 / 任务各自落到对应页面', () => {
    expect(refLink({ kind: 'project', id: 'demo', label: 'demo' })).toEqual({ path: '/admin/projects' })
    expect(refLink({ kind: 'batch', id: 'b1', label: '批次' })).toEqual({
      path: '/admin/audit',
      query: { tab: 'batches', batch: 'b1' },
    })
    expect(refLink({ kind: 'job', id: 'j1', label: '任务' })).toEqual({
      path: '/tasks',
      query: { job: 'j1' },
    })
  })
})

describe('projectOptions', () => {
  it('去重、排序,并带上「全部项目」', () => {
    const base = { created_at: 0, last_at: 0, messages: 0, pinned: false, title: '' }
    const options = projectOptions([
      { ...base, session_id: 'a', project: 'demo' },
      { ...base, session_id: 'b', project: 'sampleapp' },
      { ...base, session_id: 'c', project: 'demo' },
      { ...base, session_id: 'd', project: '' },
    ])
    expect(options).toEqual([
      { value: '', label: '全部项目' },
      { value: 'demo', label: 'demo' },
      { value: 'sampleapp', label: 'sampleapp' },
    ])
  })
})

describe('restoreEntries', () => {
  const msg = (role: string, value: unknown) => ({ role, content_json: JSON.stringify(value) })
  it('保留轨迹 / 引用,失败轮次显示成系统提示,计划卡片挂到上一条助手消息', () => {
    const entries = restoreEntries([
      msg('user', { text: '搜一下' }),
      msg('assistant', {
        text: '找到一条',
        trace: ['search_knowledge'],
        refs: [{ kind: 'item', id: 'abc', label: 'PLAN.md', collection: 'proj_demo' }],
      }),
      msg('plan', { card: { id: 'c1', capability: 'delete_item' } }),
      msg('user', { text: '再试一次' }),
      msg('assistant', { text: '', error: 'upstream: boom' }),
    ])
    expect(entries).toHaveLength(4)
    expect(entries[1].trace).toEqual(['search_knowledge'])
    expect(entries[1].refs?.[0].id).toBe('abc')
    expect(entries[1].cards?.[0].id).toBe('c1')
    expect(entries[2].role).toBe('user')
    expect(entries[3].failed).toBe(true)
    expect(entries[3].text).toContain('boom')
  })
  it('坏 JSON 跳过,不影响其它消息', () => {
    const entries = restoreEntries([
      { role: 'user', content_json: '{bad' },
      msg('user', { text: '正常' }),
    ])
    expect(entries).toEqual([{ role: 'user', text: '正常' }])
  })
})
