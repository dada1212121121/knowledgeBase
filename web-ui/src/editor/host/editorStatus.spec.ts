/**
 * 状态栏：正文在协同房间里时显示房间状态，不再显示「已保存」。
 * 以前 CSV 房间还没连上、网格是空的时候状态栏写着「已保存 · 0 格」。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EditorStatus from './EditorStatus.vue'

const text = (props: Record<string, unknown>) =>
  mount(EditorStatus, { props: { kind: 'grid', phase: 'ready', unitLabel: '格', ...props } }).find('[data-testid="editor-status-text"]').text()

describe('EditorStatus 房间状态', () => {
  it('不在房间里：照旧显示保存状态', () => {
    expect(text({})).toBe('已保存')
    expect(text({ dirty: true })).toBe('有未保存的改动')
  })

  it('在房间里：按连接状态显示，不出现「已保存」', () => {
    expect(text({ room: { status: 'connecting', writable: true } })).toBe('正在连接协同…')
    expect(text({ room: { status: 'syncing', writable: true } })).toBe('正在同步…')
    expect(text({ room: { status: 'synced', writable: true } })).toBe('已同步')
    expect(text({ room: { status: 'offline', writable: true } })).toBe('离线，改动先留在本页')
    expect(text({ room: { status: 'synced', writable: false } })).toBe('已同步 · 只读')
  })

  it('房间状态的颜色：已同步是绿，连接中 / 离线是黄，结束是红', () => {
    const tone = (status: 'synced' | 'connecting' | 'offline' | 'closed') =>
      mount(EditorStatus, { props: { kind: 'grid', phase: 'ready', room: { status, writable: true } } }).find('[data-testid="editor-status-bar"]').attributes('data-tone')
    expect([tone('synced'), tone('connecting'), tone('offline'), tone('closed')]).toEqual(['success', 'warning', 'warning', 'danger'])
  })

  it('打开 / 出错这类阻塞状态仍然优先', () => {
    expect(text({ phase: 'loading', room: { status: 'synced', writable: true } })).toBe('正在打开…')
    expect(text({ phase: 'error', room: { status: 'synced', writable: true } })).toBe('出错了')
  })

  it('有房间状态时右侧不再重复写协同文案（以前 Office 协同会一直写着「正在连接协同…」，）', () => {
    const wrapper = mount(EditorStatus, { props: { kind: 'slide', phase: 'ready', collabState: 'connecting', room: { status: 'synced', writable: true } } })
    expect(wrapper.find('[data-testid="editor-status-text"]').text()).toBe('已同步')
    expect(wrapper.text()).not.toContain('正在连接协同')
    // 没有房间状态来源时仍按原来的协同文案
    const bare = mount(EditorStatus, { props: { kind: 'grid', phase: 'ready', collabState: 'connecting' } })
    expect(bare.text()).toContain('正在连接协同')
  })
})
