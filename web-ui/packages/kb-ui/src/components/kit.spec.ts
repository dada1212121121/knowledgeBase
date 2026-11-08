// 组件包的行为测试:PageHeader · Field · ActionBar · BatchBar · Empty · Skeleton。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbPageHeader from './KbPageHeader.vue'
import KbField from './KbField.vue'
import KbActionBar from './KbActionBar.vue'
import KbBatchBar from './KbBatchBar.vue'
import KbEmpty from './KbEmpty.vue'
import KbSkeleton from './KbSkeleton.vue'

describe('KbPageHeader', () => {
  it('标题是 h1(页面里)或 h2(嵌在卡片里),带说明;没有说明就不渲染空段落', () => {
    const page = mount(KbPageHeader, { props: { title: '任务', description: '你的导入和索引任务' } })
    expect(page.find('h1.kb-ph-title').text()).toBe('任务')
    expect(page.find('.kb-ph-desc').text()).toBe('你的导入和索引任务')
    const card = mount(KbPageHeader, { props: { title: '最近', level: 2 } })
    expect(card.find('h2').exists()).toBe(true)
    expect(card.find('.kb-ph-desc').exists()).toBe(false)
  })
  it('操作区、面包屑、额外内容走插槽;没有就不留空容器', () => {
    const bare = mount(KbPageHeader, { props: { title: 'x' } })
    expect(bare.find('.kb-ph-actions').exists()).toBe(false)
    expect(bare.find('.kb-ph-crumb').exists()).toBe(false)
    const full = mount(KbPageHeader, {
      props: { title: 'x' },
      slots: { actions: '<button class="go">新建</button>', breadcrumb: '<span>管理</span>', default: '<div class="stats">统计</div>' },
    })
    expect(full.find('.kb-ph-actions .go').exists()).toBe(true)
    expect(full.find('.kb-ph-crumb').text()).toBe('管理')
    expect(full.find('.kb-ph-extra .stats').exists()).toBe(true)
  })
  it('back 显示返回键并发出事件(手机上嵌套页面用)', async () => {
    const wrapper = mount(KbPageHeader, { props: { title: 'x', back: true } })
    await wrapper.find('.kb-ph-back').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
    expect(mount(KbPageHeader, { props: { title: 'x' } }).find('.kb-ph-back').exists()).toBe(false)
  })
})

describe('KbField', () => {
  const field = (props: Record<string, unknown> = {}) =>
    mount(KbField, {
      props: { label: '邮箱', ...props },
      slots: { default: '<template #default="{ id, describedby, invalid }"><input :id="id" :aria-describedby="describedby" :aria-invalid="invalid" /></template>' },
    })

  it('标签的 for 与控件 id 对得上(点标签能聚焦控件、读屏软件读得出名字)', () => {
    const wrapper = field()
    const id = wrapper.find('input').attributes('id')!
    expect(wrapper.find('label').attributes('for')).toBe(id)
  })
  it('指定了 for 就用它', () => {
    const wrapper = field({ for: 'email' })
    expect(wrapper.find('input').attributes('id')).toBe('email')
    expect(wrapper.find('label').attributes('for')).toBe('email')
  })
  it('报错就近显示:role=alert,并通过 aria-describedby 关联;控件标记 aria-invalid', () => {
    const wrapper = field({ error: '邮箱格式不对', hint: '用于找回密码' })
    const error = wrapper.find('.kb-field-error')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toContain('邮箱格式不对')
    const describedby = wrapper.find('input').attributes('aria-describedby')!
    expect(describedby).toContain(error.attributes('id')!)
    expect(describedby).toContain(wrapper.find('.kb-field-hint').attributes('id')!)
    expect(wrapper.find('input').attributes('aria-invalid')).toBe('true')
    expect(wrapper.classes()).toContain('is-invalid')
  })
  it('没有报错 / 帮助时不渲染对应段落,aria-describedby 也不留空', () => {
    const wrapper = field()
    expect(wrapper.find('.kb-field-error').exists()).toBe(false)
    expect(wrapper.find('.kb-field-hint').exists()).toBe(false)
    expect(wrapper.find('input').attributes('aria-describedby')).toBeUndefined()
  })
  it('必填:星号对读屏隐藏,同时有「(必填)」文字——不靠颜色或符号传达', () => {
    const wrapper = field({ required: true })
    expect(wrapper.find('.kb-field-req').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('.kb-sr').text()).toBe('(必填)')
  })
  it('layout 变成 class(桌面标签在左由 CSS 在 ≥840 时生效)', () => {
    expect(field({ layout: 'inline' }).classes()).toContain('is-inline')
  })
})

