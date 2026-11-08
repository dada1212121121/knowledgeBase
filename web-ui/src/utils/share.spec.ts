// 分享的纯逻辑:角色上限、资源标识、链接设置翻译、多选合并、报错文案。
import { describe, expect, it } from 'vitest'
import type { GrantList, PublicProfile, SharedWithMeItem, ShareTarget } from '@/api/share'
import {
  annotationAuthor,
  audienceOptions,
  canCommentRole,
  canEditRole,
  canStopInherit,
  dateText,
  expiryForCreate,
  expiryPatch,
  expiryText,
  filterFriends,
  grantableRoles,
  granteeSummary,
  granteesOf,
  groupByOwner,
  guestCeilingNote,
  isFolderLike,
  isNoAccess,
  joinedViaLink,
  linkStateOf,
  maskedLink,
  mergeGrants,
  personName,
  relativeTime,
  requestableRoles,
  roleLabel,
  roleRank,
  sameTarget,
  shareErrorText,
  sortGrantRows,
  sourceLabel,
  stripErrorPrefix,
  targetKey,
  targetKindLabel,
  targetName,
  tokenFromUrl,
  uniqueTargets,
  validateExpiryDays,
  validateLinkPassword,
} from './share'

const person = (id: string, name = id): PublicProfile => ({ id, username: id, display_name: name, avatar: null })
const note: ShareTarget = { kind: 'insight', space_id: 'sp_a', collection: '_global', id: 'ins_1' }
const dir: ShareTarget = { kind: 'dir', space_id: 'sp_a', collection: '_global', path: '运维/发布' }

describe('角色', () => {
  it('名字按术语表,高低按顺序', () => {
    expect(roleLabel('viewer')).toBe('可查看')
    expect(roleLabel('commenter')).toBe('可评论')
    expect(roleLabel('editor')).toBe('可编辑')
    expect(roleLabel('manager')).toBe('可管理')
    expect(roleLabel('owner')).toBe('所有者')
    expect(roleLabel(null)).toBe('无权限')
    expect(roleRank('viewer')).toBeLessThan(roleRank('commenter'))
    expect(roleRank('editor')).toBeLessThan(roleRank('manager'))
    expect(roleRank('manager')).toBeLessThan(roleRank('owner'))
  })

  it('最多授予与自己相同的角色;所有者也只能到「可管理」;不到「可管理」一个都不能授予', () => {
    expect(grantableRoles('owner')).toEqual(['viewer', 'commenter', 'editor', 'manager'])
    expect(grantableRoles('manager')).toEqual(['viewer', 'commenter', 'editor', 'manager'])
    expect(grantableRoles('editor')).toEqual([])
    expect(grantableRoles('viewer')).toEqual([])
    expect(grantableRoles(null)).toEqual([])
    expect(grantableRoles(undefined)).toEqual([])
  })
})

describe('资源标识', () => {
  it('同一个资源的 key 相同,不同资源不同;去重保持先后顺序', () => {
    expect(targetKey(note)).toBe('insight|sp_a|_global|ins_1')
    expect(targetKey(dir)).toBe('dir|sp_a|_global|运维/发布')
    expect(sameTarget(note, { ...note })).toBe(true)
    expect(sameTarget(note, dir)).toBe(false)
    expect(uniqueTargets([dir, note, { ...dir }, note]).map(targetKey)).toEqual([targetKey(dir), targetKey(note)])
  })

  it('文件夹类分享后里面的新文档自动可见;只有文件夹和文档能停止继承', () => {
    expect(isFolderLike({ kind: 'dir' })).toBe(true)
    expect(isFolderLike({ kind: 'collection' })).toBe(true)
    expect(isFolderLike({ kind: 'space' })).toBe(true)
    expect(isFolderLike({ kind: 'file' })).toBe(false)
    expect(isFolderLike(note)).toBe(false)
    expect(canStopInherit(dir)).toBe(true)
    expect(canStopInherit({ kind: 'file', path: 'a.md' })).toBe(true)
    expect(canStopInherit(note)).toBe(true)
    expect(canStopInherit({ kind: 'collection', collection: 'c' })).toBe(false)
    expect(canStopInherit({ kind: 'space' })).toBe(false)
  })

  it('显示名:有标题用标题,文件取最后一段,集合取集合名', () => {
    expect(targetName(note, '部署清单')).toBe('部署清单')
    expect(targetName(note, '  ')).toBe('ins_1')
    expect(targetName(dir)).toBe('发布')
    expect(targetName({ kind: 'file', path: 'docs/guide.md' })).toBe('guide.md')
    expect(targetName({ kind: 'collection', collection: 'proj_x' })).toBe('proj_x')
    expect(targetName({ kind: 'space' })).toBe('整个知识库')
    expect(targetKindLabel(dir)).toBe('文件夹')
    expect(targetKindLabel(note)).toBe('笔记')
  })

  it('「继承自」标签:解百分号编码,认不出的键不把键原样露给用户', () => {
    expect(sourceLabel('space:sp_a')).toBe('整个知识库')
    expect(sourceLabel('col:sp_a/knowledgeBase%2Finsights')).toBe('集合「knowledgeBase/insights」')
    expect(sourceLabel('dir:sp_a/_global/%E8%BF%90%E7%BB%B4')).toBe('文件夹「运维」')
    expect(sourceLabel('dir:sp_a/_global/team/%E5%8F%91%E5%B8%83')).toBe('文件夹「发布」')
    expect(sourceLabel('doc:sp_a/_global/i/ins_1')).toBe('文档「ins_1」')
    expect(sourceLabel('doc:sp_a/_global/f/docs/a.md')).toBe('文档「a.md」')
    expect(sourceLabel('乱七八糟')).toBe('上级')
    expect(sourceLabel('zzz:x')).toBe('上级')
    // 坏掉的编码也不抛错
    expect(sourceLabel('dir:sp_a/_global/%E8%BF')).toContain('文件夹')
  })
})

