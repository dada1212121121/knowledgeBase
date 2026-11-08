/**
 * CSV codec 验收
 *
 * 20 份真实场景语料 + 合成边界。最关键的断言不是「解析出来的值对不对」，
 * 而是「没动过的记录在保存后仍逐字节相同」——这决定 git diff 里只会出现改过的那一格。
 */
import { describe, expect, it } from 'vitest'
import { parseRecords, parseTable } from '@/utils/csvText'
import type { EditorSource } from '../types'
import {
  CSV_MAX_EDIT_ROWS,
  applyCsvChanges,
  applyCsvEdits,
  appendCsvRow,
  csvCell,
  csvColumnCount,
  csvEditable,
  csvField,
  csvRowCount,
  csvToGridSheet,
  deleteCsvRows,
  openCsv,
  parseCsvText,
  serializeCsv,
  csvCodec,
} from './csv'

// Vite 的 ?raw 在构建期把语料打进测试 chunk，不依赖 node:fs（本项目未装 @types/node）
const RAW = import.meta.glob('./fixtures/csv/*', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const CASES = Object.entries(RAW)
  .map(([path, text]) => [path.split('/').pop()!, text] as const)
  .sort(([left], [right]) => left.localeCompare(right))
const CSV_CASES = CASES.filter(([name]) => name.endsWith('.csv'))

const bodyOf = (value: string) => (value.startsWith('\uFEFF') ? value.slice(1) : value)
const delimiterOf = (doc: ReturnType<typeof parseCsvText>) => doc.table.delimiter

describe('CSV 真实语料：未改动逐字节相同', () => {
  it('语料数量：20 份 CSV + 1 份 TSV', () => {
    expect(CSV_CASES).toHaveLength(20)
    expect(CASES).toHaveLength(21)
  })

  it.each(CSV_CASES)('%s 打开→保存不动一个字节', (name, raw) => {
    const doc = parseCsvText(raw, name)
    expect(serializeCsv(doc).text).toBe(raw)
  })

  it.each(CSV_CASES)('%s 改 A1 后其它记录逐字节不变', (name, raw) => {
    const doc = parseCsvText(raw, name)
    if (!csvRowCount(doc)) return
    const next = applyCsvEdits(doc, [{ row: 0, col: 0, text: '新值' }])
    const afterRaw = serializeCsv(next).text
    const beforeBody = bodyOf(raw)
    const afterBody = bodyOf(afterRaw)
    const before = parseRecords(beforeBody, delimiterOf(doc))
    const after = parseRecords(afterBody, delimiterOf(next))
    expect(after).toHaveLength(before.length)
    // 第一条记录允许变（就是改的那格），后面的原始片段必须一字不差
    for (let at = 1; at < before.length; at += 1) {
      expect(afterBody.slice(after[at]!.start, after[at]!.termEnd)).toBe(
        beforeBody.slice(before[at]!.start, before[at]!.termEnd),
      )
    }
    expect(csvCell(next, 0, 0)).toBe('新值')
  })
})

describe('CSV 边界与风格保持', () => {
  it('BOM：编辑后仍然只有开头一个 BOM', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/05-bom.csv']!)
    expect(doc.bom).toBe(true)
    expect(serializeCsv(doc).text.startsWith('\uFEFF')).toBe(true)
    const next = applyCsvEdits(doc, [{ row: 0, col: 0, text: '姓名' }])
    const out = serializeCsv(next).text
    expect(out.startsWith('\uFEFF')).toBe(true)
    expect(out.slice(1).startsWith('\uFEFF')).toBe(false)
  })

  it('CRLF：改一格后仍全部用 CRLF，行尾风格不变', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/04-crlf.csv']!)
    const out = serializeCsv(applyCsvEdits(doc, [{ row: 2, col: 2, text: '99' }])).text
    expect(out).toContain('\r\n')
    expect(/(?<!\r)\n/.test(out)).toBe(false)
    expect(out).toContain('B-200,扳手,99\r\n')
  })

  it('CR only：保留 \\r 行尾，不悄悄升级成 CRLF', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/12-cr-only.csv']!)
    expect(doc.table.newline).toBe('\r')
    const out = serializeCsv(applyCsvEdits(doc, [{ row: 0, col: 0, text: 'XX' }])).text
    expect(out.startsWith('XX,y\r')).toBe(true)
    expect(out).not.toContain('\r\n')
  })

  it('引号内逗号与换行：只当数据，不当分隔/换行', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/03-quoted-newline.csv']!)
    expect(csvRowCount(doc)).toBe(3)
    expect(csvCell(doc, 1, 1)).toBe('第一行\n第二行')
    expect(csvCell(doc, 1, 2)).toBe('open')
  })

  it('引号转义："" → 一个引号，改另一格不会破坏它', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/10-quotes.csv']!)
    expect(csvCell(doc, 1, 2)).toBe('他说："你好"')
    const out = serializeCsv(applyCsvEdits(doc, [{ row: 1, col: 0, text: '标题' }])).text
    expect(out).toContain('"他说：""你好"""')
  })

  it('分号嗅探', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/06-semicolon.csv']!)
    expect(doc.table.delimiter).toBe(';')
    expect(csvCell(doc, 2, 1)).toBe('3.20')
  })

  it('竖线嗅探', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/07-pipe.csv']!)
    expect(doc.table.delimiter).toBe('|')
    expect(csvCell(doc, 1, 1)).toBe('启用')
  })

  it('.tsv 扩展名强制制表符，不靠猜', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/21-tsv.tsv']!, '通讯录.tsv')
    expect(doc.table.delimiter).toBe('\t')
    expect(csvRowCount(doc)).toBe(3)
    expect(csvCell(doc, 1, 1)).toBe('13800000000')
  })

  it('空行不占行号；编辑第 2 条记录仍命中春节那行', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/08-blank-lines.csv']!)
    expect(csvRowCount(doc)).toBe(3)
    expect(csvCell(doc, 2, 1)).toBe('春节')
    const next = applyCsvEdits(doc, [{ row: 2, col: 1, text: '春节假期' }])
    expect(csvCell(next, 2, 1)).toBe('春节假期')
    // 空行原样保留
    expect(serializeCsv(next).text).toContain('元旦\n\n')
  })

  it('列数不齐：往短行补列时补分隔符，不补多余引号', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/09-ragged.csv']!)
    expect(csvColumnCount(doc)).toBe(4)
    const next = applyCsvEdits(doc, [{ row: 0, col: 2, text: '补' }])
    expect(serializeCsv(next).text.startsWith('a,b,补\n')).toBe(true)
  })

  it('多格一次编辑：从后往前打补丁，下标不漂移', () => {
    const doc = parseCsvText('a,b,c\n1,2,3\n4,5,6\n')
    const next = applyCsvEdits(doc, [
      { row: 0, col: 1, text: 'BB' },
      { row: 1, col: 2, text: 'CC' },
    ])
    expect(serializeCsv(next).text).toBe('a,BB,c\n1,2,CC\n4,5,6\n')
  })

  it('同一格连改多次以最后一次为准', () => {
    const doc = parseCsvText('a,b\n1,2\n')
    const next = applyCsvEdits(doc, [
      { row: 0, col: 0, text: 'first' },
      { row: 0, col: 0, text: 'last' },
    ])
    expect(serializeCsv(next).text).toBe('last,b\n1,2\n')
  })

  it('值没变返回同一个对象（适配器据此不置脏）', () => {
    const doc = parseCsvText('a,b\n1,2\n')
    expect(applyCsvEdits(doc, [{ row: 0, col: 0, text: 'a' }])).toBe(doc)
    expect(applyCsvEdits(doc, [])).toBe(doc)
  })

  it('坐标 / NUL 校验：坏输入明确抛错，不写出损坏文件', () => {
    const doc = parseCsvText('a,b\n1,2\n')
    expect(() => applyCsvEdits(doc, [{ row: 9, col: 0, text: 'x' }])).toThrow('第 10 行不存在')
    expect(() => applyCsvEdits(doc, [{ row: 0, col: 0, text: 'a\0b' }])).toThrow('NUL')
  })

  it('含分隔符/引号的新值只在必要时加引号并正确转义', () => {
    const doc = parseCsvText('a,b\n1,2\n')
    const next = applyCsvEdits(doc, [{ row: 0, col: 1, text: 'x,y"z' }])
    expect(serializeCsv(next).text).toBe('a,"x,y""z"\n1,2\n')
    expect(csvField('x,y', doc)).toBe('"x,y"')
  })

  it('末尾追加行：沿用 CRLF，且原文件没有末尾换行时不凭空补空行', () => {
    const doc = parseCsvText('a,b\r\n1,2', 'x.csv')
    const next = appendCsvRow(doc, ['3', '4'])
    expect(serializeCsv(next).text).toBe('a,b\r\n1,2\r\n3,4')
  })

  it('末尾追加行：原文件以换行结尾时新行也以换行结尾', () => {
    const doc = parseCsvText('a,b\n1,2\n', 'x.csv')
    expect(serializeCsv(appendCsvRow(doc, ['3', '4'])).text).toBe('a,b\n1,2\n3,4\n')
  })

  it('20 万行以上只读，边界本身仍可编辑', () => {
    const atLimit = parseCsvText(`h\n${'x\n'.repeat(CSV_MAX_EDIT_ROWS)}`)
    expect(csvRowCount(atLimit)).toBe(CSV_MAX_EDIT_ROWS + 1)
    expect(csvEditable(atLimit)).toBe(false)
    const below = parseCsvText(`h\n${'x\n'.repeat(CSV_MAX_EDIT_ROWS - 2)}`)
    expect(csvEditable(below)).toBe(true)
  })

  it('空文件：0 行、至少 1 列，打开保存仍是空字符串', () => {
    const doc = parseCsvText('')
    expect(csvRowCount(doc)).toBe(0)
    expect(csvColumnCount(doc)).toBe(1)
    expect(serializeCsv(doc).text).toBe('')
  })

  it('网格适配：行列数、单元格与列宽', () => {
    const doc = parseCsvText(RAW['./fixtures/csv/20-orders.csv']!)
    const sheet = csvToGridSheet(doc)
    expect(sheet.rowCount).toBe(csvRowCount(doc))
    expect(sheet.colCount).toBe(6)
    expect(sheet.cell(0, 1)?.text).toBe('customer')
    expect(sheet.cell(9999, 0)).toBeNull()
    expect(sheet.columnWidth?.(0)).toBeGreaterThan(60)
  })

  it('codec 形状：open 读文本源，save 回写同名文本源', async () => {
    const source: EditorSource = { kind: 'text', text: 'a,b\r\n1,2\r\n', name: 'a.csv' }
    const doc = await csvCodec.open(source)
    expect(doc.kind).toBe('grid')
    const payload = doc.payload as ReturnType<typeof parseCsvText>
    expect(csvCell(payload, 0, 0)).toBe('a')
    const saved = await csvCodec.save(doc, source)
    expect(saved.kind).toBe('text')
    if (saved.kind !== 'text') throw new Error('CSV 必须保存为文本源')
    expect(saved.text).toBe('a,b\r\n1,2\r\n')
    expect(saved.name).toBe('a.csv')
  })

  it('codec 也能从 bytes 源解码，不静默读成空文件', async () => {
    const source: EditorSource = { kind: 'bytes', bytes: new TextEncoder().encode('姓名,年龄\n张三,30\n'), name: 'x.csv' }
    const doc = openCsv(source)
    expect(csvCell(doc, 1, 1)).toBe('30')
  })

  it('分隔符嗅探只在前 20 条非空记录里投票，空表默认逗号', () => {
    const doc = parseCsvText('')
    expect(doc.table.delimiter).toBe(',')
    expect(parseTable('a;b\n1;2', false).delimiter).toBe(';')
  })
})

