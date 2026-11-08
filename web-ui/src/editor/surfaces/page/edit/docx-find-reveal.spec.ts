/**
 * 查找跳转回归：引擎回执比含新选区的几何帧早到时，滚动不能读到上一个命中的位置。
 *
 * 真实现象：机器忙时连按 30 次"下一个"，高亮落在可视区下方 700 多像素（e2e `docx-find-replace`
 * 只在负载高时失败，空闲时因帧来得快而侥幸通过）。原因是回执（ack）一到就去读 viewStore 里的选区几何，
 * 而带新选区的帧是之后才装进去的，读到的永远是上一次选中的位置，之后没有任何代码再滚一次。
 *
 * 这里用真的 `createFindBackend` + `DocxFindController`，只把引擎换成"回执立刻到、几何帧手动放行"的假货，
 * `reveal` 和产品里一样去读 viewStore 的选区几何。不依赖修复后的内部接口，所以修复前会红。
 */
import { describe, expect, it } from 'vitest'
import type { DocxEditEngine } from '../../../engines/docx'
import { createFindBackend } from './docx-find-backend'
import { DocxFindController } from './docx-find-controller'
import type { DocxMatch } from './docx-find'

/** 段落 pN 的文字在文档坐标里的 y：N * 100，方便断言"滚到了哪个命中" */
const yOfPara = (paraId: string) => Number(paraId.slice(1)) * 100

const matchIn = (paraId: string): DocxMatch => ({
  text: 'x',
  range: { story: 'body', start: { paraId, offset: 0 }, end: { paraId, offset: 1 }, view: 'accepted' },
})

/**
 * 假引擎：每次 select 立刻回执，对应的几何帧要等测试调 `deliverFrame` 才装进 viewStore。
 * `ackStatus` 用引擎真实的回执状态：选区命令不改文档，实测回执几乎总是 `noop`（35 个里 33 个），
 * 但新选区的几何照样随后一帧才到——所以 noop 和 applied 两种都要测
 */
function lagEngine(ackStatus: 'noop' | 'applied') {
  let geometry: { selectionRects: Array<{ y: number }>; caret: { y: number } | null } | null = { selectionRects: [{ y: 0 }], caret: null }
  const frames: Array<() => void> = []
  let seq = 0
  const engine = {
    flush: async () => undefined,
    client: {},
    binding: {
      viewStore: { getSnapshot: () => ({ geometry }) },
      commands: {
        submit(intent: { payload: { selection: { focus: { paraId: string } } } }) {
          seq += 1
          const y = yOfPara(intent.payload.selection.focus.paraId)
          let present!: (status: 'presented') => void
          const presented = new Promise<'presented'>((resolve) => (present = resolve))
          // 帧装好 = 先把几何装进 viewStore，再让 presented 落定（引擎里就是这个顺序）
          frames.push(() => {
            geometry = { selectionRects: [{ y }], caret: null }
            present('presented')
          })
          return { status: 'submitted', echoEnabled: false, ticket: { id: seq, seq, ack: Promise.resolve({ status: ackStatus, seq }), presented } }
        },
      },
    },
  } as unknown as DocxEditEngine
  return { engine, deliverFrame: (index: number) => frames[index]!(), frameCount: () => frames.length }
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

function setup(paragraphs: string[], ackStatus: 'noop' | 'applied') {
  const { engine, deliverFrame, frameCount } = lagEngine(ackStatus)
  const real = createFindBackend(engine, () => undefined)
  const matches = paragraphs.map(matchIn)
  // 只有 select 用真后端；查找 / 高亮不经引擎，换成固定数据
  const backend = {
    ...real,
    find: async () => ({ version: '1', matches, truncated: false }),
    highlights: async () => matches.map(() => []),
  }
  /** 每次 reveal 时读到的目标 y（和 DocxEditSurface 的 reveal 同一读法） */
  const revealedY: Array<number | undefined> = []
  const controller = new DocxFindController(backend, {
    onHighlights: () => undefined,
    reveal: () => {
      const geometry = engine.binding.viewStore.getSnapshot().geometry as { selectionRects: Array<{ y: number }>; caret: { y: number } | null } | null
      revealedY.push((geometry?.selectionRects?.[0] ?? geometry?.caret)?.y)
    },
    pageOf: () => 1,
  })
  return { controller, revealedY, deliverFrame, frameCount }
}

describe.each(['noop', 'applied'] as const)('查找跳转：回执（%s）早于几何帧', (ackStatus) => {
  it('回执到了、帧没到：不滚（滚也只会滚到上一个位置）；帧到了按新命中的位置滚', async () => {
    const { controller, revealedY, deliverFrame } = setup(['p1', 'p5', 'p9'], ackStatus)
    await controller.set('x')
    await flush()
    expect(revealedY).toEqual([])
    deliverFrame(0)
    await flush()
    expect(revealedY).toEqual([100])
  })

  it('连按下一个、帧都晚到：最后停在最后一个命中的位置，不是前一个', async () => {
    const { controller, revealedY, deliverFrame, frameCount } = setup(['p1', 'p5', 'p9', 'p14'], ackStatus)
    await controller.set('x')
    await controller.step(false)
    await controller.step(false)
    await controller.step(false)
    expect(controller.current.index).toBe(3)
    expect(frameCount()).toBe(4)
    // 几何帧按提交顺序一帧帧晚到
    for (let i = 0; i < 4; i += 1) {
      deliverFrame(i)
      await flush()
    }
    expect(revealedY.at(-1)).toBe(1400)
    // 中间的命中不该被滚到
    expect(revealedY).not.toContain(500)
    expect(revealedY).not.toContain(900)
  })

  it('每一步都等帧到了再按：每一步都滚到自己的命中', async () => {
    const { controller, revealedY, deliverFrame } = setup(['p1', 'p5', 'p9'], ackStatus)
    await controller.set('x')
    deliverFrame(0)
    await flush()
    await controller.step(false)
    deliverFrame(1)
    await flush()
    await controller.step(false)
    deliverFrame(2)
    await flush()
    expect(revealedY).toEqual([100, 500, 900])
  })

  it('帧一直不来也不卡住命令：下标照常前进', async () => {
    const { controller } = setup(['p1', 'p5', 'p9'], ackStatus)
    await controller.set('x')
    const stepped = await Promise.race([controller.step(false), new Promise((resolve) => setTimeout(() => resolve('卡住了'), 200))])
    expect(stepped).toMatchObject({ ok: true, data: { index: 1 } })
  })
})