describe('人', () => {
  it('显示名:备注优先,其次昵称,最后用户名', () => {
    expect(personName({ username: 'bob', display_name: 'Bob' }, '老 b')).toBe('老 b')
    expect(personName({ username: 'bob', display_name: 'Bob' })).toBe('Bob')
    expect(personName({ username: 'bob', display_name: ' ' })).toBe('bob')
  })

  it('好友按用户名、昵称、备注过滤,不分大小写,限量', () => {
    const friends = [
      { ...person('zhangsan', '张三'), remark: null },
      { ...person('lisi', '李四'), remark: '老李' },
      { ...person('Wang', '王五'), remark: null },
    ]
    expect(filterFriends(friends, '').length).toBe(3)
    expect(filterFriends(friends, '张').map((f) => f.id)).toEqual(['zhangsan'])
    expect(filterFriends(friends, '老李').map((f) => f.id)).toEqual(['lisi'])
    expect(filterFriends(friends, 'wang').map((f) => f.id)).toEqual(['Wang'])
    expect(filterFriends(friends, '', 2).length).toBe(2)
    expect(filterFriends(friends, '没有这个人')).toEqual([])
  })
})

describe('链接设置', () => {
  it('没开通的访问范围不能选(登录用户 / 任何人各有自己的功能点)', () => {
    const all = audienceOptions(() => true)
    expect(all.map((o) => [o.value, o.disabled])).toEqual([
      ['collaborators', false],
      ['logged_in', false],
      ['anyone', false],
    ])
    const noGuest = audienceOptions((feature) => feature !== 'collab.link_guest')
    expect(noGuest.find((o) => o.value === 'anyone')).toMatchObject({ disabled: true, hint: '你的账号没有开通这种链接' })
    expect(noGuest.find((o) => o.value === 'logged_in')?.disabled).toBe(false)
    const none = audienceOptions(() => false)
    expect(none.filter((o) => o.disabled).map((o) => o.value)).toEqual(['logged_in', 'anyone'])
    // 「仅协作者」永远可选
    expect(none[0]).toMatchObject({ value: 'collaborators', disabled: false })
  })

  it('有效期:永久 = 去掉到期日;天数 = 从现在起;不改 = 什么都不带(否则会把到期日往后推)', () => {
    expect(expiryPatch('forever')).toEqual({ clear_expiry: true })
    expect(expiryPatch('1')).toEqual({ expires_days: 1 })
    expect(expiryPatch('7')).toEqual({ expires_days: 7 })
    expect(expiryPatch('30')).toEqual({ expires_days: 30 })
    expect(expiryPatch('custom', ' 14 ')).toEqual({ expires_days: 14 })
    expect(expiryPatch('keep')).toEqual({})
    // 创建时永久就是不带,不能带 clear_expiry(创建接口没有这个字段)
    expect(expiryForCreate('forever')).toEqual({})
    expect(expiryForCreate('7')).toEqual({ expires_days: 7 })
    expect(expiryForCreate('custom', '90')).toEqual({ expires_days: 90 })
  })

  it('自定义天数只收 1–3650 的整数', () => {
    expect(validateExpiryDays('14')).toBeNull()
    expect(validateExpiryDays('1')).toBeNull()
    expect(validateExpiryDays('3650')).toBeNull()
    expect(validateExpiryDays('0')).toContain('1–3650')
    expect(validateExpiryDays('3651')).toContain('1–3650')
    expect(validateExpiryDays('')).toContain('整数')
    expect(validateExpiryDays('1.5')).toContain('整数')
    expect(validateExpiryDays('-3')).toContain('整数')
    expect(validateExpiryDays('abc')).toContain('整数')
  })

  it('访问密码 4–12 位,按字符数算(中文一位就是一位),不含控制字符', () => {
    expect(validateLinkPassword('abcd')).toBeNull()
    expect(validateLinkPassword('abcdefghijkl')).toBeNull()
    expect(validateLinkPassword('密码很好用')).toBeNull()
    expect(validateLinkPassword('abc')).toContain('4–12')
    expect(validateLinkPassword('abcdefghijklm')).toContain('4–12')
    expect(validateLinkPassword('')).toContain('4–12')
    expect(validateLinkPassword('ab\ncd')).toContain('控制字符')
  })

  it('链接状态文字和色调', () => {
    expect(linkStateOf('active')).toEqual({ text: '生效中', tone: 'success' })
    expect(linkStateOf('closed').text).toBe('已关闭')
    expect(linkStateOf('expired').tone).toBe('warning')
    expect(linkStateOf('revoked').tone).toBe('danger')
    expect(linkStateOf('什么鬼').text).toBe('已关闭')
  })

  it('地址里取令牌;只有后四位时用掩码', () => {
    expect(tokenFromUrl('https://kb.example.com/s/q7Hk2xZp9aAbCdEfGhIjKl')).toBe('q7Hk2xZp9aAbCdEfGhIjKl')
    expect(tokenFromUrl('http://x/s/abc?x=1#y')).toBe('abc')
    expect(tokenFromUrl('http://x/other')).toBe('')
    expect(maskedLink('Zp9a')).toMatch(/^\/s\/•+Zp9a$/)
  })

  it('游客实际权限比链接设的低时说明原因;链接不是「任何人」不提', () => {
    expect(guestCeilingNote({ audience: 'anyone', role: 'editor', guest_role: 'viewer' })).toContain('「可查看」')
    expect(guestCeilingNote({ audience: 'anyone', role: 'editor', guest_role: 'viewer' })).toContain('「可编辑」')
    expect(guestCeilingNote({ audience: 'anyone', role: 'viewer', guest_role: 'viewer' })).toBe('')
    expect(guestCeilingNote({ audience: 'anyone', role: 'viewer', guest_role: null })).toContain('关闭了游客访问')
    expect(guestCeilingNote({ audience: 'logged_in', role: 'editor', guest_role: null })).toBe('')
  })
})

