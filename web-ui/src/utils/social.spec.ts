// 好友页共用的纯逻辑:名字、排序筛选、时间写法、报错文案。
import { describe, expect, it } from 'vitest'
import { CapabilityError } from '@/api/client'
import type { Friend } from '@/api/social'
import {
  charCount,
  displayName,
  expiresText,
  filterFriends,
  formatWhen,
  friendSubtitle,
  friendTitle,
  hasControlChars,
  inviteFriendHint,
  isFeatureOff,
  socialErrorText,
  sortFriends,
  stripErrorPrefix,
} from './social'

const friend = (over: Partial<Friend> & { id: string; username: string }): Friend => ({
  display_name: '',
  avatar: null,
  remark: null,
  group_name: null,
  since: 0,
  ...over,
})

describe('名字', () => {
  it('昵称优先,没有昵称用用户名', () => {
    expect(displayName({ display_name: '林一', username: 'user_yi' })).toBe('林一')
    expect(displayName({ display_name: ' ', username: 'user_yi' })).toBe('user_yi')
  })

  it('好友主标题:备注优先,其次昵称,最后用户名', () => {
    expect(friendTitle(friend({ id: '1', username: 'bob', display_name: 'Bob', remark: '老 b' }))).toBe('老 b')
    expect(friendTitle(friend({ id: '1', username: 'bob', display_name: 'Bob' }))).toBe('Bob')
    expect(friendTitle(friend({ id: '1', username: 'bob' }))).toBe('bob')
    expect(friendTitle(friend({ id: '1', username: 'bob', remark: '   ' }))).toBe('bob')
  })

  it('小字:有备注时补上对方自己的昵称;永远带 @用户名,重名时靠它区分', () => {
    expect(friendSubtitle(friend({ id: '1', username: 'bob', display_name: 'Bob', remark: '老 b' }))).toBe('Bob(@bob)')
    expect(friendSubtitle(friend({ id: '1', username: 'bob', display_name: 'Bob' }))).toBe('@bob')
    // 昵称和用户名一样时不重复写
    expect(friendSubtitle(friend({ id: '1', username: 'bob', display_name: 'bob', remark: '老 b' }))).toBe('@bob')
  })
})

describe('排序与筛选', () => {
  const list = [
    friend({ id: '3', username: 'c', display_name: '王五' }),
    friend({ id: '1', username: 'a', display_name: '张三' }),
    friend({ id: '2', username: 'b', display_name: '李四', remark: '阿四' }),
    friend({ id: '4', username: 'd', display_name: 'Alice' }),
  ]

  it('按显示名排序:英文开头的在前,汉字按拼音;备注参与排序;不改原数组', () => {
    const before = list.map((item) => item.id)
    const sorted = sortFriends(list).map((item) => friendTitle(item))
    expect(sorted).toEqual(['Alice', '阿四', '王五', '张三'])
    expect(list.map((item) => item.id)).toEqual(before)
  })

  it('同名时按用户名排,顺序稳定', () => {
    const same = [friend({ id: '1', username: 'zed', display_name: '小明' }), friend({ id: '2', username: 'amy', display_name: '小明' })]
    expect(sortFriends(same).map((item) => item.username)).toEqual(['amy', 'zed'])
  })

  it('筛选:备注、昵称、用户名、分组都能命中,不区分大小写,首尾空白不算', () => {
    const rows = [
      friend({ id: '1', username: 'bob', display_name: 'Bobby', remark: '产品部小林', group_name: '同事' }),
      friend({ id: '2', username: 'carol', display_name: 'Carol' }),
    ]
    expect(filterFriends(rows, '  BOB ').map((item) => item.id)).toEqual(['1'])
    expect(filterFriends(rows, '小林').map((item) => item.id)).toEqual(['1'])
    expect(filterFriends(rows, '同事').map((item) => item.id)).toEqual(['1'])
    expect(filterFriends(rows, 'carol').map((item) => item.id)).toEqual(['2'])
    expect(filterFriends(rows, 'nobody')).toEqual([])
    expect(filterFriends(rows, '   ')).toHaveLength(2)
  })
})

describe('formatWhen', () => {
  // 按站点时区(默认上海)构造瞬间,「今天 / 昨天」的判断不随运行环境变化
  const local = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)
  const now = local(2026, 10, 28, 16, 20)

  it('一分钟内刚刚,一小时内 N 分钟前', () => {
    expect(formatWhen(now - 20_000, now)).toBe('刚刚')
    expect(formatWhen(now + 5_000, now)).toBe('刚刚')
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5 分钟前')
  })

  it('今天写时刻,昨天写昨天,一周内写周几', () => {
    expect(formatWhen(local(2026, 10, 28, 9, 5), now)).toBe('今天 09:05')
    expect(formatWhen(local(2026, 10, 27, 23, 50), now)).toBe('昨天')
    // 2026-10-26 是周一
    expect(formatWhen(local(2026, 10, 26, 12), now)).toBe('周一')
  })

  it('更早的写月-日,超过一年带年份', () => {
    expect(formatWhen(local(2026, 10, 19, 12), now)).toBe('10-19')
    expect(formatWhen(local(2026, 3, 2, 12), now)).toBe('03-02')
    expect(formatWhen(local(2025, 10, 19, 12), now)).toBe('2025-10-19')
  })

  it('没有时间返回空串', () => {
    expect(formatWhen(0, now)).toBe('')
  })
})

