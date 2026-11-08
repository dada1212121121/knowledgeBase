// 表格比容器宽时,横向滚动区会拿到 tabindex=0 让键盘能滚(axe scrollable-region-focusable)。
// 能聚焦的区域必须有名字:axe 这条规则本身不查名字,读屏却会只念「区域」,所以这里单独守住;
// 不溢出时不加 role / 名字(不能多出一个没用的地标)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import KbDataTable from './KbDataTable.vue'
import KbResponsiveTable from './KbResponsiveTable.vue'

let sizes = { scrollWidth: 100, clientWidth: 100, scrollHeight: 50, clientHeight: 50 }

function stubLayout() {
  for (const key of Object.keys(sizes) as (keyof typeof sizes)[]) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => sizes[key] })
  }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
}

afterEach(() => {
  sizes = { scrollWidth: 100, clientWidth: 100, scrollHeight: 50, clientHeight: 50 }
  vi.unstubAllGlobals()
  for (const key of ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
})

const columns = [{ key: 'name', label: '名称' }]
const rows = [{ id: 'a', name: '甲' }]

describe.each([
  ['KbResponsiveTable', KbResponsiveTable, { cards: 'never' as const }],
  ['KbDataTable', KbDataTable, {}],
])('%s 的横向滚动区', (_name, Table, extra) => {
  it('溢出:可聚焦,且是带名字的区域(默认「数据表格」)', async () => {
    sizes.scrollWidth = 400
    stubLayout()
    const wrapper = mount(Table, { props: { columns, rows, ...extra } })
    await nextTick()
    await nextTick()
    const box = wrapper.find('.kb-scroll')
    expect(box.attributes('tabindex')).toBe('0')
    expect(box.attributes('role')).toBe('region')
    expect(box.attributes('aria-label')).toBe('数据表格')
  })

  it('调用方传了 label:用调用方的名字', async () => {
    sizes.scrollWidth = 400
    stubLayout()
    const wrapper = mount(Table, { props: { columns, rows, label: '调用记录', ...extra } })
    await nextTick()
    await nextTick()
    expect(wrapper.find('.kb-scroll').attributes('aria-label')).toBe('调用记录')
  })

  it('不溢出:不可聚焦,也不带 role / 名字', async () => {
    stubLayout()
    const wrapper = mount(Table, { props: { columns, rows, ...extra } })
    await nextTick()
    await nextTick()
    const box = wrapper.find('.kb-scroll')
    expect(box.attributes('tabindex')).toBeUndefined()
    expect(box.attributes('role')).toBeUndefined()
    expect(box.attributes('aria-label')).toBeUndefined()
  })
})
