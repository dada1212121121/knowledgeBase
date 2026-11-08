/**
 * 服务端分页表格适配器
 *
 * 用内存假后端对拍：假后端按服务端的规则（行号指打开时的表、一次整批生效、乐观锁）应用操作，
 * 这样既能验证适配器发出去的操作列表对不对，也能验证保存后重读的表和预期一致。
 * 编码层面的逐字节往返由 e2e（假服务端真的按 GBK / UTF-16 解码编码）和服务端自己的测试守着。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteTableConflict, type RemoteTableBackend, type RemoteTableFormat, type RemoteTableOp, type RemoteTablePage } from '../../types'
import { REMOTE_MAX_OPS, REMOTE_MAX_PAGES, REMOTE_PAGE_ROWS, ServerCsvAdapter, draftToOps } from './csvRemote'

const FORMAT: RemoteTableFormat = { encoding: 'gb18030', encodingLabel: 'GB18030', delimiter: ',', newline: 'crlf', trailingNewline: true }

/** 内存假后端：行是字符串数组；edit 按服务端语义（行号指修改之前的表）应用操作 */
class FakeBackend implements RemoteTableBackend {
  version = 1
  sha = 'sha-1'
  reads: number[] = []
  edits: Array<{ ops: RemoteTableOp[]; expected: { version: number; sha256: string } }> = []
  failReads = 0
  /** 为真时每次 read 之后文件“被别人改了”：返回的 sha 不同 */
  driftAfterFirst = false
  private served = 0
  /** 手动放行的读取：用来制造“请求还在路上”的时刻 */
  gate: Promise<void> | null = null

  constructor(public rows: string[][]) {}

  async read(offset: number, limit: number): Promise<RemoteTablePage> {
    if (this.gate) await this.gate
    this.reads.push(offset)
    if (this.failReads > 0) {
      this.failReads -= 1
      throw new Error('网络不通')
    }
    this.served += 1
    return {
      totalRows: this.rows.length,
      columns: Math.max(0, ...this.rows.map((row) => row.length)),
      rows: this.rows.slice(offset, offset + limit).map((row) => [...row]),
      offset,
      format: FORMAT,
      sha256: this.driftAfterFirst && this.served > 1 ? 'sha-drifted' : this.sha,
      version: this.version,
    }
  }

  async edit(ops: RemoteTableOp[], expected: { version: number; sha256: string }) {
    this.edits.push({ ops, expected })
    if (expected.version !== this.version || expected.sha256 !== this.sha) throw new RemoteTableConflict('这个文件刚被别人保存过')
    const deleted = new Set<number>()
    const cells = new Map<string, string>()
    const inserts: Array<{ at: number; values: string[] }> = []
    for (const op of ops) {
      if (op.op === 'set_cell') cells.set(`${op.row}:${op.col}`, op.value)
      else if (op.op === 'delete_row') deleted.add(op.row)
      else inserts.push({ at: op.at, values: op.values })
    }
    const next: string[][] = []
    for (let row = 0; row <= this.rows.length; row += 1) {
      for (const insert of inserts) if (insert.at === row) next.push([...insert.values])
      if (row === this.rows.length || deleted.has(row)) continue
      const line = [...this.rows[row]!]
      for (const [key, value] of cells) {
        const [r, c] = key.split(':').map(Number) as [number, number]
        if (r !== row) continue
        while (line.length <= c) line.push('')
        line[c] = value
      }
      next.push(line)
    }
    this.rows = next
    this.version += 1
    this.sha = `sha-${this.version}`
    return { changed: true, version: this.version, sha256: this.sha, embedded: 1 }
  }
}

const table = (count: number, columns = 3) => Array.from({ length: count }, (_, row) => Array.from({ length: columns }, (_, col) => `r${row}c${col}`))
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}
const text = (adapter: ServerCsvAdapter, row: number, col = 0) => adapter.sheets()[0].cell(row, col)?.text

