/**
 * PPTX 编辑后端的翻译层测试：假会话 + 假 peer，不起 WASM。
 * 核对的是我们自己写的部分：px↔EMU、派发给 apply 的方法和参数、哪些页算变了、只读 / 失败守卫、叠放层级、样式读取。
 * 真实引擎的行为（保存只改目标 slide XML、IME、撤销）在 e2e 里用真文件验。
 */
import { describe, expect, it, vi } from 'vitest'
import type { PptxWorkerEditorSession } from '@betteroffice/pptx/worker'
import { OPS_USED, PptxEditBackend, effectiveRect, handleDriver, sessionDriver, slideIdOfStory } from './pptxEdit'
import { PPTX_WORKER_REPLAY_METHODS } from './version'

type Op = { method: string; args: unknown[] }

const shape = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    kind: 'shape',
    name: id,
    x: 9525 * 10,
    y: 9525 * 20,
    width: 9525 * 100,
    height: 9525 * 50,
    rotationDeg: 0,
    flipH: false,
    flipV: false,
    placeholder: null,
    textStories: [{ id: `story:slide:0:256:${id}:0`, paragraphs: [] }],
    children: [],
    ...over,
  }) as never

interface Harness {
  backend: PptxEditBackend
  ops: Op[]
  changes: Array<{ slides: readonly number[] | 'all'; remote: boolean }>
  fail(error: Error): void
  access: Record<string, unknown>
  shapesOf(list: unknown[]): void
}

function harness(options: { readonly?: boolean; shapes?: unknown[]; story?: unknown; applied?: boolean } = {}): Harness {
  const ops: Op[] = []
  let stateListener: ((state: { failure?: Error }) => void) | null = null
  let shapes = options.shapes ?? [shape('a'), shape('b'), shape('c')]
  let version = 1
  const slides = () => [
    { id: 'slide:0:256', shapes, notes: '' },
    { id: 'slide:1:257', shapes: [], notes: '' },
  ]
  const session = {
    subscribe: (listener: (state: { failure?: Error }) => void) => {
      stateListener = listener
      return () => undefined
    },
    apply: (op: Op) => {
      ops.push(op)
      version += 1
      return { consumed: true, outcome: { applied: options.applied ?? true, result: op.method.startsWith('add') && op.method !== 'addUndoBoundary' ? { shapeId: `new:${ops.length}` } : { applied: true }, changedTargets: [] } }
    },
    saveAsync: async () => new Uint8Array([1, 2, 3]),
    recoverySave: async () => ({ bytes: new Uint8Array([9]), recovery: true }),
    dispose: async () => undefined,
  } as unknown as PptxWorkerEditorSession
  const access: Record<string, unknown> = {
    version: () => String(version),
    snapshot: () => ({ widthEmu: 12192000, heightEmu: 6858000, slides: slides() }),
    layoutSlide: () => ({ width: 1280, height: 720, primitives: [] }),
    readContent: () => ({ ok: true, stories: [{ storyId: 'story:slide:0:256:a:0', text: 'hello' }] }),
    story: () => options.story ?? { id: 's', length: 0, paragraphs: [] },
    canUndo: () => true,
    canRedo: () => false,
    mediaBytes: () => new Uint8Array(),
    searchText: () => [],
  }
  const backend = new PptxEditBackend(sessionDriver(session, access as never), !!options.readonly)
  backend.prepare([])
  const changes: Harness['changes'] = []
  backend.onChange((change) => changes.push(change))
  return {
    backend,
    ops,
    changes,
    access,
    fail: (error) => stateListener?.({ failure: error }),
    shapesOf: (list) => {
      shapes = list
      version += 1
    },
  }
}

