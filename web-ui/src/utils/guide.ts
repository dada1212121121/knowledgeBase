// 新用户引导与快捷键表的纯逻辑。和界面分开,方便单测。
import { PATHS } from '@/router/paths'

// ---------------------------------------------------------------- 新用户引导(首页上的「先从这几步开始」)

export type GuideId = 'note' | 'import' | 'search' | 'friends' | 'assistant'

export interface GuideStep {
  id: GuideId
  title: string
  text: string
  /** 点「去做」去哪;没有就是执行动作(助手是打开抽屉) */
  to?: string
  done: boolean
}

export interface GuideInput {
  has: (feature: string) => boolean
  /** AI 总开关。关掉后引导里不出现任何 AI 相关的话(术语表:AI 关闭后全站无「AI」字样) */
  aiEnabled: boolean
  /** 我的笔记条数 */
  insights: number
  /** 已登记的数据源数 */
  sources: number | null
}

/**
 * 引导的步骤:只列这个账号用得到的(没开通的功能不出现),已经做过的标记为完成。
 * 「搜索」「好友」「助手」没法从数据里知道做没做过,不标完成,只作为入口。
 */
export function guideSteps(input: GuideInput): GuideStep[] {
  const steps: GuideStep[] = []
  if (input.has('docs.notes')) steps.push({ id: 'note', title: '写下第一条笔记', text: '记下一个想法、一段经验或一份清单,之后随时能搜到。', to: `${PATHS.kb}?new=1`, done: input.insights > 0 })
  if (input.has('docs.upload')) steps.push({ id: 'import', title: '导入已有的文件', text: '把文档、PDF、网页放进来,自动建立索引。', to: PATHS.import, done: (input.sources ?? 0) > 0 })
  if (input.has('search.basic')) steps.push({ id: 'search', title: '试试搜索', text: '用一句话描述你要找的东西,不用记得原文。', to: PATHS.search, done: false })
  if (input.has('collab.friends')) steps.push({ id: 'friends', title: '邀请好友一起写', text: '加好友后可以把笔记和文件夹分享给他们,一起编辑。', to: PATHS.friends, done: false })
  if (input.aiEnabled && input.has('ai.assistant')) steps.push({ id: 'assistant', title: '问问 AI 助手', text: '用自然语言检索、整理知识。', done: false })
  return steps
}

/**
 * 要不要显示引导卡:数据已经取到(没取到前不显示,免得闪一下)、没点过「不再显示」、一条笔记都还没有。
 * 写下第一条笔记就说明已经上手了,卡片自动消失。
 */
export function shouldShowGuide(input: { loaded: boolean; dismissed: boolean; insights: number; steps: number }): boolean {
  return input.loaded && !input.dismissed && input.insights === 0 && input.steps > 0
}

/** 「不再显示」记在本设备,按用户分开(同一台电脑上换账号登录,引导各算各的)。 */
export const guideKey = (userId: string): string => `kb.home.guide.dismissed.${userId}`

// ---------------------------------------------------------------- 快捷键表

export interface GotoTarget {
  key: string
  label: string
  to: string
  /** 需要的功能点:账号没有(或 AI 总开关关了)就不响应这个键,快捷键表里也不写——免得按了跳到一个「没有开通」的页面 */
  feature?: string
}

/** 「G 然后 X」的跳转表:既是按键处理的依据,也是快捷键表里那一行的来源,两处不会不一致。 */
export const GOTO_TARGETS: readonly GotoTarget[] = [
  { key: 'h', label: '首页', to: PATHS.home },
  { key: 'b', label: '知识库', to: PATHS.kb },
  { key: 's', label: '搜索', to: PATHS.search, feature: 'search.basic' },
  { key: 'r', label: '审核', to: PATHS.review, feature: 'ai.extract' },
  { key: 'j', label: '任务', to: PATHS.tasks },
  { key: 'd', label: '系统概览', to: PATHS.overview, feature: 'sys.ops' },
  { key: 'e', label: '评测', to: PATHS.eval, feature: 'search.tune' },
]

export const GOTO: Record<string, string> = Object.fromEntries(GOTO_TARGETS.map((target) => [target.key, target.to]))

/** 判断功能点的函数(session.has);没有传功能点的项恒为真。 */
export type HasFeature = (feature: string | undefined) => boolean

/** 这个账号能用的跳转键(按键处理和快捷键表都用它)。 */
export const gotoTargets = (has: HasFeature): GotoTarget[] => GOTO_TARGETS.filter((target) => has(target.feature))

export interface ShortcutRow {
  label: string
  keys: string[]
  /** 需要的功能点;没有就不显示这一行 */
  feature?: string
}

/**
 * 快捷键表(头像菜单 → 快捷键,或按 ?)。手机上没有键盘,不显示。
 * 按功能点过滤:AI 总开关关闭后不能出现「呼出 AI 助手」,没有审核 / 评测 / 系统功能的账号也不列对应的跳转键。
 */
export function shortcutRows(has: HasFeature): ShortcutRow[] {
  const targets = gotoTargets(has)
  const rows: ShortcutRow[] = [
    { label: '命令面板 / 全局搜索', keys: ['⌘K'] },
    { label: '收起 / 展开侧栏', keys: ['⌘B'] },
    { label: '呼出 AI 助手', keys: ['⌘J'], feature: 'ai.assistant' },
    { label: `跳转:${targets.map((target) => target.label).join(' / ')}`, keys: ['G', `再按 ${targets.map((target) => target.key.toUpperCase()).join(' / ')}`] },
    { label: '搜索页:聚焦搜索框', keys: ['/'], feature: 'search.basic' },
    { label: '搜索页:选择结果 / 打开', keys: ['↑', '↓', '回车'], feature: 'search.basic' },
    { label: '编辑中:保存', keys: ['⌘S'] },
    { label: '查看这张快捷键表', keys: ['?'] },
    { label: '关闭浮层、抽屉、菜单', keys: ['Esc'] },
  ]
  return rows.filter((row) => has(row.feature))
}

/** 全部功能都有时的快捷键表(单测和文档用;界面用 shortcutRows)。 */
export const SHORTCUTS: readonly ShortcutRow[] = shortcutRows(() => true)

/**
 * 这次按键是不是「?」(打开快捷键表)。
 * 不同键盘布局 / 输入方式下 event.key 不一定是 '?':US 布局是 '?',有的布局或脚本模拟出来的是带 Shift 的 '/'。
 * 所以两种都认:key 是 '?',或者物理键是斜杠(code === 'Slash')并按着 Shift。
 */
export function isHelpKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>): boolean {
  return event.key === '?' || (event.code === 'Slash' && event.shiftKey)
}
