// 通知怎么显示:种类 → 分类 / 图标、一句人话、点了去哪。数据形状来自后端发送处(见 notifications.ts 顶部)。
import { describe, expect, it } from 'vitest'
import { CATEGORIES, KIND_INFO, KIND_ORDER, categoryOf, describeNotification, kindInfo, notificationTarget, profileOf } from './notifications'

const zhao = { id: 'usr_zhao', username: 'zhaoliu', display_name: '赵六', avatar: null }
const n = (kind: string, data: Record<string, unknown>) => ({ kind, data })
const target = (over: Record<string, unknown>) => ({ kind: 'insight', space_id: 'sp_other', collection: '_global', id: 'ins_1', ...over })

describe('种类表', () => {
  it('与后端 kind::ALL 一一对应(十种,顺序一致)', () => {
    expect(KIND_ORDER).toEqual([
      'friend_request', 'friend_result', 'share_received', 'access_request', 'access_result',
      'comment_reply', 'mention', 'collaborator_removed', 'link_expiring', 'announcement',
    ])
  })

  it('名字与后端 kind::label 一致', () => {
    expect(Object.fromEntries(Object.entries(KIND_INFO).map(([kind, info]) => [kind, info.label]))).toEqual({
      friend_request: '好友申请', friend_result: '好友申请结果', share_received: '收到分享', access_request: '访问申请',
      access_result: '访问申请结果', comment_reply: '评论回复', mention: '有人提到我', collaborator_removed: '被移出协作者',
      link_expiring: '分享链接即将到期', announcement: '系统公告',
    })
  })

  it('分类:好友 / 分享 / 评论 / 系统;每种通知都归一类', () => {
    expect(categoryOf('friend_request')).toBe('friend')
    expect(categoryOf('friend_result')).toBe('friend')
    for (const kind of ['share_received', 'access_request', 'access_result', 'collaborator_removed', 'link_expiring']) expect(categoryOf(kind)).toBe('share')
    for (const kind of ['comment_reply', 'mention']) expect(categoryOf(kind)).toBe('comment')
    expect(categoryOf('announcement')).toBe('system')
    expect(CATEGORIES.map((item) => item.label)).toEqual(['全部', '好友', '分享', '评论', '系统'])
  })

  it('每种通知都有一句说明(通知偏好页用)', () => {
    for (const [kind, info] of Object.entries(KIND_INFO)) expect(info.hint.length, kind).toBeGreaterThan(4)
  })

  it('不认识的种类(后端新增了)归系统、用通用文案', () => {
    expect(kindInfo('brand_new')).toEqual({ label: '通知', category: 'system', icon: 'bell', hint: '' })
    expect(categoryOf('brand_new')).toBe('system')
  })
})

describe('describeNotification', () => {
  it('好友申请:昵称 + @用户名 + 附言(带引号),头像用对方', () => {
    const view = describeNotification(n('friend_request', { request_id: 'frq_1', from: zhao, message: '我是上周的同事' }))
    expect(view.title).toBe('赵六(@zhaoliu) 请求加你为好友')
    expect(view.detail).toBe('“我是上周的同事”')
    expect(view.actor).toEqual(zhao)
  })

  it('好友申请没有附言:第二行为空', () => {
    expect(describeNotification(n('friend_request', { from: zhao, message: null })).detail).toBe('')
  })

  it('好友申请结果:通过 / 没通过 / 通过邀请码自动成为好友', () => {
    expect(describeNotification(n('friend_result', { accepted: true, by: zhao })).title).toBe('赵六(@zhaoliu) 通过了你的好友申请')
    expect(describeNotification(n('friend_result', { accepted: false, by: zhao })).title).toBe('赵六(@zhaoliu) 没有通过你的好友申请')
    expect(describeNotification(n('friend_result', { accepted: true, via_invite: true, by: zhao })).title).toBe('赵六(@zhaoliu) 通过你的邀请码加入,已自动成为你的好友')
  })

  it('收到分享:谁、哪份文档、我的权限;一次分享多项时说数量', () => {
    const one = describeNotification(n('share_received', { title: '部署清单', count: 1, role_label: '可编辑', from: zhao }))
    expect(one.title).toBe('赵六 向你分享了「部署清单」')
    expect(one.detail).toBe('你的权限:可编辑')
    expect(describeNotification(n('share_received', { title: '部署清单', count: 5, role_label: '可查看', from: zhao })).title).toBe('赵六 向你分享了 5 项内容')
  })

  it('访问申请与结果', () => {
    const request = describeNotification(n('access_request', { title: '部署清单', role_label: '可编辑', requester: zhao, message: '想一起改' }))
    expect(request.title).toBe('赵六 申请「部署清单」的可编辑权限')
    expect(request.detail).toBe('“想一起改”')
    const yes = describeNotification(n('access_result', { title: '部署清单', approved: true, role_label: '可编辑', by: zhao }))
    expect(yes.title).toBe('赵六 同意了你对「部署清单」的访问申请')
    expect(yes.detail).toBe('你的权限:可编辑')
    const no = describeNotification(n('access_result', { title: '部署清单', approved: false, role_label: '可编辑', by: zhao }))
    expect(no.title).toBe('赵六 拒绝了你对「部署清单」的访问申请')
    expect(no.detail).toBe('')
  })

  it('被移出协作者', () => {
    expect(describeNotification(n('collaborator_removed', { title: '部署清单', from: zhao })).title).toBe('赵六 把你从「部署清单」的协作者中移除了')
  })

  it('后端还没有发送处的几种:有什么字段就用什么,缺了退回通用文案', () => {
    expect(describeNotification(n('mention', { from: zhao, title: '周报', excerpt: '@你 看一下' }))).toMatchObject({ title: '赵六 在「周报」里提到了你', detail: '@你 看一下' })
    expect(describeNotification(n('comment_reply', { from: zhao, title: '周报', text: '同意' }))).toMatchObject({ title: '赵六 回复了你在「周报」的评论', detail: '同意' })
    expect(describeNotification(n('link_expiring', { title: '周报' })).title).toBe('「周报」的分享链接即将到期')
    expect(describeNotification(n('announcement', { title: '今晚维护', body: '23:00 起停机 10 分钟' }))).toMatchObject({ title: '今晚维护', detail: '23:00 起停机 10 分钟' })
    expect(describeNotification(n('announcement', {})).title).toBe('系统公告')
    expect(describeNotification(n('mention', {})).title).toBe('有人 在「一份文档」里提到了你')
  })

  it('永远不显示原始 JSON:不认识的种类、坏数据都只给种类名', () => {
    expect(describeNotification(n('brand_new', { secret: 'x' }))).toEqual({ title: '通知', detail: '', actor: null })
    expect(describeNotification({ kind: 'friend_request', data: null as unknown as Record<string, unknown> }).title).toBe('有人 请求加你为好友')
    expect(describeNotification(n('friend_request', { from: 'not an object' })).actor).toBeNull()
  })

  it('用户写的文字(昵称、标题、附言)原样保留,不做任何 HTML 处理(由模板按纯文本显示)', () => {
    const view = describeNotification(n('share_received', { title: '<b>x</b>', from: { ...zhao, display_name: '<i>赵</i>' } }))
    expect(view.title).toBe('<i>赵</i> 向你分享了「<b>x</b>」')
  })
})

