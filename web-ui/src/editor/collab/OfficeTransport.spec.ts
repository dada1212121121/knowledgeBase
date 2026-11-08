import { describe, expect, it, vi } from 'vitest'
import { createRoomStatusFeed, toRoomStatus } from './OfficeTransport'

describe('Office 协同房间状态', () => {
  it('引擎连接状态换成状态栏的房间状态：连上但没对齐是「正在同步」', () => {
    expect(toRoomStatus('connecting', false)).toBe('connecting')
    expect(toRoomStatus('connected', false)).toBe('syncing')
    expect(toRoomStatus('connected', true)).toBe('synced')
    expect(toRoomStatus('disconnected', true)).toBe('offline')
    expect(toRoomStatus('destroyed', true)).toBe('closed')
  })

  it('订阅时立即推一次当前状态；状态变了才通知；退订后不再通知', () => {
    const feed = createRoomStatusFeed(true)
    const seen = vi.fn()
    const off = feed.source.subscribe(seen)
    expect(seen).toHaveBeenLastCalledWith({ status: 'connecting', writable: true })
    feed.update('connected', false)
    feed.update('connected', true)
    feed.update('connected', true)
    expect(seen.mock.calls.map((c) => c[0].status)).toEqual(['connecting', 'syncing', 'synced'])
    off()
    feed.update('disconnected', true)
    expect(seen).toHaveBeenCalledTimes(3)
    expect(feed.source.getState().status).toBe('offline')
  })

  it('服务端结束协同后，引擎补发的断开不能把「已结束」改回「离线」；只读参与者带着只读标记', () => {
    const feed = createRoomStatusFeed(false)
    feed.update('connected', true)
    feed.close()
    feed.update('disconnected', false)
    expect(feed.source.getState()).toEqual({ status: 'closed', writable: false })
  })
})
