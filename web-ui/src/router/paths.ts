// 页面地址的唯一出处:导航、手机标签栏、「我的」页、命令面板、重定向都引用这里,
// 不再在各处手写字符串。
//
// 地址分两组（设计规范）:
//   我的(所有用户):/home /kb /search /review /import /tasks /friends /assistant /mine /me /guide
//   管理(按功能点显示):/admin/*
// 旧地址(/dashboard /browser /sources /ingest /jobs /audit /eval /projects /system /settings /agent /params /users
// /settings/appearance)全部在 router/legacy.ts 里重定向到这里,书签、邮件里的链接、AI 助手引用都继续有效。
export const PATHS = {
  home: '/home',
  kb: '/kb',
  search: '/search',
  shares: '/shares',
  trash: '/trash',
  review: '/review',
  import: '/import',
  importQueue: '/import/queue',
  tasks: '/tasks',
  friends: '/friends',
  assistant: '/assistant',
  mine: '/mine',
  me: '/me',
  appearance: '/me/appearance',
  guide: '/guide',
  overview: '/admin/overview',
  users: '/admin/users',
  params: '/admin/params',
  usage: '/admin/usage',
  projects: '/admin/projects',
  system: '/admin/system',
  audit: '/admin/audit',
  eval: '/admin/eval',
  settings: '/admin/settings',
} as const

/** 文件时间线 / 批次详情是「导入记录」下的子页。 */
export const importFile = (id: string) => `${PATHS.import}/files/${encodeURIComponent(id)}`
export const importBatch = (batch: string) => `${PATHS.import}/batches/${encodeURIComponent(batch)}`

/** 手机底部标签栏里有入口的页面;其它页面在手机上都是从「我的」页进入的,左上角返回回到「我的」。 */
export const TAB_PAGES: readonly string[] = [PATHS.home, PATHS.kb, PATHS.search, PATHS.mine]