describe('时间文案', () => {
  // 固定「现在」= 2026-10-28 16:00(站点时区,默认上海),避免依赖运行时刻
  const now = Date.UTC(2026, 9, 28, 8, 0, 0)
  const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) => Date.UTC(year, month - 1, day, hour - 8, minute)

  it('相对时间按术语表', () => {
    expect(relativeTime(now - 20_000, now)).toBe('刚刚')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(relativeTime(at(10, 28, 14, 20), now)).toBe('今天 14:20')
    expect(relativeTime(at(10, 27, 23, 0), now)).toBe('昨天')
    expect(relativeTime(at(10, 26), now)).toBe('周一')
    expect(relativeTime(at(10, 19), now)).toBe('10-19')
    expect(relativeTime(at(10, 19, 12, 0, 2025), now)).toBe('2025-10-19')
    expect(relativeTime(null, now)).toBe('')
  })

  it('有效期一句话', () => {
    expect(expiryText(null, now)).toBe('永久有效')
    expect(expiryText(at(11, 30), now)).toBe('有效期至 11-30')
    expect(expiryText(at(1, 5, 12, 0, 2027), now)).toBe('有效期至 2027-01-05')
    expect(expiryText(now - 1, now)).toBe('已过期')
    expect(dateText(at(3, 4), now)).toBe('03-04')
  })
})

