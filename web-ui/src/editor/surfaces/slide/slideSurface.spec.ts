/**
 * Slide Surface 外壳测试
 *
 * 渲染后端换成假后端（见 fakeBackend.ts），Canvas 换成什么都不做的 2D 上下文——
 * 真实引擎的画面、30 页首屏耗时、手机视口这些要真浏览器才有意义，在 e2e `--surface=pptx-read` 里验。
 * 这里验外壳自己的逻辑：加载状态机、翻页、缩略图、备注、查找、放映、命令、失败路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { DocumentSession, EditorCommand, SurfaceContext } from '../../types'
import { makeFakeBackend, stubCanvas, type FakeBackend, type FakeBackendOptions } from './fakeBackend'
import { SlideSurface } from './surface'

let restoreCanvas: () => void = () => undefined
const mounted: Array<{ surface: SlideSurface; el: HTMLElement }> = []

beforeEach(() => {
  restoreCanvas = stubCanvas()
})
afterEach(() => {
  for (const { surface, el } of mounted.splice(0)) {
    surface.unmount()
    el.remove()
  }
  restoreCanvas()
})

interface Harness {
  surface: SlideSurface
  el: HTMLElement
  backend: FakeBackend
  stats: ReturnType<typeof vi.fn>
  errors: Error[]
}

async function mountSlides(options: FakeBackendOptions = {}, hint?: SurfaceContext['document']['hint'], load?: () => Promise<FakeBackend>): Promise<Harness> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const backend = makeFakeBackend(options)
  const stats = vi.fn()
  const errors: Error[] = []
  const ctx = {
    session: { getSelection: () => null, setSnapshotProvider: () => undefined } as unknown as DocumentSession,
    document: { kind: 'slide', format: 'pptx', revision: 0, payload: { kind: 'bytes', name: 'deck.pptx', bytes: new Uint8Array() }, hint },
    permissions: { read: true, write: false, comment: false, ai: false, export: false },
    readonly: true,
    onStatsChange: stats,
    onError: (error: Error) => errors.push(error),
    onDirtyChange: () => undefined,
  } as unknown as SurfaceContext
  const surface = new SlideSurface(() => async () => (load ? load() : backend))
  await surface.mount(el, ctx)
  mounted.push({ surface, el })
  await vi.waitFor(() => expect(el.querySelector('[data-state]')?.getAttribute('data-state')).not.toBe('loading'))
  // 打开被拆成几个宏任务（每段让出一次主线程，避免合成一个长任务）：等第一页真的画上去（data-painted）才算打开完成，
  // 出错的场景（状态是 error）没有画面，直接往下走
  const root = () => el.querySelector('[data-testid="slide-surface"]')
  await vi.waitFor(() => expect(root()?.getAttribute('data-state') === 'error' || Number(root()?.getAttribute('data-painted')) >= 1).toBe(true))
  await flushPromises()
  return { surface, el, backend, stats, errors }
}

const cmd = (type: string, args?: unknown): EditorCommand => ({ id: type, type, args, source: 'user' })
const state = (el: HTMLElement) => el.querySelector('[data-testid="slide-surface"]')!.getAttribute('data-state')
const slideOf = (el: HTMLElement) => Number(el.querySelector('[data-testid="slide-surface"]')!.getAttribute('data-slide'))
const click = (el: HTMLElement, testid: string) => (el.querySelector(`[data-testid="${testid}"]`) as HTMLElement).click()

describe('Slide Surface 外壳', () => {
  it('打开：加载完成后显示页数、画布、缩略图；通知宿主刷新统计', async () => {
    const { el, backend, stats } = await mountSlides({ count: 5 })
    expect(state(el)).toBe('ready')
    expect(el.querySelector('[data-testid="slide-total"]')!.textContent).toContain('5')
    expect(el.querySelectorAll('[data-testid="slide-thumb"]')).toHaveLength(5)
    expect(el.querySelector('[data-testid="slide-canvas"]')!.getAttribute('aria-label')).toContain('第 1 张，共 5 张：标题 1')
    expect(backend.log.paint[0]).toBe(0)
    expect(stats).toHaveBeenCalled()
  })

  it('当前页优先：第一次绘制的是当前页，缩略图随后在后台生成，并且离当前页近的先画', async () => {
    const { el, backend } = await mountSlides({ count: 6 }, { anchor: { kind: 'slide', slide: 4 } })
    expect(slideOf(el)).toBe(3)
    expect(backend.log.paint[0]).toBe(3)
    // 后台：相邻页预渲染 + 缩略图都会被画出来
    await vi.waitFor(() => expect(new Set(backend.log.paint).size).toBe(6), { timeout: 3000 })
    // 紧接当前页之后画的是相邻页，而不是第 0 页
    expect(backend.log.paint.slice(1, 3).every((index) => Math.abs(index - 3) <= 2)).toBe(true)
  })

  it('翻页：按钮、页码输入、PageDown / Home / End、越界夹取', async () => {
    const { el } = await mountSlides({ count: 5 })
    click(el, 'slide-next')
    await flushPromises()
    expect(slideOf(el)).toBe(1)
    const input = el.querySelector('[data-testid="slide-page"]') as HTMLInputElement
    expect(input.value).toBe('2')
    input.value = '4'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(slideOf(el)).toBe(3)
    input.value = '99'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('blur'))
    await flushPromises()
    expect(slideOf(el)).toBe(4)
    expect(input.value).toBe('5')
    const stage = el.querySelector('[data-testid="slide-stage"]') as HTMLElement
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await flushPromises()
    expect(slideOf(el)).toBe(0)
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    await flushPromises()
    expect(slideOf(el)).toBe(1)
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flushPromises()
    expect(slideOf(el)).toBe(4)
    expect((el.querySelector('[data-testid="slide-next"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('点缩略图跳页，并给当前页打上 aria-current', async () => {
    const { el } = await mountSlides({ count: 5 })
    const thumbs = el.querySelectorAll<HTMLElement>('[data-testid="slide-thumb"]')
    thumbs[3]!.click()
    await flushPromises()
    expect(slideOf(el)).toBe(3)
    expect(thumbs[3]!.getAttribute('aria-current')).toBe('true')
    expect(thumbs[0]!.getAttribute('aria-current')).toBeNull()
  })

  it('备注：有备注的页显示内容，没备注的页显示占位；整份都没备注就没有备注按钮', async () => {
    const { el } = await mountSlides({ count: 3, notes: { 1: '先讲收益，再讲风险。' } })
    expect(el.querySelector('[data-testid="slide-notes-toggle"]')).not.toBeNull()
    // 宽屏且整份有备注：默认展开
    expect(el.querySelector('[data-testid="slide-notes"]')!.textContent).toContain('这一页没有备注')
    click(el, 'slide-next')
    await flushPromises()
    expect(el.querySelector('[data-testid="slide-notes"]')!.textContent).toContain('先讲收益，再讲风险。')
    click(el, 'slide-notes-toggle')
    await flushPromises()
    expect(el.querySelector('[data-testid="slide-notes"]')).toBeNull()

    const plain = await mountSlides({ count: 3 })
    expect(plain.el.querySelector('[data-testid="slide-notes-toggle"]')).toBeNull()
  })

  it('查找：计数、逐个跳页、Esc 清除；命中高亮画在 overlay 上', async () => {
    const { surface, el } = await mountSlides({ count: 4, texts: { 0: 'alpha', 1: 'beta', 2: 'alpha alpha', 3: 'gamma' } })
    const found = await surface.command(cmd('search.set', { query: 'alpha' }))
    expect(found.ok).toBe(true)
    expect(found.data).toMatchObject({ query: 'alpha', total: 3, index: 0 })
    await flushPromises()
    expect(el.querySelectorAll('.kb-sl-hit')).toHaveLength(1)
    const second = await surface.command(cmd('search.next'))
    expect(second.data).toMatchObject({ total: 3, index: 1 })
    await flushPromises()
    expect(slideOf(el)).toBe(2)
    expect(el.querySelectorAll('.kb-sl-hit')).toHaveLength(2)
    expect(el.querySelectorAll('.kb-sl-hit.is-active')).toHaveLength(1)
    const wrapped = await surface.command(cmd('search.prev'))
    expect(wrapped.data).toMatchObject({ index: 0 })
    await flushPromises()
    expect(slideOf(el)).toBe(0)
    const none = await surface.command(cmd('search.set', { query: 'zzz' }))
    expect(none.data).toMatchObject({ total: 0, index: -1 })
    await surface.command(cmd('search.set', { query: 'alpha' }))
    await surface.command(cmd('search.close'))
    await flushPromises()
    expect(el.querySelectorAll('.kb-sl-hit')).toHaveLength(0)
  })

  it('检索命中：翻到命中页并高亮；命中文字不在可见文字里时提示在备注或图片中', async () => {
    const hit = await mountSlides({ count: 5 }, { text: '第 3 页的正文 alpha beta', anchor: { kind: 'slide', slide: 3 } })
    expect(slideOf(hit.el)).toBe(2)
    expect(hit.el.querySelectorAll('.kb-sl-hit').length).toBeGreaterThan(0)
    expect(hit.el.textContent).not.toContain('命中在备注或图片中')
    const miss = await mountSlides({ count: 5 }, { text: '只存在于备注里的句子', anchor: { kind: 'slide', slide: 2 } })
    expect(slideOf(miss.el)).toBe(1)
    expect(miss.el.textContent).toContain('命中在备注或图片中')
  })

  it('放映：从当前页开始，键盘翻页、跳过隐藏页、Esc 退出并回到放映时的那一页', async () => {
    const { el } = await mountSlides({ count: 5, hidden: [2] })
    click(el, 'slide-next')
    await flushPromises()
    click(el, 'slide-present-btn')
    await flushPromises()
    const present = () => document.querySelector('[data-testid="slide-present"]')
    expect(present()).not.toBeNull()
    expect(document.querySelector('[data-testid="slide-present-no"]')!.textContent).toContain('2 / 5')
    const press = async (key: string) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await flushPromises()
    }
    await press('ArrowRight')
    // 第 3 张是隐藏页：直接到第 4 张
    expect(document.querySelector('[data-testid="slide-present-no"]')!.textContent).toContain('4 / 5')
    await press('ArrowLeft')
    expect(document.querySelector('[data-testid="slide-present-no"]')!.textContent).toContain('2 / 5')
    await press('End')
    expect(document.querySelector('[data-testid="slide-present-no"]')!.textContent).toContain('5 / 5')
    await press('Escape')
    expect(present()).toBeNull()
    expect(slideOf(el)).toBe(4)
  })

  it('放映：触屏左滑下一页、右滑上一页、点右侧下一页、点左侧上一页', async () => {
    const { el } = await mountSlides({ count: 5 })
    click(el, 'slide-present-btn')
    await flushPromises()
    const root = document.querySelector('[data-testid="slide-present"]') as HTMLElement
    const no = () => document.querySelector('[data-testid="slide-present-no"]')!.textContent
    // jsdom 没有 PointerEvent：用同名的 MouseEvent 并补上 pointerId，组件只读 clientX / clientY / pointerId
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      root.dispatchEvent(event)
    }
    const gesture = async (from: [number, number], to: [number, number]) => {
      pointer('pointerdown', from[0], from[1])
      pointer('pointerup', to[0], to[1])
      await flushPromises()
    }
    await gesture([300, 100], [100, 110])
    expect(no()).toContain('2 / 5')
    await gesture([100, 100], [300, 105])
    expect(no()).toContain('1 / 5')
    // jsdom 里视口宽度是 1024：右侧 1/3 之外 = 下一页
    await gesture([900, 300], [900, 300])
    expect(no()).toContain('2 / 5')
    await gesture([100, 300], [100, 300])
    expect(no()).toContain('1 / 5')
  })

  it('命令：缩放、跳转锚点、选页；写命令一律拒绝', async () => {
    const { surface, el } = await mountSlides({ count: 5 })
    expect((await surface.command(cmd('nav.anchor', { anchor: { kind: 'slide', slide: 4 } }))).ok).toBe(true)
    await flushPromises()
    expect(slideOf(el)).toBe(3)
    expect((await surface.command(cmd('nav.anchor', { anchor: { kind: 'cell', sheet: 'a', cell: 'A1' } }))).ok).toBe(false)
    expect((await surface.command(cmd('slide.select', { index: 1 }))).ok).toBe(true)
    await flushPromises()
    expect(slideOf(el)).toBe(1)
    const before = el.querySelector('[data-testid="slide-zoom"]')!.textContent
    await surface.command(cmd('zoom.in'))
    expect(el.querySelector('[data-testid="slide-zoom"]')!.textContent).not.toBe(before)
    await surface.command(cmd('zoom.fit'))
    expect(el.querySelector('[data-testid="slide-zoom"]')!.textContent).toBe(before)
    expect((await surface.command(cmd('mark.toggle', { mark: 'strong' }))).ok).toBe(false)
  })

  it('查询：页数、大纲（标题 + 1 起的锚点）、状态快照与恢复', async () => {
    const { surface, el } = await mountSlides({ count: 3 })
    expect(await surface.query({ type: 'wordCount' })).toEqual({ words: 3, unitLabel: '页' })
    expect(await surface.query({ type: 'outline' })).toEqual([
      { level: 1, text: '标题 1', anchor: { kind: 'slide', slide: 1 } },
      { level: 1, text: '标题 2', anchor: { kind: 'slide', slide: 2 } },
      { level: 1, text: '标题 3', anchor: { kind: 'slide', slide: 3 } },
    ])
    click(el, 'slide-next')
    await flushPromises()
    const saved = surface.capture()
    expect(saved).toMatchObject({ kind: 'slide', activeSlide: 1 })
    surface.restore({ ...saved, activeSlide: 2 })
    await flushPromises()
    expect(slideOf(el)).toBe(2)
  })

  it('读屏：画布有无障碍名称，当前页文字放在视觉隐藏的 live 区域里', async () => {
    const { el } = await mountSlides({ count: 2, texts: { 0: '第一页的要点' } })
    expect(el.querySelector('[data-testid="slide-sr"]')!.textContent).toContain('第一页的要点')
    expect(el.querySelector('[data-testid="slide-sr"]')!.getAttribute('aria-live')).toBe('polite')
  })

  it('后端加载失败：显示错误并通知宿主（宿主据此走回退链）', async () => {
    const { el, errors } = await mountSlides({}, undefined, async () => {
      throw new Error('这份演示文稿渲染失败')
    })
    expect(state(el)).toBe('error')
    expect(el.querySelector('[data-testid="slide-error"]')!.textContent).toContain('渲染失败')
    expect(errors.map((error) => error.message)).toContain('这份演示文稿渲染失败')
  })

  it('第一页就画不出来按整体失败处理；后面某一页画不出来只提示那一页', async () => {
    const first = await mountSlides({ count: 3, failPaint: [0] })
    expect(state(first.el)).toBe('error')
    expect(first.errors).toHaveLength(1)

    const later = await mountSlides({ count: 3, failPaint: [1] })
    expect(state(later.el)).toBe('ready')
    click(later.el, 'slide-next')
    await flushPromises()
    expect(later.el.querySelector('[data-testid="slide-page-error"]')!.textContent).toContain('第 2 张画不出来')
    click(later.el, 'slide-next')
    await flushPromises()
    expect(later.el.querySelector('[data-testid="slide-page-error"]')).toBeNull()
    expect(state(later.el)).toBe('ready')
  })

  it('没有幻灯片的文件是失败而不是空白', async () => {
    const { el } = await mountSlides({ count: 0 })
    expect(state(el)).toBe('error')
    expect(el.querySelector('[data-testid="slide-error"]')!.textContent).toContain('没有幻灯片')
  })

  it('卸载时释放后端（引擎内存）', async () => {
    const { surface, backend } = await mountSlides({ count: 2 })
    expect(backend.log.disposed).toBe(false)
    surface.unmount()
    await flushPromises()
    expect(backend.log.disposed).toBe(true)
  })

  it('后端提示（缺字体等）显示成提示条', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const backend = { ...makeFakeBackend({ count: 1 }), notices: () => ['字体 X 未内置，已用替代字体显示'] }
    const surface = new SlideSurface(() => async () => backend)
    mounted.push({ surface, el })
    await surface.mount(el, {
      session: { setSnapshotProvider: () => undefined } as unknown as DocumentSession,
      document: { kind: 'slide', format: 'pptx', revision: 0, payload: null },
      permissions: { read: true, write: false, comment: false, ai: false, export: false },
      readonly: true,
    } as unknown as SurfaceContext)
    await vi.waitFor(() => expect(el.querySelector('[data-testid="slide-notice"]')).not.toBeNull())
    expect(el.querySelector('[data-testid="slide-notice"]')!.textContent).toContain('字体 X')
  })
})
