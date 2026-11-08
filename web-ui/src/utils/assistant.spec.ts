// AI 助手纯逻辑:排队提示、额度提示。
import { describe, expect, it } from 'vitest'
import { isMyQueueEvent, queueText, workspaceView } from './assistant'

describe('queueText', () => {
  it('前面有人:写清几个人,并说轮到会自动开始', () => {
    expect(queueText(1)).toBe('排队中:前面还有 1 个人,轮到你会自动开始')
    expect(queueText(3)).toBe('排队中:前面还有 3 个人,轮到你会自动开始')
  })
  it('轮到了 / 没有数据:不显示', () => {
    expect([0, -1, null, undefined, Number.NaN].map(queueText)).toEqual(['', '', '', '', ''])
  })
})

describe('isMyQueueEvent', () => {
  it('当前会话的事件才算;还没有会话号(本轮第一条消息)时任何事件都算', () => {
    expect(isMyQueueEvent('s1', 's1')).toBe(true)
    expect(isMyQueueEvent('s2', 's1')).toBe(false)
    expect(isMyQueueEvent('s2', '')).toBe(true)
    expect(isMyQueueEvent(null, '')).toBe(true)
    expect(isMyQueueEvent(null, 's1')).toBe(false)
  })
})

describe('workspaceView', () => {
  const MB = 1024 * 1024
  it('任何一项取不到:不显示,不编数字', () => {
    expect(workspaceView(null, 512)).toBeNull()
    expect(workspaceView(10 * MB, null)).toBeNull()
    expect(workspaceView(undefined, undefined)).toBeNull()
  })
  it('不限(上限 0):只说用了多少,不拦', () => {
    expect(workspaceView(10 * MB, 0)).toEqual({ text: '代理工作目录已用 10 MB', level: 'unlimited', blocked: false })
  })
  it('正常:已用 / 上限', () => {
    expect(workspaceView(100 * MB, 512)).toEqual({ text: '代理工作目录已用 100 MB / 上限 512 MB', level: 'ok', blocked: false })
  })
  it('超过 90%:提醒快满了,不拦', () => {
    const view = workspaceView(470 * MB, 512)!
    expect(view).toMatchObject({ level: 'warn', blocked: false })
    expect(view.text).toContain('快满了')
  })
  it('满了(和后端一样,是「超过」上限才拒绝):拦住,并说去哪看', () => {
    const view = workspaceView(512 * MB + 1, 512)!
    expect(view).toMatchObject({ level: 'over', blocked: true })
    expect(view.text).toContain('我的用量')
  })
  it('恰好等于上限:后端不拒绝(used > limit 才拒),这里只提醒快满了,不拦', () => {
    expect(workspaceView(512 * MB, 512)).toMatchObject({ level: 'warn', blocked: false })
  })
  it('服务端不对这个账号拦(主知识库账号):只说用了多少,不写上限,超了也不拦', () => {
    expect(workspaceView(600 * MB, 512, false)).toEqual({ text: '代理工作目录已用 600 MB', level: 'unlimited', blocked: false })
  })
  it('老守护进程没有 workspace_enforced(null):按不确定处理,不拦', () => {
    expect(workspaceView(600 * MB, 512, null)).toMatchObject({ blocked: false })
  })
  it('文案里不说 token / 字节数原值', () => {
    for (const [used, limit] of [[1, 1], [600 * MB, 512], [0, 0]] as const) expect(workspaceView(used, limit)!.text).not.toMatch(/token|bytes/i)
  })
})
