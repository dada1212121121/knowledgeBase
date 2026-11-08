// 用例照搬 crates/kb-extract/src/csv_edit.rs 的单测(单人表格编辑的服务端实现):两边对同一份文字做同一个改动,结果必须一样。
import { describe, expect, it } from 'vitest'
import {
  applySplice,
  cellValue,
  deleteRowSplice,
  detectDelimiter,
  insertRowSplice,
  parseTable,
  setCellSplice,
} from './csvText'

const set = (text: string, row: number, col: number, value: string, tsv = false) => {
  const splice = setCellSplice(parseTable(text, tsv), row, col, value)
  return splice ? applySplice(text, splice) : text
}
const del = (text: string, row: number) => applySplice(text, deleteRowSplice(parseTable(text, false), row))
const ins = (text: string, at: number, values: string[]) => applySplice(text, insertRowSplice(parseTable(text, false), at, values))
/** 连续做几步(每一步都在上一步的结果上重新解析:协同里每次改动都是独立的一笔) */
const steps = (text: string, ...fns: Array<(text: string) => string>) => fns.reduce((acc, fn) => fn(acc), text)

describe('csvText(和服务端 csv_edit 一致)', () => {
  it('改一个格子只动那个格子;原来带引号的仍带引号,没有的必要时才加', () => {
    const original = 'id,name,note\r\n1,apple,"red, sweet"\r\n2,pear,green\r\n'
    expect(set(original, 1, 1, 'APPLE')).toBe('id,name,note\r\n1,APPLE,"red, sweet"\r\n2,pear,green\r\n')
    expect(set(original, 1, 2, 'plain')).toBe('id,name,note\r\n1,apple,"plain"\r\n2,pear,green\r\n')
    expect(steps(original, (t) => set(t, 2, 2, 'a,b'), (t) => set(t, 2, 1, 'say "hi"'))).toBe(
      'id,name,note\r\n1,apple,"red, sweet"\r\n2,"say ""hi""","a,b"\r\n',
    )
    expect(set(original, 2, 2, 'two\nlines').endsWith('2,pear,"two\nlines"\r\n')).toBe(true)
    // 值没变:不产生替换
    expect(setCellSplice(parseTable(original, false), 1, 1, 'apple')).toBeNull()
  })

  it('分隔符、行尾都保持;CR 文件里新插的行也用 CR', () => {
    expect(set('名称;数量\r\n苹果;3', 1, 1, '30')).toBe('名称;数量\r\n苹果;30')
    expect(set('a\tb\n1\t2\n', 1, 0, 'x\ty', true)).toBe('a\tb\n"x\ty"\t2\n')
    expect(ins('a,b\r1,2\r', 2, ['3', '4'])).toBe('a,b\r1,2\r3,4\r')
  })

  it('分隔符按内容判断,tsv 按扩展名', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';')
    expect(detectDelimiter('a|b|c\n1|2|3\n')).toBe('|')
    expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t')
    expect(detectDelimiter('a,b,c\n1,2,3\n')).toBe(',')
    expect(detectDelimiter('just\nwords\n')).toBe(',')
    expect(detectDelimiter('"a,1";b\n"c,2";d\n')).toBe(';')
    expect(parseTable('a,b\n1,2\n', true).delimiter).toBe('\t')
  })

  it('全空白的行不占行号,但它们的字节原样留着', () => {
    const original = 'a,b\n\n1,2\n   ,  \n3,4\n'
    const table = parseTable(original, false)
    expect(table.rows.length).toBe(3)
    expect([0, 1, 2].map((row) => [cellValue(table, row, 0), cellValue(table, row, 1)])).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
    expect(set(original, 2, 0, 'X')).toBe('a,b\n\n1,2\n   ,  \nX,4\n')
  })

  it('超出这一行的列:补空格子', () => {
    expect(set('a,b\n1,2\n', 1, 4, 'far')).toBe('a,b\n1,2,,,far\n')
    expect(set('a,b\n1,2', 0, 2, 'c')).toBe('a,b,c\n1,2')
    expect(steps('a\n1\n', (t) => set(t, 1, 1, 'x'), (t) => set(t, 1, 3, 'y'))).toBe('a\n1,x,,y\n')
  })

  it('插行删行保持文件结尾的样子', () => {
    expect(ins('a,b\r\n1,2\r\n', 1, ['x', 'y,z'])).toBe('a,b\r\nx,"y,z"\r\n1,2\r\n')
    expect(ins('a,b\n1,2\n', 0, ['h', 'i'])).toBe('h,i\na,b\n1,2\n')
    expect(ins('a,b\n1,2\n', 2, ['3', '4'])).toBe('a,b\n1,2\n3,4\n')
    expect(ins('a,b\n1,2', 2, ['3', '4'])).toBe('a,b\n1,2\n3,4')
    expect(ins('', 0, ['a', 'b'])).toBe('a,b\n')
    expect(del('a\nb\nc\n', 1)).toBe('a\nc\n')
    expect(del('a\nb\nc\n', 2)).toBe('a\nb\n')
    expect(del('a\nb\nc', 2)).toBe('a\nb')
    expect(steps('a\nb\nc', (t) => del(t, 2), (t) => del(t, 1))).toBe('a')
    expect(steps('a\nb\nc\n', (t) => del(t, 2), (t) => del(t, 1), (t) => del(t, 0))).toBe('')
  })

  it('奇怪的引号写法:格子外面一个字都不动', () => {
    const original = '"a"x, b ,"""q""",,tail\n'
    expect(set(original, 0, 3, 'mid')).toBe('"a"x, b ,"""q""",mid,tail\n')
    const table = parseTable(original, false)
    expect([0, 1, 2, 3, 4].map((col) => cellValue(table, 0, col))).toEqual(['ax', ' b ', '"q"', '', 'tail'])
  })

  it('不存在的行、NUL 字符:拒绝', () => {
    expect(() => setCellSplice(parseTable('a\n', false), 5, 0, 'x')).toThrow(/不存在/)
    expect(() => setCellSplice(parseTable('a\n', false), 0, 0, 'x\0')).toThrow(/NUL/)
    expect(() => deleteRowSplice(parseTable('a\n', false), 3)).toThrow(/不存在/)
  })

  it('下标是 JS 字符串下标(和 Y.Text 一致):中文、emoji 前后都对', () => {
    const original = '名称,备注\n😀苹果,甜\n'
    expect(set(original, 1, 1, '很甜')).toBe('名称,备注\n😀苹果,很甜\n')
  })
})

