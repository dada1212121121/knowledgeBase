// 存储图表的数据整形:构成加总、每人一根条、名字和配额线。
import { describe, expect, it } from 'vitest'
import type { StorageRow } from '@/api/usage'
import { compositionOf, topUsersBars } from './storageCharts'

const GB = 1024 ** 3
const row = (id: string, parts: [number, number, number, number], limitGb: number, extra: Partial<StorageRow> = {}): StorageRow => {
  const [meta, sources, vectors, workspace] = parts
  return {
    space_id: `sp_${id}`,
    owner_id: `usr_${id}`,
    username: id,
    display_name: id.toUpperCase(),
    sources_bytes: sources * GB,
    uploads_bytes: 0,
    vectors_bytes: vectors * GB,
    meta_bytes: meta * GB,
    workspace_bytes: workspace * GB,
    total_bytes: (meta + sources + vectors + workspace) * GB,
    measured_at: 1,
    limit_bytes: limitGb * GB,
    ...extra,
  }
}

describe('compositionOf', () => {
  it('按分项加总,四项都在(0 也留着),顺序固定', () => {
    const items = compositionOf([row('a', [1, 10, 5, 0], 100), row('b', [2, 20, 5, 0], 100)])
    expect(items.map((item) => item.name)).toEqual(['笔记', '原件', '向量索引', '代理工作目录'])
    expect(items.map((item) => item.value / GB)).toEqual([3, 30, 10, 0])
  })

  it('原件 = 上传的原始文件 + 还没处理完的上传分片', () => {
    const items = compositionOf([row('a', [0, 4, 0, 0], 0, { uploads_bytes: 1 * GB })])
    expect(items[1]!.value).toBe(5 * GB)
  })

  it('没有任何人时四项都是 0,不报错', () => {
    expect(compositionOf([]).every((item) => item.value === 0)).toBe(true)
  })

  it('颜色按分项固定,和横向条用同一组', () => {
    const colors = compositionOf([]).map((item) => item.color)
    const bar = topUsersBars([row('a', [1, 1, 1, 1], 0)])[0]!
    expect(bar.segments.map((segment) => segment.color)).toEqual(colors)
  })
})

describe('topUsersBars', () => {
  it('按总占用倒序,只取前几个', () => {
    const rows = [row('small', [0, 1, 0, 0], 100), row('big', [0, 90, 0, 0], 100), row('mid', [0, 30, 0, 0], 100)]
    expect(topUsersBars(rows, 2).map((bar) => bar.key)).toEqual(['sp_big', 'sp_mid'])
  })

  it('不改动传进来的数组顺序(表格还要按自己的排序用它)', () => {
    const rows = [row('a', [0, 1, 0, 0], 0), row('b', [0, 9, 0, 0], 0)]
    topUsersBars(rows)
    expect(rows.map((item) => item.space_id)).toEqual(['sp_a', 'sp_b'])
  })

  it('每根条四个分项都给(包括 0),同名分段在每行里一致', () => {
    const [bar] = topUsersBars([row('a', [0, 5, 0, 0], 10)])
    expect(bar!.segments.map((segment) => segment.name)).toEqual(['笔记', '原件', '向量索引', '代理工作目录'])
    expect(bar!.segments.map((segment) => segment.value / GB)).toEqual([0, 5, 0, 0])
  })

  it('配额线是该用户的存储上限;不限(0)的不画线', () => {
    const [limited, unlimited] = topUsersBars([row('a', [0, 50, 0, 0], 100), row('b', [0, 5, 0, 0], 0)])
    expect(limited!.limit).toBe(100 * GB)
    expect(unlimited!.limit).toBe(0)
  })

  it('右边的文字写「已用 / 上限」,不限写「不限」', () => {
    const [limited, unlimited] = topUsersBars([row('a', [0, 50, 0, 0], 100), row('b', [0, 5, 0, 0], 0)])
    expect(limited!.totalText).toBe('50 GB / 100 GB')
    expect(unlimited!.totalText).toBe('5.0 GB / 不限')
  })

  it('名字用昵称,旁边是 @用户名;账号已删除写「已删除的账号」', () => {
    const [named, gone] = topUsersBars([row('a', [0, 9, 0, 0], 0), row('x', [0, 1, 0, 0], 0, { username: null, display_name: null })])
    expect(named!.label).toBe('A')
    expect(named!.sub).toBe('@a')
    expect(gone!.label).toBe('已删除的账号')
    expect(gone!.sub).toBe('')
  })
})
