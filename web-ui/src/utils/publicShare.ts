// 公开分享页的纯逻辑:错误码 → 给游客看的状态页、密码页的报错、昵称校验、内置浏览器识别。
// 后端的状态和错误码见 kb-web/src/share_public.rs 与 tests/e2e_links.rs。文案按术语表:
// 先说发生了什么,再说可以怎么做;各种失效状态不透露「除了失效本身以外」的信息(不告诉游客这是谁的什么内容)。
import type { PublicActive, ShareTarget } from '@/api/share'
import { targetKindLabel, targetName } from '@/utils/share'

export interface StatusView {
  /** 状态页图标的语气:失效类 neutral;需要登录 / 没权限 accent;网络 / 限流 warning */
  tone: 'neutral' | 'accent' | 'warning'
  icon: 'link' | 'lock' | 'clock' | 'failed' | 'users'
  title: string
  text: string
  /** 页面给的下一步:登录 / 重试 / 没有(失效了,只能联系所有者) */
  action: 'login' | 'retry' | null
  /** 后端错误码(测试和排查用,不显示) */
  code: string
}

interface ErrorLike {
  status?: number
  code?: string
  message?: string
}

const GONE_TEXT = '请联系把链接发给你的人,让他重新分享一个。'

const BY_CODE: Record<string, Omit<StatusView, 'code'>> = {
  link_not_found: { tone: 'neutral', icon: 'link', title: '这个链接不存在或已失效', text: `检查一下地址是否完整。${GONE_TEXT}`, action: null },
  not_found: { tone: 'neutral', icon: 'link', title: '这个链接不存在或已失效', text: `检查一下地址是否完整。${GONE_TEXT}`, action: null },
  link_closed: { tone: 'neutral', icon: 'lock', title: '所有者关闭了这个链接', text: '所有者暂时关掉了它,以后可能会重新打开。可以先联系他问一下。', action: null },
  link_expired: { tone: 'neutral', icon: 'clock', title: '这个链接已过期', text: `链接有有效期,到期后就打不开了。${GONE_TEXT}`, action: null },
  link_revoked: { tone: 'neutral', icon: 'link', title: '这个链接已被撤销', text: `所有者删除了它,地址不会再恢复。${GONE_TEXT}`, action: null },
  link_unavailable: { tone: 'neutral', icon: 'failed', title: '这个链接暂时不可用', text: '分享它的账号暂时不能使用。可以稍后再试,或联系所有者。', action: null },
  login_required: { tone: 'accent', icon: 'users', title: '需要登录后才能查看', text: '所有者设置了只有登录用户才能打开这个链接。登录后会回到这里。', action: 'login' },
  guests_disabled: { tone: 'accent', icon: 'users', title: '现在不允许游客访问', text: '管理员暂时关闭了游客访问。登录后可以继续查看(登录用户不受影响),或联系所有者。', action: 'login' },
  no_access: { tone: 'accent', icon: 'lock', title: '你没有权限查看这个内容', text: '你已登录,但所有者没有给你这份内容的权限。可以联系所有者,请他把你添加为协作者。', action: null },
  rate_limited: { tone: 'warning', icon: 'clock', title: '访问太频繁了', text: '请等一两分钟再刷新。', action: 'retry' },
  network: { tone: 'warning', icon: 'failed', title: '连不上服务器', text: '检查网络后重试,页面不会丢失你的位置。', action: 'retry' },
}

/** 取状态失败时该显示哪种状态页。认不出的错误码按状态码兜底,绝不显示英文异常或状态码。 */
export function statusFromError(error: unknown): StatusView {
  const info = (error ?? {}) as ErrorLike
  const code = info.code ?? 'unknown'
  const known = BY_CODE[code]
  if (known) return { ...known, code }
  if (info.status === 401) return { ...BY_CODE.login_required!, code }
  if (info.status === 403) return { ...BY_CODE.no_access!, code }
  if (info.status === 404 || info.status === 410) return { ...BY_CODE.link_not_found!, code }
  if (info.status === 429) return { ...BY_CODE.rate_limited!, code }
  return { tone: 'warning', icon: 'failed', title: '这个页面没有打开', text: '出了点问题,请稍后重试。如果一直这样,请联系把链接发给你的人。', action: 'retry', code }
}

/** 输密码失败时给的话。locked(429)有两种服务端文案(这个来源输错太多 / 整条链接被锁),原话是写给人看的,原样用。 */
export function unlockErrorText(error: unknown): { text: string; locked: boolean } {
  const info = (error ?? {}) as ErrorLike
  if (info.code === 'wrong_password') return { text: '访问密码不对,请再试一次。注意区分大小写。', locked: false }
  if (info.code === 'locked' || info.status === 429) {
    const said = (info.message ?? '').trim()
    return { text: /[\u3400-\u9fff]/.test(said) ? said : '输错次数太多,已暂时锁定。请 10 分钟后再试。', locked: true }
  }
  if (info.code === 'network' || info.status === 0) return { text: '连不上服务器。检查网络后重试。', locked: false }
  return { text: '没有解锁成功,请稍后再试。', locked: false }
}

export const NICKNAME_MAX = 20

/** 游客昵称:1–20 个字,不含 < >(后端同样拒绝,这里提前挡掉并说清楚)。合法返回 null。 */
export function validateNickname(text: string): string | null {
  const value = text.trim()
  if (!value) return '昵称不能为空。'
  if (Array.from(value).length > NICKNAME_MAX) return `昵称最多 ${NICKNAME_MAX} 个字。`
  if (/[<>]/.test(value)) return '昵称不能包含 < 或 >。'
  return null
}

/** 微信 / QQ 等内置浏览器:不能直接下载文件(设计规范),要提示「在浏览器中打开」。识别逻辑已挪到 utils/inApp.ts(知识库页、共享给我也要用),这里保留原来的导出。 */
export { isInAppBrowser } from '@/utils/inApp'

/** 合集链接里一个根的显示名:有标题用标题,否则文件取最后一段、集合取集合名;笔记没拿到标题前只写「笔记」,不露 id。 */
export function rootLabel(target: ShareTarget, titles: Record<string, string>): string {
  if (target.kind === 'insight') return titles[target.id ?? ''] || '笔记'
  return targetName(target)
}
export const rootKind = (target: ShareTarget): string => targetKindLabel(target)

/** 页面标题:有名字用「名字 · 站点」,没有只用站点名。 */
export function pageTitle(info: Pick<PublicActive, 'title' | 'site'> | null, fallbackName = ''): string {
  const name = (info?.title || fallbackName).trim()
  const site = info?.site?.name?.trim() || '知识库'
  return name ? `${name} · ${site}` : site
}

/** 水印要铺多少个(行 × 列);固定一个够盖满屏的数量,不随窗口量来量去。 */
export const WATERMARK_TILES = 40
