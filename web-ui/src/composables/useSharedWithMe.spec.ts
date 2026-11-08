import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedWithMeItem } from '@/api/share'

const api = vi.hoisted(() => ({ sharedWithMe: vi.fn(), hideShare: vi.fn() }))
vi.mock('@/api/share', () => api)

import { useSharedWithMe } from './useSharedWithMe'

const owner = { id: 'usr_a', username: 'alice', display_name: 'Alice', avatar: null }
const item = (title: string, hidden = false): SharedWithMeItem => ({
  target: { kind: 'insight', space_id: 'sp_a', collection: '_global', id: title },
  key: `k:${title}`,
  title,
  role: 'viewer',
  owner,
  shared_at: 1,
  expires_at: null,
  hidden,
})

beforeEach(() => {
  api.sharedWithMe.mockReset()
  api.hideShare.mockReset()
  api.hideShare.mockResolvedValue({ hidden: true })
})

describe('useSharedWithMe', () => {
  it('总是连被移出的一起取;默认只显示没被移出的,并数出各有几条', async () => {
    api.sharedWithMe.mockResolvedValue({ items: [item('a'), item('b', true), item('c')] })
    const shared = useSharedWithMe()
    expect(shared.status.value).toBe('idle')
    await shared.load()
    expect(api.sharedWithMe).toHaveBeenCalledWith(true)
    expect(shared.status.value).toBe('ready')
    expect(shared.count.value).toBe(2)
    expect(shared.hiddenCount.value).toBe(1)
    expect(shared.groups.value[0]!.items.map((entry) => entry.title)).toEqual(['a', 'c'])
    shared.showHidden.value = true
    expect(shared.groups.value[0]!.items.map((entry) => entry.title)).toEqual(['a', 'b', 'c'])
    expect(api.sharedWithMe).toHaveBeenCalledTimes(1)
  })

  it('加载失败:给人话,状态是 error;之后重试成功恢复', async () => {
    api.sharedWithMe.mockRejectedValueOnce({ status: 500, message: 'internal: x' })
    const shared = useSharedWithMe()
    await shared.load()
    expect(shared.status.value).toBe('error')
    expect(shared.errorText.value).toContain('没有加载出来')
    api.sharedWithMe.mockResolvedValueOnce({ items: [] })
    await shared.load()
    expect(shared.status.value).toBe('ready')
  })

  it('响应里没有 items:当作没有共享,不抛错', async () => {
    api.sharedWithMe.mockResolvedValue({})
    const shared = useSharedWithMe()
    await shared.load()
    expect(shared.status.value).toBe('ready')
    expect(shared.groups.value).toEqual([])
  })

  it('刷新时保留旧列表,不退回加载中(不闪)', async () => {
    api.sharedWithMe.mockResolvedValue({ items: [item('a')] })
    const shared = useSharedWithMe()
    await shared.load()
    const pending = shared.load()
    expect(shared.status.value).toBe('ready')
    await pending
  })

  it('移出:逐项请求后重读;部分失败如实报告失败了几项', async () => {
    api.sharedWithMe.mockResolvedValue({ items: [item('a'), item('b')] })
    api.hideShare.mockResolvedValueOnce({ hidden: true }).mockRejectedValueOnce({ status: 404 })
    const shared = useSharedWithMe()
    await shared.load()
    const result = await shared.setHidden([item('a').target, item('b').target], true)
    expect(result).toEqual({ done: 1, failed: 1 })
    expect(api.hideShare).toHaveBeenCalledWith(item('a').target, true)
    expect(api.sharedWithMe).toHaveBeenCalledTimes(2)
  })
})
