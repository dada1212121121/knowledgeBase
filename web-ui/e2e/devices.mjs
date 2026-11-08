// 设备矩阵与浏览器引擎(多用户设计说明):所有 e2e 脚本从这里取尺寸和引擎。
//
// 用法(环境变量,viewer-shots / sweep / clipcheck 都认):
//   KB_ENGINE=chromium|webkit|firefox|all     默认 chromium;all = 三个依次跑
//   KB_SIZES=390x844,1440x900                  按 "宽x高" 选;不设 = core 组
//   KB_DEVICE_GROUP=core|phone|tablet|desktop|all   不设 KB_SIZES 时按组选,默认 core
//
// 触屏设备(phone / tablet)用 hasTouch;手机再用 isMobile(Firefox 不支持 isMobile,自动略过)。
import { chromium, firefox, webkit } from '@playwright/test'

/** 设备清单。group: phone(<600)/ fold(600–839)/ tablet(840–1279 或平板)/ desktop(≥1280)。 */
export const DEVICES = [
  { name: '360x780', width: 360, height: 780, dpr: 3, touch: true, mobile: true, group: 'phone', label: '安卓小屏' },
  { name: '375x667', width: 375, height: 667, dpr: 2, touch: true, mobile: true, group: 'phone', label: 'iPhone SE' },
  { name: '390x844', width: 390, height: 844, dpr: 2, touch: true, mobile: true, group: 'phone', label: 'iPhone 15', core: true },
  { name: '430x932', width: 430, height: 932, dpr: 2, touch: true, mobile: true, group: 'phone', label: 'iPhone Pro Max' },
  { name: '844x390', width: 844, height: 390, dpr: 2, touch: true, mobile: true, group: 'phone', label: '手机横屏' },
  { name: '673x841', width: 673, height: 841, dpr: 2, touch: true, mobile: true, group: 'fold', label: '折叠屏展开' },
  { name: '744x1133', width: 744, height: 1133, dpr: 2, touch: true, mobile: false, group: 'tablet', label: 'iPad mini 竖' },
  { name: '800x1280', width: 800, height: 1280, dpr: 2, touch: true, mobile: false, group: 'tablet', label: '安卓平板竖' },
  { name: '820x1180', width: 820, height: 1180, dpr: 1, touch: true, mobile: false, group: 'tablet', label: 'iPad Air 竖', core: true },
  { name: '1180x820', width: 1180, height: 820, dpr: 1, touch: true, mobile: false, group: 'tablet', label: 'iPad Air 横', core: true },
  { name: '1024x1366', width: 1024, height: 1366, dpr: 1, touch: true, mobile: false, group: 'tablet', label: 'iPad Pro 竖' },
  { name: '1280x800', width: 1280, height: 800, dpr: 1, touch: false, mobile: false, group: 'desktop', label: '笔记本' },
  { name: '1440x900', width: 1440, height: 900, dpr: 1, touch: false, mobile: false, group: 'desktop', label: '桌面', core: true },
  { name: '1920x1080', width: 1920, height: 1080, dpr: 1, touch: false, mobile: false, group: 'desktop', label: '1080p', core: true },
  { name: '2560x1440', width: 2560, height: 1440, dpr: 1, touch: false, mobile: false, group: 'desktop', label: '2K' },
]

export const ENGINES = { chromium, webkit, firefox }

const parseSize = (text) => {
  const [width, height] = text.split('x').map(Number)
  return { name: text, width, height, dpr: 1, touch: width < 1024, mobile: width < 600, group: 'custom', label: '自定义' }
}

/** 选设备:显式尺寸(可以是清单外的 "宽x高")> 设备组 > core。 */
export function pickDevices({ sizes = process.env.KB_SIZES, group = process.env.KB_DEVICE_GROUP } = {}) {
  const wanted = (sizes ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  if (wanted.length) return wanted.map((name) => DEVICES.find((device) => device.name === name) ?? parseSize(name))
  if (group === 'all') return DEVICES
  if (group && group !== 'core') {
    const list = DEVICES.filter((device) => device.group === group || (group === 'phone' && device.group === 'fold'))
    if (!list.length) throw new Error(`未知设备组 ${group}(可用 core/phone/tablet/desktop/all)`)
    return list
  }
  return DEVICES.filter((device) => device.core)
}

/** 引擎列表:KB_ENGINE=all 或逗号分隔。 */
export function pickEngines(value = process.env.KB_ENGINE ?? 'chromium') {
  const names = value === 'all' ? Object.keys(ENGINES) : value.split(',').map((item) => item.trim()).filter(Boolean)
  for (const name of names) if (!ENGINES[name]) throw new Error(`未知引擎 ${name}(可用 chromium/webkit/firefox/all)`)
  return names
}

export async function launch(engine = 'chromium') {
  const options = engine === 'chromium' ? { chromiumSandbox: false, timeout: 60_000 } : { timeout: 60_000 }
  return ENGINES[engine].launch(options)
}

/** 给 browser.newContext 用的选项。 */
export function contextOptions(device, engine = 'chromium', extra = {}) {
  const options = {
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    hasTouch: device.touch,
    // sweep / clipcheck 等巡检脚本也不要被 service worker 缓存干扰
    serviceWorkers: 'block',
    // 巡检 / 门禁默认「减少动效」：面板的进场动画（几十到两百多毫秒）会让「点击时元素还在动」的时序变得不稳，
    // 项目动效令牌在这个偏好下时长归零。要验动效本身用 motion-check.mjs（它自己建上下文、不关动画），或设 KB_E2E_MOTION=1
    ...(process.env.KB_E2E_MOTION === '1' ? {} : { reducedMotion: 'reduce' }),
    ...extra,
  }
  if (device.mobile && engine !== 'firefox') options.isMobile = true // Firefox 不支持 isMobile
  return options
}

/** 文件名后缀:chromium 保持原样,其它引擎带上引擎名,避免截图互相覆盖。 */
export const engineSuffix = (engine) => (engine === 'chromium' ? '' : `-${engine}`)