/**
 * 行操作：插入 / 删除若干行，和服务端 csv_edit 同一套规则。
 * 关键是「没碰的字节不动」和「文件末尾有没有换行」这个习惯在删行后保持不变。
 */
describe('行操作：删除若干行', () => {
  const del = (raw: string, rows: number[]) => serializeCsv(deleteCsvRows(parseCsvText(raw, 'a.csv'), rows)).text

  it('删中间一行：连行尾一起删，其余字节不动', () => {
    expect(del('a,b\n1,2\n3,4\n5,6\n', [1])).toBe('a,b\n3,4\n5,6\n')
    expect(del('\uFEFFa,b\r\n1,2\r\n3,4\r\n', [1])).toBe('\uFEFFa,b\r\n3,4\r\n')
  })

  it('删连续的几行与不连续的几行', () => {
    expect(del('a\n1\n2\n3\n4\n5\n', [1, 2, 3])).toBe('a\n4\n5\n')
    expect(del('a\n1\n2\n3\n4\n5\n', [5, 1, 3])).toBe('a\n2\n4\n')
  })

  it('末尾没有换行：删最后一行连它前面的换行一起删，结尾仍然没有换行', () => {
    expect(del('a,b\n1,2\n3,4', [2])).toBe('a,b\n1,2')
    expect(del('a,b\n1,2\n3,4\n5,6', [2, 3])).toBe('a,b\n1,2')
    expect(del('a,b\r\n1,2\r\n3,4', [1, 2])).toBe('a,b')
  })

  it('全部删光得到空文件', () => {
    expect(del('a,b\n1,2\n', [0, 1])).toBe('')
    expect(del('a,b\n1,2', [0, 1])).toBe('')
  })

  it('引号里带换行的记录整条删除', () => {
    expect(del('a,b\n"x\ny",2\n3,4\n', [1])).toBe('a,b\n3,4\n')
  })

  it('重复的行号只删一次，越界报错', () => {
    expect(del('a\n1\n2\n', [1, 1])).toBe('a\n2\n')
    expect(() => deleteCsvRows(parseCsvText('a\n1\n', 'a.csv'), [5])).toThrow(/不存在/)
  })

  it('空行号列表不改文档（引用相等）', () => {
    const doc = parseCsvText('a\n1\n', 'a.csv')
    expect(deleteCsvRows(doc, [])).toBe(doc)
  })

  it('随机删除组合：结果与「删完再重新解析」的行数、剩余行内容一致', () => {
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 120; round += 1) {
      const count = 1 + random(8)
      const newline = ['\n', '\r\n'][random(2)]!
      const rows = Array.from({ length: count }, (_, index) => `r${index},${index}`)
      const raw = rows.join(newline) + (random(2) ? newline : '')
      const picked = [...new Set(Array.from({ length: random(count + 1) }, () => random(count)))]
      const doc = parseCsvText(raw, 'a.csv')
      const next = deleteCsvRows(doc, picked)
      const survivors = rows.filter((_, index) => !picked.includes(index))
      expect(next.table.rows.length).toBe(survivors.length)
      survivors.forEach((line, index) => expect(csvCell(next, index, 0)).toBe(line.split(',')[0]))
      // 结尾换行习惯：原来有就有，原来没有就没有（全删光除外）
      const text = serializeCsv(next).text
      if (survivors.length) expect(text.endsWith(newline)).toBe(raw.endsWith(newline))
    }
  })
})

