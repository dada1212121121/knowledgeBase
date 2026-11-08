// 共享给我的侧栏:分组 / 角色 / 多选(Ctrl、Shift、选择模式)/ 批量移出与放回 / 四种状态。
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SharedWithMeItem } from '@/api/share'
import { groupByOwner } from '@/utils/share'
import SharedSidebar from './SharedSidebar.vue'

const alice = { id: 'usr_a', username: 'alice', display_name: 'Alice', avatar: null }
const bob = { id: 'usr_b', username: 'bob', display_name: 'Bob', avatar: null }
const item = (owner: typeof alice, title: string, extra: Partial<SharedWithMeItem> = {}): SharedWithMeItem => ({
  target: { kind: 'insight', space_id: `sp_${owner.username}`, collection: '_global', id: title },
  key: `${owner.username}:${title}`,
  title,
  role: 'viewer',
  owner,
  shared_at: 1,
  expires_at: null,
  hidden: false,
  ...extra,
})
const ITEMS = [item(alice, 'A1'), item(alice, 'A2', { role: 'editor' }), item(alice, 'A3'), item(bob, 'B1', { target: { kind: 'dir', space_id: 'sp_bob', collection: '_global', path: 'docs' } })]

function mountSidebar(props: Record<string, unknown> = {}) {
  return mount(SharedSidebar, {
    props: { groups: groupByOwner(ITEMS), status: 'ready', errorText: '', activeKey: null, showHidden: false, hiddenCount: 0, ...props },
    attachTo: document.body,
  })
}
const row = (wrapper: ReturnType<typeof mount>, title: string) => wrapper.find(`[data-testid="shared-item-${title}"]`)

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

describe('显示', () => {
  it('按分享人分组;每行有内容名、类型和我的角色;当前打开的那行高亮', () => {
    const wrapper = mountSidebar({ activeKey: 'alice:A2' })
    expect(wrapper.findAll('.kb-ssb-owner').map((el) => `${el.find('.kb-ssb-owner-name').text()}${el.find('.kb-ssb-count').text()}`)).toEqual(['Alice3', 'Bob1'])
    expect(row(wrapper, 'A2').text()).toContain('笔记')
    expect(row(wrapper, 'A2').text()).toContain('可编辑')
    expect(row(wrapper, 'B1').text()).toContain('文件夹')
    expect(row(wrapper, 'B1').text()).toContain('可查看')
    expect(row(wrapper, 'A2').classes()).toContain('is-active')
    expect(row(wrapper, 'A1').classes()).not.toContain('is-active')
  })

  it('有到期日的共享写明到期;被移出的标「已移出」', () => {
    const wrapper = mountSidebar({
      groups: groupByOwner([item(alice, 'A1', { expires_at: new Date(2099, 10, 30).getTime() }), item(alice, 'A2', { hidden: true })], true),
      showHidden: true,
      hiddenCount: 1,
    })
    expect(row(wrapper, 'A1').text()).toContain('到期 2099-11-30')
    expect(row(wrapper, 'A2').text()).toContain('已移出')
  })

  it('点一行(没在选择)就是打开它', async () => {
    const wrapper = mountSidebar()
    await row(wrapper, 'A1').trigger('click')
    expect(wrapper.emitted('select')![0]![0]).toMatchObject({ key: 'alice:A1' })
  })
})

describe('四种状态', () => {
  it('加载中:骨架屏;报错:可重试;空:解释会出现什么', async () => {
    expect(mountSidebar({ status: 'loading' }).find('[aria-busy=true]').exists()).toBe(true)
    const failed = mountSidebar({ status: 'error', errorText: '共享给我的内容没有加载出来。检查网络后重试。' })
    expect(failed.find('[data-testid=shared-error]').text()).toContain('没有加载出来')
    await failed.find('[data-testid=shared-error] button').trigger('click')
    expect(failed.emitted('retry')).toHaveLength(1)
    const empty = mountSidebar({ groups: [] })
    expect(empty.find('[data-testid=shared-empty]').text()).toContain('还没有人分享内容给你')
    expect(empty.find('[data-testid=shared-empty]').text()).toContain('按分享人出现在这里')
  })

  it('全被移出了:不说「没人分享」,而是告诉他移出了、怎么放回', async () => {
    const wrapper = mountSidebar({ groups: [], hiddenCount: 3 })
    expect(wrapper.find('[data-testid=shared-empty]').text()).toContain('你把共享的内容都移出了列表')
    await wrapper.find('[data-testid=shared-empty] button').trigger('click')
    expect(wrapper.emitted('update:showHidden')![0]).toEqual([true])
  })

  it('「已移出」开关只在有被移出的内容(或已打开)时出现', () => {
    expect(mountSidebar().find('[data-testid=shared-show-hidden]').exists()).toBe(false)
    expect(mountSidebar({ hiddenCount: 2 }).find('[data-testid=shared-show-hidden]').exists()).toBe(true)
  })
})

