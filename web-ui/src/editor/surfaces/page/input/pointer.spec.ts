/**
 * 页面指针手势单测：点击落点、双击 / 三击、Shift 扩选、拖选串行、触屏轻点与长按、缩放换算。
 * 用假 binding（记录提交的命令），不依赖真引擎；真实鼠标 / 触屏在 `e2e/docx-edit-ime.mjs` 与 `editor-native --surface=docx` 里验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PagePointerController, TOUCH_LONG_PRESS_MS, type PageGeometry, type PointerHost, type PointerLike } from './pointer'

type Submitted = { kind: string; payload: Record<string, any>; options: unknown }

const PAGE_A = { pageId: 'a', pageIndex: 0 }
const PAGE_B = { pageId: 'b', pageIndex: 1 }

function pages(): PageGeometry[] {
  return [
    { page: PAGE_A, bounds: { x: 0, y: 0, width: 600, height: 800 } },
    { page: PAGE_B, bounds: { x: 0, y: 820, width: 600, height: 800 } },
  ] as unknown as PageGeometry[]
}

function makeHost(left = 0, top = 0): PointerHost & { captured: Set<number> } {
  const captured = new Set<number>()
  return {
    captured,
    getBoundingClientRect: () => ({ left, top, width: 600, height: 1640 }),
    setPointerCapture: (id) => void captured.add(id),
    releasePointerCapture: (id) => void captured.delete(id),
    hasPointerCapture: (id) => captured.has(id),
    style: { touchAction: 'pan-x pan-y' },
  }
}

let clock = 1000
function ptr(init: Partial<PointerLike>): PointerLike {
  return {
    type: 'pointerdown',
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    isPrimary: true,
    detail: 1,
    timeStamp: (clock += 50),
    clientX: 100,
    clientY: 100,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...init,
  }
}

function setup(options: { zoom?: number; compose?: boolean } = {}) {
  const submitted: Submitted[] = []
  const acks: Array<() => void> = []
  const setProvisionalCaret = vi.fn()
  const snapshot = { geometry: { frameEpoch: 3, layoutRevision: 2, coversThroughSeq: 0, pages: pages() }, throughSeq: 0, provisionalCaret: null as unknown }
  const focusInput = vi.fn()
  const onDragSelectionChange = vi.fn()
  const controller = new PagePointerController({
    binding: {
      viewStore: { getSnapshot: () => snapshot, setProvisionalCaret } as never,
      admission: { getSnapshot: () => ({ tail: undefined, compositionSlot: null, readOnly: false }) } as never,
      commands: {
        submit: (intent: { kind: string; payload: Record<string, any> }, opts: unknown) => {
          submitted.push({ kind: intent.kind, payload: intent.payload, options: opts })
          const seq = submitted.length
          return {
            status: 'submitted',
            ticket: {
              seq,
              ack: new Promise<void>((resolve) => acks.push(resolve)),
              presented: Promise.resolve(),
            },
          }
        },
      } as never,
    },
    getZoom: () => options.zoom ?? 1,
    getWidth: () => 600,
    focusInput,
    isCompositionActive: () => options.compose === true,
    onDragSelectionChange,
  })
  return { controller, submitted, acks, focusInput, onDragSelectionChange, setProvisionalCaret, snapshot }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('鼠标点击', () => {
  it('单击提交 selectPoint，带页面标识、页内坐标、帧与版面版本，并把焦点交回输入框', () => {
    const { controller, submitted, focusInput } = setup()
    const host = makeHost()
    controller.notePress()
    controller.onPointerDown(ptr({ clientX: 120, clientY: 220 }), host)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.kind).toBe('selectPoint')
    expect(submitted[0]!.payload).toMatchObject({ page: PAGE_A, x: 120, y: 220, frameEpoch: 3, layoutRevision: 2, clickCount: 1 })
    expect(focusInput).toHaveBeenCalled()
    expect(host.captured.has(1)).toBe(true)
  })

  it('点在第二页上：坐标换算到该页内', () => {
    const { controller, submitted } = setup()
    controller.notePress()
    controller.onPointerDown(ptr({ clientX: 50, clientY: 900 }), makeHost())
    expect(submitted[0]!.payload).toMatchObject({ page: PAGE_B, x: 50, y: 80 })
  })

  it('宿主有偏移和缩放：按 (client - host) / zoom 还原页面坐标', () => {
    const { controller, submitted } = setup({ zoom: 2 })
    controller.notePress()
    controller.onPointerDown(ptr({ clientX: 300, clientY: 250 }), makeHost(100, 50))
    expect(submitted[0]!.payload).toMatchObject({ page: PAGE_A, x: 100, y: 100 })
  })

  it('点在页面外的空白不落点', () => {
    const { controller, submitted } = setup()
    controller.notePress()
    controller.onPointerDown(ptr({ clientX: 900, clientY: 100 }), makeHost())
    expect(submitted).toHaveLength(0)
  })

  it('非主键 / 第二根触点不处理', () => {
    const { controller, submitted } = setup()
    controller.onPointerDown(ptr({ button: 2 }), makeHost())
    controller.onPointerDown(ptr({ pointerType: 'touch', isPrimary: false }), makeHost())
    expect(submitted).toHaveLength(0)
  })

  it('没有几何（引擎还没出第一帧）时不处理', () => {
    const { controller, submitted, snapshot } = setup()
    ;(snapshot as { geometry: unknown }).geometry = null
    controller.notePress()
    controller.onPointerDown(ptr({}), makeHost())
    expect(submitted).toHaveLength(0)
  })
})

describe('双击 / 三击', () => {
  const click = (c: ReturnType<typeof setup>, host: PointerHost, init: Partial<PointerLike> = {}) => {
    c.controller.notePress()
    c.controller.onPointerDown(ptr(init), host)
    c.controller.onPointerUp(ptr({ type: 'pointerup', buttons: 0, ...init }), host)
  }

  it('间隔 <500ms 且位移 <5px 的连续点击依次是 1、2、3，第四下回到 1', () => {
    const c = setup()
    const host = makeHost()
    for (let index = 0; index < 4; index += 1) click(c, host, { timeStamp: 2000 + index * 100 })
    expect(c.submitted.map((entry) => entry.payload.clickCount)).toEqual([1, 2, 3, 1])
  })

  it('间隔太久不算连击', () => {
    const c = setup()
    const host = makeHost()
    click(c, host, { timeStamp: 2000 })
    click(c, host, { timeStamp: 2800 })
    expect(c.submitted.map((entry) => entry.payload.clickCount)).toEqual([1, 1])
  })

  it('位移超过 5px 不算连击', () => {
    const c = setup()
    const host = makeHost()
    click(c, host, { timeStamp: 2000, clientX: 100 })
    click(c, host, { timeStamp: 2100, clientX: 110 })
    expect(c.submitted.map((entry) => entry.payload.clickCount)).toEqual([1, 1])
  })

  it('两次点击之间有别处的按下（比如工具栏）不算连击', () => {
    const c = setup()
    const host = makeHost()
    click(c, host, { timeStamp: 2000 })
    c.controller.notePress()
    click(c, host, { timeStamp: 2100 })
    expect(c.submitted.map((entry) => entry.payload.clickCount)).toEqual([1, 1])
  })
})

describe('Shift 扩选与拖选', () => {
  it('Shift+点击把修饰键带进意图', () => {
    const c = setup()
    c.controller.notePress()
    c.controller.onPointerDown(ptr({ shiftKey: true }), makeHost())
    expect(c.submitted[0]!.payload.modifiers).toMatchObject({ shift: true })
  })

  it('按住拖动提交 extendSelection；上一次没回执时只保留最新位置，回执后再发', async () => {
    const c = setup()
    const host = makeHost()
    c.controller.notePress()
    c.controller.onPointerDown(ptr({ clientX: 100, clientY: 100 }), host)
    c.submitted.length = 0
    c.controller.onPointerMove(ptr({ type: 'pointermove', clientX: 150, clientY: 100 }), host)
    c.controller.onPointerMove(ptr({ type: 'pointermove', clientX: 200, clientY: 100 }), host)
    c.controller.onPointerMove(ptr({ type: 'pointermove', clientX: 250, clientY: 100 }), host)
    expect(c.onDragSelectionChange).toHaveBeenCalledWith(true)
    // 第一次在飞，后两次合并成最新位置，暂不发出
    expect(c.submitted.map((entry) => entry.kind)).toEqual(['extendSelection'])
    expect(c.submitted[0]!.payload.x).toBe(150)
    c.acks[c.acks.length - 1]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(c.submitted.map((entry) => entry.payload.x)).toEqual([150, 250])
  })

  it('松开鼠标释放指针捕获，并把挂起的最后一个位置发出去', () => {
    const c = setup()
    const host = makeHost()
    c.controller.notePress()
    c.controller.onPointerDown(ptr({ clientX: 100 }), host)
    c.controller.onPointerMove(ptr({ type: 'pointermove', clientX: 150 }), host)
    c.controller.onPointerMove(ptr({ type: 'pointermove', clientX: 220 }), host)
    c.controller.onPointerUp(ptr({ type: 'pointerup', buttons: 0, clientX: 220 }), host)
    expect(host.captured.size).toBe(0)
    expect(c.submitted.at(-1)!.payload.x).toBe(220)
  })

  it('没按住（buttons=0）的移动不扩选', () => {
    const c = setup()
    const host = makeHost()
    c.controller.notePress()
    c.controller.onPointerDown(ptr({}), host)
    c.submitted.length = 0
    c.controller.onPointerMove(ptr({ type: 'pointermove', buttons: 0, clientX: 300 }), host)
    expect(c.submitted).toHaveLength(0)
  })
})

describe('触屏', () => {
  const touch = (init: Partial<PointerLike> = {}) => ptr({ pointerType: 'touch', ...init })

  it('轻点 = 落点；按下时先不提交（可能是滚动）', () => {
    const c = setup()
    const host = makeHost()
    c.controller.notePress()
    c.controller.onPointerDown(touch({}), host)
    expect(c.submitted).toHaveLength(0)
    c.controller.onPointerUp(touch({ type: 'pointerup', buttons: 0 }), host)
    expect(c.submitted.map((entry) => entry.kind)).toEqual(['selectPoint'])
  })

  it('位移超过阈值（滚动）不落点，长按计时也被取消', () => {
    const c = setup()
    const host = makeHost()
    c.controller.notePress()
    c.controller.onPointerDown(touch({}), host)
    c.controller.onPointerMove(touch({ type: 'pointermove', clientY: 140 }), host)
    c.controller.onPointerUp(touch({ type: 'pointerup', buttons: 0, clientY: 140 }), host)
    vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS + 100)
    expect(c.submitted).toHaveLength(0)
  })

  it('长按 500ms 进入选择：落点、捕获指针、禁止页面滚动；松开后恢复滚动', () => {
    const c = setup()
    const host = makeHost()
    c.controller.notePress()
    c.controller.onPointerDown(touch({}), host)
    vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS + 1)
    expect(c.submitted.map((entry) => entry.kind)).toEqual(['selectPoint'])
    expect(c.controller.isTouchSelecting()).toBe(true)
    expect(host.style.touchAction).toBe('none')
    c.controller.onPointerMove(touch({ type: 'pointermove', clientX: 220 }), host)
    expect(c.submitted.at(-1)!.kind).toBe('extendSelection')
    c.controller.onPointerUp(touch({ type: 'pointerup', buttons: 0, clientX: 220 }), host)
    expect(c.controller.isTouchSelecting()).toBe(false)
    expect(host.style.touchAction).toBe('pan-x pan-y')
    expect(host.captured.size).toBe(0)
  })

  it('长按之前松开：不进入选择', () => {
    const c = setup()
    const host = makeHost()
    c.controller.notePress()
    c.controller.onPointerDown(touch({}), host)
    vi.advanceTimersByTime(TOUCH_LONG_PRESS_MS - 100)
    c.controller.onPointerUp(touch({ type: 'pointerup', buttons: 0 }), host)
    vi.advanceTimersByTime(500)
    expect(c.controller.isTouchSelecting()).toBe(false)
  })
})
