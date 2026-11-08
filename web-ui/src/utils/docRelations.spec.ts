// 「关系」页签的纯数据整理:去重、标题回退、行号与顺序。网络部分在页面里,这里只钉规则。
import { describe, expect, it } from 'vitest'
import { noteTargetIds, relationFileName, splitRelations } from './docRelations'

describe('docRelations', () => {
  it('出链按正文行号排;笔记用查到的标题,文件用文件名', () => {
    const { outbound, inbound } = splitRelations(
      {
        outbound: [
          { target_kind: 'file', target_collection: 'proj_kb', target_id: 'docs/利润表.xlsx', line: 12 },
          { target_kind: 'note', target_collection: 'proj_kb', target_id: 'ins_a', label: '旧的写法', line: 3 },
        ],
        inbound: [],
      },
      { ins_a: '成本对比' },
    )
    expect(outbound.map((item) => [item.kind, item.title, item.line])).toEqual([
      ['note', '成本对比', 3],
      ['file', '利润表.xlsx', 12],
    ])
    expect(inbound).toEqual([])
  })

  it('同一篇文档引用多次只留一行:次数累加,行号取第一处', () => {
    const { inbound } = splitRelations({
      inbound: [
        { source_kind: 'note', source_collection: 'proj_kb', source_id: 'ins_a', source_title: '周报', line: 12 },
        { source_kind: 'note', source_collection: 'proj_kb', source_id: 'ins_a', source_title: '周报', line: 40 },
        { source_kind: 'file', source_collection: 'proj_kb', source_id: 'docs/b.md', source_title: '', line: 7 },
      ],
    })
    expect(inbound).toEqual([
      { kind: 'note', collection: 'proj_kb', id: 'ins_a', title: '周报', line: 12, count: 2 },
      { kind: 'file', collection: 'proj_kb', id: 'docs/b.md', title: 'b.md', line: 7, count: 1 },
    ])
  })

  it('标题读不到时退回链接文字 / id,不丢项', () => {
    const { outbound } = splitRelations(
      {
        outbound: [
          { target_kind: 'note', target_collection: 'c', target_id: 'ins_missing', label: '' },
          { target_kind: 'note', target_collection: 'c', target_id: 'ins_labeled', label: '别名' },
          { target_kind: 'file', target_collection: 'c', href: 'kb://c/docs/a.md', label: '附件说明' },
        ],
      },
      {},
    )
    // 中文按 zh 排序在前;同标题才看行号
    expect(outbound.map((item) => item.title)).toEqual(['别名', 'a.md', 'ins_missing'])
  })

  it('入链没有标题时用文件名;笔记 id 原样显示', () => {
    const { inbound } = splitRelations({
      inbound: [
        { source_kind: 'file', source_collection: 'c', source_id: 'deep/dir/report.pdf' },
        { source_kind: 'note', source_collection: 'c', source_id: 'ins_x' },
      ],
    })
    expect(inbound.map((item) => [item.kind, item.title])).toEqual([
      ['note', 'ins_x'],
      ['file', 'report.pdf'],
    ])
  })

  it('没有目标 / 来源或带 reason 的行跳过(旧索引空行、已失效的链接、锚点与外部链接)', () => {
    const { outbound, inbound } = splitRelations({
      outbound: [
        { target_kind: 'note', target_collection: 'c' },
        { target_kind: 'file', target_collection: 'c', target_id: '' },
        { target_kind: 'note', target_collection: 'c', target_id: 'bad id', reason: '笔记 id 不合法' },
        { target_kind: 'anchor', target_id: '#做法' },
        { target_kind: 'external', target_id: 'https://example.com' },
      ],
      inbound: [
        { source_kind: 'note', source_collection: 'c' },
        { source_kind: 'note', source_collection: 'c', source_id: 'ins_bad', reason: '笔记不存在' },
      ],
    })
    expect(outbound).toEqual([])
    expect(inbound).toEqual([])
  })

  it('参数为空时返回两组空数组', () => {
    expect(splitRelations(null)).toEqual({ outbound: [], inbound: [] })
    expect(splitRelations({})).toEqual({ outbound: [], inbound: [] })
  })

  it('noteTargetIds 只收笔记、去重', () => {
    expect(
      noteTargetIds([
        { target_kind: 'note', target_id: 'ins_b' },
        { target_kind: 'note', target_id: 'ins_a' },
        { target_kind: 'note', target_id: 'ins_a' },
        { target_kind: 'file', target_id: 'docs/a.md' },
        { target_kind: 'note' },
      ]),
    ).toEqual(['ins_b', 'ins_a'])
  })

  it('relationFileName 只取最后一段,空路径原样返回', () => {
    expect(relationFileName('docs/深层/报告.docx')).toBe('报告.docx')
    expect(relationFileName('')).toBe('')
  })
})