describe('expiresText', () => {
  const now = 1_000_000_000_000
  it('按天向上取整;不到一天、已过期各有说法', () => {
    expect(expiresText(now + 6.2 * 86_400_000, now)).toBe('7 天后过期')
    expect(expiresText(now + 86_400_000, now)).toBe('1 天后过期')
    expect(expiresText(now + 3_600_000, now)).toBe('不到 1 天后过期')
    expect(expiresText(now - 1, now)).toBe('已过期')
  })
})

describe('字数与控制字符', () => {
  it('字数按码点算:emoji 和生僻字不会算成两个', () => {
    expect(charCount('你好')).toBe(2)
    expect(charCount('👍')).toBe(1)
    expect(charCount('𠮷野家')).toBe(3)
  })

  it('换行、制表符是控制字符,普通标点不是', () => {
    expect(hasControlChars('第一行\n第二行')).toBe(true)
    expect(hasControlChars('a\tb')).toBe(true)
    expect(hasControlChars('你好,世界!')).toBe(false)
  })
})

describe('报错文案', () => {
  it('去掉后端错误前面的英文前缀', () => {
    expect(stripErrorPrefix('invalid input: 附言最多 100 个字')).toBe('附言最多 100 个字')
    expect(stripErrorPrefix('forbidden: 你刚刚向这位用户申请过,请 24 小时后再试')).toBe('你刚刚向这位用户申请过,请 24 小时后再试')
    expect(stripErrorPrefix('unavailable: 搜索太频繁了,请一分钟后再试')).toBe('搜索太频繁了,请一分钟后再试')
    expect(stripErrorPrefix('没有前缀的话原样')).toBe('没有前缀的话原样')
  })

  it('后端给的是中文原因就原样用', () => {
    const err = new CapabilityError('unavailable: 搜索太频繁了,请一分钟后再试', 'unavailable', 503)
    expect(socialErrorText(err, '兜底')).toBe('搜索太频繁了,请一分钟后再试')
  })

  it('不是给人看的(英文异常)换成调用方写的兜底;403 说明没开通', () => {
    expect(socialErrorText(new CapabilityError('internal: sqlite busy', 'internal', 500), '没能保存。请稍后重试。')).toBe('没能保存。请稍后重试。')
    expect(socialErrorText(new CapabilityError('forbidden', 'forbidden', 403), '兜底')).toBe('你的账号没有开通这个功能,请联系管理员。')
  })

  it('断网(fetch 抛 TypeError)告诉用户检查网络', () => {
    expect(socialErrorText(new TypeError('Failed to fetch'), '兜底')).toContain('连不上服务器')
  })

  it('其它任何东西都用兜底,不把原始异常给用户', () => {
    expect(socialErrorText(new Error('boom'), '兜底')).toBe('兜底')
    expect(socialErrorText('字符串', '兜底')).toBe('兜底')
  })

  it('403 / 404 才算「功能没开通」,500 不算', () => {
    expect(isFeatureOff(new CapabilityError('x', 'forbidden', 403))).toBe(true)
    expect(isFeatureOff(new CapabilityError('x', 'not_found', 404))).toBe(true)
    expect(isFeatureOff(new CapabilityError('x', 'internal', 500))).toBe(false)
    expect(isFeatureOff(new Error('x'))).toBe(false)
  })
})

describe('inviteFriendHint', () => {
  it('邀请码无效、或确认没有开「自动加好友」:不提示', () => {
    expect(inviteFriendHint(false, true)).toBe('')
    expect(inviteFriendHint(false, undefined)).toBe('')
    expect(inviteFriendHint(true, false)).toBe('')
  })

  it('接口告诉我们开了:确定的说法', () => {
    expect(inviteFriendHint(true, true)).toBe('注册后你会自动和邀请人成为好友,之后可以在「好友」里改备注或删除。')
  })

  it('接口没告诉我们(目前如此):用条件句如实说,不装作知道;也不透露邀请人是谁', () => {
    const text = inviteFriendHint(true, undefined)
    expect(text).toBe('如果邀请人开启了「自动加好友」,注册后你们会自动成为好友,之后可以在「好友」里改备注或删除。')
    expect(text).not.toMatch(/@|用户名/)
  })
})
