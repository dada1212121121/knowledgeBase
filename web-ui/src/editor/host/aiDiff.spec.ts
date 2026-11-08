// AI 写作预览的字词级对比：中文逐字、英文按词；拼回去和两边原文完全一致；超大输入退化成整段删加。
import { describe, expect, it } from 'vitest'
import { diffWords, tokenize } from './aiDiff'

const side = (segments: ReturnType<typeof diffWords>, kind: 'before' | 'after') =>
  segments.filter((segment) => segment.kind === 'equal' || segment.kind === (kind === 'before' ? 'remove' : 'add')).map((segment) => segment.text).join('')

describe('diffWords', () => {
  it('中文只改了几个字：只标出这几个字', () => {
    const segments = diffWords('这个功能很好用很好用。', '这个功能很好用。')
    expect(segments).toEqual([
      { kind: 'equal', text: '这个功能很好用' },
      { kind: 'remove', text: '很好用' },
      { kind: 'equal', text: '。' },
    ])
  })

  it('英文按词对比，不拆开单词', () => {
    const segments = diffWords('the quick brown fox', 'the slow brown fox')
    expect(segments).toEqual([
      { kind: 'equal', text: 'the ' },
      { kind: 'remove', text: 'quick' },
      { kind: 'add', text: 'slow' },
      { kind: 'equal', text: ' brown fox' },
    ])
    expect(tokenize('kb search 连接')).toEqual(['kb', ' ', 'search', ' ', '连', '接'])
  })

  it('任意两段文字：删去「新增」得到原文，删去「删除」得到新文', () => {
    const cases: [string, string][] = [
      ['守护进程重启期间，kb search 连接失败直接退出。', '守护进程重启时，`kb search` 连接失败会直接退出（exit 3）。'],
      ['', '全新的一段'],
      ['要删掉的一段', ''],
      ['- 列表一\n- 列表二', '- 列表一\n- 列表三\n- 列表四'],
    ]
    for (const [before, after] of cases) {
      const segments = diffWords(before, after)
      expect(side(segments, 'before'), before).toBe(before)
      expect(side(segments, 'after'), after).toBe(after)
    }
  })

  it('相同文字：只有一段 equal；两边都空：没有段', () => {
    expect(diffWords('一样', '一样')).toEqual([{ kind: 'equal', text: '一样' }])
    expect(diffWords('', '')).toEqual([])
  })

  it('整体重写的长段落：退化成整段删 + 整段加，结果仍能还原两边', () => {
    const before = '甲'.repeat(900) + '乙'
    const after = '丙'.repeat(900) + '丁'
    const segments = diffWords(before, after)
    expect(segments).toEqual([
      { kind: 'remove', text: before },
      { kind: 'add', text: after },
    ])
  })
})
