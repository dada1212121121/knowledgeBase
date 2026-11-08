// 首页纯逻辑:问候、最近编辑合并、共享动态、待处理事项。
import { describe, expect, it } from 'vitest'
import type { ItemSummary } from '@/api/client'
import type { SharedWithMeItem } from '@/api/share'
import { greeting, itemTitle, mergeRecent, pendingRows, recentRoute, sharedRoute, sharedRows } from './home'

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)
const relative = (at: number, now: number) => `${Math.round((now - at) / 60_000)} 分钟前`

const item = (id: string, updated_at: number, extra: Partial<ItemSummary> = {}): ItemSummary => ({
  id,
  collection: 'proj/insights',
  kind: 'insight',
  lang: null,
  source: `notes/${id}.md`,
  start_line: null,
  end_line: null,
  symbol: null,
  title: `笔记 ${id}`,
  status: 'active',
  tags: [],
  updated_at,
  version: 1,
  ...extra,
})

describe('greeting', () => {
  it('按小时分段,名字用逗号接上', () => {
    expect(greeting(3, 'Alice')).toBe('夜深了，Alice')
    expect(greeting(8, 'Alice')).toBe('早上好，Alice')
    expect(greeting(10, 'Alice')).toBe('上午好，Alice')
    expect(greeting(12, 'Alice')).toBe('中午好，Alice')
    expect(greeting(15, 'Alice')).toBe('下午好，Alice')
    expect(greeting(21, 'Alice')).toBe('晚上好，Alice')
  })
  it('没有名字不留孤零零的逗号', () => {
    expect(greeting(15, '')).toBe('下午好')
    expect(greeting(15, '   ')).toBe('下午好')
  })
  it('分段边界:5 点算早上,9 点算上午,12 点算中午,14 点算下午,18 点算晚上', () => {
    expect([5, 9, 12, 14, 18].map((hour) => greeting(hour, ''))).toEqual(['早上好', '上午好', '中午好', '下午好', '晚上好'])
  })
})

describe('mergeRecent', () => {
  it('跨集合按更新时间新的在前,同一条只留一次,最多 limit 条', () => {
    const merged = mergeRecent([[item('a', 100), item('b', 300)], [item('c', 200), item('b', 300)]], 3)
    expect(merged.map((row) => row.id)).toEqual(['b', 'c', 'a'])
    expect(mergeRecent([[item('a', 1), item('b', 2), item('c', 3)]], 2).map((row) => row.id)).toEqual(['c', 'b'])
  })
  it('只留生效中的笔记:代码块、文档块和已被取代的不算「我在编辑」', () => {
    const merged = mergeRecent([[item('n', 1), item('code', 9, { kind: 'code' }), item('old', 8, { status: 'superseded' }), item('doc', 7, { kind: 'doc' })]], 10)
    expect(merged.map((row) => row.id)).toEqual(['n'])
  })
  it('没有数据返回空数组', () => {
    expect(mergeRecent([], 5)).toEqual([])
    expect(mergeRecent([[]], 5)).toEqual([])
  })
})

describe('itemTitle / recentRoute', () => {
  it('标题 > 符号 > 来源路径最后一段 > 兜底', () => {
    expect(itemTitle({ title: ' 部署清单 ', symbol: 'x', source: 'a/b.md' })).toBe('部署清单')
    expect(itemTitle({ title: null, symbol: 'build', source: 'a/b.md' })).toBe('build')
    expect(itemTitle({ title: '', symbol: null, source: 'a/b.md' })).toBe('b.md')
    expect(itemTitle({ title: null, symbol: null, source: '' })).toBe('未命名笔记')
  })
  it('点最近编辑的笔记 = 知识库页按集合 + 条目打开', () => {
    expect(recentRoute({ collection: 'proj/insights', id: 'ins_1' })).toEqual({ path: '/kb', query: { collection: 'proj/insights', item: 'ins_1' } })
  })
})

