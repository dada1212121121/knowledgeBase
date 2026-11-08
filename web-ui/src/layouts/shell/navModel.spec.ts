// 导航清单:「我的 / 管理」两组、按功能表过滤、高亮、手机返回目标。
import { describe, expect, it } from 'vitest'
import { buildNavGroups, collapsedGroups, compact, isActivePath, phoneBackTarget } from './navModel'

const route = (path: string, meta: Record<string, unknown> = {}) => ({ path, meta })
const ctx = (over: Partial<Parameters<typeof buildNavGroups>[0]> = {}) => ({
  has: () => true,
  route: route('/search'),
  counts: { items: 12438, sources: 2, drafts: 7, jobs: 3 },
  ...over,
})
const ids = (groups: ReturnType<typeof buildNavGroups>, group?: string) =>
  groups.filter((item) => !group || item.id === group).flatMap((item) => item.items.map((entry) => entry.id))
/** 去掉给定功能点的功能表 */
const without = (...blocked: string[]) => (feature?: string) => !feature || !blocked.includes(feature)

describe('compact', () => {
  it('0 不显示,1000 以内原样,以上用 k', () => {
    expect(compact(0)).toBe('')
    expect(compact(999)).toBe('999')
    expect(compact(12438)).toBe('12.4k')
  })
})

describe('buildNavGroups', () => {
  it('只有「管理」可以折叠(入口多,矮屏上整列放不下)', () => {
    const groups = buildNavGroups(ctx())
    expect(groups.map((group) => [group.id, group.collapsible === true])).toEqual([['mine', false], ['admin', true]])
  })

  it('分「我的」「管理」两组,拥有全部功能时的入口与顺序', () => {
    const groups = buildNavGroups(ctx())
    expect(groups.map((group) => [group.id, group.label])).toEqual([['mine', '我的'], ['admin', '管理']])
    expect(ids(groups, 'mine')).toEqual(['home', 'kb', 'search', 'shares', 'trash', 'review', 'import', 'tasks', 'friends', 'assistant'])
    expect(ids(groups, 'admin')).toEqual(['overview', 'users', 'params', 'usage', 'projects', 'system', 'audit', 'eval', 'settings'])
  })

  it('入口地址是新地址(旧地址只做重定向)', () => {
    const items = buildNavGroups(ctx()).flatMap((group) => group.items)
    expect(Object.fromEntries(items.map((item) => [item.id, item.to]))).toEqual({
      home: '/home', kb: '/kb', search: '/search', shares: '/shares', trash: '/trash', review: '/review', import: '/import', tasks: '/tasks', friends: '/friends', assistant: '/assistant',
      overview: '/admin/overview', users: '/admin/users', params: '/admin/params', usage: '/admin/usage', projects: '/admin/projects',
      system: '/admin/system', audit: '/admin/audit', eval: '/admin/eval', settings: '/admin/settings',
    })
  })

  it('普通用户(没有任何 sys.* / sources.local / search.tune)整个「管理」组不出现,连标题都没有', () => {
    const groups = buildNavGroups(ctx({ has: without('sys.ops', 'sys.users', 'sys.settings', 'sources.local', 'search.tune') }))
    expect(groups.map((group) => group.id)).toEqual(['mine'])
  })

  it('管理组按功能点逐项出现:只有 sys.users 的角色只看到「用户与权限」', () => {
    const groups = buildNavGroups(ctx({ has: (feature) => !feature?.startsWith('sys.') && feature !== 'sources.local' && feature !== 'search.tune' || feature === 'sys.users' }))
    expect(ids(groups, 'admin')).toEqual(['users'])
  })

  it('AI 总开关关掉(没有 ai.*):审核收件箱、AI 助手入口不出现,其余照常', () => {
    const groups = buildNavGroups(ctx({ has: (feature) => !feature?.startsWith('ai.') }))
    const mine = ids(groups, 'mine')
    expect(mine).not.toContain('review')
    expect(mine).not.toContain('assistant')
    expect(mine).toEqual(['home', 'kb', 'search', 'shares', 'trash', 'import', 'tasks', 'friends'])
  })

  it('好友入口按 collab.friends 显示 / 隐藏,指向 /friends', () => {
    const entry = (has: (feature?: string) => boolean) =>
      buildNavGroups(ctx({ has })).flatMap((group) => group.items).find((item) => item.id === 'friends')
    expect(entry(() => true)).toMatchObject({ to: '/friends', label: '好友', icon: 'users' })
    expect(entry(without('collab.friends'))).toBeUndefined()
    // 关掉别的功能点不影响好友入口
    expect(entry(without('ai.assistant', 'docs.upload'))).toBeDefined()
  })

  it('没有 collab.share 看不到「我的分享」(接收分享不需要功能,所以「共享给我」在知识库页里)', () => {
    expect(ids(buildNavGroups(ctx({ has: without('collab.share') })), 'mine')).not.toContain('shares')
    expect(ids(buildNavGroups(ctx()), 'mine')).toContain('shares')
  })

  it('没有 docs.upload 看不到「导入」;没有 search.basic 看不到「搜索」', () => {
    expect(ids(buildNavGroups(ctx({ has: without('docs.upload') })), 'mine')).not.toContain('import')
    expect(ids(buildNavGroups(ctx({ has: without('search.basic') })), 'mine')).not.toContain('search')
  })

  it('每个入口的功能点都来自后端的能力表(审计 / 系统状态 / 系统概览 = sys.ops,项目与集合 = sources.local)', () => {
    const asked: string[] = []
    buildNavGroups(ctx({ has: (feature) => (feature && asked.push(feature), true) }))
    expect([...new Set(asked)].sort()).toEqual(['ai.assistant', 'ai.extract', 'collab.friends', 'collab.share', 'docs.upload', 'search.basic', 'search.tune', 'sources.local', 'sys.ops', 'sys.settings', 'sys.users'])
  })

  it('角标与计数来自 counts:待审草稿、运行中的任务;导入总数是灰字', () => {
    const items = buildNavGroups(ctx()).flatMap((group) => group.items)
    expect(items.find((item) => item.id === 'review')?.count).toBe(7)
    expect(items.find((item) => item.id === 'tasks')?.count).toBe(3)
    expect(items.find((item) => item.id === 'import')?.text).toBe('2')
    expect(items.find((item) => item.id === 'kb')?.text).toBe('12.4k')
  })

  it('当前页高亮对应入口;嵌套页面按 meta.group 归到父入口', () => {
    const active = (path: string, meta = {}) =>
      buildNavGroups(ctx({ route: route(path, meta) })).flatMap((group) => group.items).filter((item) => item.active).map((item) => item.id)
    expect(active('/search')).toEqual(['search'])
    expect(active('/import/files/abc', { group: '/import' })).toEqual(['import'])
    expect(active('/import/queue', { group: '/import' })).toEqual(['import'])
    expect(active('/admin/audit')).toEqual(['audit'])
    expect(active('/kb')).toEqual(['kb'])
  })
})

