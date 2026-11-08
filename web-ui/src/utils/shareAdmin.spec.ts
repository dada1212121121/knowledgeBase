import { describe, expect, it } from 'vitest'
import type { AdminLink } from '@/api/usage'
import { canRevoke, filterLinks, isRisky, kindLabel, linkCounts, personText } from './shareAdmin'

const person = (username: string, name: string | null) => ({ id: `usr_${username}`, username, display_name: name, avatar: null })
const link = (id: string, extra: Partial<AdminLink> = {}): AdminLink => ({
  id: `lnk_${id}`,
  hint: id,
  kind: 'insight',
  audience: 'anyone',
  role: 'viewer',
  has_password: false,
  state: 'active',
  views: 0,
  last_view_at: null,
  created_at: 0,
  creator: person('alice', 'Alice'),
  owner: person('alice', 'Alice'),
  ...extra,
})

describe('分享治理的纯逻辑', () => {
  it('类型与人名:账号被删除显示「已删除的账号」,没有昵称用用户名', () => {
    expect(kindLabel('dir')).toBe('文件夹')
    expect(kindLabel('bundle')).toBe('多项合集')
    expect(kindLabel('???')).toBe('其它')
    expect(personText(null)).toBe('已删除的账号')
    expect(personText(person('bob', null))).toBe('bob')
    expect(personText(person('bob', ' 鲍勃 '))).toBe('鲍勃')
  })

  it('「有风险」= 有效 + 任何人能开 + 没有密码;有密码、要登录、已失效的都不算', () => {
    expect(isRisky(link('a'))).toBe(true)
    expect(isRisky(link('b', { has_password: true }))).toBe(false)
    expect(isRisky(link('c', { audience: 'logged_in' }))).toBe(false)
    expect(isRisky(link('d', { state: 'expired' }))).toBe(false)
  })

  it('已撤销的不能再撤销,过期和被关闭的仍可撤销', () => {
    expect(canRevoke(link('a', { state: 'revoked' }))).toBe(false)
    expect(canRevoke(link('b', { state: 'expired' }))).toBe(true)
    expect(canRevoke(link('c', { state: 'closed' }))).toBe(true)
    expect(canRevoke(link('d'))).toBe(true)
  })

  it('筛选:按所有者 / 创建者 / 尾号查找,再按状态', () => {
    const rows = [
      link('aa11'),
      link('bb22', { owner: person('zhangsan', '张三'), has_password: true }),
      link('cc33', { owner: person('lisi', '李四'), creator: person('bob', 'Bob'), state: 'expired' }),
      link('dd44', { owner: null, creator: null, state: 'revoked' }),
    ]
    expect(filterLinks(rows, { query: '张三', state: 'all' }).map((row) => row.hint)).toEqual(['bb22'])
    expect(filterLinks(rows, { query: 'BOB', state: 'all' }).map((row) => row.hint)).toEqual(['cc33'])
    expect(filterLinks(rows, { query: 'dd44', state: 'all' }).map((row) => row.hint)).toEqual(['dd44'])
    expect(filterLinks(rows, { query: '', state: 'active' }).map((row) => row.hint)).toEqual(['aa11', 'bb22'])
    expect(filterLinks(rows, { query: '', state: 'risky' }).map((row) => row.hint)).toEqual(['aa11'])
    expect(filterLinks(rows, { query: '', state: 'ended' }).map((row) => row.hint)).toEqual(['cc33', 'dd44'])
  })

  it('统计:有效数 / 有风险数 / 有密码的有效链接数', () => {
    const rows = [link('a'), link('b', { has_password: true }), link('c', { state: 'revoked' })]
    expect(linkCounts(rows)).toEqual({ active: 2, risky: 1, passworded: 1 })
  })
})