describe('KbActionBar', () => {
  it('dirty 时左侧提示未保存;按钮走默认插槽', () => {
    const wrapper = mount(KbActionBar, { props: { dirty: true }, slots: { default: '<button>保存</button>' } })
    expect(wrapper.find('.kb-actionbar-note').text()).toBe('有未保存的修改')
    expect(wrapper.classes()).toContain('is-dirty')
    expect(wrapper.find('button').text()).toBe('保存')
  })
  it('没修改时没有提示;可自定义提示文字;note 插槽可放别的说明', () => {
    expect(mount(KbActionBar).find('.kb-actionbar-note').exists()).toBe(false)
    expect(mount(KbActionBar, { props: { dirty: true, dirtyText: '草稿未保存' } }).find('.kb-actionbar-note').text()).toBe('草稿未保存')
    expect(mount(KbActionBar, { slots: { note: '上次保存 10:20' } }).find('.kb-actionbar-note').text()).toBe('上次保存 10:20')
  })
})

describe('KbBatchBar', () => {
  it('没选中时不出现;选中后显示数量,是 toolbar 且数量变化会被读屏播报', () => {
    expect(mount(KbBatchBar, { props: { count: 0 } }).find('[data-testid="batchbar"]').exists()).toBe(false)
    const wrapper = mount(KbBatchBar, { props: { count: 3 } })
    expect(wrapper.attributes('role')).toBe('toolbar')
    expect(wrapper.find('.kb-batchbar-count').text()).toBe('已选 3 项')
    expect(wrapper.find('.kb-batchbar-count').attributes('aria-live')).toBe('polite')
  })
  it('没全选时有「全选 N 项」,全选后没有;取消选择发出 clear', async () => {
    const some = mount(KbBatchBar, { props: { count: 2, total: 10 } })
    const all = some.findAll('.kb-batchbar-link')
    expect(all[0]!.text()).toBe('全选 10 项')
    await all[0]!.trigger('click')
    expect(some.emitted('all')).toHaveLength(1)
    await all[1]!.trigger('click')
    expect(some.emitted('clear')).toHaveLength(1)
    const full = mount(KbBatchBar, { props: { count: 10, total: 10 } })
    expect(full.findAll('.kb-batchbar-link')).toHaveLength(1)
    expect(full.find('.kb-batchbar-link').text()).toBe('取消选择')
  })
  it('批量操作按钮走默认插槽', () => {
    const wrapper = mount(KbBatchBar, { props: { count: 1 }, slots: { default: '<button class="del">删除</button>' } })
    expect(wrapper.find('.kb-batchbar-actions .del').exists()).toBe(true)
  })
})

describe('KbEmpty', () => {
  it('一句说明 + 一个下一步;role=status', () => {
    const wrapper = mount(KbEmpty, { props: { title: '没有任务', description: '新的导入任务会出现在这里' }, slots: { action: '<button class="next">去导入</button>' } })
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.find('.kb-empty-title').text()).toBe('没有任务')
    expect(wrapper.find('.kb-empty-desc').text()).toBe('新的导入任务会出现在这里')
    expect(wrapper.find('.next').exists()).toBe(true)
  })
  it('size=sm 是紧凑版;没有说明 / 操作就不渲染对应段落', () => {
    const wrapper = mount(KbEmpty, { props: { title: '空', size: 'sm' } })
    expect(wrapper.classes()).toContain('is-sm')
    expect(wrapper.find('.kb-empty-desc').exists()).toBe(false)
    expect(wrapper.find('.kb-row').exists()).toBe(false)
  })
})

describe('KbSkeleton', () => {
  it('读屏只读一次「加载中」:role=status + aria-busy', () => {
    const wrapper = mount(KbSkeleton)
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-busy')).toBe('true')
    expect(wrapper.attributes('aria-label')).toBe('加载中')
  })
  it('lines 变体:行数 = lines,最后一行较短', () => {
    const lines = mount(KbSkeleton, { props: { lines: 4 } }).findAll('.kb-skel-line')
    expect(lines).toHaveLength(4)
    expect(lines[3]!.attributes('style')).toContain('62%')
  })
  it('list / card / table 变体各有各的结构', () => {
    const list = mount(KbSkeleton, { props: { variant: 'list', lines: 3 } })
    expect(list.findAll('.kb-skel-item')).toHaveLength(3)
    expect(list.find('.kb-skel-avatar').exists()).toBe(true)
    const card = mount(KbSkeleton, { props: { variant: 'card', lines: 2 } })
    expect(card.find('.kb-skel-title').exists()).toBe(true)
    expect(card.findAll('.kb-skel-line')).toHaveLength(3)
    const table = mount(KbSkeleton, { props: { variant: 'table', lines: 4 } })
    expect(table.find('.kb-skel-head').exists()).toBe(true)
    expect(table.findAll('.kb-skel-row')).toHaveLength(4)
  })
})
