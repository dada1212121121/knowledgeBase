/**
 * Word 编辑命令矩阵：每条 `docx.*` 命令 × 期望的引擎意图（通道、种类、载荷）。
 * 命令表是纯函数，这里不起引擎；真实引擎上的"命令真的改了文档"由 e2e 的 docx-commands 场景验证。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_BORDER_PEN, DOCX_COMMAND_TYPES, isDocxCommandType, normalizeHex, planDocxCommand } from './intents'

const plan = (type: Parameters<typeof planDocxCommand>[0], args?: unknown) => planDocxCommand(type, args as never)

describe('文本标记', () => {
  it.each([
    ['docx.bold', 'bold'],
    ['docx.italic', 'italic'],
    ['docx.underline', 'underline'],
    ['docx.superscript', 'superscript'],
    ['docx.subscript', 'subscript'],
  ] as const)('%s → 格式通道 toggleMark(%s)', (type, mark) => {
    expect(plan(type)).toEqual({ channel: 'format', intent: { kind: 'toggleMark', payload: { mark: { type: mark } } } })
  })

  it('删除线用专门的 toggleStrike（支持单 / 双删除线的切换逻辑在引擎里）', () => {
    expect(plan('docx.strike')).toEqual({ channel: 'format', intent: { kind: 'toggleStrike', payload: {} } })
  })

  it('清除格式', () => {
    expect(plan('docx.clearFormat')).toEqual({ channel: 'format', intent: { kind: 'clearFormatting', payload: {} } })
  })
})

describe('字体 / 字号 / 颜色 / 高亮', () => {
  it('字体族同时写 ascii 与 hAnsi（中文字体名写在 eastAsia 之外也要让西文用它）', () => {
    expect(plan('docx.fontFamily', { family: ' 宋体 ' })).toEqual({
      channel: 'format',
      intent: { kind: 'formatRange', payload: { delta: { fontFamily: { ascii: '宋体', hAnsi: '宋体' } } } },
    })
  })

  it('空字体名被拒绝', () => {
    expect(plan('docx.fontFamily', { family: '  ' })).toBeNull()
  })

  it.each([10.5, 12, 72, 1, 400])('字号 %s 磅合法', (points) => {
    expect(plan('docx.fontSize', { points })).toMatchObject({ intent: { kind: 'formatRange', payload: { delta: { fontSize: points } } } })
  })

  it.each([0, -3, 401, 10.3, Number.NaN, Infinity])('字号 %s 非法（OOXML 半磅粒度、1~400）', (points) => {
    expect(plan('docx.fontSize', { points })).toBeNull()
  })

  it('文字颜色规整成 6 位大写 hex，同时写 color 与 textColor（Word 的主题色回退依赖后者）', () => {
    expect(plan('docx.textColor', { color: '#ff0000' })).toMatchObject({
      intent: { kind: 'formatRange', payload: { delta: { color: { rgb: 'FF0000' }, other: { textColor: { rgb: 'FF0000' } } } } },
    })
    expect(plan('docx.textColor', { color: 'f00' })).toMatchObject({ intent: { payload: { delta: { color: { rgb: 'FF0000' } } } } })
  })

  it('文字颜色 null = 清除；不合法的颜色被拒绝而不是悄悄变黑', () => {
    expect(plan('docx.textColor', { color: null })).toMatchObject({ intent: { payload: { delta: { color: null } } } })
    expect(plan('docx.textColor', { color: 'red!' })).toBeNull()
  })

  it('高亮：命名色原样给引擎，null / none = 取消高亮', () => {
    expect(plan('docx.highlight', { color: 'yellow' })).toMatchObject({ intent: { payload: { delta: { highlight: 'yellow' } } } })
    expect(plan('docx.highlight', { color: 'none' })).toMatchObject({ intent: { payload: { delta: { highlight: null } } } })
    expect(plan('docx.highlight', { color: null })).toMatchObject({ intent: { payload: { delta: { highlight: null } } } })
  })
})

describe('段落', () => {
  it.each(['left', 'center', 'right', 'both'])('对齐 %s', (value) => {
    expect(plan('docx.align', { value })).toEqual({ channel: 'format', intent: { kind: 'setParagraphAttrs', payload: { attrs: { alignment: value } } } })
  })

  it('不认识的对齐被拒绝', () => {
    expect(plan('docx.align', { value: 'justify' })).toBeNull()
  })

  it('行距按 auto 规则写（240 = 单倍）；越界拒绝', () => {
    expect(plan('docx.lineSpacing', { value: 360 })).toMatchObject({ intent: { payload: { attrs: { lineSpacing: 360, lineSpacingRule: 'auto' } } } })
    expect(plan('docx.lineSpacing', { value: 10 })).toBeNull()
    expect(plan('docx.lineSpacing', { value: 99999 })).toBeNull()
  })

  it('列表：项目符号 / 编号；缩进增减', () => {
    expect(plan('docx.list', { kind: 'bullet' })).toEqual({ channel: 'format', intent: { kind: 'toggleList', payload: { kind: 'bullet' } } })
    expect(plan('docx.list', { kind: 'numbered' })).toEqual({ channel: 'format', intent: { kind: 'toggleList', payload: { kind: 'numbered' } } })
    expect(plan('docx.indent', { direction: 'increase' })).toEqual({ channel: 'format', intent: { kind: 'changeIndent', payload: { direction: 'increase' } } })
    expect(plan('docx.indent', { direction: 'decrease' })).toEqual({ channel: 'format', intent: { kind: 'changeIndent', payload: { direction: 'decrease' } } })
  })

  it('段落样式；空样式 id 拒绝', () => {
    expect(plan('docx.style', { styleId: 'Heading1' })).toEqual({ channel: 'format', intent: { kind: 'applyParagraphStyle', payload: { styleId: 'Heading1' } } })
    expect(plan('docx.style', { styleId: '' })).toBeNull()
  })

  it('文字方向', () => {
    expect(plan('docx.rtl')).toMatchObject({ intent: { payload: { attrs: { bidi: true } } } })
    expect(plan('docx.ltr')).toMatchObject({ intent: { payload: { attrs: { bidi: false } } } })
  })
})

describe('表格', () => {
  it('插入表格走提交通道；行列数必须是 1..100 / 1..63 的整数', () => {
    expect(plan('docx.table.insert', { rows: 3, columns: 4 })).toEqual({ channel: 'submit', intent: { kind: 'insertTable', payload: { rows: 3, columns: 4 } } })
    for (const bad of [{ rows: 0, columns: 2 }, { rows: 2, columns: 0 }, { rows: 101, columns: 2 }, { rows: 2, columns: 64 }, { rows: 1.5, columns: 2 }]) {
      expect(plan('docx.table.insert', bad)).toBeNull()
    }
  })

  it('插入 / 删除 行列、删表、合并', () => {
    expect(plan('docx.table.row', { side: 'above' })).toEqual({ channel: 'submit', intent: { kind: 'insertTableRow', payload: { side: 'above' } } })
    expect(plan('docx.table.row', { side: 'below' })).toMatchObject({ intent: { payload: { side: 'below' } } })
    expect(plan('docx.table.column', { side: 'left' })).toMatchObject({ intent: { kind: 'insertTableColumn', payload: { side: 'left' } } })
    expect(plan('docx.table.column', { side: 'right' })).toMatchObject({ intent: { payload: { side: 'right' } } })
    expect(plan('docx.table.deleteRow')).toMatchObject({ intent: { kind: 'deleteTableRow' } })
    expect(plan('docx.table.deleteColumn')).toMatchObject({ intent: { kind: 'deleteTableColumn' } })
    expect(plan('docx.table.delete')).toMatchObject({ intent: { kind: 'deleteTable' } })
    expect(plan('docx.table.merge')).toMatchObject({ intent: { kind: 'mergeTableCells' } })
  })

  it('拆分单元格需要正整数行列', () => {
    expect(plan('docx.table.split', { rows: 2, columns: 2 })).toMatchObject({ intent: { kind: 'splitTableCell', payload: { rows: 2, columns: 2 } } })
    expect(plan('docx.table.split', { rows: 0, columns: 2 })).toBeNull()
  })

  it('底纹：hex 规整；null 清除；非法拒绝', () => {
    expect(plan('docx.table.shading', { color: '#ffeeaa' })).toMatchObject({ intent: { kind: 'setTableCellShading', payload: { color: 'FFEEAA' } } })
    expect(plan('docx.table.shading', { color: null })).toMatchObject({ intent: { payload: { color: null } } })
    expect(plan('docx.table.shading', { color: 'xyz' })).toBeNull()
  })

  it('边框预设：all 六条边全有笔；none 全是 none；outside 只有四周；inside 只有内线；单边只有那一条', () => {
    const borders = (preset: string) => (plan('docx.table.borders', { preset }) as { intent: { payload: { borders: Record<string, unknown> } } }).intent.payload.borders
    expect(Object.keys(borders('all')).sort()).toEqual(['bottom', 'insideH', 'insideV', 'left', 'right', 'top'])
    expect(borders('all').top).toEqual(DEFAULT_BORDER_PEN)
    expect(Object.keys(borders('outside')).sort()).toEqual(['bottom', 'left', 'right', 'top'])
    expect(Object.keys(borders('inside')).sort()).toEqual(['insideH', 'insideV'])
    expect(Object.keys(borders('top'))).toEqual(['top'])
    expect(Object.values(borders('none')).every((pen) => (pen as { style: string }).style === 'none')).toBe(true)
    expect(plan('docx.table.borders', { preset: 'diagonal' })).toBeNull()
  })

  it('自定义笔宽 / 颜色传进边框', () => {
    const pen = { style: 'single', size: 12, color: { rgb: 'FF0000' } }
    const result = plan('docx.table.borders', { preset: 'outside', pen }) as { intent: { payload: { borders: { top: unknown } } } }
    expect(result.intent.payload.borders.top).toEqual(pen)
  })

  it('选整行 / 整列 / 整表', () => {
    expect(plan('docx.table.select', { target: 'row' })).toEqual({ channel: 'submit', intent: { kind: 'selectTableCells', payload: { target: 'row' } } })
  })
})

describe('图片 / 分页 / 历史', () => {
  it('插入图片原样带上载荷；没有图片拒绝', () => {
    const image = { src: 'data:image/png;base64,AAAA', width: 100, height: 50 }
    expect(plan('docx.image.insert', { image })).toEqual({ channel: 'submit', intent: { kind: 'insertImage', payload: { image } } })
    expect(plan('docx.image.insert', {})).toBeNull()
  })

  it('分页符 / 分节符', () => {
    expect(plan('docx.pageBreak')).toEqual({ channel: 'submit', intent: { kind: 'insertPageBreak', payload: {} } })
    expect(plan('docx.sectionBreak', { type: 'continuous' })).toMatchObject({ intent: { kind: 'insertSectionBreak', payload: { type: 'continuous' } } })
    expect(plan('docx.sectionBreak', {})).toMatchObject({ intent: { payload: { type: 'nextPage' } } })
  })

  it('撤销 / 重做是引擎历史，不是前端栈', () => {
    expect(plan('docx.undo')).toEqual({ channel: 'submit', intent: { kind: 'undo', payload: {} } })
    expect(plan('docx.redo')).toEqual({ channel: 'submit', intent: { kind: 'redo', payload: {} } })
  })
})

describe('完整性', () => {
  it('每个声明的命令类型都有对应的计划（防止加了类型忘了加映射）', () => {
    const sample: Record<string, unknown> = {
      'docx.fontFamily': { family: 'Arial' },
      'docx.fontSize': { points: 12 },
      'docx.textColor': { color: '#000000' },
      'docx.highlight': { color: 'yellow' },
      'docx.align': { value: 'left' },
      'docx.lineSpacing': { value: 240 },
      'docx.list': { kind: 'bullet' },
      'docx.indent': { direction: 'increase' },
      'docx.style': { styleId: 'Normal' },
      'docx.table.insert': { rows: 2, columns: 2 },
      'docx.table.row': { side: 'below' },
      'docx.table.column': { side: 'right' },
      'docx.table.split': { rows: 1, columns: 2 },
      'docx.table.shading': { color: 'CCCCCC' },
      'docx.table.borders': { preset: 'all' },
      'docx.table.select': { target: 'table' },
      'docx.image.insert': { image: { src: 'x' } },
      'docx.sectionBreak': { type: 'nextPage' },
    }
    // 环绕要读选中图片的当前版式，纯映射表给不出意图，由执行器处理（runner.spec 覆盖）
    const byRunner = new Set(['docx.image.wrap'])
    for (const type of DOCX_COMMAND_TYPES) {
      if (byRunner.has(type)) expect(plan(type, { target: 'square' }), type).toBeNull()
      else expect(plan(type, sample[type]), type).not.toBeNull()
    }
    expect(new Set(DOCX_COMMAND_TYPES).size).toBe(DOCX_COMMAND_TYPES.length)
  })

  it('isDocxCommandType 只认本表', () => {
    expect(isDocxCommandType('docx.bold')).toBe(true)
    expect(isDocxCommandType('mark.toggle')).toBe(false)
    expect(isDocxCommandType('docx.nothing')).toBe(false)
  })

  it('normalizeHex', () => {
    expect(normalizeHex('#abc')).toBe('AABBCC')
    expect(normalizeHex(' 00ff00 ')).toBe('00FF00')
    expect(normalizeHex('')).toBeNull()
    expect(normalizeHex('12345')).toBeNull()
    expect(normalizeHex(undefined)).toBeNull()
  })
})