describe('编辑通道只用上游允许的方法', () => {
  it('OPS_USED 全部在 PPTX_WORKER_REPLAY_METHODS 之内，且没有表格行列增删', () => {
    for (const method of OPS_USED) expect(PPTX_WORKER_REPLAY_METHODS as readonly string[]).toContain(method)
    expect(OPS_USED.some((method) => /Table/.test(method))).toBe(false)
  })

  it('把每个公开的写操作各调用一遍，实际派发的方法都在 OPS_USED 里', () => {
    const { backend, ops } = harness()
    backend.insertText('story:slide:0:256:a:0', 0, 'x')
    backend.deleteText('story:slide:0:256:a:0', 0, 1)
    backend.insertBreak('story:slide:0:256:a:0', 0)
    backend.formatText('story:slide:0:256:a:0', 0, 1, { bold: true })
    backend.alignText('story:slide:0:256:a:0', 0, 1, 'ctr')
    backend.setRect(0, 'a', { x: 1, y: 2, width: 3, height: 4 })
    backend.addTextBox(0, { x: 0, y: 0, width: 100, height: 40 }, '')
    backend.addShape(0, 'ellipse', { x: 0, y: 0, width: 100, height: 40 })
    backend.addPicture(0, { bytes: new Uint8Array([1]), contentType: 'image/png', name: 'p.png' }, { x: 0, y: 0, width: 10, height: 10 })
    backend.removeShape(0, 'a')
    for (const order of ['front', 'back', 'forward', 'backward'] as const) backend.zOrder(0, 'a', order)
    backend.setFill(0, 'a', '#ff0000')
    backend.setNotes(0, '备注')
    backend.insertSlide(0)
    backend.duplicateSlide(0)
    backend.deleteSlide(1)
    backend.moveSlide(0, 1)
    backend.boundary()
    backend.undo()
    backend.redo()
    const used = new Set(ops.map((op) => op.method))
    for (const method of used) expect(OPS_USED as readonly string[], method).toContain(method)
    expect(used.size).toBe(OPS_USED.length)
  })
})

describe('坐标换算与参数', () => {
  it('setRect：px → EMU（914400 EMU = 96 px），取整，宽高至少 1', () => {
    const { backend, ops } = harness()
    backend.setRect(0, 'a', { x: 10.5, y: 20, width: 100, height: 0 })
    expect(ops[0]).toEqual({ method: 'setShapeRect', args: ['slide:0:256', 'a', { x: 100013, y: 190500, width: 952500, height: 1 }] })
  })

  it('addTextBox / addShape / addPicture 的草稿结构', () => {
    const { backend, ops } = harness()
    const rect = { x: 100, y: 50, width: 200, height: 40 }
    expect(backend.addTextBox(1, rect, '你好')).toMatch(/^new:/)
    expect(ops[0]).toEqual({ method: 'addTextBox', args: ['slide:1:257', { name: '文本框', rect: { x: 952500, y: 476250, width: 1905000, height: 381000 }, text: '你好', style: { fontSizePt: 18 } }] })
    backend.addShape(0, 'roundRect', rect, '#00ff00')
    expect(ops[1]!.args[1]).toMatchObject({ name: '圆角矩形', geometry: 'roundRect', fill: '#00ff00' })
    backend.addPicture(0, { bytes: new Uint8Array([104, 105]), contentType: 'image/png', name: 'a.png' }, rect)
    expect(ops[2]!.args[1]).toMatchObject({ name: 'a.png', contentType: 'image/png', mediaBase64: 'aGk=' })
  })

  it('大图的 base64 分块编码不爆栈', () => {
    const { backend, ops } = harness()
    const big = new Uint8Array(300_000).fill(65)
    backend.addPicture(0, { bytes: big, contentType: 'image/png', name: 'big.png' }, { x: 0, y: 0, width: 10, height: 10 })
    expect((ops[0]!.args[1] as { mediaBase64: string }).mediaBase64.length).toBe(400_000)
  })

  it('格式补丁：下划线布尔 → OOXML 的 sng / none，只带用户改的字段', () => {
    const { backend, ops } = harness()
    backend.formatText('story:slide:0:256:a:0', 2, 5, { underline: true, fontSizePt: 24 })
    backend.formatText('story:slide:0:256:a:0', 2, 5, { underline: false })
    expect(ops[0]!.args[3]).toEqual({ underline: 'sng', fontSizePt: 24 })
    expect(ops[1]!.args[3]).toEqual({ underline: 'none' })
  })

  it('页序操作：新建在当前页之后、复制到当前页之后', () => {
    const { backend, ops } = harness()
    backend.insertSlide(0)
    backend.duplicateSlide(0)
    expect(ops[0]).toEqual({ method: 'insertSlide', args: [1] })
    expect(ops[1]).toEqual({ method: 'duplicateSlide', args: ['slide:0:256', 1] })
  })
})

