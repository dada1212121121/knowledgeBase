import { clockText, daysAgo, monthDayText, weekday } from './time'
// 好友与通知页面共用的纯逻辑:名字怎么显示、列表怎么排和筛、时间怎么写、报错怎么说。
// 不依赖组件,方便单测。文案规则见 设计稿(报错 = 发生了什么 + 可以怎么做;相对时间的写法)。
import { CapabilityError } from '@/api/client'
import type { Friend, PublicProfile } from '@/api/social'

/** 与后端 kb-core/src/social.rs 的上限一致:前端先拦一遍,少碰一次 400。 */
export const MAX_REQUEST_MESSAGE = 100
export const MAX_REMARK = 30
export const MAX_GROUP = 20

/** 字数按码点算(后端用 chars.count),emoji、生僻字不会被算成两个。 */
export function charCount(text: string): number {
  return Array.from(text).length
}

/** 后端拒绝换行等控制字符(附言、备注、分组名)。 */
export function hasControlChars(text: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(text)
}

/** 给人看的名字:昵称优先,没有昵称用用户名。 */
export function displayName(profile: Pick<PublicProfile, 'display_name' | 'username'>): string {
  return profile.display_name.trim() || profile.username
}

/** 好友列表里的主标题:我给他起的备注名优先。 */
export function friendTitle(friend: Pick<Friend, 'remark' | 'display_name' | 'username'>): string {
  return friend.remark?.trim() || displayName(friend)
}

/** 主标题下面的小字:有备注时补上对方自己的昵称,让人知道备注的是谁;一律带 @用户名,重名时靠它区分。 */
export function friendSubtitle(friend: Pick<Friend, 'remark' | 'display_name' | 'username'>): string {
  const handle = `@${friend.username}`
  const nick = friend.display_name.trim()
  if (friend.remark?.trim() && nick && nick !== friend.username) return `${nick}(${handle})`
  return handle
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

// 不同浏览器的排序规则对「英文和汉字谁在前」说法不一(有的英文在前,有的汉字在前),
// 所以先把英文 / 数字开头的排在前面,再各自内部排序(汉字按拼音);这样各个浏览器里顺序一致。
const startsWithHan = (text: string) => /^[\u3400-\u9fff]/.test(text)

/** 按显示名排序(中文按拼音),同名按用户名,保证顺序稳定。不改原数组。 */
export function sortFriends(list: readonly Friend[]): Friend[] {
  return [...list].sort((a, b) => {
    const left = friendTitle(a)
    const right = friendTitle(b)
    return Number(startsWithHan(left)) - Number(startsWithHan(right)) || collator.compare(left, right) || collator.compare(a.username, b.username)
  })
}

/** 在备注、昵称、用户名、分组里找关键词(不区分大小写,空白不算)。 */
export function filterFriends(list: readonly Friend[], query: string): Friend[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...list]
  return list.filter((friend) =>
    [friend.remark, friend.display_name, friend.username, friend.group_name].some((field) => field?.toLowerCase().includes(needle)),
  )
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 相对时间,写法按 GLOSSARY:刚刚 / 5 分钟前 / 今天 14:20 / 昨天 / 周一 / 10-19 / 2025-10-19(超过一年带年份)。 */
export function formatWhen(at: number, now: number = Date.now()): string {
  if (!at) return ''
  const diff = now - at
  // 时钟略有偏差时对方的时间可能比本机「晚」几秒,也算刚刚
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  // 日历日按站点时区切分:跨时区时“昨天”不能按访问者电脑的午夜算
  const days = daysAgo(at, now)
  if (days <= 0) return `今天 ${clockText(at)}`
  if (days === 1) return '昨天'
  if (days < 7) return WEEKDAYS[weekday(at)]!
  return monthDayText(at, now)
}

/** 申请还有多久过期(后端 7 天自动过期)。 */
export function expiresText(expiresAt: number, now: number = Date.now()): string {
  const left = expiresAt - now
  if (left <= 0) return '已过期'
  if (left < 86_400_000) return '不到 1 天后过期'
  return `${Math.ceil(left / 86_400_000)} 天后过期`
}

/** 后端错误文案前面带「invalid input: 」「forbidden: 」之类的英文前缀,给人看的话不需要。 */
export function stripErrorPrefix(message: string): string {
  return message.replace(/^(invalid input|forbidden|not found|unavailable|already exists|upstream|internal):\s*/i, '').trim()
}

const hasChinese = (text: string) => /[\u4e00-\u9fff]/.test(text)

/**
 * 把请求失败翻成人话。后端给的中文原因(「搜索太频繁了,请一分钟后再试」)原样用;
 * 看起来不是给人看的(英文异常、HTTP 状态码)就换成调用方写的 `fallback`(它应该写成「发生了什么 + 怎么办」)。
 */
export function socialErrorText(err: unknown, fallback: string): string {
  if (err instanceof CapabilityError) {
    const text = stripErrorPrefix(err.message)
    if (hasChinese(text)) return text
    if (err.status === 403) return '你的账号没有开通这个功能,请联系管理员。'
    return fallback
  }
  if (err instanceof TypeError) return '连不上服务器。检查网络后重试,页面会自动重连。'
  return fallback
}

/**
 * 是不是「这个账号用不了好友功能」:功能点被关掉时,后端对每个好友能力返回 403 或 404(见 e2e_social.rs)。
 * 页面据此显示「没有开通」而不是一条笼统的报错。
 */
export function isFeatureOff(err: unknown): boolean {
  return err instanceof CapabilityError && (err.status === 403 || err.status === 404)
}

/**
 * 「拉黑」的确认弹窗内容(好友详情、收到的申请两处共用,后果只写一份)。
 * 后果照后端的行为写:解除好友、作废待处理的申请,对方不能再申请 / 分享给我 / 提到我,对方不会收到通知,已有分享不受影响。
 */
export function blockConfirmText(name: string) {
  return {
    title: `拉黑${name}?`,
    message:
      '拉黑后你们不再是好友,双方待处理的申请会作废;对方不能再向你申请好友、不能把文档分享给你、不能在评论里提到你。对方不会收到任何通知,已经分享的内容不受影响。你可以随时在「已拉黑」里取消。',
    confirmText: '拉黑',
    tone: 'danger' as const,
    doneText: '已拉黑',
  }
}

/**
 * 注册页:邀请码有效时,告诉用户注册后会不会自动和邀请人成为好友。
 * 邀请码可以设成「自动加好友」(后端 auto_friend,默认是)。注册页核对邀请码的接口(invite-check)目前不告诉前端
 * 这个邀请码有没有开,所以拿不到答案时用条件句如实说;以后接口带上 `auto_friend` 就会变成确定的说法。
 * 不透露邀请人是谁:注册之前不需要知道。
 */
export function inviteFriendHint(valid: boolean, autoFriend: boolean | undefined): string {
  if (!valid || autoFriend === false) return ''
  const tail = '之后可以在「好友」里改备注或删除。'
  return autoFriend === true ? `注册后你会自动和邀请人成为好友,${tail}` : `如果邀请人开启了「自动加好友」,注册后你们会自动成为好友,${tail}`
}
