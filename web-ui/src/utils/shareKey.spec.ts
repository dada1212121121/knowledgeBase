import { describe, expect, it } from 'vitest'
import type { ShareTarget } from '@/api/share'
import { bestCovering, coversTarget, parseResourceKey } from './shareKey'

describe('parseResourceKey', () => {
  it('五种键都能解析回结构化的资源', () => {
    expect(parseResourceKey('space:sp_a')).toEqual({ kind: 'space', space_id: 'sp_a' })
    expect(parseResourceKey('col:sp_a/proj')).toEqual({ kind: 'collection', space_id: 'sp_a', collection: 'proj' })
    expect(parseResourceKey('dir:sp_a/proj/docs/api')).toEqual({ kind: 'dir', space_id: 'sp_a', collection: 'proj', path: 'docs/api' })
    expect(parseResourceKey('doc:sp_a/_global/i/ins-1')).toEqual({ kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'ins-1' })
    expect(parseResourceKey('doc:sp_a/proj/f/docs/a.md')).toEqual({ kind: 'file', space_id: 'sp_a', collection: 'proj', path: 'docs/a.md' })
  })
  it('百分号编码的中文集合名 / 路径还原正确', () => {
    expect(parseResourceKey('doc:sp_a/%E8%BF%90%E7%BB%B4/f/%E8%AF%B4%E6%98%8E/%E4%B9%A6.md')).toEqual({ kind: 'file', space_id: 'sp_a', collection: '运维', path: '说明/书.md' })
  })
  it('不是合法的键就是 null,不抛异常', () => {
    for (const bad of ['', 'nonsense', 'doc:', 'doc:sp_a', 'doc:sp_a/c/x/y', 'doc:sp_a/c/i', 'col:sp_a/%ZZ', 'space:sp_a/extra']) expect(parseResourceKey(bad), bad).toBeNull()
  })
})

describe('coversTarget / bestCovering', () => {
  const file: ShareTarget = { kind: 'file', space_id: 'sp_a', collection: 'proj', path: 'docs/api/a.md' }
  const note: ShareTarget = { kind: 'insight', space_id: 'sp_a', collection: 'proj', id: 'n1' }
  it('整个知识库 / 集合 / 目录(按路径边界)/ 自己', () => {
    expect(coversTarget({ kind: 'space', space_id: 'sp_a' }, file)).toBe(true)
    expect(coversTarget({ kind: 'space', space_id: 'sp_b' }, file)).toBe(false)
    expect(coversTarget({ kind: 'collection', space_id: 'sp_a', collection: 'proj' }, note)).toBe(true)
    expect(coversTarget({ kind: 'collection', space_id: 'sp_a', collection: 'other' }, note)).toBe(false)
    expect(coversTarget({ kind: 'dir', space_id: 'sp_a', collection: 'proj', path: 'docs' }, file)).toBe(true)
    expect(coversTarget({ kind: 'dir', space_id: 'sp_a', collection: 'proj', path: 'doc' }, file)).toBe(false)
    expect(coversTarget({ kind: 'dir', space_id: 'sp_a', collection: 'proj', path: 'docs' }, note)).toBe(false)
    expect(coversTarget(file, file)).toBe(true)
    expect(coversTarget(note, note)).toBe(true)
    expect(coversTarget(note, { ...note, id: 'n2' })).toBe(false)
  })
  it('有多个授权覆盖同一篇时,选最具体的', () => {
    const items = [
      { id: 'space', target: { kind: 'space', space_id: 'sp_a' } as ShareTarget },
      { id: 'col', target: { kind: 'collection', space_id: 'sp_a', collection: 'proj' } as ShareTarget },
      { id: 'dir-short', target: { kind: 'dir', space_id: 'sp_a', collection: 'proj', path: 'docs' } as ShareTarget },
      { id: 'dir-long', target: { kind: 'dir', space_id: 'sp_a', collection: 'proj', path: 'docs/api' } as ShareTarget },
      { id: 'file', target: file },
    ]
    expect(bestCovering(items, file)?.id).toBe('file')
    expect(bestCovering(items.filter((item) => item.id !== 'file'), file)?.id).toBe('dir-long')
    expect(bestCovering(items.filter((item) => item.id === 'space' || item.id === 'col'), file)?.id).toBe('col')
    expect(bestCovering(items.slice(0, 0), file)).toBeNull()
  })
})
