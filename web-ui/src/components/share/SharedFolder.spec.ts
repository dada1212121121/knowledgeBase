// 共享文件夹 / 集合目录:层级展示(子文件夹可下钻)、分页、空态、四种状态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ShareAccess, ShareTarget } from '@/api/share'
import SharedFolder from './SharedFolder.vue'

const dir: ShareTarget = { kind: 'dir', space_id: 'sp_a', collection: '_global', path: 'docs' }
const collection: ShareTarget = { kind: 'collection', space_id: 'sp_a', collection: '_global' }

const call = vi.fn()
const access: ShareAccess = {
  call: call as ShareAccess['call'],
  rawUrl: (col, p) => `/raw?c=${col}&p=${p}`,
  can: { edit: false, comment: false, download: true },
}
const editAccess: ShareAccess = { ...access, can: { edit: true, comment: true, download: true } }

async function mountFolder(target: ShareTarget, acc = access) {
  const wrapper = mount(SharedFolder, { props: { target, access: acc }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const row = (id: string, source: string, extra: Record<string, unknown> = {}) => ({
  id,
  source,
  kind: 'doc',
  tags: [],
  updated_at: Date.now() - 3600_000,
  ...extra,
})

beforeEach(() => {
  setActivePinia(createPinia())
  call.mockReset()
  call.mockResolvedValue({ total: 0, items: [] })
  document.body.innerHTML = ''
})

describe('SharedFolder', () => {
  it('文件夹授权带 path_prefix;集合授权不带;默认按文件维度 group_by_file', async () => {
    call.mockResolvedValue({ total: 0, items: [] })
    await mountFolder(dir)
    expect(call).toHaveBeenCalledWith('list_items', expect.objectContaining({ collection: '_global', path_prefix: 'docs', group_by_file: true }))

    call.mockClear()
    await mountFolder(collection)
    expect(call).toHaveBeenCalledWith('list_items', expect.objectContaining({ collection: '_global', group_by_file: true }))
    expect(call.mock.calls[0]![1]).not.toHaveProperty('path_prefix')
  })

  it('层级展示子文件夹与直接文件;同一文件多块去重;网页来源与附件不列', async () => {
    call.mockResolvedValue({
      total: 5,
      items: [
        row('c1', 'docs/guide.md'),
        row('c2', 'docs/guide.md'),
        row('w1', 'https://example.com/page', { kind: 'external' }),
        row('a1', '_attachments/2026-10/ab12cd34-报告.pdf'),
        row('n1', 'insight:n1', { kind: 'insight', title: '部署清单', insight_kind: 'howto' }),
        row('c3', 'docs/deep/ops.md'),
      ],
    })
    const wrapper = await mountFolder(dir)
    // 默认不展开子分类（按用户要求）
    expect(wrapper.find('[data-testid=tree-facet-doc]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=shared-folder-deep]').exists()).toBe(false)

    // 点击展开文档分类
    await wrapper.find('[data-testid=tree-facet-doc]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-folder-deep]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=shared-row-c1]').text()).toContain('guide.md')

    // 点击展开笔记分类
    await wrapper.find('[data-testid=tree-facet-insight]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-row-n1]').text()).toContain('部署清单')

    // 重置分类筛选并切换为平铺列表视图
    await wrapper.find('[data-testid=pill-all]').trigger('click')
    await wrapper.find('[data-testid=view-flat]').trigger('click')
    await flushPromises()
    const flatNames = wrapper.findAll('.kb-sidebar-item-name').map((el) => el.text())
    expect(flatNames).toEqual(['guide.md', 'ops.md', '部署清单'])
  })

  it('点击子文件夹：发出 dir 目标进行下钻；点击文档：发出 insight/file 目标', async () => {
    call.mockResolvedValue({
      total: 3,
      items: [
        row('n1', 'insight:n1', { kind: 'insight', title: '部署清单' }),
        row('c1', 'docs/guide.md'),
        row('c2', 'docs/deep/ops.md'),
      ],
    })
    const wrapper = await mountFolder(dir)
    // 展开文档和笔记分类
    await wrapper.find('[data-testid=tree-facet-doc]').trigger('click')
    await wrapper.find('[data-testid=tree-facet-insight]').trigger('click')
    await flushPromises()

    // 点击子文件夹
    await wrapper.find('[data-testid=shared-folder-deep]').trigger('click')
    // 点击笔记与直接文件
    await wrapper.find('[data-testid=shared-row-n1]').trigger('click')
    await wrapper.find('[data-testid=shared-row-c1]').trigger('click')

    expect(wrapper.emitted('open')).toEqual([
      [{ kind: 'dir', space_id: 'sp_a', collection: '_global', path: 'docs/deep' }, 'deep'],
      [{ kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'n1' }, '部署清单'],
      [{ kind: 'file', space_id: 'sp_a', collection: '_global', path: 'docs/guide.md' }, 'guide.md'],
    ])
  })

  it('分类与知识库页面完全一致（全部、笔记、文档），支持分类药丸与目录树展开', async () => {
    call.mockResolvedValue({
      total: 3,
      items: [
        row('f1', 'SampleERP使用手册.docx'),
        row('f2', '进价模板.xlsx'),
        row('n1', 'insight:n1', { kind: 'insight', title: 'sampleproj 项目规范' }),
      ],
    })
    const wrapper = await mountFolder(collection)
    // 顶部分类药丸与知识库完全一致：全部 3、笔记 1、文档 2
    expect(wrapper.find('[data-testid=pill-all]').text()).toContain('全部')
    expect(wrapper.find('[data-testid=pill-all]').text()).toContain('3')
    expect(wrapper.find('[data-testid=pill-insight]').text()).toContain('笔记')
    expect(wrapper.find('[data-testid=pill-insight]').text()).toContain('1')
    expect(wrapper.find('[data-testid=pill-doc]').text()).toContain('文档')
    expect(wrapper.find('[data-testid=pill-doc]').text()).toContain('2')

    // 目录树根节点为集合名称 _global 3，包含「文档 2」和「笔记 1」，默认收起
    expect(wrapper.find('[data-testid=tree-root]').text()).toContain('_global')
    expect(wrapper.find('[data-testid=tree-facet-doc]').text()).toContain('文档')
    expect(wrapper.find('[data-testid=tree-facet-doc]').text()).toContain('2')
    expect(wrapper.find('[data-testid=tree-facet-insight]').text()).toContain('笔记')
    expect(wrapper.find('[data-testid=tree-facet-insight]').text()).toContain('1')
    expect(wrapper.find('[data-testid=shared-row-f1]').exists()).toBe(false)

    // 展开文档与笔记分类后展示
    await wrapper.find('[data-testid=tree-facet-doc]').trigger('click')
    await wrapper.find('[data-testid=tree-facet-insight]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-row-f1]').text()).toContain('SampleERP使用手册.docx')
    expect(wrapper.find('[data-testid=shared-row-n1]').text()).toContain('sampleproj 项目规范')

    // 重置分类并点击笔记药丸：切换到列表视图并仅展示笔记
    await wrapper.find('[data-testid=pill-all]').trigger('click')
    await wrapper.find('[data-testid=pill-insight]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=view-flat]').classes()).toContain('is-active')
    const listNames = wrapper.findAll('.kb-sidebar-item-name').map((el) => el.text())
    expect(listNames).toEqual(['sampleproj 项目规范'])
  })

  it('按权限显示可编辑或只读徽标', async () => {
    call.mockResolvedValue({
      total: 2,
      items: [
        row('c1', 'docs/guide.md'),
        row('c2', 'docs/manual.pdf'),
      ],
    })
    // 只读访问者
    const roWrapper = await mountFolder(dir, access)
    await roWrapper.find('[data-testid=tree-facet-doc]').trigger('click')
    await flushPromises()
    expect(roWrapper.find('[data-testid=shared-perm-c1]').text()).toBe('只读')
    expect(roWrapper.find('[data-testid=shared-perm-c2]').text()).toBe('只读')

    // 编辑者权限：md 文档显示可编辑，pdf 显示只读
    const rwWrapper = await mountFolder(dir, editAccess)
    await rwWrapper.find('[data-testid=tree-facet-doc]').trigger('click')
    await flushPromises()
    expect(rwWrapper.find('[data-testid=shared-perm-c1]').text()).toBe('可编辑')
    expect(rwWrapper.find('[data-testid=shared-perm-c2]').text()).toBe('只读')
  })

  it('分页:已取回的行数不到总数就给「加载更多」,取完就没有;后端过滤让一页变短也不会漏', async () => {
    call.mockResolvedValueOnce({ total: 3, items: [row('c1', 'docs/a.md')] })
    const wrapper = await mountFolder(dir)
    await wrapper.find('[data-testid=view-flat]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=shared-folder-more]').exists()).toBe(true)
    call.mockResolvedValueOnce({ total: 3, items: [row('c2', 'docs/b.md'), row('c3', 'docs/c.md')] })
    await wrapper.find('[data-testid=shared-folder-more]').trigger('click')
    await flushPromises()
    expect(call.mock.calls.at(-1)![1]).toMatchObject({ page: 2 })
    expect(wrapper.findAll('.kb-sidebar-item-name')).toHaveLength(3)
    expect(wrapper.find('[data-testid=shared-folder-more]').exists()).toBe(false)
  })

  it('空:说明新建的文档会自动出现;整个知识库的授权:如实说不能列目录,不发请求', async () => {
    const empty = await mountFolder(dir)
    expect(empty.find('[data-testid=shared-folder-empty]').text()).toContain('对方新建文档后会自动出现在这里')
    call.mockClear()
    const space = await mountFolder({ kind: 'space', space_id: 'sp_a' })
    expect(space.find('[data-testid=shared-folder-space]').text()).toContain('不能在这里列出目录')
    expect(call).not.toHaveBeenCalled()
  })

  it('加载失败:可重试', async () => {
    call.mockRejectedValueOnce({ status: 404, message: 'not found: 没有找到这个内容' })
    const wrapper = await mountFolder(dir)
    expect(wrapper.find('[data-testid=shared-folder-error]').text()).toContain('目录没有加载出来')
    call.mockResolvedValueOnce({ total: 1, items: [row('c1', 'docs/a.md')] })
    await wrapper.find('[data-testid=shared-folder-error] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid=view-flat]').exists()).toBe(true)
    await wrapper.find('[data-testid=view-flat]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.kb-sidebar-item-name')).toHaveLength(1)
  })
})
