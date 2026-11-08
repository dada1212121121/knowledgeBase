import { describe, expect, it } from 'vitest'
import { inAppDownloadNote, inAppName, isInAppBrowser, isWeChat } from './inApp'

// 真实 UA 的样子(节选)
const UA = {
  wechatIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002831) NetType/WIFI Language/zh_CN',
  wechatAndroid:
    'Mozilla/5.0 (Linux; Android 13; PGJM10 Build/TP1A.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160059 MMWEBSDK/20231201 MMWEBID/5555 MicroMessenger/8.0.44.2502(0x28002C3B) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  // 安卓微信用 X5 内核时 UA 里同时有 MQQBrowser 和 MicroMessenger:必须认成微信
  wechatX5: 'Mozilla/5.0 (Linux; Android 10; MI 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.62 XWEB/2692 MMWEBSDK/200901 Mobile Safari/537.36 MMWEBID/1 MicroMessenger/7.0.20.1781(0x27001439) Process/tools MQQBrowser/6.2 TBS/045913',
  wecom: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 wxwork/4.1.10 MicroMessenger/7.0.1 Language/zh ColorScheme/Light',
  qqIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/8.9.28.635 V1_IPH_SQ_8.9.28_1_APP_A Pixel/1170',
  qqAndroid: 'Mozilla/5.0 (Linux; Android 12; V2118A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046011 Mobile Safari/537.36 V1_AND_SQ_8.9.28_4210_YYB_D QQ/8.9.28.12345 NetType/WIFI',
  dingtalk: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AliApp(DingTalk/7.0.20) com.laiwang.DingTalk/7.0.20',
  feishu: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Lark/7.3.10 LarkLocale/zh_CN',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // 独立的 QQ 浏览器桌面版:UA 是 QQBrowser/ 而不是 QQ/,不是内置浏览器
  qqBrowserDesktop: 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36 QQBrowser/10.8.4410.400',
}

describe('isInAppBrowser', () => {
  it('微信 / QQ / 钉钉 / 飞书 是内置浏览器', () => {
    for (const key of ['wechatIos', 'wechatAndroid', 'wechatX5', 'wecom', 'qqIos', 'qqAndroid', 'dingtalk', 'feishu'] as const) expect(isInAppBrowser(UA[key]), key).toBe(true)
  })
  it('Safari / Chrome / 桌面浏览器 / 独立的 QQ 浏览器 / 空 UA 都不是', () => {
    for (const key of ['safari', 'chromeAndroid', 'desktop', 'qqBrowserDesktop'] as const) expect(isInAppBrowser(UA[key]), key).toBe(false)
    expect(isInAppBrowser('')).toBe(false)
  })
})

describe('inAppName', () => {
  it('分清是哪一个;安卓微信的 X5 内核同时带 MQQBrowser,仍是微信', () => {
    expect(inAppName(UA.wechatIos)).toBe('微信')
    expect(inAppName(UA.wechatAndroid)).toBe('微信')
    expect(inAppName(UA.wechatX5)).toBe('微信')
    expect(inAppName(UA.wecom)).toBe('微信')
    expect(inAppName(UA.qqIos)).toBe('QQ')
    expect(inAppName(UA.qqAndroid)).toBe('QQ')
    expect(inAppName(UA.dingtalk)).toBe('钉钉')
    expect(inAppName(UA.feishu)).toBe('飞书')
  })
  it('普通浏览器没有名字', () => {
    expect(inAppName(UA.safari)).toBeNull()
    expect(inAppName('')).toBeNull()
  })
  it('isWeChat 只认微信', () => {
    expect(isWeChat(UA.wechatX5)).toBe(true)
    expect(isWeChat(UA.qqAndroid)).toBe(false)
    expect(isWeChat(UA.safari)).toBe(false)
  })
})

describe('inAppDownloadNote', () => {
  it('内置浏览器里说清楚怎么办:点右上角「⋯」→「在浏览器中打开」', () => {
    expect(inAppDownloadNote(UA.wechatIos)).toBe('在微信里不能直接下载文件。点右上角「⋯」→「在浏览器中打开」,即可下载。')
    expect(inAppDownloadNote(UA.qqIos)).toContain('在QQ里不能直接下载')
    expect(inAppDownloadNote(UA.qqIos)).toContain('在浏览器中打开')
  })
  it('普通浏览器不提示', () => {
    expect(inAppDownloadNote(UA.safari)).toBeNull()
    expect(inAppDownloadNote(UA.desktop)).toBeNull()
  })
  it('文案里没有英文术语,也没有 AI 字样', () => {
    expect(inAppDownloadNote(UA.dingtalk)).not.toMatch(/AI|token|rerank/i)
  })
})