describe('collapsedGroups', () => {
  const groups = buildNavGroups(ctx())

  it('没选过时按「放不下」算:放得下就都展开', () => {
    expect(collapsedGroups({ groups, userCollapsed: null, autoCollapsed: [] })).toEqual([])
  })

  it('没选过且放不下:收起可折叠的那组,不可折叠的不动', () => {
    expect(collapsedGroups({ groups, userCollapsed: null, autoCollapsed: ['admin'] })).toEqual(['admin'])
    // 就算自动算出了「我的」也不该收:它不可折叠
    expect(collapsedGroups({ groups, userCollapsed: null, autoCollapsed: ['mine', 'admin'] })).toEqual(['admin'])
  })

  it('用户手动选过就以用户为准(自动结果作废):空数组 = 手动展开过', () => {
    expect(collapsedGroups({ groups, userCollapsed: [], autoCollapsed: ['admin'] })).toEqual([])
    expect(collapsedGroups({ groups, userCollapsed: ['admin'], autoCollapsed: [] })).toEqual(['admin'])
  })

  it('当前页在组里时那一组永远展开(否则看的那一页从导航里消失)', () => {
    const inAdmin = buildNavGroups(ctx({ route: route('/admin/eval') }))
    expect(collapsedGroups({ groups: inAdmin, userCollapsed: ['admin'], autoCollapsed: ['admin'] })).toEqual([])
    // 组里没有当前页时照旧收起
    expect(collapsedGroups({ groups, userCollapsed: ['admin'], autoCollapsed: [] })).toEqual(['admin'])
  })
})

describe('isActivePath', () => {
  it('完全匹配或子路径', () => {
    expect(isActivePath(route('/kb'), '/kb')).toBe(true)
    expect(isActivePath(route('/kb/x'), '/kb')).toBe(true)
    expect(isActivePath(route('/kbx'), '/kb')).toBe(false)
  })
})

describe('phoneBackTarget', () => {
  it('标签栏里的页面没有返回键', () => {
    for (const path of ['/home', '/kb', '/search', '/mine']) expect(phoneBackTarget(route(path))).toBeNull()
  })
  it('嵌套页面回父页,其余回「我的」', () => {
    expect(phoneBackTarget(route('/import/files/1', { parent: '/import/queue' }))).toBe('/import/queue')
    expect(phoneBackTarget(route('/tasks'))).toBe('/mine')
    expect(phoneBackTarget(route('/me'))).toBe('/mine')
  })
})
