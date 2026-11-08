// CSV / TSV 预览：走紧凑解析（类型数组 + 按需取值），显示行为要和以前的整表数组一致。
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SheetViewer from './SheetViewer.vue'

function mountSheet(props: Record<string, unknown>) {
  return mount(SheetViewer, { props: { url: '', format: 'csv', ...props }, attachTo: document.body })
}
async function ready(wrapper: ReturnType<typeof mountSheet>) {
  for (let i = 0; i < 50 && wrapper.attributes('data-state') === 'loading'; i += 1) {
    await flushPromises()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const cellsOf = (wrapper: ReturnType<typeof mountSheet>, row: number) => wrapper.findAll('.kb-sg-row')[row]!.findAll('.kb-sg-cell').map((cell) => cell.text())

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SheetViewer CSV 预览', () => {
  it('解析完成前 data-state=loading，之后 ready；首行当表头，数据行带原行号', async () => {
    const wrapper = mountSheet({ text: '名称,数量\r\n苹果,3\r\n梨,5\r\n' })
    expect(wrapper.attributes('data-state')).toBe('loading')
    await ready(wrapper)
    expect(wrapper.attributes('data-state')).toBe('ready')
    expect(wrapper.findAll('.kb-sg-label').map((label) => label.text())).toEqual(['名称', '数量'])
    expect(cellsOf(wrapper, 0)).toEqual(['苹果', '3'])
    // 行号是原表行号：表头占第 1 行，第一条数据是第 2 行
    expect(wrapper.findAll('.kb-sg-row')[0]!.find('.kb-sg-no').text()).toBe('2')
    expect(wrapper.find('.kb-sg-count').text()).toContain('2 行 × 2 列')
    wrapper.unmount()
  })

  it('引号、引号内的逗号 / 换行 / 转义引号都按 CSV 规则还原', async () => {
    const wrapper = mountSheet({ text: 'a,b\n"含,逗号","说""你好""\n换行"\n' })
    await ready(wrapper)
    expect(cellsOf(wrapper, 0)).toEqual(['含,逗号', '说"你好"\n换行'])
    wrapper.unmount()
  })

  it('TSV 用制表符；分号分隔的 .csv 自动识别', async () => {
    const tsv = mountSheet({ format: 'tsv', text: '甲\t乙\n1\t2\n' })
    await ready(tsv)
    expect(cellsOf(tsv, 0)).toEqual(['1', '2'])
    tsv.unmount()
    const semi = mountSheet({ text: '甲;乙;丙\n1;2;3\n' })
    await ready(semi)
    expect(cellsOf(semi, 0)).toEqual(['1', '2', '3'])
    semi.unmount()
  })

  it('筛选只留包含关键词的行（行号仍是原行号）；点格子在编辑栏看到完整内容', async () => {
    const wrapper = mountSheet({ text: '名称,数量\n苹果,3\n香蕉,5\n苹果派,7\n' })
    await ready(wrapper)
    await wrapper.find('.kb-sg-filter').setValue('苹果')
    expect(wrapper.findAll('.kb-sg-row').map((row) => row.find('.kb-sg-no').text())).toEqual(['2', '4'])
    expect(wrapper.find('.kb-sg-count').text()).toContain('2 / 3 行')
    await wrapper.findAll('.kb-sg-row')[1]!.findAll('.kb-sg-cell')[0]!.trigger('click')
    expect(wrapper.find('.kb-sg-fx-text').text()).toBe('苹果派')
    expect(wrapper.find('.kb-sg-fx-ref').text()).toBe('A4')
    wrapper.unmount()
  })

  it('空表给出提示并发 error', async () => {
    const wrapper = mountSheet({ text: '\n\n', url: '/nowhere' })
    // text 是空白：走“拉原件”分支，原件拉不到时同样进入 error 状态，不会卡在 loading
    await ready(wrapper)
    expect(wrapper.attributes('data-state')).toBe('error')
    wrapper.unmount()
  })
})
