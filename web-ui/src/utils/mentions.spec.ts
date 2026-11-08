// 评论里的 @ 提及:解析、高亮切分、光标处补全、候选的合并与过滤。
import { describe, expect, it } from 'vitest'
import { applyMention, bodySegments, extractMentions, filterCandidates, mentionQuery, mergeCandidates, type MentionCandidate } from './mentions'

describe('@ 解析', () => {
  it('取出 @用户名:小写、去重、不带 @,顺序按首次出现', () => {
    expect(extractMentions('请 @Alice 和 @bob_2 看看,@alice 再确认')).toEqual(['alice', 'bob_2'])
  })
  it('中文紧跟着用户名也行;用户名后面是标点 / 换行也行', () => {
    expect(extractMentions('@alice请看,@bob_2。\n@carol')).toEqual(['alice', 'bob_2', 'carol'])
  })
  it('邮箱、太短、太长、不在词边界的 @ 都不算', () => {
    expect(extractMentions('发到 a@b.com 或 x.y@mail.cn')).toEqual([])
    expect(extractMentions('@ab 太短')).toEqual([])
    expect(extractMentions(`@${'a'.repeat(21)} 太长`)).toEqual([])
    expect(extractMentions('@@alice')).toEqual([])
    expect(extractMentions('没有人')).toEqual([])
  })
  it('一条最多 10 个(后端也只取前 10 个)', () => {
    const body = Array.from({ length: 12 }, (_, index) => `@user${String(index).padStart(2, '0')}`).join(' ')
    expect(extractMentions(body)).toHaveLength(10)
    expect(extractMentions(body)[9]).toBe('user09')
  })
  it('高亮片段:只看写法,不看这个人存不存在;拼回去等于原文', () => {
    const body = '请 @alice 看,@nobody_here 也看。a@b.com 不算'
    const segments = bodySegments(body)
    expect(segments.map((segment) => segment.text).join('')).toBe(body)
    expect(segments.filter((segment) => segment.mention).map((segment) => segment.text)).toEqual(['@alice', '@nobody_here'])
  })
})

describe('@ 补全', () => {
  it('光标前正在输入的 @xxx:取出位置和已输入的部分', () => {
    expect(mentionQuery('请 @al', 5)).toEqual({ start: 2, query: 'al' })
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQuery('你好@bo', 5)).toEqual({ start: 2, query: 'bo' })
  })
  it('不在输入提及时是 null:邮箱里的 @、@ 后面已有空格、光标在别处', () => {
    expect(mentionQuery('a@b', 3)).toBeNull()
    expect(mentionQuery('@alice 然后', 9)).toBeNull()
    expect(mentionQuery('没有', 2)).toBeNull()
    expect(mentionQuery(`@${'a'.repeat(21)}`, 22)).toBeNull()
  })
  it('选中候选:@al 换成 @alice 并补一个空格,光标在空格之后', () => {
    expect(applyMention('请 @al', 2, 5, 'alice')).toEqual({ text: '请 @alice ', caret: 9 })
  })
  it('后面本来就是空格 / 换行就不再补;中间插入时后半段原样保留', () => {
    expect(applyMention('@al 看看', 0, 3, 'alice')).toEqual({ text: '@alice 看看', caret: 7 })
    expect(applyMention('@al\n下一行', 0, 3, 'alice')).toEqual({ text: '@alice\n下一行', caret: 7 })
  })
})

describe('候选', () => {
  const person = (username: string, source: MentionCandidate['source'], extra: Partial<MentionCandidate> = {}): MentionCandidate => ({
    id: `usr_${username}`, username, display_name: username.toUpperCase(), avatar: null, source, ...extra,
  })
  it('合并:同一个人只留一条,来源取优先级最高的,并保住好友备注;排除自己;没用户名的丢掉', () => {
    const merged = mergeCandidates(
      [
        [person('lisi', 'friend', { remark: '老李' }), person('wangwu', 'friend')],
        [person('lisi', 'collaborator'), person('me', 'collaborator'), { ...person('anon', 'commenter'), username: '' }],
      ],
      'usr_me',
    )
    expect(merged.map((entry) => [entry.username, entry.source])).toEqual([['lisi', 'collaborator'], ['wangwu', 'friend']])
    expect(merged[0]!.remark).toBe('老李')
  })
  it('过滤:用户名开头 > 用户名包含 > 昵称 / 备注包含;空查询给前几个;限量', () => {
    const list = [person('zhangsan', 'friend', { display_name: '张三' }), person('anna', 'friend', { remark: '安娜' }), person('banana', 'friend'), person('lisi', 'friend', { display_name: '李四', remark: '老李' })]
    expect(filterCandidates(list, 'an').map((entry) => entry.username)).toEqual(['anna', 'zhangsan', 'banana'])
    expect(filterCandidates(list, '老李').map((entry) => entry.username)).toEqual(['lisi'])
    expect(filterCandidates(list, '张').map((entry) => entry.username)).toEqual(['zhangsan'])
    expect(filterCandidates(list, '').map((entry) => entry.username)).toHaveLength(4)
    expect(filterCandidates(list, '', 2)).toHaveLength(2)
    expect(filterCandidates(list, 'nobody')).toEqual([])
  })
})