describe('profileOf', () => {
  it('需要 id 和 username;缺了就当没有', () => {
    expect(profileOf(zhao)).toEqual(zhao)
    expect(profileOf({ id: 'a' })).toBeNull()
    expect(profileOf(null)).toBeNull()
    expect(profileOf({ id: 'a', username: 'b', avatar: 'a.png' })).toEqual({ id: 'a', username: 'b', display_name: '', avatar: 'a.png' })
  })
})

describe('notificationTarget', () => {
  it('好友申请 → 好友页「申请」页签;申请结果 → 好友页', () => {
    expect(notificationTarget(n('friend_request', {}), 'sp_me')).toEqual({ path: '/friends', query: { tab: 'requests' } })
    expect(notificationTarget(n('friend_result', {}), 'sp_me')).toEqual({ path: '/friends' })
  })

  it('别人知识库里的笔记 / 文件 / 目录 / 集合:去知识库对应位置,并带上对方的知识库 id', () => {
    expect(notificationTarget(n('share_received', { target: target({}) }), 'sp_me')).toEqual({ path: '/kb', query: { collection: '_global', item: 'ins_1', space: 'sp_other', scope: 'shared' } })
    expect(notificationTarget(n('share_received', { target: target({ kind: 'file', id: undefined, path: 'a/b.pdf' }) }), 'sp_me')).toEqual({
      path: '/kb',
      query: { collection: '_global', path: 'a/b.pdf', space: 'sp_other', scope: 'shared' },
    })
    expect(notificationTarget(n('share_received', { target: target({ kind: 'dir', id: undefined, path: 'a/b' }) }), 'sp_me')).toEqual({
      path: '/kb',
      query: { collection: '_global', dir: 'a/b', space: 'sp_other', scope: 'shared' },
    })
    expect(notificationTarget(n('share_received', { target: target({ kind: 'collection', id: undefined }) }), 'sp_me')).toEqual({
      path: '/kb',
      query: { collection: '_global', space: 'sp_other', scope: 'shared' },
    })
  })

  it('我自己知识库里的内容(别人申请访问我的文档):不带 space 参数,现在的知识库页就能打开', () => {
    expect(notificationTarget(n('access_request', { target: target({ space_id: 'sp_me' }) }), 'sp_me')).toEqual({ path: '/kb', query: { collection: '_global', item: 'ins_1' } })
  })

  it('没有 target、被移出协作者、系统公告:没有去处(这一行不可点)', () => {
    expect(notificationTarget(n('share_received', {}), 'sp_me')).toBeNull()
    expect(notificationTarget(n('collaborator_removed', { target: target({}) }), 'sp_me')).toBeNull()
    expect(notificationTarget(n('announcement', { target: target({}) }), 'sp_me')).toBeNull()
    expect(notificationTarget(n('brand_new', {}), 'sp_me')).toBeNull()
  })
})
