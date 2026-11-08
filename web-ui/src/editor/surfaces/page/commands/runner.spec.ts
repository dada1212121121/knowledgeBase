/**
 * 格式状态与命令执行器单测：用假 binding，验证可用性判断、通道选择、回执处理与字体登记握手。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDocxCommandRunner } from './runner'
import { docxCommandGate, docxFormatState, toChromeFormatState } from './state'

describe('docxFormatState', () => {
  it('三态：mixed 也算亮（部分加粗时粗体按钮是亮的）', () => {
    const state = docxFormatState({ toolbar: { bold: 'mixed', italic: true, underline: false, strike: null } })
    expect(state.marks).toEqual(['bold', 'italic'])
  })

  it('字号：toolbar 是半磅，要折成磅；混选时退回 effectiveFormatting', () => {
    expect(docxFormatState({ toolbar: { fontSize: 21 } }).fontSizePt).toBe(10.5)
    expect(docxFormatState({ toolbar: { fontSize: null }, effectiveFormatting: { fontSizePt: 11 } }).fontSizePt).toBe(11)
    expect(docxFormatState(null).fontSizePt).toBeNull()
  })

  it('列表：numId 1 = 项目符号，其余 > 0 = 编号，没有 = 都不亮', () => {
    expect(docxFormatState({ toolbar: { paragraphProperties: { numPr: { numId: 1 } } } }).lists).toMatchObject({ bullet: true, ordered: false })
    expect(docxFormatState({ toolbar: { paragraphProperties: { numPr: { numId: 3 } } } }).lists).toMatchObject({ bullet: false, ordered: true })
    expect(docxFormatState({ toolbar: { paragraphProperties: { numPr: { numId: 0 } } } }).lists).toMatchObject({ bullet: false, ordered: false })
    expect(docxFormatState({ toolbar: { paragraphProperties: {} } }).lists).toMatchObject({ bullet: false, ordered: false })
  })

  it('表格上下文 / 历史 / 只读', () => {
    const state = docxFormatState({ tableContext: { hasMultiCellSelection: true, canSplitCell: false }, canUndo: true, readOnly: true })
    expect(state).toMatchObject({ inTable: true, canMerge: true, canSplit: false, canUndo: true, canRedo: false, readOnly: true })
  })

  it('没有 editState（引擎还没出第一帧）也不抛错', () => {
    expect(docxFormatState(undefined).marks).toEqual([])
  })
})

describe('docxCommandGate', () => {
  const base = docxFormatState({ canUndo: false, canRedo: false })

  it('只读拒绝一切，且最先判', () => {
    const readOnly = docxFormatState({ readOnly: true, canUndo: true })
    expect(docxCommandGate('docx.bold', readOnly)).toBe('文档当前是只读的')
    expect(docxCommandGate('docx.undo', readOnly)).toBe('文档当前是只读的')
  })

  it('撤销 / 重做看引擎历史；刚键入还没回执（pendingInput）时放行撤销', () => {
    expect(docxCommandGate('docx.undo', base)).toBe('没有可撤销的操作')
    expect(docxCommandGate('docx.undo', base, true)).toBeNull()
    expect(docxCommandGate('docx.redo', base)).toBe('没有可重做的操作')
    expect(docxCommandGate('docx.undo', docxFormatState({ canUndo: true }))).toBeNull()
  })

  it('表格命令要求光标在表格里；合并要多选；拆分要能拆', () => {
    expect(docxCommandGate('docx.table.row', base)).toBe('请先把光标放进表格')
    const inTable = docxFormatState({ tableContext: { hasMultiCellSelection: false, canSplitCell: false } })
    expect(docxCommandGate('docx.table.row', inTable)).toBeNull()
    expect(docxCommandGate('docx.table.merge', inTable)).toBe('请先选中要合并的多个单元格')
    expect(docxCommandGate('docx.table.split', inTable)).toBe('这个单元格不能再拆分')
    const multi = docxFormatState({ tableContext: { hasMultiCellSelection: true, canSplitCell: true } })
    expect(docxCommandGate('docx.table.merge', multi)).toBeNull()
    expect(docxCommandGate('docx.table.split', multi)).toBeNull()
  })

  it('文本命令不要求在表格里', () => {
    expect(docxCommandGate('docx.bold', base)).toBeNull()
    expect(docxCommandGate('docx.table.insert', base)).toBeNull()
  })
})

/* ---------------- 执行器 ---------------- */

