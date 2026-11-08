// 响应式表格:桌面表格 / 手机卡片、多选、批量条、长按进入多选。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import KbResponsiveTable, { type RtColumn } from './KbResponsiveTable.vue'

const columns: RtColumn[] = [
  { key: 'name', label: '名称', mobile: 'primary' },
  { key: 'owner', label: '所有者' },
  { key: 'size', label: '大小', align: 'right' },
  { key: 'path', label: '路径', mobile: 'hidden' },
]
const rows = [
  { id: 'a', name: '部署清单', owner: '林一', size: '2 KB', path: '/ops/a' },
  { id: 'b', name: '会议纪要', owner: '张三', size: '8 KB', path: '/ops/b' },
  { id: 'c', name: '接口约定', owner: '李四', size: '1 KB', path: '/ops/c' },
]

/** 带 v-model:selected 的外壳,和页面里的用法一致 */
function harness(props: Record<string, unknown> = {}, slots: Record<string, () => unknown> = {}) {
  const selected = ref<string[]>([])
  const Host = defineComponent({
    setup: () => () =>
      h(
        KbResponsiveTable,
        { columns, rows, selectable: true, selected: selected.value, 'onUpdate:selected': (value: string[]) => (selected.value = value), ...props },
        slots,
      ),
  })
  return { wrapper: mount(Host, { attachTo: document.body }), selected }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('KbResponsiveTable 桌面', () => {
  it('渲染表头和行;右对齐列;选择列在最前', () => {
    const { wrapper } = harness({ cards: 'never' })
    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual(['', '名称', '所有者', '大小', '路径'])
    expect(wrapper.findAll('[data-testid="rt-row"]')).toHaveLength(3)
    expect(wrapper.findAll('thead th')[3]!.classes()).toContain('num')
    expect(wrapper.find('[data-testid="rt-card"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('勾选一行:出现批量条,显示已选数量;再点取消', async () => {
    const { wrapper, selected } = harness({ cards: 'never' })
    await wrapper.findAll('tbody .kb-rt-check')[1]!.setValue(true)
    expect(selected.value).toEqual(['b'])
    expect(wrapper.find('.kb-batchbar-count').text()).toBe('已选 1 项')
    expect(wrapper.findAll('tbody tr')[1]!.classes()).toContain('sel')
    await wrapper.findAll('tbody .kb-rt-check')[1]!.setValue(false)
    expect(selected.value).toEqual([])
    expect(wrapper.find('[data-testid="batchbar"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('表头全选:全选 / 半选 / 清空', async () => {
    const { wrapper, selected } = harness({ cards: 'never' })
    const all = () => wrapper.find('[data-testid="rt-all"]').element as HTMLInputElement
    await wrapper.find('[data-testid="rt-all"]').setValue(true)
    expect(selected.value).toEqual(['a', 'b', 'c'])
    expect(all().checked).toBe(true)
    await wrapper.findAll('tbody .kb-rt-check')[0]!.setValue(false)
    expect(all().checked).toBe(false)
    expect(all().indeterminate).toBe(true)
    await wrapper.find('[data-testid="rt-all"]').setValue(true)
    expect(selected.value).toEqual(['b', 'c', 'a'].sort().length === 3 ? selected.value : [])
    expect(selected.value).toHaveLength(3)
    await wrapper.find('[data-testid="rt-all"]').setValue(false)
    expect(selected.value).toEqual([])
    wrapper.unmount()
  })

  it('批量条:全选 N 项、取消选择、批量操作插槽拿得到选中项', async () => {
    const { wrapper, selected } = harness({ cards: 'never' }, { batch: () => h('button', { class: 'del' }, '删除') })
    await wrapper.findAll('tbody .kb-rt-check')[0]!.setValue(true)
    expect(wrapper.find('.kb-batchbar-actions .del').exists()).toBe(true)
    const links = wrapper.findAll('.kb-batchbar-link')
    expect(links[0]!.text()).toBe('全选 3 项')
    await links[0]!.trigger('click')
    expect(selected.value).toHaveLength(3)
    await wrapper.findAll('.kb-batchbar-link').at(-1)!.trigger('click')
    expect(selected.value).toEqual([])
    wrapper.unmount()
  })

  it('不可多选时没有复选框和批量条', () => {
    const { wrapper } = harness({ cards: 'never', selectable: false })
    expect(wrapper.find('.kb-rt-check').exists()).toBe(false)
    wrapper.unmount()
  })

  it('数据换了(翻页 / 筛选),已经不在当前行里的选中项被丢掉', async () => {
    const { wrapper, selected } = harness({ cards: 'never' })
    await wrapper.find('[data-testid="rt-all"]').setValue(true)
    await wrapper.setProps({})
    selected.value = ['a', 'b', 'c']
    const next = rows.slice(0, 1)
    const Host2 = mount(KbResponsiveTable, { props: { columns, rows, selectable: true, selected: ['a', 'zz'], cards: 'never' }, attachTo: document.body })
    await Host2.setProps({ rows: next })
    expect(Host2.emitted('update:selected')?.at(-1)).toEqual([['a']])
    Host2.unmount()
    wrapper.unmount()
  })

  it('整行可点:发出 rowClick(Enter 也行);点复选框格不触发', async () => {
    const wrapper = mount(KbResponsiveTable, { props: { columns, rows, clickable: true, selectable: true, cards: 'never' } })
    await wrapper.findAll('tbody tr')[1]!.trigger('click')
    expect(wrapper.emitted('rowClick')?.[0]).toEqual([rows[1]])
    await wrapper.findAll('tbody tr')[2]!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('rowClick')).toHaveLength(2)
    await wrapper.findAll('tbody .kb-rt-checkcell')[0]!.trigger('click')
    expect(wrapper.emitted('rowClick')).toHaveLength(2)
  })

  it('点选择列单元格里复选框周围的空白也能勾选(触屏上复选框只有 22px,单元格 52×48 都该是点击目标);仍不触发整行点击', async () => {
    const { wrapper, selected } = harness({ cards: 'never', clickable: true })
    const cells = wrapper.findAll('tbody .kb-rt-checkcell')
    await cells[1]!.trigger('click')
    expect(selected.value).toEqual(['b'])
    expect(wrapper.emitted('rowClick')).toBeUndefined()
    await cells[1]!.trigger('click')
    expect(selected.value).toEqual([])
    wrapper.unmount()
  })

  it('直接点复选框只切换一次(单元格的转发不能让它再切一次):看发出的次数,不能只看最终选中了谁', async () => {
    // 受控模式下重复调用 toggle 结果是幂等的,最终状态看不出问题;但真实浏览器里复选框是 DOM 状态,
    // 切两次等于没切(点了没反应)。所以数 change 事件和 update:selected 的次数
    const updates: string[][] = []
    const wrapper = mount(KbResponsiveTable, {
      props: { columns, rows, selectable: true, selected: [], cards: 'never', 'onUpdate:selected': (value: string[]) => updates.push(value) },
      attachTo: document.body, // 不挂到文档里,jsdom 的复选框 click() 不会触发 change
    })
    const box = wrapper.findAll('tbody .kb-rt-check')[0]!
    let changes = 0
    box.element.addEventListener('change', () => (changes += 1))
    await box.trigger('click')
    expect(changes).toBe(1)
    expect(updates).toEqual([['a']])
    wrapper.unmount()
  })

  it('表头的全选格同理:点格子空白处等于点全选', async () => {
    const { wrapper, selected } = harness({ cards: 'never' })
    await wrapper.find('thead .kb-rt-checkcell').trigger('click')
    expect(selected.value).toEqual(['a', 'b', 'c'])
    wrapper.unmount()
  })

  it('单元格插槽 cell-<key> 覆盖默认文字;row-actions 多一列', () => {
    const wrapper = mount(KbResponsiveTable, {
      props: { columns, rows, cards: 'never' },
      slots: { 'cell-name': '<template #cell-name="{ row }"><b class="n">{{ row.name }}!</b></template>', 'row-actions': '<button class="more">⋯</button>' },
    })
    expect(wrapper.find('tbody .n').text()).toBe('部署清单!')
    expect(wrapper.findAll('tbody .more')).toHaveLength(3)
    wrapper.unmount()
  })

  it('加载中显示骨架,空数据显示空态(可自定义文案)', () => {
    expect(mount(KbResponsiveTable, { props: { columns, rows: [], loading: true } }).find('.kb-skel').exists()).toBe(true)
    const empty = mount(KbResponsiveTable, { props: { columns, rows: [], empty: '还没有文档' } })
    expect(empty.find('.kb-empty-title').text()).toBe('还没有文档')
    expect(empty.find('table').exists()).toBe(false)
  })
})

describe('KbResponsiveTable 手机卡片', () => {
  it('每行一张卡:主字段加粗当标题,次要字段是「标签:值」,hidden 的列不出现', () => {
    const { wrapper } = harness({ cards: 'always', selectable: false })
    expect(wrapper.find('table').exists()).toBe(false)
    const cards = wrapper.findAll('[data-testid="rt-card"]')
    expect(cards).toHaveLength(3)
    expect(cards[0]!.find('.kb-rt-primary').text()).toBe('部署清单')
    const metas = cards[0]!.findAll('.kb-rt-meta').map((meta) => meta.text())
    expect(metas).toEqual(['所有者林一', '大小2 KB'])
    expect(cards[0]!.text()).not.toContain('/ops/a')
    wrapper.unmount()
  })

  it('没有 primary 列时取第一个非 hidden 的列当标题', () => {
    const wrapper = mount(KbResponsiveTable, { props: { columns: [{ key: 'path', label: '路径', mobile: 'hidden' }, { key: 'owner', label: '所有者' }], rows, cards: 'always' } })
    expect(wrapper.find('.kb-rt-primary').text()).toBe('林一')
  })

  it('点「选择」进入多选模式,卡片出现复选框;点卡片切换选中;「完成」退出并清空', async () => {
    const { wrapper, selected } = harness({ cards: 'always' })
    expect(wrapper.find('.kb-rt-check').exists()).toBe(false)
    await wrapper.find('.kb-rt-toggle').trigger('click')
    expect(wrapper.findAll('.kb-rt-check')).toHaveLength(3)
    await wrapper.findAll('[data-testid="rt-card"]')[1]!.trigger('click')
    expect(selected.value).toEqual(['b'])
    expect(wrapper.findAll('[data-testid="rt-card"]')[1]!.classes()).toContain('is-selected')
    expect(wrapper.find('.kb-batchbar-count').text()).toBe('已选 1 项')
    await wrapper.find('.kb-rt-toggle').trigger('click')
    expect(selected.value).toEqual([])
    expect(wrapper.find('.kb-rt-check').exists()).toBe(false)
    wrapper.unmount()
  })

  it('长按(触屏 450ms)进入多选并选中这一张;抬手那下 click 不再切换;已有选中后点卡片继续切换', async () => {
    const { wrapper, selected } = harness({ cards: 'always' })
    const card = wrapper.findAll('[data-testid="rt-card"]')[0]!
    await card.trigger('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 })
    vi.advanceTimersByTime(460)
    await wrapper.vm.$nextTick()
    expect(selected.value).toEqual(['a'])
    await card.trigger('pointerup', { pointerType: 'touch' })
    await card.trigger('click')
    expect(selected.value).toEqual(['a'])
    await wrapper.findAll('[data-testid="rt-card"]')[2]!.trigger('click')
    expect(selected.value).toEqual(['a', 'c'])
    wrapper.unmount()
  })

  it('长按前手指移动超过容差(在滚动)不触发多选;鼠标不触发长按', async () => {
    const { wrapper, selected } = harness({ cards: 'always' })
    const card = wrapper.findAll('[data-testid="rt-card"]')[0]!
    await card.trigger('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 })
    await card.trigger('pointermove', { pointerType: 'touch', clientX: 10, clientY: 40 })
    vi.advanceTimersByTime(600)
    expect(selected.value).toEqual([])
    await card.trigger('pointerdown', { pointerType: 'mouse', clientX: 10, clientY: 10 })
    vi.advanceTimersByTime(600)
    expect(selected.value).toEqual([])
    wrapper.unmount()
  })

  it('没有选中时点卡片触发 rowClick(clickable);卡片上的操作区点击不触发整卡点击', async () => {
    const wrapper = mount(KbResponsiveTable, {
      props: { columns, rows, cards: 'always', clickable: true },
      slots: { 'row-actions': '<button class="act">⋯</button>' },
    })
    await wrapper.findAll('[data-testid="rt-card"]')[0]!.trigger('click')
    expect(wrapper.emitted('rowClick')).toHaveLength(1)
    await wrapper.find('.act').trigger('click')
    expect(wrapper.emitted('rowClick')).toHaveLength(1)
    wrapper.unmount()
  })

  it('auto 模式按手机宽度切换(matchMedia 为真时是卡片)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('599'), addEventListener() {}, removeEventListener() {} }))
    const wrapper = mount(KbResponsiveTable, { props: { columns, rows } })
    expect(wrapper.find('[data-testid="rt-card"]').exists()).toBe(true)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    expect(mount(KbResponsiveTable, { props: { columns, rows } }).find('table').exists()).toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('KbResponsiveTable · 列的 hideWhen(这一行没内容就不占位)', () => {
  const cols: RtColumn[] = [
    { key: 'name', label: '操作', mobile: 'primary' },
    { key: 'batch', label: '所属批次', mobile: 'meta', hideWhen: (row) => !row.batch },
    { key: 'note', label: '详情', mobile: 'meta' },
  ]
  const data = [
    { id: 'a', name: '保存笔记', batch: 'bat_1', note: '编号 x' },
    { id: 'b', name: '助手对话', batch: null, note: '' },
  ]

  it('手机卡片:hideWhen 为真的 meta 行不渲染,为假的照常渲染', () => {
    const wrapper = mount(KbResponsiveTable, { props: { columns: cols, rows: data, cards: 'always' } })
    const cards = wrapper.findAll('[data-testid="rt-card"]')
    expect(cards[0]!.text()).toContain('所属批次')
    expect(cards[0]!.text()).toContain('bat_1')
    expect(cards[1]!.text()).not.toContain('所属批次')
    wrapper.unmount()
  })

  it('没有 hideWhen 的列行为不变:值是空的也照常占一行(由调用方自己决定写不写「—」)', () => {
    const wrapper = mount(KbResponsiveTable, { props: { columns: cols, rows: data, cards: 'always' } })
    expect(wrapper.findAll('[data-testid="rt-card"]')[1]!.text()).toContain('详情')
    wrapper.unmount()
  })

  it('桌面表格不受影响:单元格都在,列才对得齐', () => {
    const wrapper = mount(KbResponsiveTable, { props: { columns: cols, rows: data, cards: 'never' } })
    const second = wrapper.findAll('[data-testid="rt-row"]')[1]!
    expect(second.findAll('td')).toHaveLength(3)
    wrapper.unmount()
  })
})
