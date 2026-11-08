// 系统设置页的分区清单与导航规则(纯函数,便于单测)。
//
// 分区按「这件事是谁管的」归类,而不是按原来堆在一起的顺序:
//   - 模型、编码代理调用大模型或外部代理,属于 AI 功能:AI 总开关关掉后整个分区从导航里消失,
//     页面任何位置也不再出现「AI」字样(术语表「AI 相关文案」,管理员视角也一样);
//   - 备份要 `sys.ops`、编码代理要 `ai.acp`,账号没有这个功能时分区不出现
//     (后端对每个能力照样检查,隐藏只是体验);
//   - 旧地址 `?tab=…` 继续有效:合并掉的分区(检索调权 / 关于)落到合并后的位置,
//     搬走的分区(外观 / 访问令牌)去它们现在的页面。

export type SectionId =
  | 'general'
  | 'storage'
  | 'search'
  | 'model'
  | 'components'
  | 'ocr'
  | 'skills'
  | 'mcp'
  | 'acp'
  | 'backup'

export interface SectionDef {
  id: SectionId
  /** 导航与面包屑里的名字(术语表的说法)。 */
  label: string
  /** 调用大模型或外部代理:AI 总开关关闭后整个分区不出现。 */
  ai?: boolean
  /** 账号还要具备的功能点(没有就不显示这个分区)。 */
  feature?: string
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'general', label: '常规' },
  { id: 'storage', label: '存储与索引' },
  { id: 'search', label: '搜索与排序' },
  { id: 'model', label: '模型', ai: true },
  { id: 'components', label: '组件' },
  { id: 'ocr', label: 'OCR 与转写' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP 接入' },
  { id: 'acp', label: '编码代理', ai: true, feature: 'ai.acp' },
  { id: 'backup', label: '备份', feature: 'sys.ops' },
]

/** 旧页签名 → 现在的分区。合并掉的分区不会再有自己的页签。 */
export const TAB_ALIASES: Readonly<Record<string, SectionId>> = {
  tuning: 'search', // 检索调权并进「搜索与排序」
  about: 'general', // 关于并进「常规」
  llm: 'model', // 更早的「LLM」页签
  provider: 'components',
}

/** 搬到别的页面的旧页签。 */
export type TabRedirect = 'appearance' | 'tokens'
const REDIRECTS: readonly string[] = ['appearance', 'tokens']

export interface NavContext {
  /** 站点的 AI 总开关是否开着。会话还没加载完时按「没开」算,免得闪一下「AI」字样。 */
  aiOn: boolean
  /** 账号有没有某个功能点。 */
  has: (feature: string) => boolean
}

/** 当前账号、当前站点设置下看得到的分区(顺序与 `SECTIONS` 一致)。 */
export function visibleSections(context: NavContext): SectionDef[] {
  return SECTIONS.filter((section) => {
    if (section.ai && !context.aiOn) return false
    if (section.feature && !context.has(section.feature)) return false
    return true
  })
}

export interface ResolvedTab {
  id: SectionId
  /** 这个页签已经搬到别的页面:调用方应跳过去。 */
  redirect?: TabRedirect
  /** 地址里的页签名认不出或当前看不到:调用方应把地址改成 `id`,别留一个会骗人的地址。 */
  corrected: boolean
}

/** 把地址里的 `?tab=` 解析成要显示的分区。 */
export function resolveTab(raw: unknown, visible: readonly SectionDef[]): ResolvedTab {
  const first = visible[0]?.id ?? 'general'
  const slug = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? String(raw[0] ?? '').trim() : ''
  if (!slug) return { id: first, corrected: false }
  if (REDIRECTS.includes(slug)) return { id: first, redirect: slug as TabRedirect, corrected: false }
  const id = (TAB_ALIASES[slug] ?? slug) as SectionId
  if (visible.some((section) => section.id === id)) return { id, corrected: id !== slug }
  return { id: first, corrected: true }
}

/** 分区名(面包屑、无障碍名称用)。 */
export function sectionLabel(id: SectionId): string {
  return SECTIONS.find((section) => section.id === id)?.label ?? ''
}