describe('sharedRows', () => {
  const alice = { id: 'usr_alice', username: 'alice', display_name: 'Alice', avatar: null }
  const shared = (key: string, shared_at: number, extra: Partial<SharedWithMeItem> = {}): SharedWithMeItem => ({
    target: { kind: 'insight', space_id: 'sp_alice', collection: 'c', id: key },
    key,
    title: `文档 ${key}`,
    role: 'editor',
    owner: alice,
    shared_at,
    expires_at: null,
    hidden: false,
    ...extra,
  })

  it('新分享的在前,被我移出列表的不出现,最多 limit 条', () => {
    const rows = sharedRows([shared('a', 10), shared('b', 30), shared('c', 20, { hidden: true }), shared('d', 25)], 2, NOW, relative)
    expect(rows.map((row) => row.key)).toEqual(['b', 'd'])
  })
  it('文案说清谁、什么类型、什么名字、我的角色和时间;不假装知道对方后来改了什么', () => {
    const [row] = sharedRows([shared('a', NOW - 10 * 60_000)], 5, NOW, relative)
    expect(row!.headline).toBe('Alice 分享了笔记「文档 a」给你')
    expect(row!.sub).toBe('可编辑 · 10 分钟前')
    expect(row!.headline).not.toMatch(/更新了/)
  })
  it('文件夹按类型说「文件夹」,名字取路径最后一段', () => {
    const [row] = sharedRows([shared('d', 1, { title: '', target: { kind: 'dir', space_id: 'sp_alice', collection: 'c', path: 'docs/规划' } })], 5, NOW, relative)
    expect(row!.headline).toBe('Alice 分享了文件夹「规划」给你')
  })
  it('点进去 = 知识库页切到「共享给我」并打开那一项', () => {
    expect(sharedRoute({ key: 'k1' })).toEqual({ path: '/kb', query: { scope: 'shared', open: 'k1' } })
    expect(sharedRows([shared('k1', 1)], 1, NOW, relative)[0]!.to).toEqual({ path: '/kb', query: { scope: 'shared', open: 'k1' } })
  })
  it('输入不被改动(排序不能原地打乱调用方的数组)', () => {
    const input = [shared('a', 10), shared('b', 30)]
    sharedRows(input, 5, NOW, relative)
    expect(input.map((row) => row.key)).toEqual(['a', 'b'])
  })
})

describe('pendingRows', () => {
  const zhao = { id: 'usr_zhao', username: 'zhaoliu', display_name: '赵六', avatar: null }
  const base = { friends: [], access: [], drafts: 0, now: NOW, relative }

  it('什么都没有就是空数组', () => {
    expect(pendingRows(base)).toEqual([])
  })
  it('好友申请:带头像信息,附言优先于时间,去好友页的「申请」页签', () => {
    const [row] = pendingRows({ ...base, friends: [{ id: 'frq_1', from: zhao, message: '我是上周的同事', created_at: NOW - 60_000, expires_at: NOW + 1 }] })
    expect(row).toMatchObject({ kind: 'friend', title: '赵六 请求加你为好友', sub: '“我是上周的同事”', to: { path: '/friends', query: { tab: 'requests' } } })
    expect(row!.person).toEqual({ id: 'usr_zhao', name: '赵六', avatar: null })
    const [noMessage] = pendingRows({ ...base, friends: [{ id: 'frq_2', from: zhao, message: null, created_at: NOW - 5 * 60_000, expires_at: NOW + 1 }] })
    expect(noMessage!.sub).toBe('5 分钟前')
  })
  it('访问申请:只列等我处理的(pending),说清谁、要什么角色、哪个文档', () => {
    const rows = pendingRows({
      ...base,
      access: [
        { id: 'ar1', key: 'k', target: { kind: 'insight', space_id: 's', collection: 'c', id: 'i' }, title: '部署清单', requester: zhao, role: 'editor', message: null, state: 'pending', created_at: NOW - 120_000, decided_at: null },
        { id: 'ar2', key: 'k2', target: null, title: '旧申请', requester: zhao, role: 'viewer', message: null, state: 'approved', created_at: 1, decided_at: 2 },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'access', title: '赵六 申请可编辑「部署清单」', to: { path: '/shares', query: { tab: 'requests' } } })
  })
  it('申请人账号已不存在也不崩,写「有人」', () => {
    const [row] = pendingRows({
      ...base,
      access: [{ id: 'ar3', key: 'k', target: null, title: '周报', requester: null, role: 'commenter', message: null, state: 'pending', created_at: NOW, decided_at: null }],
    })
    expect(row!.title).toBe('有人 申请可评论「周报」')
    expect(row!.person).toBeUndefined()
  })
  it('待审的候选笔记只用一行代表,0 条不出现', () => {
    expect(pendingRows({ ...base, drafts: 7 })).toEqual([expect.objectContaining({ kind: 'review', title: '7 条待审核的候选笔记', action: '去审核', to: { path: '/review' } })])
    expect(pendingRows({ ...base, drafts: 0 })).toEqual([])
  })
  it('顺序:好友申请 → 访问申请 → 草稿', () => {
    const rows = pendingRows({
      ...base,
      drafts: 2,
      friends: [{ id: 'f', from: zhao, message: null, created_at: NOW, expires_at: NOW + 1 }],
      access: [{ id: 'a', key: 'k', target: null, title: 't', requester: zhao, role: 'viewer', message: null, state: 'pending', created_at: NOW, decided_at: null }],
    })
    expect(rows.map((row) => row.kind)).toEqual(['friend', 'access', 'review'])
  })
})
