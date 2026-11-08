import { describe, expect, it } from 'vitest'
import {
  columnName,
  shiftFormula,
  xlsxCommitEdits,
  xlsxCopyPayload,
  xlsxFillPlan,
  xlsxPlanPaste,
  xlsxTogglePatch,
} from './xlsx-edit'

describe('xlsx-edit 公式与粘贴语义', () => {
  it('相对引用按偏移量平移，$ 锚定的行列不动', () => {
    expect(shiftFormula('=A1', 1, 1)).toBe('=B2')
    expect(shiftFormula('=A1+$B$2', 2, 0)).toBe('=A3+$B$2')
    expect(shiftFormula('=SUM(A1:B2)', 0, 2)).toBe('=SUM(C1:D2)')
    expect(shiftFormula('=$A1+B$2', 3, 3)).toBe('=$A4+E$2')
  })

  it('字符串字面量里的 A1 不被改写', () => {
    expect(shiftFormula('="A1"&A1', 1, 0)).toBe('="A1"&A2')
    expect(shiftFormula('=IF(A1="B2","B2",A1)', 1, 1)).toBe('=IF(B2="B2","B2",B2)')
  })

  it('函数名、跨表引用与移出边界时保持原样', () => {
    expect(shiftFormula('=LOG10(A1)', 1, 1)).toBe('=LOG10(B2)')
    expect(shiftFormula("='Data 1'!A1", 1, 0)).toBe("='Data 1'!A2")
    expect(shiftFormula('=A1', -5, 0)).toBe('=A1')
  })

  it('非公式与零偏移直接返回', () => {
    expect(shiftFormula('hello', 2, 2)).toBe('hello')
    expect(shiftFormula('=SUM(A1:A2)', 0, 0)).toBe('=SUM(A1:A2)')
  })

  it('列号 → 字母（跨 Z 进位）', () => {
    expect(columnName(1)).toBe('A')
    expect(columnName(26)).toBe('Z')
    expect(columnName(27)).toBe('AA')
    expect(columnName(703)).toBe('AAA')
  })
})

describe('xlsx-edit 粘贴计划', () => {
  it('单格复制铺满整个目标选区', () => {
    const plan = xlsxPlanPaste({ text: 'x' }, { top: 1, left: 1, bottom: 2, right: 2 })
    expect(plan.cells).toHaveLength(4)
    expect(plan.cells.every((cell) => cell.input === 'x')).toBe(true)
    expect(plan.cells[3]).toEqual({ row: 2, col: 2, input: 'x' })
  })

  it('多格矩阵从锚点展开，文本公式按原样写入不平移', () => {
    const plan = xlsxPlanPaste(
      { text: '=A1\t2\n3\t4' },
      { top: 5, left: 2, bottom: 5, right: 2 },
    )
    expect(plan.rows).toBe(2)
    expect(plan.cols).toBe(2)
    expect(plan.cells[0]).toEqual({ row: 5, col: 2, input: '=A1' })
    expect(plan.cells[3]).toEqual({ row: 6, col: 3, input: '4' })
  })

  it('空剪贴板不产生写入', () => {
    expect(xlsxPlanPaste({ text: '' }, { top: 0, left: 0, bottom: 0, right: 0 }).cells).toEqual([])
  })

  it('超过上限时截断并明确标记', () => {
    const text = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => '1').join('\t')).join('\n')
    const plan = xlsxPlanPaste({ text }, { top: 0, left: 0, bottom: 0, right: 0 }, 25)
    expect(plan.truncated).toBe(true)
    expect(plan.cells.length).toBeLessThanOrEqual(25)
  })

  it('Ctrl+D 向下填充会平移相对引用，锚定引用不动', () => {
    const cells = xlsxFillPlan({ top: 2, left: 1, bottom: 4, right: 2 }, [['=A1', '=$B$1']], 'down')
    expect(cells).toEqual([
      { row: 3, col: 1, input: '=A2' },
      { row: 3, col: 2, input: '=$B$1' },
      { row: 4, col: 1, input: '=A3' },
      { row: 4, col: 2, input: '=$B$1' },
    ])
  })

  it('Ctrl+R 向右填充按列平移', () => {
    const cells = xlsxFillPlan({ top: 0, left: 0, bottom: 0, right: 2 }, [['=B1']], 'right')
    expect(cells).toEqual([
      { row: 0, col: 1, input: '=C1' },
      { row: 0, col: 2, input: '=D1' },
    ])
  })

  it('目标选区里的合并从属格不会被展开写入', () => {
    // 这里只验证展开规则：起点是选区左上角，不额外写从属格（合并交给引擎判 locked-target）
    const plan = xlsxPlanPaste({ text: 'a\tb' }, { top: 3, left: 4, bottom: 3, right: 4 })
    expect(plan.cells).toEqual([
      { row: 3, col: 4, input: 'a' },
      { row: 3, col: 5, input: 'b' },
    ])
  })
})

describe('xlsx-edit 提交与样式', () => {
  it('普通回车只写活动格，Ctrl+Enter 才填满选区', () => {
    const range = { top: 1, left: 1, bottom: 3, right: 2 }
    expect(xlsxCommitEdits(range, 'v')).toEqual([{ row: 1, col: 1, input: 'v' }])
    expect(xlsxCommitEdits(range, 'v', { fillSelection: true })).toHaveLength(6)
  })

  it('加粗切换是取反，空格式视为未加粗', () => {
    expect(xlsxTogglePatch(null, 'bold')).toEqual({ bold: true })
    expect(xlsxTogglePatch({ bold: true } as never, 'bold')).toEqual({ bold: false })
  })

  it('复制同时产出 TSV 与保留换行的 HTML', () => {
    const payload = xlsxCopyPayload([[{ text: 'a\nb', formula: null }]])
    expect(payload.text).toBe('"a\nb"')
    expect(payload.html).toContain('a<br>b')
  })

  it('合并单元格在 HTML 里合并、TSV 里补齐空格位', () => {
    const payload = xlsxCopyPayload(
      [
        [{ text: 'm', formula: null }, { text: '', formula: null }],
        [{ text: 'x', formula: null }, { text: 'y', formula: null }],
      ],
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }],
    )
    expect(payload.text).toBe('m\t\nx\ty')
    expect(payload.html).toContain('colspan="2"')
    expect(payload.html).not.toContain('<td></td>\n<td>')
  })
})