type Outcome = { status: 'applied' | 'noop' | 'refused' | 'cancelled'; seq?: number; reason?: string }

interface FakePicture {
  handle: string
  version: string
  /** 选中对象的属性；null = 读不出（选中的不是图片），不写 = 默认嵌入式图片 */
  attrs?: Record<string, unknown> | null
}

interface FakeOptions {
  editState?: unknown
  outcome?: Outcome | ((kind: string) => Outcome)
  pending?: number
  prepare?: () => Promise<unknown>
  picture?: FakePicture
}

function fakeEngine(options: FakeOptions = {}) {
  const calls: Array<{ channel: 'format' | 'submit'; kind: string; payload: unknown; options: unknown }> = []
  const respond = (kind: string): Outcome => (typeof options.outcome === 'function' ? options.outcome(kind) : (options.outcome ?? { status: 'applied', seq: calls.length }))
  const admit = (channel: 'format' | 'submit') => (intent: { kind: string; payload: unknown }, opts: unknown) => {
    calls.push({ channel, kind: intent.kind, payload: intent.payload, options: opts })
    return { status: 'submitted', echoEnabled: false, ticket: { id: calls.length, seq: calls.length, ack: Promise.resolve(respond(intent.kind)), presented: Promise.resolve('presented') } }
  }
  const applied = vi.fn()
  const environment = { faces: [{ family: 'X', data: new Uint8Array(4) }], chains: {}, families: ['X'] }
  const picture = options.picture
  const objectRead = !picture ? null : picture.attrs === null ? null : { kind: 'object', handle: picture.handle, properties: picture.attrs ?? { wrapType: 'inline' } }
  const engine = {
    binding: {
      viewStore: {
        getSnapshot: () => ({
          editState: options.editState ?? { canUndo: true, canRedo: true, tableContext: { hasMultiCellSelection: true, canSplitCell: true } },
          workerSelection: picture ? { anchor: { story: 'body', paraId: 'p', offset: 0 }, focus: { story: 'body', paraId: 'p', offset: 1 } } : null,
          geometry: picture ? FAKE_GEOMETRY(picture) : null,
        }),
      },
      admission: { getSnapshot: () => ({ pendingInputs: options.pending ?? 0 }) },
      commands: { format: admit('format'), submit: admit('submit') },
    },
    client: { documentRead: async () => ({ version: 'v', value: objectRead }) },
    flush: async () => undefined,
    prepareFontFamily: options.prepare ?? (async () => environment),
    fontEnvironmentApplied: applied,
  }
  return { engine: engine as never, calls, applied, environment }
}

/**
 * 最小几何：一张被选中的图片。字段与引擎一致才算数：对象表的版本、帧代次、版面版本都要和几何对得上
 * （pictureGeometryMatches），且图片被标记 selected——这些不对，真实引擎里就选不中图片。
 */
const FAKE_GEOMETRY = (picture: FakePicture) => ({
  documentVersion: picture.version,
  frameEpoch: 3,
  layoutRevision: 2,
  coversThroughSeq: 0,
  objects: {
    version: picture.version,
    frameEpoch: 3,
    layoutRevision: 2,
    objects: [{ kind: 'image', handle: picture.handle, selected: true, nested: false, rects: [{ pageIndex: 0, x: 10, y: 20, width: 100, height: 50 }], floating: false, rotation: 0 }],
  },
  pages: [],
  caret: null,
  selectionRects: [],
})

