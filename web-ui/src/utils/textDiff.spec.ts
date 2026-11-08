import { describe, expect, it } from 'vitest'
import { diffLines, sameText } from './textDiff'

/** 只看 kind+text,断言更直观。 */
const shape = (before: string, after: string, context = 3) =>
  diffLines(before, after, context).lines.map((line) => (line.kind === 'skip' ? `skip:${line.count}` : `${line.kind[0]}:${line.text}`))

describe('textDiff', () => {
  it('内容一样时全是 equal,且没有新增 / 删除', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc')
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
    expect(result.lines.every((line) => line.kind === 'equal')).toBe(true)
  })

  it('改一行:旧行标删除、新行标新增,行号各自连续', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc')
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    expect(result.lines.map((line) => line.kind)).toEqual(['equal', 'remove', 'add', 'equal'])
    const [first, removed, added, last] = result.lines
    expect(first).toMatchObject({ oldLine: 1, newLine: 1 })
    expect(removed).toMatchObject({ oldLine: 2, newLine: null })
    expect(added).toMatchObject({ oldLine: null, newLine: 2 })
    expect(last).toMatchObject({ oldLine: 3, newLine: 3 })
  })

  it('纯新增:只在结尾追加几行', () => {
    const result = diffLines('a\nb', 'a\nb\nc\nd')
    expect(result.added).toBe(2)
    expect(result.removed).toBe(0)
    expect(result.lines.slice(-2).map((line) => [line.kind, line.text, line.newLine])).toEqual([
      ['add', 'c', 3],
      ['add', 'd', 4],
    ])
  })

  it('纯删除:删掉中间一段', () => {
    const result = diffLines('a\nb\nc\nd', 'a\nd')
    // 改动区在中间,前后各 1 行以内不折叠
    expect(result.added).toBe(0)
    expect(result.removed).toBe(2)
    expect(result.lines.filter((line) => line.kind === 'remove').map((line) => line.text)).toEqual(['b', 'c'])
  })

  it('末尾换行不算多一行', () => {
    expect(diffLines('a\nb\n', 'a\nb').added).toBe(0)
    expect(diffLines('a\nb\n', 'a\nb').removed).toBe(0)
    expect(sameText('a\nb\n', 'a\nb  ')).toBe(true)
  })

  it('空文件与有内容的互转', () => {
    expect(shape('', 'a\nb')).toEqual(['a:a', 'a:b'])
    expect(shape('a\nb', '')).toEqual(['r:a', 'r:b'])
  })

  it('长段未改动行折叠,每段留头尾各 3 行', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n')
    const after = before.replace('line-20', 'line-20 改过')
    const lines = diffLines(before, after).lines
    // 19 行未改动 + 1 行改动:折叠成 3 行 + skip:13 + 3 行 + 改动
    expect(lines.map((line) => (line.kind === 'skip' ? 'skip' : line.kind))).toEqual([
      'equal', 'equal', 'equal', 'skip', 'equal', 'equal', 'equal', 'remove', 'add',
    ])
    expect(lines[3].count).toBe(13)
  })

  it('改动密集时不折叠', () => {
    const lines = diffLines('a\nb', 'a\nB', 0).lines
    expect(lines.some((line) => line.kind === 'skip')).toBe(false)
  })

  it('超大改动不爆内存:退化成整段删 + 整段加', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `x${i}`).join('\n')
    const after = Array.from({ length: 2100 }, (_, i) => `y${i}`).join('\n')
    const result = diffLines(before, after, 0)
    expect(result.removed).toBe(2100)
    expect(result.added).toBe(2100)
  })

  it('行号从 1 开始,skip 行没有行号', () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')
    const lines = diffLines(before, `${before}\n新的一行`, 2).lines
    const skip = lines.find((line) => line.kind === 'skip')
    expect(skip).toMatchObject({ oldLine: null, newLine: null })
    expect(lines[0].oldLine).toBe(1)
    expect(lines.at(-1)).toMatchObject({ kind: 'add', newLine: 13 })
  })
})
