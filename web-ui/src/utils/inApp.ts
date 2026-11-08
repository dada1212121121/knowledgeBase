// 微信 / QQ 等内置浏览器的识别与提示文案(设计规范)。
//
// 为什么要认出它们:分享链接最常在微信、QQ 里被点开,而这些内置浏览器(尤其 iOS 的微信)会拦住文件下载,
// 点了没有任何反应。用户并不知道是浏览器的问题,所以要在下载按钮旁边说清楚怎么办。
// 只用于「给提示」,不用来阻止任何功能(登录、阅读、评论、编辑在内置浏览器里都要照常能用)。

/** 内置浏览器的 UA 特征(与原来 publicShare.ts 里的写法一致):微信 / QQ / 钉钉 / 飞书。 */
const IN_APP = /MicroMessenger|QQ\/|MQQBrowser|DingTalk|Lark|Feishu/i

export function isInAppBrowser(userAgent: string): boolean {
  return IN_APP.test(userAgent)
}

/**
 * 是哪一个应用。顺序有讲究:安卓微信的 UA 里同时有 MQQBrowser(X5 内核)和 MicroMessenger,要先认微信;
 * 企业微信的 UA 也带 MicroMessenger,同样归在「微信」。
 */
export function inAppName(userAgent: string): '微信' | 'QQ' | '钉钉' | '飞书' | null {
  if (/MicroMessenger/i.test(userAgent)) return '微信'
  if (/DingTalk/i.test(userAgent)) return '钉钉'
  if (/Lark|Feishu/i.test(userAgent)) return '飞书'
  if (/QQ\/|MQQBrowser/i.test(userAgent)) return 'QQ'
  return null
}

/** 是不是微信(含企业微信)。 */
export const isWeChat = (userAgent: string): boolean => inAppName(userAgent) === '微信'

/**
 * 下载被拦时的说明;不在内置浏览器里返回 null(调用方据此决定要不要显示)。
 * 「⋯」菜单里的字样各家略有不同(「在浏览器打开」「用 Safari 打开」),这里用最通用的说法,不逐家承诺。
 */
export function inAppDownloadNote(userAgent: string): string | null {
  const name = inAppName(userAgent)
  if (!name) return null
  return `在${name}里不能直接下载文件。点右上角「⋯」→「在浏览器中打开」,即可下载。`
}