async function open(rows: string[][] = table(1200)) {
  const backend = new FakeBackend(rows)
  const adapter = await ServerCsvAdapter.create(backend, '评测.csv')
  return { backend, adapter }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ServerCsvAdapter 取页', () => {
  it('1. 打开只读第一页：总行数来自服务端，没读到的页留空', async () => {
    const { backend, adapter } = await open()
    const sheet = adapter.sheets()[0]
    expect(backend.reads).toEqual([0])
    expect(sheet.rowCount).toBe(1200)
    expect(sheet.colCount).toBe(3)
    expect(text(adapter, 0)).toBe('r0c0')
    expect(text(adapter, REMOTE_PAGE_ROWS - 1, 2)).toBe(`r${REMOTE_PAGE_ROWS - 1}c2`)
    expect(sheet.cell(REMOTE_PAGE_ROWS, 0)).toBeNull()
    expect(adapter.statusText()).toContain('GB18030')
    expect(adapter.stats()).toEqual({ words: 1200, unitLabel: '行' })
  })

  it('2. 视口滚到哪取哪：看得见的页先取，顺带取前后各一页；读到后通知“数据变了”', async () => {
    const { backend, adapter } = await open()
    const seen: Array<string | undefined> = []
    adapter.subscribe((change) => seen.push(change))
    adapter.prefetch(1000, 1040)
    await flush()
    // 第 1000 行在第 3 页（0 基）；并发上限 2：第 3 页和第 2 页先取
    expect(backend.reads.slice(1)).toEqual([1000, 500])
    expect(text(adapter, 1000)).toBe('r1000c0')
    expect(seen.every((change) => change === 'data')).toBe(true)
    // 第 3 页之外不会为 0 页或没看的页再发请求
    expect(backend.reads.filter((offset) => offset === 0)).toHaveLength(1)
  })

  it('3. 快速滚动时只取最后停下的位置：中途路过的页不取', async () => {
    const rows = table(5000)
    const backend = new FakeBackend(rows)
    const adapter = await ServerCsvAdapter.create(backend, 'big.csv')
    let release: () => void = () => undefined
    backend.gate = new Promise((resolve) => (release = resolve))
    adapter.prefetch(1000, 1040) // 第 2 页 + 邻居
    adapter.prefetch(2500, 2540) // 滚过去了：想要的变成第 5 页
    adapter.prefetch(4500, 4540) // 最终停在这里
    release()
    backend.gate = null
    await flush()
    await flush()
    // 第一次 prefetch 已经发出了两个请求（上限 2），其余排队的按“最新想要的页”补
    const later = backend.reads.slice(1).map((offset) => offset / REMOTE_PAGE_ROWS)
    expect(later).toContain(9)
    expect(later).not.toContain(5)
  })

  it('4. 取页失败显示原因，2 秒后自动重试', async () => {
    const { backend, adapter } = await open()
    backend.failReads = 1
    adapter.prefetch(600, 620)
    await flush()
    expect(adapter.statusText()).toContain('读取失败')
    expect(adapter.sheets()[0].cell(600, 0)).toBeNull()
    await vi.advanceTimersByTimeAsync(2100)
    expect(text(adapter, 600)).toBe('r600c0')
    expect(adapter.statusText()).not.toContain('读取失败')
  })

  it('5. 内存里最多留固定页数，离视口最远的先丢，草稿不受影响', async () => {
    const total = (REMOTE_MAX_PAGES + 8) * REMOTE_PAGE_ROWS
    const { adapter } = await open(table(total, 1))
    adapter.apply([{ row: 3, col: 0, text: '改' }])
    for (let page = 1; page <= REMOTE_MAX_PAGES + 6; page += 1) {
      adapter.prefetch(page * REMOTE_PAGE_ROWS, page * REMOTE_PAGE_ROWS + 10)
      await flush()
      await flush()
    }
    // 最近看的页在，最早的页被丢了，但改过的格子仍然显示改后的值
    expect(text(adapter, (REMOTE_MAX_PAGES + 6) * REMOTE_PAGE_ROWS)).toBeTruthy()
    expect(adapter.sheets()[0].cell(REMOTE_PAGE_ROWS + 1, 0)).toBeNull()
    expect(text(adapter, 3)).toBe('改')
  })

  it('6. 取页时发现文件已被别人改过（哈希变了）：转只读并说明，不把两个版本的行拼在一起', async () => {
    const { backend, adapter } = await open()
    backend.driftAfterFirst = true
    adapter.prefetch(600, 620)
    await flush()
    expect(adapter.readonly()).toBe(true)
    expect(adapter.statusText()).toContain('被改动')
    expect(adapter.apply([{ row: 0, col: 0, text: 'x' }])).toBe(false)
  })

  it('7. 查找只扫读进来的页', async () => {
    const { adapter } = await open(table(3000))
    expect(adapter.sheets()[0].scanRanges?.()).toEqual([[0, REMOTE_PAGE_ROWS]])
    adapter.prefetch(2000, 2010)
    await flush()
    await flush()
    adapter.insertRows(0, 1)
    // 新行在第 0 行，其余都后移一行；读到的是第 0 页和第 3～5 页，中间的第 1、2 页没读，不在范围里
    expect(adapter.sheets()[0].scanRanges?.()).toEqual([
      [0, REMOTE_PAGE_ROWS + 1],
      [3 * REMOTE_PAGE_ROWS + 1, 3001],
    ])
  })
})

