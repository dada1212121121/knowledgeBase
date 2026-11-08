// 数据表格的行级右键:表格自己只负责把「在哪一行、什么位置」抛给页面,
// 菜单内容由页面决定(文件行是文件菜单,笔记行是笔记菜单)。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KbDataTable from './KbDataTable.vue'
import type { Column } from './types'

const columns: Column[] = [
  { key: 'title', label: '标题' },
  { key: 'kind', label: '类型' },
]
const rows = [
  { id: 'a', title: '第一篇', kind: 'insight' },
  { id: 'b', title: '第二篇', kind: 'doc' },
]

describe('KbDataTable 右键', () => {
  it('在行上右键把这一行和鼠标位置交给页面', async () => {
    const wrapper = mount(KbDataTable, { props: { columns, rows } })
    const tr = wrapper.findAll('tbody tr')
    expect(tr).toHaveLength(2)
    await tr[1].trigger('contextmenu', { clientX: 240, clientY: 180 })
    const events = wrapper.emitted('menu')
    expect(events).toHaveLength(1)
    expect(events?.[0][0]).toMatchObject({ id: 'b' })
    expect(events?.[0][1]).toBe(1)
    expect((events?.[0][2] as MouseEvent).clientX).toBe(240)
  })

  it('右键不弹出浏览器默认菜单(否则盖住自己的菜单)', async () => {
    const wrapper = mount(KbDataTable, { props: { columns, rows } })
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    wrapper.findAll('tbody tr')[0].element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