describe('行操作：写入新行', () => {
  const put = (raw: string, inserts: Array<{ at: number; values: string[] }>, edits: Array<{ row: number; col: number; text: string }> = []) =>
    serializeCsv(applyCsvChanges(parseCsvText(raw, 'a.csv'), edits, inserts.map((item, seq) => ({ ...item, seq })))).text

  it('插在某行之前，沿用原文行尾', () => {
    expect(put('a,b\r\n1,2\r\n', [{ at: 1, values: ['x', 'y'] }])).toBe('a,b\r\nx,y\r\n1,2\r\n')
  })

  it('加在最后：末尾有换行就接在后面，没有就先补换行', () => {
    expect(put('a,b\n1,2\n', [{ at: 2, values: ['x', 'y'] }])).toBe('a,b\n1,2\nx,y\n')
    expect(put('a,b\n1,2', [{ at: 2, values: ['x', 'y'] }])).toBe('a,b\n1,2\nx,y')
  })

  it('同一位置多条新行：seq 小的排在上面', () => {
    expect(put('a\n1\n', [{ at: 1, values: ['p'] }, { at: 1, values: ['q'] }])).toBe('a\np\nq\n1\n')
    expect(put('a\n1', [{ at: 2, values: ['p'] }, { at: 2, values: ['q'] }])).toBe('a\n1\np\nq')
  })

  it('新行与格子改动同时落：插入点正好是被改行的开头 / 行尾', () => {
    expect(put('a,b\n1,2\n', [{ at: 1, values: ['x'] }], [{ row: 1, col: 0, text: 'one' }])).toBe('a,b\nx\none,2\n')
    // 末行没有换行：给末行补列，同时在它后面加新行
    expect(put('a,b\n1,2', [{ at: 2, values: ['x'] }], [{ row: 1, col: 3, text: 'z' }])).toBe('a,b\n1,2,,z\nx')
  })

  it('值里有分隔符 / 引号 / 换行时自动加引号；NUL 报错', () => {
    expect(put('a,b\n', [{ at: 1, values: ['x,y', 'say "hi"'] }])).toBe('a,b\n"x,y","say ""hi"""\n')
    expect(() => put('a,b\n', [{ at: 1, values: ['\0'] }])).toThrow(/NUL/)
  })

  it('位置越界报错；没有任何变化返回原文档', () => {
    const doc = parseCsvText('a\n1\n', 'a.csv')
    expect(() => applyCsvChanges(doc, [], [{ at: 9, values: ['x'], seq: 0 }])).toThrow()
    expect(applyCsvChanges(doc, [], [])).toBe(doc)
  })
})