describe('变化通知', () => {
  it('文本修改只算它所在的那一页；页序 / 撤销重做算全部', () => {
    const { backend, changes } = harness()
    backend.insertText('story:slide:1:257:shape:3:0', 0, 'x')
    expect(changes.at(-1)).toEqual({ slides: [1], remote: false })
    backend.setRect(0, 'a', { x: 0, y: 0, width: 5, height: 5 })
    expect(changes.at(-1)).toEqual({ slides: [0], remote: false })
    backend.deleteSlide(1)
    expect(changes.at(-1)?.slides).toBe('all')
    backend.undo()
    expect(changes.at(-1)?.slides).toBe('all')
  })

  it('故事 id 认不出所在页时退成全部', () => {
    const { backend, changes } = harness()
    backend.insertText('story:weird', 0, 'x')
    expect(changes.at(-1)?.slides).toBe('all')
    expect(slideIdOfStory('story:slide:3:259:shape:1:0')).toBe('slide:3:259')
    expect(slideIdOfStory('nope')).toBeNull()
  })

  it('引擎说没有生效（applied=false）就不通知', () => {
    const { backend, changes } = harness({ applied: false })
    backend.setRect(0, 'a', { x: 0, y: 0, width: 5, height: 5 })
    expect(changes).toEqual([])
  })

  it('取消订阅后不再通知', () => {
    const { backend } = harness()
    const seen = vi.fn()
    const off = backend.onChange(seen)
    backend.boundary()
    backend.setRect(0, 'a', { x: 0, y: 0, width: 5, height: 5 })
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    backend.setRect(0, 'a', { x: 1, y: 0, width: 5, height: 5 })
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('守卫', () => {
  it('只读：写操作抛错、不派发；撤销栈切刀静默忽略；setReadonly 之后放开', () => {
    const { backend, ops } = harness({ readonly: true })
    expect(backend.readonly).toBe(true)
    expect(() => backend.insertText('story:slide:0:256:a:0', 0, 'x')).toThrow('只读')
    expect(() => backend.removeShape(0, 'a')).toThrow('只读')
    backend.boundary()
    expect(ops).toEqual([])
    const seen: Array<{ state?: boolean }> = []
    backend.onChange((change) => seen.push(change))
    backend.setReadonly(false)
    // 放开只读要通知界面（刷新编辑层和按钮），但它不是内容修改
    expect(seen).toEqual([{ slides: [], remote: false, state: true }])
    backend.setReadonly(false)
    expect(seen).toHaveLength(1)
    backend.removeShape(0, 'a')
    expect(ops).toHaveLength(1)
  })

  it('会话失败：记下错误、通知监听者、之后写操作抛同一个错误、撤销按钮不可用', () => {
    const { backend, fail, ops } = harness()
    const seen = vi.fn()
    backend.onFailure(seen)
    const error = new Error('wasm trap')
    fail(error)
    expect(backend.failure()).toBe(error)
    expect(seen).toHaveBeenCalledWith(error)
    expect(() => backend.removeShape(0, 'a')).toThrow('wasm trap')
    expect(backend.canUndo()).toBe(false)
    expect(ops).toEqual([])
  })

  it('失败后仍能抢救一份恢复副本', async () => {
    const { backend, fail } = harness()
    fail(new Error('x'))
    expect(Array.from((await backend.recover())!)).toEqual([9])
  })

  it('越界的页号给出明确错误', () => {
    const { backend } = harness()
    expect(() => backend.removeShape(9, 'a')).toThrow('没有第 10 张')
  })
})

describe('叠放与替换图片', () => {
  it('替换图片：新图画在旧图位置，按旧图的层级退回，再删旧图', () => {
    const { backend, ops } = harness({ shapes: [shape('bottom'), shape('pic', { kind: 'picture' }), shape('top1'), shape('top2')] })
    backend.replacePicture(0, 'pic', { bytes: new Uint8Array([1]), contentType: 'image/png', name: 'n.png' })
    const methods = ops.map((op) => op.method)
    // 旧图在 z=1，上面有 2 个形状 → 新图要后退 2 步才回到旧图正上方
    expect(methods).toEqual(['addPicture', 'sendShapeBackward', 'sendShapeBackward', 'removeShape'])
    expect(ops[0]!.args[1]).toMatchObject({ rect: { x: 95250, y: 190500, width: 952500, height: 476250 } })
    expect(ops[3]!.args).toEqual(['slide:0:256', 'pic'])
  })

  it('旧图本来在最上层：不需要退', () => {
    const { backend, ops } = harness({ shapes: [shape('a'), shape('pic', { kind: 'picture' })] })
    backend.replacePicture(0, 'pic', { bytes: new Uint8Array([1]), contentType: 'image/png', name: 'n.png' })
    expect(ops.map((op) => op.method)).toEqual(['addPicture', 'removeShape'])
  })

  it('旧图不存在 → 报错而不是乱加', () => {
    const { backend, ops } = harness()
    expect(() => backend.replacePicture(0, 'ghost', { bytes: new Uint8Array(), contentType: 'image/png', name: 'x' })).toThrow('已经不存在')
    expect(ops).toEqual([])
  })
})

describe('形状列表', () => {
  it('占位符没写几何时用继承来的矩形；旋转 / 翻转 / 没有几何的限制能力', () => {
    const inheritedOnly = shape('ph', { width: 0, height: 0, x: 0, y: 0, placeholder: {}, inherited: { x: 9525 * 5, y: 9525 * 6, width: 9525 * 70, height: 9525 * 30, rotationDeg: 0, flipH: false, flipV: false } })
    const rotated = shape('rot', { rotationDeg: 45 })
    const flipped = shape('flip', { flipH: true })
    const none = shape('none', { width: 0, height: 0 })
    const { backend } = harness({ shapes: [inheritedOnly, rotated, flipped, none] })
    const [ph, rot, flip, nothing] = backend.shapes(0)
    expect(ph).toMatchObject({ rect: { x: 5, y: 6, width: 70, height: 30 }, canMove: true, canResize: true, placeholder: true })
    expect(rot).toMatchObject({ canMove: true, canResize: false, rotation: 45 })
    expect(flip).toMatchObject({ canMove: true, canResize: false })
    expect(nothing).toMatchObject({ canMove: false, canResize: false })
  })

  it('隐藏的形状不进可选列表；图片默认锁定宽高比；组合 / 表格没有文本流入口；z 是叠放序号', () => {
    const { backend } = harness({
      shapes: [shape('h', { hidden: true }), shape('pic', { kind: 'picture' }), shape('grp', { kind: 'group' }), shape('tbl', { kind: 'graphicFrame' }), shape('txt')],
    })
    const list = backend.shapes(0)
    expect(list.map((item) => item.id)).toEqual(['pic', 'grp', 'tbl', 'txt'])
    expect(list.map((item) => item.z)).toEqual([1, 2, 3, 4])
    expect(list[0]!.aspectLocked).toBe(true)
    expect(list[1]!.storyId).toBeNull()
    expect(list[2]!.storyId).toBeNull()
    expect(list[3]!.storyId).toBe('story:slide:0:256:txt:0')
    expect(backend.shapes(5)).toEqual([])
  })

  it('effectiveRect 单独：自己的优先，宽高为 0 时看继承', () => {
    expect(effectiveRect(shape('x'))).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    expect(effectiveRect(shape('x', { width: 0 }))).toBeNull()
  })

  it('改了内容（版本号变）之后形状列表和目录都重新读', () => {
    const h = harness({ shapes: [shape('a')] })
    expect(h.backend.shapes(0)).toHaveLength(1)
    h.shapesOf([shape('a'), shape('b')])
    expect(h.backend.shapes(0)).toHaveLength(2)
  })
})

describe('文字样式读取', () => {
  const run = (text: string, style: Record<string, unknown> = {}) => ({ text, style: { bold: null, italic: null, fontSizePt: null, color: null, fontFamily: null, underline: null, ...style } })
  const story = {
    id: 's',
    length: 12,
    paragraphs: [
      { id: 'p1', alignment: 'ctr', level: 0, bulletJson: null, runs: [run('hel', { bold: true, fontSizePt: 24 }), run('lo', { underline: 'sng', color: '#112233' })] },
      { id: 'p2', alignment: null, level: 0, bulletJson: null, runs: [run('xyz', { italic: true })] },
    ],
  }

  it('光标左边的字符决定样式；段首看右边；段与段之间隔着 1 个分隔符', () => {
    const { backend } = harness({ story })
    expect(backend.styleAt('s', 2)).toMatchObject({ bold: true, fontSizePt: 24, align: 'ctr', underline: false })
    expect(backend.styleAt('s', 4)).toMatchObject({ bold: false, underline: true, color: '#112233' })
    expect(backend.styleAt('s', 0)).toMatchObject({ bold: true })
    // p1 占 0~5，分隔符在 5，p2 从 6 开始
    expect(backend.styleAt('s', 6)).toMatchObject({ italic: true, align: null })
    expect(backend.styleAt('s', 8)).toMatchObject({ italic: true })
  })

  it('取不到文本流时给出默认样式而不是抛错', () => {
    const h = harness()
    h.access.story = () => {
      throw new Error('没有这个故事')
    }
    expect(h.backend.styleAt('missing', 0)).toEqual({ bold: false, italic: false, underline: false, fontSizePt: null, color: null, align: null })
  })
})

describe('输入沿用光标处的格式', () => {
  const run = (text: string, style: Record<string, unknown> = {}) => ({ text, style: { bold: null, italic: null, fontSizePt: null, color: null, fontFamily: null, underline: null, ...style } })
  const story = {
    id: 's',
    length: 9,
    paragraphs: [
      { id: 'p1', alignment: null, level: 0, bulletJson: null, runs: [run('abc', { color: '#E7E8F0', fontSizePt: 22 }), run('def', { bold: true, fontFamily: 'Calibri' })] },
      { id: 'p2', alignment: null, level: 0, bulletJson: null, runs: [run('xy')] },
    ],
  }

  it('插入点左边那个 run 的颜色 / 字号 / 字体 / 粗体都带上；用户显式给的覆盖它', () => {
    const { backend, ops } = harness({ story })
    backend.insertText('s', 2, 'X')
    expect(ops[0]!.args).toEqual(['s', 2, 'X', { fontSizePt: 22, color: '#E7E8F0' }])
    backend.insertText('s', 5, 'Y')
    expect(ops[1]!.args[3]).toEqual({ bold: true, fontFamily: 'Calibri' })
    backend.insertText('s', 2, 'Z', { color: '#ff0000', bold: true })
    expect(ops[2]!.args[3]).toEqual({ fontSizePt: 22, color: '#ff0000', bold: true })
  })

  it('段首沿用本段第一个 run；没有格式的 run 不带额外参数', () => {
    const { backend, ops } = harness({ story })
    backend.insertText('s', 0, 'Q')
    expect(ops[0]!.args[3]).toEqual({ fontSizePt: 22, color: '#E7E8F0' })
    backend.insertText('s', 7, 'R')
    expect(ops[1]!.args).toEqual(['s', 7, 'R'])
  })
})

describe('保存', () => {
  it('保存交给会话（先落稳再序列化）', async () => {
    const { backend } = harness()
    expect(Array.from(await backend.save())).toEqual([1, 2, 3])
  })
})

describe('协同通道（句柄直连）', () => {
  function fakeHandle() {
    let version = 1
    const updateListeners = new Set<(update: Uint8Array, origin: 'local' | 'remote') => void>()
    const calls: string[] = []
    const handle = {
      version: () => String(version),
      snapshot: () => ({ slides: [] }),
      addUndoBoundary: () => void calls.push('boundary'),
      insertText: (...args: unknown[]) => {
        calls.push(`insertText:${args.join(',')}`)
        version += 1
        return { storyId: 's' }
      },
      noop: () => 'nothing',
      undo: () => ({ applied: true }),
      save: () => new Uint8Array([7, 7]),
      dispose: () => void calls.push('dispose'),
      onUpdate: (listener: (update: Uint8Array, origin: 'local' | 'remote') => void) => {
        updateListeners.add(listener)
        return () => updateListeners.delete(listener)
      },
    }
    return { handle, calls, push: (origin: 'local' | 'remote') => updateListeners.forEach((l) => l(new Uint8Array(), origin)) }
  }

  it('apply：直接调句柄的同名方法；版本号变了才算生效', () => {
    const { handle, calls } = fakeHandle()
    const driver = handleDriver(handle as never)
    expect(driver.apply('insertText', ['s', 0, 'x'])).toEqual({ applied: true, result: { storyId: 's' } })
    expect(calls).toEqual(['insertText:s,0,x'])
    expect(driver.apply('noop' as never, [])).toEqual({ applied: false, result: 'nothing' })
  })

  it('撤销栈切刀、保存、恢复副本都走句柄；释放时先收尾协同提供者', async () => {
    const { handle, calls } = fakeHandle()
    const closed = vi.fn()
    const driver = handleDriver(handle as never, { dispose: closed })
    driver.boundary()
    expect(Array.from(await driver.save())).toEqual([7, 7])
    expect(Array.from((await driver.recover())!)).toEqual([7, 7])
    await driver.dispose()
    expect(closed).toHaveBeenCalled()
    expect(calls).toEqual(['boundary', 'dispose'])
  })

  it('远端更新才通知（本地更新已经由 apply 通知过，不能重复）；释放后不再通知', async () => {
    const { handle, push } = fakeHandle()
    const driver = handleDriver(handle as never)
    const seen = vi.fn()
    driver.onRemote!(seen)
    push('local')
    expect(seen).not.toHaveBeenCalled()
    push('remote')
    expect(seen).toHaveBeenCalledTimes(1)
    await driver.dispose()
    push('remote')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('后端接上协同通道：远端修改发 remote 通知并让缓存失效；失败通知经 fail 钩子', () => {
    const { handle, push } = fakeHandle()
    let failNow: (error: Error) => void = () => undefined
    const driver = handleDriver(handle as never, {
      fail: (listener) => {
        failNow = listener
        return () => undefined
      },
    })
    ;(driver as { access: unknown }).access = {
      version: () => '1',
      snapshot: () => ({ widthEmu: 12192000, heightEmu: 6858000, slides: [] }),
      layoutSlide: () => ({ width: 1280, height: 720, primitives: [] }),
      readContent: () => ({ ok: true, stories: [] }),
      story: () => ({ paragraphs: [] }),
      canUndo: () => false,
      canRedo: () => false,
      mediaBytes: () => new Uint8Array(),
      searchText: () => [],
    }
    const backend = new PptxEditBackend(driver, false)
    const seen: Array<{ remote: boolean }> = []
    backend.onChange((change) => seen.push(change))
    push('remote')
    expect(seen).toEqual([{ slides: 'all', remote: true }])
    const failures: Error[] = []
    backend.onFailure((error) => failures.push(error))
    failNow(new Error('协议错误'))
    expect(failures.map((e) => e.message)).toEqual(['协议错误'])
    expect(() => backend.insertText('story:slide:0:256:x:0', 0, 'a')).toThrow('协议错误')
  })
})