describe('ServerCsvAdapter 编辑与草稿', () => {
  it('8. 改一格：显示新值（带底色）、状态栏有摘要，改回原值草稿清空', async () => {
    const { adapter } = await open()
    const before = adapter.revision()
    expect(adapter.apply([{ row: 2, col: 1, text: '新值' }])).toBe(true)
    expect(adapter.revision()).toBeGreaterThan(before)
    expect(adapter.sheets()[0].cell(2, 1)).toMatchObject({ text: '新值', background: expect.any(String) })
    expect(adapter.dirty()).toBe(true)
    expect(adapter.statusText()).toContain('改了 1 个格子')
    expect(adapter.apply([{ row: 2, col: 1, text: 'r2c1' }])).toBe(true)
    expect(adapter.dirty()).toBe(false)
    expect(adapter.sheets()[0].cell(2, 1)?.background).toBeUndefined()
    // 同值不算改动
    expect(adapter.apply([{ row: 2, col: 1, text: 'r2c1' }])).toBe(false)
  })

  it('9. 还没读进来的行不改（不知道原值），不会把没读到的格子清成空', async () => {
    const { adapter } = await open()
    expect(adapter.apply([{ row: 700, col: 0, text: '' }])).toBe(false)
    expect(adapter.dirty()).toBe(false)
  })

  it('10. 草稿翻成操作列表：行号都指打开时的表，被删行上的格子改动不提交，空白新行不提交', async () => {
    const { adapter } = await open()
    adapter.apply([{ row: 1, col: 0, text: 'A' }, { row: 5, col: 2, text: 'B' }])
    adapter.deleteRows(5, 5)
    adapter.insertRows(3, 2) // 两个空行
    adapter.apply([{ row: 3, col: 1, text: '新行' }]) // 只填了第一个空行
    // 视图：0 1 2 | 新 新 | 3 4 | 6 …（原第 5 行被删，原第 3、4 行被新行顶到第 5、6 行）
    expect([5, 6, 7].map((row) => text(adapter, row))).toEqual(['r3c0', 'r4c0', 'r6c0'])
    const ops = (adapter as unknown as { draft: Parameters<typeof draftToOps>[0] }).draft
    expect(draftToOps(ops)).toEqual([
      { op: 'set_cell', row: 1, col: 0, value: 'A' },
      { op: 'delete_row', row: 5 },
      { op: 'insert_row', at: 3, values: ['', '新行'] },
    ])
  })

  it('11. 撤销 / 重做覆盖改格子、插入、删除；回到原样后不再算脏', async () => {
    const { adapter } = await open()
    adapter.apply([{ row: 0, col: 0, text: 'X' }])
    adapter.insertRows(2, 1)
    adapter.deleteRows(0, 1)
    expect(adapter.sheets()[0].rowCount).toBe(1199)
    expect(adapter.undo()).toBe(true) // 撤销删除
    expect(adapter.sheets()[0].rowCount).toBe(1201)
    expect(adapter.undo()).toBe(true) // 撤销插入
    expect(adapter.sheets()[0].rowCount).toBe(1200)
    expect(adapter.undo()).toBe(true) // 撤销改格子
    expect(text(adapter, 0)).toBe('r0c0')
    expect(adapter.dirty()).toBe(false)
    expect(adapter.undo()).toBe(false)
    expect(adapter.redo()).toBe(true)
    expect(text(adapter, 0)).toBe('X')
    expect(adapter.redo()).toBe(true)
    expect(adapter.redo()).toBe(true)
    expect(adapter.sheets()[0].rowCount).toBe(1199)
    expect(adapter.redo()).toBe(false)
  })

  it('12. 新的编辑清掉重做栈', async () => {
    const { adapter } = await open()
    adapter.apply([{ row: 0, col: 0, text: 'X' }])
    adapter.undo()
    adapter.apply([{ row: 1, col: 0, text: 'Y' }])
    expect(adapter.redo()).toBe(false)
  })

  it('13. 删除行：视图上移，被删的行不再显示；删除新行只是去掉它', async () => {
    const { adapter } = await open()
    expect(adapter.deleteRows(1, 2)).toBe(true)
    expect(text(adapter, 1)).toBe('r3c0')
    expect(adapter.sheets()[0].rowCount).toBe(1198)
    adapter.insertRows(0, 1)
    expect(adapter.deleteRows(0, 0)).toBe(true)
    expect(adapter.sheets()[0].rowCount).toBe(1198)
    expect(adapter.deleteRows(5000, 5001)).toBe(false)
  })

  it('14. 一次提交超过 5000 个操作：拒绝并在状态栏说明', async () => {
    const { adapter } = await open(table(8000, 1))
    expect(adapter.deleteRows(0, REMOTE_MAX_OPS)).toBe(false)
    expect(adapter.statusText()).toContain('最多删除')
    expect(adapter.dirty()).toBe(false)
  })

  it('15. 格子里有 NUL 或超长：拒绝并说明', async () => {
    const { adapter } = await open()
    expect(adapter.apply([{ row: 0, col: 0, text: 'a\0b' }])).toBe(false)
    expect(adapter.statusText()).toContain('NUL')
    expect(adapter.apply([{ row: 0, col: 0, text: 'x'.repeat(40_000) }])).toBe(false)
    expect(adapter.statusText()).toContain('最多')
  })

  it('16. 空表：可以插入第一行，保存提交 insert_row', async () => {
    const { backend, adapter } = await open([])
    expect(adapter.sheets()[0].rowCount).toBe(0)
    expect(adapter.insertRows(0, 1)).toBe(true)
    adapter.apply([{ row: 0, col: 0, text: 'hello' }])
    const result = await adapter.save()
    expect(result.ok).toBe(true)
    expect(backend.edits[0]!.ops).toEqual([{ op: 'insert_row', at: 0, values: ['hello'] }])
    expect(backend.rows).toEqual([['hello']])
  })
})