// ---------------- ：紧凑解析器、增量更新与参考实现逐条一致 ----------------
import { applySplicesToTable, applySpliceToTable, parseRecords, rowFieldCount, type CsvTable } from './csvText'

const CORPUS = import.meta.glob('../editor/codecs/fixtures/csv/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** 表的完整结构(位置、引号、值、行号、列数、换行),用来逐项比较 */
function signature(table: CsvTable) {
  const records = []
  for (let r = 0; r < table.recordCount; r += 1) {
    const fields = []
    for (let f = table.recField[r]; f < table.recField[r + 1]; f += 1) fields.push([table.fieldStart[f], table.fieldEnd[f], table.fieldQuoted[f]])
    records.push([table.recStart[r], table.recEnd[r], table.recTermEnd[r], fields])
  }
  const values = Array.from(table.rows, (_, row) => Array.from({ length: rowFieldCount(table, row) }, (_, col) => cellValue(table, row, col)))
  return { delimiter: table.delimiter, newline: table.newline, rows: Array.from(table.rows), columns: table.columns, records, values }
}

/** 参考实现(对象版)给出的同一份结构 */
function reference(text: string, delimiter: string) {
  const records = parseRecords(text, delimiter)
  const rows: number[] = []
  records.forEach((record, index) => {
    if (!record.fields.every((field) => field.value.trim() === '')) rows.push(index)
  })
  return {
    records: records.map((record) => [record.start, record.end, record.termEnd, record.fields.map((field) => [field.start, field.end, field.quoted ? 1 : 0])]),
    rows,
    values: rows.map((index) => records[index]!.fields.map((field) => field.value)),
  }
}

/** 固定种子的伪随机数,失败可复现 */
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
const PIECES = ['a', '中', ' ', ',', ';', '\t', '"', '""', '\n', '\r\n', '\r', 'x"y', '  ', '\u3000', '|']
function randomText(next: () => number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += PIECES[Math.floor(next() * PIECES.length)]
  return out
}

describe('紧凑解析器', () => {
  it('仓库 CSV 语料:位置、引号、值、行号与参考实现逐条一致', () => {
    for (const [name, text] of Object.entries(CORPUS)) {
      const body = text.replace(/^\uFEFF/, '')
      const table = parseTable(body, name.endsWith('.tsv'))
      const mine = signature(table)
      const ref = reference(body, table.delimiter)
      expect({ records: mine.records, rows: mine.rows, values: mine.values }, name).toEqual(ref)
    }
  })

  it('随机文字(引号 / 分隔符 / 三种换行 / 空白行混排)500 份与参考实现一致', () => {
    const next = rng(20261104)
    for (let round = 0; round < 500; round += 1) {
      const text = randomText(next, 1 + Math.floor(next() * 60))
      const table = parseTable(text, false)
      const mine = signature(table)
      const ref = reference(text, table.delimiter)
      expect({ records: mine.records, rows: mine.rows, values: mine.values }, JSON.stringify(text)).toEqual(ref)
    }
  })

  it('分隔符嗅探只看开头:第 21 条之后的内容不影响结果', () => {
    const head = Array.from({ length: 25 }, (_, i) => `a${i};b;c`).join('\n')
    expect(detectDelimiter(`${head}\n${'x,y,z,w\n'.repeat(1000)}`)).toBe(';')
  })
})

describe('增量更新(applySpliceToTable,)', () => {
  it('随机改格子(值里带引号 / 分隔符 / 换行 / 空串)2000 次,每一步都与整份重解析相同', () => {
    const next = rng(42)
    const values = ['', '新值', '含,逗号', '含"引号', '换\n行', ' ', 'a;b', '\t', '"']
    for (let round = 0; round < 40; round += 1) {
      let table = parseTable(randomText(next, 20 + Math.floor(next() * 80)), false)
      for (let step = 0; step < 50 && table.rows.length; step += 1) {
        const row = Math.floor(next() * table.rows.length)
        const col = Math.floor(next() * (table.columns + 2))
        const splice = setCellSplice(table, row, col, values[Math.floor(next() * values.length)]!)
        if (!splice) continue
        const incremental = applySpliceToTable(table, splice, false)
        const full = parseTable(applySplice(table.text, splice), false)
        expect(signature(incremental), JSON.stringify(table.text)).toEqual(signature(full))
        table = incremental
      }
    }
  })

  it('任意文字替换(协同里别人在源码里乱改)1000 次也与整份重解析相同', () => {
    const next = rng(7)
    for (let round = 0; round < 1000; round += 1) {
      const table = parseTable(randomText(next, 10 + Math.floor(next() * 50)), false)
      const index = Math.floor(next() * (table.text.length + 1))
      const remove = Math.floor(next() * Math.min(4, table.text.length - index + 1))
      const splice = { index, remove, insert: randomText(next, Math.floor(next() * 3)) }
      expect(signature(applySpliceToTable(table, splice, false)), JSON.stringify([table.text, splice])).toEqual(
        signature(parseTable(applySplice(table.text, splice), false)),
      )
    }
  })

  it('旧表不被改动(撤销栈还拿着它);一批替换与逐笔替换结果相同', () => {
    const table = parseTable('a,b\n1,2\n3,4\n', false)
    const before = signature(table)
    const splices = [setCellSplice(table, 2, 1, '四')!, setCellSplice(table, 1, 0, '一')!].sort((x, y) => y.index - x.index)
    const batched = applySplicesToTable(table, splices, false)
    expect(signature(table)).toEqual(before)
    expect([cellValue(batched, 1, 0), cellValue(batched, 2, 1)]).toEqual(['一', '四'])
    expect(batched.text).toBe('a,b\n一,2\n3,四\n')
  })

  it('引号没闭合会吞掉后面的行:增量更新必须看出来并整份重解析', () => {
    const table = parseTable('a,b\n1,2\n3,4\n', false)
    // 在第 1 行开头插一个引号(源码编辑器里手滑)
    const splice = { index: table.recStart[1]!, remove: 1, insert: '"1' }
    const result = applySpliceToTable(table, splice, false)
    expect(signature(result)).toEqual(signature(parseTable(applySplice(table.text, splice), false)))
    expect(result.rows.length).toBe(2)
  })
})