describe('createDocxCommandRunner', () => {
  it('格式命令走 format 通道并带围栏', async () => {
    const { engine, calls } = fakeEngine()
    const result = await createDocxCommandRunner(engine).run('docx.bold')
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ channel: 'format', kind: 'toggleMark', payload: { mark: { type: 'bold' } }, options: { fence: true } }])
  })

  it('结构命令走 submit 通道；选整行用 selection 来源（不进历史）', async () => {
    const { engine, calls } = fakeEngine()
    const runner = createDocxCommandRunner(engine)
    await runner.run('docx.table.insert', { rows: 2, columns: 2 })
    await runner.run('docx.table.select', { target: 'row' })
    expect(calls.map((call) => [call.channel, call.kind])).toEqual([['submit', 'insertTable'], ['submit', 'selectTableCells']])
    expect(calls[1]!.options).toMatchObject({ source: 'selection', fence: true })
    expect(calls[0]!.options).toMatchObject({ fence: true })
  })

  it('不是 docx.* 的命令不处理', async () => {
    const { engine, calls } = fakeEngine()
    expect(await createDocxCommandRunner(engine).run('mark.toggle')).toEqual({ ok: false, reason: 'not_docx_command' })
    expect(calls).toHaveLength(0)
  })

  it('只读：一条意图都不提交', async () => {
    const { engine, calls } = fakeEngine({ editState: { readOnly: true } })
    const result = await createDocxCommandRunner(engine).run('docx.bold')
    expect(result).toEqual({ ok: false, reason: '文档当前是只读的' })
    expect(calls).toHaveLength(0)
  })

  it('参数不合法：不提交，给出原因', async () => {
    const { engine, calls } = fakeEngine()
    const result = await createDocxCommandRunner(engine).run('docx.fontSize', { points: 10.3 })
    expect(result).toEqual({ ok: false, reason: '这个操作的参数不合法' })
    expect(calls).toHaveLength(0)
  })

  it('不在表格里的表格命令被拒，不提交', async () => {
    const { engine, calls } = fakeEngine({ editState: { tableContext: null } })
    expect(await createDocxCommandRunner(engine).run('docx.table.deleteRow')).toEqual({ ok: false, reason: '请先把光标放进表格' })
    expect(calls).toHaveLength(0)
  })

  it('引擎拒绝：带着原因返回，不当成功', async () => {
    const { engine } = fakeEngine({ outcome: { status: 'refused', reason: 'read-only' } })
    expect(await createDocxCommandRunner(engine).run('docx.italic')).toEqual({ ok: false, reason: '文档当前是只读的' })
    const other = fakeEngine({ outcome: { status: 'refused', reason: 'weird-reason' } })
    const result = await createDocxCommandRunner(other.engine).run('docx.italic')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('weird-reason')
  })

  it('noop 是成功（合法但没有改动），并带标记', async () => {
    const { engine } = fakeEngine({ outcome: { status: 'noop', seq: 7 } })
    expect(await createDocxCommandRunner(engine).run('docx.indent', { direction: 'decrease' })).toEqual({ ok: true, data: { seq: 7, noop: true } })
  })

  it('撤销：刚键入还没回执时放行', async () => {
    const { engine, calls } = fakeEngine({ editState: { canUndo: false }, pending: 1 })
    expect((await createDocxCommandRunner(engine).run('docx.undo')).ok).toBe(true)
    expect(calls[0]!.kind).toBe('undo')
  })

  it('改字体族：先登记字体环境（setFontEnvironment）再提交格式意图，登记后释放字节', async () => {
    const { engine, calls, applied, environment } = fakeEngine()
    const result = await createDocxCommandRunner(engine).run('docx.fontFamily', { family: 'Arial' })
    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.kind)).toEqual(['setFontEnvironment', 'formatRange'])
    expect(applied).toHaveBeenCalledWith(environment)
    expect(environment.faces).toHaveLength(0)
  })

  it('字体准备失败：不提交任何意图，原因说清楚', async () => {
    const { engine, calls } = fakeEngine({ prepare: async () => { throw new Error('网络断了') } })
    const result = await createDocxCommandRunner(engine).run('docx.fontFamily', { family: 'Arial' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Arial')
    expect(result.reason).toContain('网络断了')
    expect(calls).toHaveLength(0)
  })

  it('字体登记被引擎拒绝：格式意图不提交，字节仍被释放', async () => {
    const { engine, calls, applied, environment } = fakeEngine({ outcome: (kind) => (kind === 'setFontEnvironment' ? { status: 'refused', reason: 'stale-version' } : { status: 'applied' }) })
    const result = await createDocxCommandRunner(engine).run('docx.fontFamily', { family: 'Arial' })
    expect(result.ok).toBe(false)
    expect(calls.map((call) => call.kind)).toEqual(['setFontEnvironment'])
    expect(applied).not.toHaveBeenCalled()
    expect(environment.faces).toHaveLength(0)
  })

  it('环绕：读选中图片的当前版式，算补丁，带图片版本号提交 setObjectProperties', async () => {
    const { engine, calls } = fakeEngine({ picture: { handle: 'img-1', version: 'v7', attrs: { wrapType: 'inline' } } })
    const result = await createDocxCommandRunner(engine).run('docx.image.wrap', { target: 'square' })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ channel: 'submit', kind: 'setObjectProperties', options: { fence: true } })
    const payload = calls[0]!.payload as { handle: string; expectVersion: string; patch: Record<string, unknown> }
    expect(payload.handle).toBe('img-1')
    expect(payload.expectVersion).toBe('v7')
    expect(payload.patch).toMatchObject({ wrapType: 'square', wrap: 'square', displayMode: 'float' })
  })

  it('环绕改回嵌入：补丁是 inline', async () => {
    const { engine, calls } = fakeEngine({ picture: { handle: 'img-1', version: 'v1', attrs: { wrapType: 'square', cssFloat: 'left' } } })
    await createDocxCommandRunner(engine).run('docx.image.wrap', { target: 'inline' })
    expect((calls[0]!.payload as { patch: Record<string, unknown> }).patch).toMatchObject({ wrapType: 'inline', displayMode: 'inline' })
  })

  it('没选中图片时环绕被拒，不提交任何东西', async () => {
    const { engine, calls } = fakeEngine()
    expect(await createDocxCommandRunner(engine).run('docx.image.wrap', { target: 'square' })).toEqual({ ok: false, reason: '请先选中一张图片' })
    expect(calls).toHaveLength(0)
  })

  it('选中的对象读不出属性（不是图片）：说明原因，不提交', async () => {
    const { engine, calls } = fakeEngine({ picture: { handle: 'obj', version: 'v1', attrs: null } })
    expect(await createDocxCommandRunner(engine).run('docx.image.wrap', { target: 'square' })).toEqual({ ok: false, reason: '选中的不是图片' })
    expect(calls).toHaveLength(0)
  })

  it('图片版本过期被引擎拒绝：原因带给用户（不会改错图）', async () => {
    const { engine } = fakeEngine({ picture: { handle: 'img-1', version: 'old' }, outcome: { status: 'refused', reason: 'stale-version' } })
    const result = await createDocxCommandRunner(engine).run('docx.image.wrap', { target: 'tight' })
    expect(result).toEqual({ ok: false, reason: '文档在你操作期间被改动了，请重试' })
  })

  it('formatState / gate 直接读 viewStore 的最新 editState', () => {
    const { engine } = fakeEngine({ editState: { toolbar: { bold: true }, canUndo: false } })
    const runner = createDocxCommandRunner(engine)
    expect(runner.formatState().marks).toEqual(['bold'])
    expect(runner.gate('docx.undo')).toBe('没有可撤销的操作')
    expect(runner.gate('docx.bold')).toBeNull()
  })
})

