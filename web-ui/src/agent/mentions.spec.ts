import { describe, expect, it, vi } from 'vitest'
import {
  buildMentionPrompt,
  mentionQueryOf,
  mentionToken,
  parseMentionTokens,
  refsOfMentions,
  searchMentions,
  stripMentionTokens,
  type MentionSearchContext,
} from './mentions'

function context(overrides: Partial<MentionSearchContext> = {}): MentionSearchContext {
  return {
    call: vi.fn().mockResolvedValue({}),
    agents: [
      { id: 'deepseek', name: 'DeepSeek', available: true },
      { id: 'claude', name: 'Claude Code', available: false },
    ],
    ...overrides,
  }
}

describe('@ 引用', () => {
  it('在开头 / 空白 / 中文后面触发,邮箱不触发', () => {
    expect(mentionQueryOf('@部')).toEqual({ query: '部', start: 0 })
    expect(mentionQueryOf('帮我看看@部署')).toEqual({ query: '部署', start: 4 })
    expect(mentionQueryOf('看看 @部署')).toEqual({ query: '部署', start: 3 })
    expect(mentionQueryOf('me@x.com')).toBeNull()
    expect(mentionQueryOf('@a b')).toBeNull()
    expect(mentionQueryOf('没有引用')).toBeNull()
  })

  it('引用链接可读、可解析、可还原', () => {
    const ref = { kind: 'item' as const, id: '01abc', label: '部署文档', uri: 'kb://item/01abc' }
    const token = mentionToken(ref)
    expect(token).toBe('@[部署文档](kb://item/01abc)')
    expect(parseMentionTokens(`看下 ${token} 谢谢`)).toEqual([ref])
    expect(stripMentionTokens(`看下 ${token} 谢谢`)).toBe('看下 @部署文档 谢谢')
  })

  it('提示词里带参考资料和工具提示', () => {
    const prompt = buildMentionPrompt('总结一下 @[部署文档](kb://item/01abc)', [
      { kind: 'item', id: '01abc', label: '部署文档', uri: 'kb://item/01abc' },
      { kind: 'project', id: 'sampleapp', label: 'SampleApp', uri: 'kb://project/sampleapp' },
    ])
    expect(prompt).toContain('用户引用了这些资料')
    expect(prompt).toContain('get_item')
    expect(prompt).toContain('kb://project/sampleapp')
    expect(prompt).toContain('总结一下 @部署文档')
  })

  it('代理只列可用的,项目 / 集合从能力拿', async () => {
    const ctx = context({
      call: vi.fn().mockImplementation((name: string) => {
        if (name === 'list_projects') {
          return Promise.resolve({ projects: [{ name: 'SampleApp', slug: 'sampleapp', root_path: '/srv/sampleapp' }] })
        }
        if (name === 'list_collections') {
          return Promise.resolve({ collections: [{ name: 'proj_sampleapp', rows: 10 }] })
        }
        if (name === 'search_knowledge') {
          return Promise.resolve({ hits: [{ id: 'h1', collection: 'proj_sampleapp', source: 'docs/a.md', title: '部署' }] })
        }
        if (name === 'agent_sessions') {
          return Promise.resolve({ sessions: [{ session_id: 's1', title: '聊部署' }] })
        }
        return Promise.resolve({})
      }),
    })
    expect((await searchMentions('agent', '', ctx)).map((item) => item.id)).toEqual(['deepseek'])
    expect((await searchMentions('item', '部署', ctx))[0].uri).toBe('kb://item/h1')
    expect((await searchMentions('project', 'sampleapp', ctx))[0].label).toBe('SampleApp')
    expect((await searchMentions('collection', 'sampleapp', ctx))[0].detail).toBe('10 行')
    expect((await searchMentions('session', '部署', ctx))[0].label).toBe('聊部署')
  })

  it('条目没关键词时不打接口', async () => {
    const ctx = context()
    expect(await searchMentions('item', '', ctx)).toEqual([])
    expect(ctx.call).not.toHaveBeenCalled()
  })

  it('引用胶囊只给能跳转的类型', () => {
    expect(
      refsOfMentions([
        { kind: 'item', id: 'i', label: '条目', uri: 'kb://item/i' },
        { kind: 'collection', id: 'c', label: '集合', uri: 'kb://collection/c' },
        { kind: 'session', id: 's', label: '会话', uri: 'kb://session/s' },
        { kind: 'agent', id: 'a', label: '代理', uri: 'kb://agent/a' },
      ]),
    ).toEqual([
      { kind: 'item', id: 'i', label: '条目', collection: '', source: undefined },
      { kind: 'collection', id: 'c', label: '集合' },
    ])
  })
})
