// 历史版本列表:相邻两版能对比、除最新一版外能恢复;只读时不给恢复。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VersionHistory, { type VersionRow } from './VersionHistory.vue'

const rows: VersionRow[] = [
  { id: 'v3', version: 3, author: 'alice', created_at: 1793690000000, size: 1200, preview: '' },
  { id: 'v2', version: 2, author: 'bob', created_at: 1793680000000, size: 1100, preview: '' },
  { id: 'v1', version: 1, author: 'baseline', created_at: 1793670000000, size: 1000, preview: '' },
]

describe('VersionHistory', () => {
  it('每版都显示版本号与人,最新一版标「当前」', () => {
    const wrapper = mount(VersionHistory, { props: { versions: rows, readonly: false } })
    const items = wrapper.findAll('[data-version]')
    expect(items).toHaveLength(3)
    expect(items[0].text()).toContain('v3')
    expect(items[0].text()).toContain('alice')
    expect(items[0].text()).toContain('当前')
    expect(items[1].text()).toContain('bob')
  })

  it('最早的一版没有「对比」,其余都能对比上一版', () => {
    const wrapper = mount(VersionHistory, { props: { versions: rows, readonly: false } })
    const compare = wrapper.findAll('[data-testid="version-compare"]')
    expect(compare).toHaveLength(2)
    // 点第 1 行(当前这一版)→ 对比 v2 → v3
    compare[0].trigger('click')
    expect(wrapper.emitted('compare')?.[0]).toEqual([0])
    compare[1].trigger('click')
    expect(wrapper.emitted('compare')?.[1]).toEqual([1])
  })

  it('能恢复旧版,恢复按钮点出的是版本 id', async () => {
    const wrapper = mount(VersionHistory, { props: { versions: rows, readonly: false } })
    const restore = wrapper.findAll('[data-testid="version-restore"]')
    expect(restore).toHaveLength(2)
    await restore[0].trigger('click')
    expect(wrapper.emitted('restore')?.[0]).toEqual(['v2'])
  })

  it('只读时不给恢复入口', () => {
    const wrapper = mount(VersionHistory, { props: { versions: rows, readonly: true } })
    expect(wrapper.findAll('[data-testid="version-restore"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('当前')
  })

  it('每版都能看到开头几行正文,几版内容不同时一眼能分开', () => {
    const withText: VersionRow[] = [
      { id: 'v3', version: 3, author: 'alice', created_at: 1793690000000, size: 120, preview: '第三版正文' },
      { id: 'v2', version: 2, author: 'alice', created_at: 1793680000000, size: 110, preview: '第二版正文' },
      { id: 'v1', version: 1, author: 'baseline', created_at: 1793670000000, size: 100, preview: '' },
    ]
    const wrapper = mount(VersionHistory, { props: { versions: withText, readonly: false } })
    const previews = wrapper.findAll('[data-testid="version-preview"]').map((node) => node.text())
    expect(previews).toEqual(['第三版正文', '第二版正文', '（正文为空）'])
  })

  it('二进制版本说清没有正文可看,不显示成「正文为空」', () => {
    const binary: VersionRow[] = [{ id: 'b2', version: 2, author: 'a', created_at: 1, size: 2048, preview: '', binary: true }]
    const wrapper = mount(VersionHistory, { props: { versions: binary, readonly: false } })
    expect(wrapper.find('[data-testid="version-preview"]').text()).toContain('二进制文件')
  })

  it('没有历史时给出空文案', () => {
    const wrapper = mount(VersionHistory, { props: { versions: [], readonly: false, emptyText: '还没有保存过版本' } })
    expect(wrapper.text()).toContain('还没有保存过版本')
    expect(wrapper.findAll('[data-version]')).toHaveLength(0)
  })
})