describe('协作者名单', () => {
  const list = (grants: GrantList['grants']): GrantList => ({
    target: dir,
    key: 'k',
    my_role: 'owner',
    owner: null,
    inherit_broken: false,
    grants,
  })
  const row = (id: string, role: GrantList['grants'][number]['role'], inherited = false, via = 'direct') => ({
    user: person(id),
    role,
    inherited,
    source: 'dir:sp_a/_global/x',
    via,
    expires_at: null,
  })

  it('多选:每一项上角色一致就显示这个角色;角色不同或只在部分项上是「各项不同」', () => {
    const merged = mergeGrants([
      list([row('bob', 'editor'), row('carol', 'viewer'), row('dave', 'viewer')]),
      list([row('bob', 'editor'), row('carol', 'editor')]),
      list([row('bob', 'editor')]),
    ])
    expect(merged.find((m) => m.user.id === 'bob')).toMatchObject({ role: 'editor', count: 3 })
    expect(merged.find((m) => m.user.id === 'carol')).toMatchObject({ role: 'mixed', count: 2 })
    expect(merged.find((m) => m.user.id === 'dave')).toMatchObject({ role: 'mixed', count: 1 })
  })

  it('多选只看直接授权,继承来的不进名单;只选一项时全部角色原样', () => {
    const merged = mergeGrants([list([row('bob', 'editor', true), row('carol', 'viewer')])])
    expect(merged.map((m) => m.user.id)).toEqual(['carol'])
    expect(merged[0]).toMatchObject({ role: 'viewer', count: 1 })
    expect(mergeGrants([])).toEqual([])
  })

  it('单个资源的列表:继承来的放后面,各组内按名字排;通过链接加入的能认出来', () => {
    const rows = sortGrantRows([row('zed', 'viewer', true), row('amy', 'editor', false, 'link:lnk_1'), row('bob', 'viewer')])
    expect(rows.map((r) => r.user.id)).toEqual(['amy', 'bob', 'zed'])
    expect(joinedViaLink(rows[0]!)).toBe(true)
    expect(joinedViaLink(rows[1]!)).toBe(false)
  })
})

describe('报错文案', () => {
  it('去掉后端的英文类别前缀,中文原话保留', () => {
    expect(stripErrorPrefix('forbidden: 你最多只能授予「可编辑」')).toBe('你最多只能授予「可编辑」')
    expect(stripErrorPrefix('invalid input: 不能分享给自己')).toBe('不能分享给自己')
    expect(stripErrorPrefix('not found: 没有找到这个用户')).toBe('没有找到这个用户')
    expect(stripErrorPrefix('没有前缀')).toBe('没有前缀')
  })

  it('中文 message 原样给用户;英文或空的按状态码写成人话', () => {
    expect(shareErrorText({ status: 403, message: 'forbidden: 你最多只能授予「可编辑」' })).toBe('你最多只能授予「可编辑」')
    expect(shareErrorText({ status: 403, message: 'forbidden: denied' })).toContain('没有权限')
    expect(shareErrorText({ status: 404, message: '' })).toContain('没有找到')
    expect(shareErrorText({ status: 400, message: 'invalid input: bad' })).toContain('填写的内容不对')
    expect(shareErrorText({ status: 409, message: 'x' })).toContain('刷新')
    expect(shareErrorText({ status: 429, message: 'x' })).toContain('太频繁')
    expect(shareErrorText({ status: 500, message: 'boom' })).toBe('操作没有成功,请稍后再试。')
    expect(shareErrorText(new Error('Failed to fetch'), '换一个兜底')).toBe('换一个兜底')
    expect(shareErrorText(null)).toBe('操作没有成功,请稍后再试。')
    // 任何情况都不把 HTTP 状态码或英文异常露出来
    for (const status of [400, 403, 404, 409, 429, 503, 500]) expect(shareErrorText({ status, message: 'Internal Server Error' })).not.toMatch(/[A-Za-z]{4,}|\d{3}/)
  })

  it('403 / 404 都当作「没有权限」(后端对没权限的资源回 404)', () => {
    expect(isNoAccess({ status: 403 })).toBe(true)
    expect(isNoAccess({ status: 404 })).toBe(true)
    expect(isNoAccess({ status: 500 })).toBe(false)
    expect(isNoAccess(new Error('x'))).toBe(false)
    expect(isNoAccess(null)).toBe(false)
  })
})