describe('ServerCsvAdapter 保存', () => {
  it('17. 保存：带打开时的版本和哈希；成功后草稿清空、以新版本为基线、总行数更新', async () => {
    const { backend, adapter } = await open()
    adapter.apply([{ row: 1, col: 0, text: 'A' }])
    adapter.deleteRows(2, 2)
    adapter.insertRows(0, 1)
    adapter.apply([{ row: 0, col: 1, text: 'top' }])
    const result = await adapter.save()
    expect(result).toMatchObject({ ok: true, revision: 2, sha256: 'sha-2', embedded: 1 })
    expect(backend.edits[0]!.expected).toEqual({ version: 1, sha256: 'sha-1' })
    expect(backend.edits[0]!.ops).toEqual([
      { op: 'set_cell', row: 1, col: 0, value: 'A' },
      { op: 'delete_row', row: 2 },
      { op: 'insert_row', at: 0, values: ['', 'top'] },
    ])
    expect(adapter.dirty()).toBe(false)
    expect(adapter.undo()).toBe(false)
    expect(adapter.sheets()[0].rowCount).toBe(1200)
    expect(text(adapter, 0, 1)).toBe('top')
    expect(text(adapter, 2)).toBe('A')
    // 第二次保存用新基线，不会被自己上一次的保存挡住
    adapter.apply([{ row: 3, col: 0, text: 'again' }])
    expect((await adapter.save()).ok).toBe(true)
    expect(backend.edits[1]!.expected).toEqual({ version: 2, sha256: 'sha-2' })
  })

  it('18. 乐观锁冲突：保存被拒，草稿和撤销栈原样保留，仍然是脏的，可以继续改', async () => {
    const { backend, adapter } = await open()
    adapter.apply([{ row: 1, col: 0, text: '我的改动' }])
    backend.version = 5
    backend.sha = 'sha-other'
    const result = await adapter.save()
    expect(result.ok).toBe(false)
    expect(result.conflict?.message).toContain('刚被别人保存')
    expect(adapter.dirty()).toBe(true)
    expect(text(adapter, 1)).toBe('我的改动')
    expect(adapter.undo()).toBe(true)
    expect(adapter.redo()).toBe(true)
    expect(adapter.apply([{ row: 2, col: 0, text: '继续改' }])).toBe(true)
  })

  it('19. 其它失败（网络 / 服务端拒绝）：返回原因，草稿保留', async () => {
    const { backend, adapter } = await open()
    adapter.apply([{ row: 1, col: 0, text: 'x' }])
    backend.edit = async () => {
      throw new Error('文件有 40 MB，超过在线编辑的上限')
    }
    const result = await adapter.save()
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('上限') })
    expect(result.conflict).toBeUndefined()
    expect(adapter.dirty()).toBe(true)
  })

  it('20. 只有没填内容的新行：什么都不提交，直接算成功且不请求服务端', async () => {
    const { backend, adapter } = await open()
    adapter.insertRows(1, 3)
    expect(adapter.dirty()).toBe(false)
    const result = await adapter.save()
    expect(result).toMatchObject({ ok: true, unchanged: true })
    expect(backend.edits).toHaveLength(0)
    expect(adapter.sheets()[0].rowCount).toBe(1200)
  })

  it('21. 保存期间不接受编辑，状态栏显示“保存中”', async () => {
    const { backend, adapter } = await open()
    adapter.apply([{ row: 0, col: 0, text: 'x' }])
    let release: () => void = () => undefined
    const original = backend.edit.bind(backend)
    backend.edit = (ops, expected) => new Promise((resolve) => (release = () => resolve(original(ops, expected))))
    const pending = adapter.save()
    await flush()
    expect(adapter.statusText()).toContain('保存中')
    expect(adapter.apply([{ row: 1, col: 0, text: 'y' }])).toBe(false)
    expect(adapter.deleteRows(0, 0)).toBe(false)
    expect(adapter.undo()).toBe(false)
    release()
    expect((await pending).ok).toBe(true)
    expect(adapter.apply([{ row: 1, col: 0, text: 'y' }])).toBe(true)
  })

  it('22. 保存成功后旧基线上还在路上的取页结果作废', async () => {
    const { backend, adapter } = await open()
    let release: () => void = () => undefined
    backend.gate = new Promise((resolve) => (release = resolve))
    adapter.prefetch(1000, 1010) // 请求挂起
    backend.gate = null
    adapter.apply([{ row: 0, col: 0, text: 'x' }])
    expect((await adapter.save()).ok).toBe(true)
    release()
    await flush()
    // 旧基线（sha-1）发出的请求回来了，但已经作废，不能写进新基线的页缓存
    expect(adapter.readonly()).toBe(false)
  })
})
