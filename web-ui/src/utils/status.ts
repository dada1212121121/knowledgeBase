// 错误与状态页的纯逻辑:服务不可用的原因怎么分类、文案怎么写、登录后 / 恢复后回到哪里。
// 和界面分开,方便单测。

/** 为什么页面打不开:决定标题和说明,也决定要不要自动重试。 */
export type UnavailableKind = 'offline' | 'maintenance' | 'server' | 'network'

export const UNAVAILABLE_KINDS: readonly UnavailableKind[] = ['offline', 'maintenance', 'server', 'network']

/**
 * 把一次失败的请求归类。
 * - 设备自己没网(navigator.onLine === false)优先:这时候怪服务器没有意义;
 * - 503 是守护进程明确说「暂时不可用」(升级 / 重启 / 迁移中),按「维护中」说;
 * - 其它 4xx / 5xx 是服务出了问题;
 * - 没有状态码(fetch 直接失败)是连不上服务器。
 */
export function classifyUnavailable(status: number | null | undefined, online: boolean): UnavailableKind {
  if (!online) return 'offline'
  if (status === 503) return 'maintenance'
  if (typeof status === 'number' && status >= 400) return 'server'
  return 'network'
}

export interface UnavailableCopy {
  icon: 'wrench' | 'failed' | 'globe' | 'server'
  title: string
  text: string
  /** 自动重试:维护 / 连不上通常过一会儿就好;设备没网要等网络回来(online 事件)。 */
  autoRetry: boolean
}

/** 每种原因的页面文案(术语表:报错写「出了什么事 + 怎么办」)。 */
export const UNAVAILABLE_COPY: Record<UnavailableKind, UnavailableCopy> = {
  offline: { icon: 'globe', title: '你的设备现在没有网络', text: '连上网络后会自动重试;也可以点「重试」。已经打开的内容不会丢。', autoRetry: false },
  maintenance: { icon: 'wrench', title: '服务正在维护', text: '管理员正在升级或重启服务,通常几分钟就好。这个页面会自动重试,恢复后回到你刚才的页面。', autoRetry: true },
  server: { icon: 'failed', title: '服务出了点问题', text: '服务返回了错误。稍后再试;如果一直这样,请联系管理员查看系统状态。', autoRetry: true },
  network: { icon: 'server', title: '连不上服务器', text: '可能是网络不稳,或服务还没启动。这个页面会自动重试,也可以检查网络后点「重试」。', autoRetry: true },
}

/** 自动重试的间隔:先快后慢,避免服务刚起来时被一堆页面同时打。 */
export function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, attempt))
}

/**
 * 登录后 / 恢复后回到哪里:只允许站内路径。
 * 拒绝 `//host`(协议相对地址)、`/\host`(部分浏览器把反斜杠当斜杠)、带协议的地址和含控制字符的值,防开放重定向。
 */
export function safeNext(next: string | null | undefined, fallback = '/home'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback
  return next
}