describe('共享给我', () => {
  const item = (owner: PublicProfile, title: string, extra: Partial<SharedWithMeItem> = {}): SharedWithMeItem => ({
    target: { kind: 'insight', space_id: `sp_${owner.id}`, collection: '_global', id: title },
    key: `doc:sp_${owner.id}/_global/i/${title}`,
    title,
    role: 'viewer',
    owner,
    shared_at: 1,
    expires_at: null,
    hidden: false,
    ...extra,
  })

  it('按分享人分组:最近分享给我的人在前,同一个人的内容也是新的在前', () => {
    const groups = groupByOwner([
      item(person('b', '李四'), '乙', { shared_at: 300 }),
      item(person('a', '张三'), '丙', { shared_at: 100 }),
      item(person('b', '李四'), '甲', { shared_at: 500 }),
      item(person('a', '张三'), '丁', { shared_at: 200 }),
    ])
    expect(groups.map((group) => personName(group.owner))).toEqual(['李四', '张三'])
    expect(groups[0]!.items.map((entry) => entry.title)).toEqual(['甲', '乙'])
    expect(groups[1]!.items.map((entry) => entry.title)).toEqual(['丁', '丙'])
  })

  it('时间相同时才按名字定先后(中文按拼音:丙 bing 在 丁 ding 前);Bob 这类英文名不会因浏览器不同而换位', () => {
    const groups = groupByOwner([item(person('z', '张三'), '丁', { shared_at: 1 }), item(person('z', '张三'), '丙', { shared_at: 1 }), item(person('l', '李四'), '甲', { shared_at: 1 })])
    expect(groups.map((group) => personName(group.owner))).toEqual(['李四', '张三'])
    expect(groups[1]!.items.map((entry) => entry.title)).toEqual(['丙', '丁'])
    // 英文名最近分享过就排在前面,与中英文排序规则无关
    const mixed = groupByOwner([item(person('a', '张三'), 'x', { shared_at: 1 }), item(person('b', 'Bob'), 'y', { shared_at: 2 })])
    expect(mixed.map((group) => personName(group.owner))).toEqual(['Bob', '张三'])
  })

  it('被我移出列表的默认不显示;整组都被移出就没有这一组', () => {
    const items = [item(person('a', '张三'), 'x', { hidden: true }), item(person('b', '李四'), 'y'), item(person('b', '李四'), 'z', { hidden: true })]
    expect(groupByOwner(items).map((group) => [personName(group.owner), group.items.length])).toEqual([['李四', 1]])
    // 打开「显示已移出的」:李四 2 项、张三 1 项
    expect(groupByOwner(items, true).map((group) => [personName(group.owner), group.items.length])).toEqual([['李四', 2], ['张三', 1]])
  })

  it('我能不能编辑 / 评论按角色高低', () => {
    expect(canEditRole('editor')).toBe(true)
    expect(canEditRole('manager')).toBe(true)
    expect(canEditRole('commenter')).toBe(false)
    expect(canEditRole(null)).toBe(false)
    expect(canCommentRole('commenter')).toBe(true)
    expect(canCommentRole('viewer')).toBe(false)
  })

  it('申请权限只列比现有角色更高的,且只有查看 / 评论 / 编辑三档', () => {
    expect(requestableRoles(null)).toEqual(['viewer', 'commenter', 'editor'])
    expect(requestableRoles('viewer')).toEqual(['commenter', 'editor'])
    expect(requestableRoles('commenter')).toEqual(['editor'])
    expect(requestableRoles('editor')).toEqual([])
    expect(requestableRoles('manager')).toEqual([])
  })
})

describe('我的分享', () => {
  const grantees = (...names: string[]) => ({ grantees: names.map((name) => ({ user: person(name, name), role: 'viewer' as const })) })

  it('协作者摘要:两人以内全列,更多的写「等 N 人」', () => {
    expect(granteeSummary(grantees('张三'))).toBe('张三')
    expect(granteeSummary(grantees('张三', '李四'))).toBe('张三、李四')
    expect(granteeSummary(grantees('张三', '李四', '王五', '赵六', '孙七'))).toBe('张三、李四 等 5 人')
    expect(granteeSummary(grantees())).toBe('')
  })

  it('选中的几项里出现过的协作者(去重、按名字排)', () => {
    const merged = granteesOf([grantees('王五', '张三'), grantees('张三', '李四')])
    expect(merged.map((profile) => profile.id)).toEqual(['李四', '王五', '张三'])
    expect(granteesOf([])).toEqual([])
  })
})

describe('评论作者', () => {
  it('游客去掉内部编号和「经链接」后缀;用户 id 不原样露出来', () => {
    expect(annotationAuthor('guest:小王#3fa9c1')).toBe('访客 小王')
    expect(annotationAuthor('guest:访客 3fa9#3fa9c1(经链接 Zp9a)')).toBe('访客 3fa9')
    expect(annotationAuthor('guest:小王#3fa9c1(经链接 Zp9a)')).toBe('访客 小王')
    expect(annotationAuthor('usr_8f21aa')).toBe('协作者')
    expect(annotationAuthor('usr_me', 'usr_me')).toBe('我')
    expect(annotationAuthor('mcp · Claude Code')).toBe('mcp · Claude Code')
    expect(annotationAuthor(null)).toBe('匿名')
    expect(annotationAuthor('  ')).toBe('匿名')
  })
})
