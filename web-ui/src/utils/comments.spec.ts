// 评论串的纯逻辑:分串排序、孤儿回复、筛选、作者显示。
import { describe, expect, it } from 'vitest'
import { authorView, buildThreads, commentCount, commentErrorText, filterThreads, resolverName, threadOf, type CommentAuthors, type CommentRecord } from './comments'

const c = (id: string, at: number, extra: Partial<CommentRecord> = {}): CommentRecord => ({ id, body: `正文 ${id}`, author: 'usr_bob', created_at: at, ...extra })

describe('buildThreads', () => {
  it('顶层评论按时间从旧到新;回复挂在父评论下,也按时间;输入顺序不影响结果', () => {
    const threads = buildThreads([c('r2', 50, { parent_id: 'a' }), c('b', 30), c('a', 10), c('r1', 20, { parent_id: 'a' })])
    expect(threads.map((thread) => thread.id)).toEqual(['a', 'b'])
    expect(threads[0]!.replies.map((reply) => reply.id)).toEqual(['r1', 'r2'])
    expect(threads[1]!.replies).toEqual([])
  })

  it('已解决看顶层评论的 resolved_at,回复自己的 resolved_at 不算', () => {
    const threads = buildThreads([c('a', 1, { resolved_at: 99, resolved_by: 'usr_bob' }), c('b', 2), c('r', 3, { parent_id: 'b', resolved_at: 99 })])
    expect(threads.map((thread) => thread.resolved)).toEqual([true, false])
  })

  it('父评论不在结果里(列表被条数上限截断)的回复归成一串,不丢也不挂错', () => {
    const threads = buildThreads([c('x', 100), c('r1', 40, { parent_id: 'gone' }), c('r2', 60, { parent_id: 'gone' })])
    expect(threads.map((thread) => thread.id)).toEqual(['orphan:gone', 'x'])
    expect(threads[0]!.root).toBeNull()
    expect(threads[0]!.replies.map((reply) => reply.id)).toEqual(['r1', 'r2'])
    expect(threads[0]!.resolved).toBe(false)
  })

  it('同一毫秒的评论顺序稳定(按 id),空列表是空数组', () => {
    expect(buildThreads([c('b', 5), c('a', 5)]).map((thread) => thread.id)).toEqual(['a', 'b'])
    expect(buildThreads([])).toEqual([])
  })
})

describe('筛选与查找', () => {
  const threads = buildThreads([c('a', 1, { resolved_at: 9 }), c('b', 2), c('r', 3, { parent_id: 'a' }), c('s', 4, { parent_id: 'b' })])
  it('「未解决」只留没标记的串;「全部」都留', () => {
    expect(filterThreads(threads, 'open').map((thread) => thread.id)).toEqual(['b'])
    expect(filterThreads(threads, 'all').map((thread) => thread.id)).toEqual(['a', 'b'])
  })
  it('总条数含回复;孤儿串里没有顶层评论也只数回复', () => {
    expect(commentCount(threads)).toBe(4)
    expect(commentCount(buildThreads([c('r', 1, { parent_id: 'gone' })]))).toBe(1)
  })
  it('按评论 id 找到它所在的串(顶层或回复都行),找不到是 null', () => {
    expect(threadOf(threads, 'r')?.id).toBe('a')
    expect(threadOf(threads, 'b')?.id).toBe('b')
    expect(threadOf(threads, 'nope')).toBeNull()
  })
})

describe('authorView', () => {
  const authors: CommentAuthors = {
    usr_bob: { id: 'usr_bob', username: 'bob', display_name: 'Bob', avatar: 'a1.png' },
    usr_anon: { id: 'usr_anon', display_name: '匿名可见的人', avatar: null },
    usr_blank: { id: 'usr_blank', username: 'blank', display_name: '  ', avatar: null },
  }
  it('登录用户用 authors 里的显示名和头像;自己显示「我」', () => {
    expect(authorView('usr_bob', authors, 'usr_me')).toMatchObject({ name: 'Bob', username: 'bob', userId: 'usr_bob', avatar: 'a1.png', isMe: false, kind: 'user' })
    expect(authorView('usr_bob', authors, 'usr_bob')).toMatchObject({ name: '我', isMe: true })
  })
  it('匿名访客看到的资料没有用户名:不假设它存在', () => {
    expect(authorView('usr_anon', authors)).toMatchObject({ name: '匿名可见的人', username: null })
  })
  it('显示名是空白就退回用户名;不在映射里显示「协作者」,绝不露出用户 id', () => {
    expect(authorView('usr_blank', authors).name).toBe('blank')
    expect(authorView('usr_gone', authors).name).toBe('协作者')
    expect(authorView('usr_gone', undefined).name).toBe('协作者')
    expect(authorView('usr_gone', authors).username).toBeNull()
  })
  it('游客:「访客 昵称」,不展示编号和「经链接」后缀,也没有头像 / 用户 id', () => {
    const view = authorView('guest:小王#3fa9c1(经链接 Zp9a)', authors)
    expect(view).toMatchObject({ name: '访客 小王', kind: 'guest', userId: null, avatar: null, username: null })
    expect(JSON.stringify(view)).not.toContain('3fa9c1')
  })
  it('工具(web / mcp)原样显示;空作者是「匿名」', () => {
    expect(authorView('mcp · Claude Code', authors)).toMatchObject({ name: 'mcp · Claude Code', kind: 'tool' })
    expect(authorView(null, authors).name).toBe('匿名')
    expect(authorView('  ', authors).name).toBe('匿名')
  })
  it('谁标记的已解决:自己是「我」,有资料点名,没资料不点名', () => {
    expect(resolverName('usr_me', authors, 'usr_me')).toBe('我')
    expect(resolverName('usr_bob', authors, 'usr_me')).toBe('Bob')
    expect(resolverName('usr_gone', authors, 'usr_me')).toBe('')
    expect(resolverName(null, authors)).toBe('')
  })
})

describe('commentErrorText', () => {
  it('404 不显示后端的「评论 <内部 id>」,换成人话并说怎么办', () => {
    const text = commentErrorText({ status: 404, message: 'not found: 评论 0190a1' }, '兜底')
    expect(text).toContain('已经不在了')
    expect(text).toContain('刷新页面后再试')
    expect(text).not.toContain('0190a1')
  })
  it('其它错误沿用分享里的转换:中文消息原样用,没有就按状态码,再没有用兜底', () => {
    expect(commentErrorText({ status: 403, message: 'forbidden: 这个链接的权限是「可查看」,不能执行这个操作' }, '兜底')).toBe('这个链接的权限是「可查看」,不能执行这个操作')
    expect(commentErrorText({ status: 429, message: 'rate limited' }, '兜底')).toContain('太频繁')
    expect(commentErrorText({ status: 500, message: 'boom' }, '兜底')).toBe('兜底')
  })
})
