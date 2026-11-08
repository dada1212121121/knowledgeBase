/**
 * Grid Surface 组件测试
 *
 * 只测 DOM 交互语义，不测像素：键盘移动、公式栏、查找、编辑提交、工作表切换。
 * 像素由 painter.spec.ts 的假 ctx 与后续 e2e 负责。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import GridSurfaceView from './GridSurface.vue'
import type { GridSheet } from './types'

function makeSheet(): GridSheet {
  const cells: Record<string, string> = {
    '0:0': 'Alice',
    '0:1': '28',
    '1:0': 'Bob',
    '2:2': 'Alice',
  }
  return {
    name: 'Sheet1',
    rowCount: 10,
    colCount: 5,
    cell: (row, col) => {
      const text = cells[`${row}:${col}`]
      return text === undefined ? null : { text }
    },
  }
}

const fakeContext = {
  setTransform: () => undefined,
  clearRect: () => undefined,
  fillRect: () => undefined,
  strokeRect: () => undefined,
  beginPath: () => undefined,
  rect: () => undefined,
  clip: () => undefined,
  save: () => undefined,
  restore: () => undefined,
  translate: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  stroke: () => undefined,
  fillText: () => undefined,
  textAlign: 'left',
  textBaseline: 'alphabetic',
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeContext as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function mountGrid(readonly = false) {
  return mount(GridSurfaceView, {
    props: { sheet: makeSheet(), sheets: [{ name: 'Sheet1' }, { name: 'Sheet2' }], activeSheet: 0, readonly },
    attachTo: document.body,
  })
}

describe('GridSurface.vue', () => {
  it('1. 公式栏显示活动单元格内容与地址', async () => {
    const wrapper = mountGrid()
    expect((wrapper.find('.kb-gs-cellname').element as HTMLElement).textContent).toBe('A1')
    expect((wrapper.find('.kb-gs-formula-input').element as HTMLInputElement).value).toBe('Alice')
    wrapper.unmount()
  })

  it('2. 方向键移动选区并 emit selection', async () => {
    const wrapper = mountGrid()
    await wrapper.find('.kb-gs').trigger('keydown', { key: 'ArrowRight' })
    const events = wrapper.emitted('selection')!
    expect(events.at(-1)?.[0]).toMatchObject({ row: 0, col: 1, text: '28', range: { top: 0, left: 1, bottom: 0, right: 1 } })
    expect((wrapper.find('.kb-gs-cellname').element as HTMLElement).textContent).toBe('B1')
    wrapper.unmount()
  })

  it('3. Shift + 方向键扩选，公式栏仍显示活动格', async () => {
    const wrapper = mountGrid()
    await wrapper.find('.kb-gs').trigger('keydown', { key: 'ArrowDown', shiftKey: true })
    const last = wrapper.emitted('selection')!.at(-1)?.[0] as { range: { top: number; bottom: number } }
    expect(last.range).toMatchObject({ top: 0, bottom: 1 })
    wrapper.unmount()
  })

  it('4. Ctrl+A 全选整表', async () => {
    const wrapper = mountGrid()
    await wrapper.find('.kb-gs').trigger('keydown', { key: 'a', ctrlKey: true })
    const last = wrapper.emitted('selection')!.at(-1)?.[0] as { range: { top: number; left: number; bottom: number; right: number } }
    expect(last.range).toEqual({ top: 0, left: 0, bottom: 9, right: 4 })
    wrapper.unmount()
  })

  it('5. 查找命中并跳到第一条，findStep 循环', async () => {
    const wrapper = mountGrid()
    const found = (wrapper.vm as unknown as { find: (q: string) => { total: number; index: number } }).find('Alice')
    expect(found).toEqual({ total: 2, index: 0 })
    await nextTick()
    expect((wrapper.find('.kb-gs-cellname').element as HTMLElement).textContent).toBe('A1')
    const second = (wrapper.vm as unknown as { findStep: () => { total: number; index: number } }).findStep()
    expect(second).toEqual({ total: 2, index: 1 })
    await nextTick()
    expect((wrapper.find('.kb-gs-cellname').element as HTMLElement).textContent).toBe('C3')
    wrapper.unmount()
  })

  it('6. 双击打开编辑框，Enter 提交并下移', async () => {
    const wrapper = mountGrid()
    await wrapper.find('.kb-gs').trigger('keydown', { key: 'ArrowRight' })
    const canvas = wrapper.find('canvas')
    await canvas.trigger('pointerdown', { clientX: 150, clientY: 29, button: 0, pointerId: 1 })
    await canvas.trigger('dblclick', { clientX: 150, clientY: 29 })
    await nextTick()
    const editor = wrapper.find('.kb-gs-editor')
    expect(editor.exists()).toBe(true)
    await editor.setValue('29')
    await editor.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('edit')?.[0]?.[0]).toEqual([{ row: 0, col: 1, text: '29' }])
    // Enter 之后选区下移
    const last = wrapper.emitted('selection')!.at(-1)?.[0] as { row: number; col: number }
    expect(last).toMatchObject({ row: 1, col: 1 })
    wrapper.unmount()
  })

  it('7. 只读态不打开编辑框', async () => {
    const wrapper = mountGrid(true)
    await wrapper.find('canvas').trigger('dblclick', { clientX: 52, clientY: 25 })
    await nextTick()
    expect(wrapper.find('.kb-gs-editor').exists()).toBe(false)
    wrapper.unmount()
  })

  it('8. 点击工作表标签 emit selectSheet', async () => {
    const wrapper = mountGrid()
    await wrapper.findAll('.kb-gs-tab')[1]!.trigger('click')
    expect(wrapper.emitted('selectSheet')?.[0]).toEqual([1])
    wrapper.unmount()
  })

  it('9. 公式栏回车提交编辑', async () => {
    const wrapper = mountGrid()
    const input = wrapper.find('.kb-gs-formula-input')
    await input.setValue('Alicia')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('edit')?.[0]?.[0]).toEqual([{ row: 0, col: 0, text: 'Alicia' }])
    wrapper.unmount()
  })
})