describe('多选', () => {
  it('点「选择」进入选择模式:再点行是切换而不是打开;批量条显示已选数', async () => {
    const wrapper = mountSidebar()
    await wrapper.find('[data-testid=shared-select-toggle]').trigger('click')
    await row(wrapper, 'A1').trigger('click')
    await row(wrapper, 'A3').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(wrapper.find('[data-testid=batchbar]').text()).toContain('已选 2 项')
    expect(row(wrapper, 'A1').attributes('aria-pressed')).toBe('true')
    expect(row(wrapper, 'A2').attributes('aria-pressed')).toBe('false')
    await row(wrapper, 'A1').trigger('click')
    expect(wrapper.find('[data-testid=batchbar]').text()).toContain('已选 1 项')
  })

  it('Ctrl / ⌘ + 点击直接进入多选;Shift + 点击连选(按列表里看到的顺序,跨分享人也连)', async () => {
    const wrapper = mountSidebar()
    await row(wrapper, 'A1').trigger('click', { ctrlKey: true })
    expect(wrapper.find('[data-testid=batchbar]').text()).toContain('已选 1 项')
    await row(wrapper, 'B1').trigger('click', { shiftKey: true })
    expect(wrapper.find('[data-testid=batchbar]').text()).toContain('已选 4 项')
    const meta = mountSidebar()
    await row(meta, 'A2').trigger('click', { metaKey: true })
    expect(meta.find('[data-testid=batchbar]').text()).toContain('已选 1 项')
  })

  it('全选 / 取消选择', async () => {
    const wrapper = mountSidebar()
    await row(wrapper, 'A1').trigger('click', { ctrlKey: true })
    await wrapper.find('.kb-batchbar-link').trigger('click') // 全选 4 项
    expect(wrapper.find('[data-testid=batchbar]').text()).toContain('已选 4 项')
    const clear = wrapper.findAll('.kb-batchbar-link').at(-1)!
    await clear.trigger('click')
    expect(wrapper.find('[data-testid=batchbar]').exists()).toBe(false)
    // 取消后再点行又是「打开」
    await row(wrapper, 'A1').trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
  })

  it('批量移出:只带还没被移出的;发出后清空选择', async () => {
    const wrapper = mountSidebar()
    await row(wrapper, 'A1').trigger('click', { ctrlKey: true })
    await row(wrapper, 'A3').trigger('click', { ctrlKey: true })
    expect(wrapper.find('[data-testid=shared-restore]').exists()).toBe(false)
    await wrapper.find('[data-testid=shared-hide]').trigger('click')
    const [targets, hidden] = wrapper.emitted('hide')![0]! as [SharedWithMeItem[], boolean]
    expect(targets.map((entry) => entry.key)).toEqual(['alice:A1', 'alice:A3'])
    expect(hidden).toBe(true)
    expect(wrapper.find('[data-testid=batchbar]').exists()).toBe(false)
  })

  it('选中的是已移出的:给「放回」,不给「移出」;混着选两个都给,各自只处理该处理的', async () => {
    const groups = groupByOwner([item(alice, 'A1'), item(alice, 'A2', { hidden: true })], true)
    const wrapper = mountSidebar({ groups, showHidden: true, hiddenCount: 1 })
    await row(wrapper, 'A2').trigger('click', { ctrlKey: true })
    expect(wrapper.find('[data-testid=shared-hide]').exists()).toBe(false)
    await row(wrapper, 'A1').trigger('click', { ctrlKey: true })
    expect(wrapper.find('[data-testid=shared-hide]').exists()).toBe(true)
    await wrapper.find('[data-testid=shared-restore]').trigger('click')
    const [targets, hidden] = wrapper.emitted('hide')![0]! as [SharedWithMeItem[], boolean]
    expect(targets.map((entry) => entry.key)).toEqual(['alice:A2'])
    expect(hidden).toBe(false)
  })

  it('列表重读后看不到的选中项被丢掉(例如刚把它移出了)', async () => {
    const wrapper = mountSidebar()
    await row(wrapper, 'A1').trigger('click', { ctrlKey: true })
    await row(wrapper, 'A2').trigger('click', { ctrlKey: true })
    await wrapper.setProps({ groups: groupByOwner(ITEMS.filter((entry) => entry.title !== 'A1')) })
    expect(wrapper.find('[data-testid=batchbar]').text()).toContain('已选 1 项')
  })
})