describe('toChromeFormatState', () => {
  it('当前值与置灰原因：不在表格里时全部表格命令不可用，环绕要选图片', () => {
    const chrome = toChromeFormatState(docxFormatState({ toolbar: { alignment: 'center', fontSize: 24, fontFamily: '宋体', styleId: 'Heading1' } }))
    expect(chrome.values).toMatchObject({ alignment: 'center', fontSizePt: 12, fontFamily: '宋体', styleId: 'Heading1' })
    expect(chrome.unavailable['docx.table.row']).toBe('请先把光标放进表格')
    expect(chrome.unavailable['docx.table.borders']).toBe('请先把光标放进表格')
    expect(chrome.unavailable['docx.image.wrap']).toBe('请先选中一张图片')
    // 文本命令、插入表格永远不在置灰表里
    expect(chrome.unavailable['docx.bold']).toBeUndefined()
    expect(chrome.unavailable['docx.table.insert']).toBeUndefined()
  })

  it('在表格里且选了图片：对应命令解除置灰；合并仍要多选', () => {
    const chrome = toChromeFormatState(docxFormatState({ tableContext: { hasMultiCellSelection: false, canSplitCell: false } }, true))
    expect(chrome.unavailable['docx.table.row']).toBeUndefined()
    expect(chrome.unavailable['docx.image.wrap']).toBeUndefined()
    expect(chrome.unavailable['docx.table.merge']).toBe('请先选中要合并的多个单元格')
  })
})
