/**
 * 内置工具栏的静态声明（由 `builtin/*.ext.ts` 经扩展注册表提供给界面）
 *
 * 这个文件只放「数据」：每个内容面有哪些分组、哪些动作。谁把它们交给界面是 `builtin/` 下各个 `*.ext.ts` 的事——
 * 它们读这里的常量，逐项调用 `registerToolbarItem` / `registerSlashItem`，和第三方扩展走同一套 API；
 * Host 不再直接读这里。所以别的分支往 `PAGE_EDIT_TOOLBAR`、`TEXT_TOOLBAR`、`CONTRIBUTIONS` 里加新的分组或动作，
 * 注册代码不用改，自动生效。
 *
 * 为什么工具栏与斜杠菜单是「数据」而不是散在模板里的按钮：
 * 1. 同一个动作要在三处出现（工具栏 / 斜杠菜单 / 命令面板），只有一份声明才能保证文案、图标、
 * 命令类型、权限要求完全一致；以后 的第三方扩展也只需要产出同形状的对象。
 * 2. Chrome 只负责渲染与派发，不认识 `mark.toggle` 这类语义；Surface 只负责执行，不认识按钮。
 *    换一种内容面（表格/演示）时新增一份贡献即可，不必改 Chrome。
 * 3. `write` 标记让「只读时隐藏写操作」由数据驱动，避免每个按钮各自判断一次权限导致漏判。
 */
import type { SurfaceKind } from '../../types'
import type { ToolbarCheckSpec, ToolbarChoiceSpec } from '../api'
import { FONT_FAMILIES as NOTE_FONT_FAMILIES } from '@/utils/colorPalette'
import { CALLOUT_TYPES } from '@/utils/callouts'
import { pinyinForms } from '@/utils/pinyin'

/**
 * 按钮高亮判定：Chrome 拿到 Surface 上报的格式状态后逐项比对。
 * 形状由扩展 API 定义（内置工具栏和第三方扩展走同一份声明，这里只是别名，不再各写一份）
 */
export type ActionCheck = ToolbarCheckSpec

/** 一个可执行动作的完整声明 */
export interface EditorAction {
  id: string
  /** 按钮可见文案（图标按钮也必须有，供 aria-label / title 使用） */
  label: string
  /** 交给 CommandBus 的命令类型 */
  command: string
  args?: unknown
  /** 图标字符（只放单字符或无歧义的短符号，不引入图标字体） */
  icon?: string
  /** 是否需要写权限；只读时整颗按钮不渲染 */
  write?: boolean
  /** 快捷键提示（只用于 title / aria-keyshortcuts，真正的按键在 useEditorHotkeys / keymap） */
  shortcut?: string
  /** 高亮判定 */
  check?: ActionCheck
  /** 斜杠菜单里的额外搜索关键词 */
  keywords?: string[]
  /** UI 类动作（要弹输入框/面板）：只出现在工具栏，不放进斜杠菜单 */
  ui?: boolean
  /**
   * 带选项的动作（字号、字体、颜色、表格大小…）：点击展开菜单，选中某项时用该项的 `args` 执行 `command`。
   * 为什么放进数据而不是写死在 Chrome：Chrome 不认识"字号"这类语义，只负责渲染菜单与派发；
   * 选项的文案与参数跟动作声明在一起，才能保证工具栏、命令面板、快捷键三处一致。
   */
  choices?: readonly ActionChoice[]
  /**
   * 下拉菜单：有 children 的动作本身不执行命令，点开列出子动作（工具栏放不下十几个插入项，
   * 收进「插入」下拉，和旧编辑器的「插入」菜单一致）。斜杠菜单与「更多」溢出菜单里直接展开成平铺的子动作。
   */
  children?: readonly EditorAction[]
  /**
   * 斜杠菜单里的显示策略：`always` 即使是 ui 类也放进去（打开选择器 / 文件选择的动作，回车后有可见反馈）；
   * `never` 不放。缺省按「非 ui 且需要写权限」。
   */
  slash?: 'always' | 'never'
  /** 比 `label` 更完整的说明，用作 `aria-label` / 悬停提示（顶栏操作区的按钮，如「导出 Markdown」） */
  description?: string
  /** `hide`：手机上外壳压成一行时不显示（页头已有同样的入口） */
  compact?: 'hide'
  /** 双击按钮时用这组参数执行同一个命令（格式刷：单击刷一次，双击连续刷）；不写就没有双击行为 */
  doubleClickArgs?: unknown
}

/** 选项（色块、当前值打勾）的形状同样来自扩展 API */
export type ActionChoice = ToolbarChoiceSpec

export interface ToolbarGroup {
  // 合并两侧：'rows' 来自 （CSV 行操作），'table' 来自 （Word 表格编辑），两者都保留
  id: 'marks' | 'blocks' | 'lists' | 'insert' | 'table' | 'view' | 'rows'
  label: string
  actions: EditorAction[]
}

/** 打开 Host 侧面板（选择器 / 文件选择）：工具栏、斜杠菜单、插入下拉共用同一条命令 */
const PANEL = (panel: 'wikilink' | 'filelink' | 'image' | 'attachment') => ({ command: 'text.panel.open', args: { panel } })

/** 提示块各类型的图标点（与旧编辑器的色点对应）；标签复用 CALLOUT_TYPES，保证两边文案一致 */
const CALLOUT_ACTIONS: readonly EditorAction[] = (Object.keys(CALLOUT_TYPES) as (keyof typeof CALLOUT_TYPES)[]).map((type) => ({
  id: `callout.${type}`,
  label: `提示块 · ${CALLOUT_TYPES[type]}`,
  icon: '▌',
  command: 'block.insertCallout',
  args: { type },
  write: true,
  keywords: ['callout', 'note', '提示块', CALLOUT_TYPES[type]],
}))

/**
 * AI 写作（UI-3）：打开工具栏下面的 AI 写作条。命令由文本面交给 Host；页面没接 AI 写作（AI 总开关关了、
 * 账号没有 AI 助手、分享页）时，工具栏 / 斜杠菜单都不显示这些项（EditorChrome 与 TextSurface 按 `text.ai.open` 过滤）。
 * 不单独占工具栏按钮：1366 宽起工具栏只剩约 30px，再加一颗就会把「大纲」挤进「更多」
 */
export const AI_WRITE_COMMAND = 'text.ai.open'
const AI_WRITE_ACTION: EditorAction = {
  id: 'ai.write',
  label: 'AI 写作…',
  icon: '✦',
  command: AI_WRITE_COMMAND,
  write: true,
  slash: 'always',
  description: 'AI 写作：润色、总结、翻译选中的文字，或按要求写一段',
  keywords: ['ai', 'write', '写作', '帮我写', '改写', '生成', '润色', '总结', '翻译'],
}
const AI_CONTINUE_ACTION: EditorAction = {
  id: 'ai.continue',
  label: 'AI 续写',
  icon: '✦',
  command: AI_WRITE_COMMAND,
  args: { action: 'continue' },
  write: true,
  slash: 'always',
  keywords: ['ai', 'continue', '续写', '接着写'],
}

/** 「插入」下拉里的更多项：旧编辑器 insert 菜单的全部内容（代码块、分割线在工具栏上已有按钮） */
const INSERT_MORE: readonly EditorAction[] = [
  AI_WRITE_ACTION,
  { id: 'codeblock', label: '代码块', icon: '{ }', command: 'block.insertCodeBlock', write: true, shortcut: 'Ctrl+Alt+C', keywords: ['code', 'pre', '代码块'] },
  { id: 'diagram', label: '流程图 / 时序图', icon: '⛓', command: 'block.insertDiagram', write: true, keywords: ['mermaid', 'diagram', '流程图', '时序图'] },
  { id: 'math', label: '公式', icon: '∑', command: 'block.insertMath', write: true, keywords: ['math', 'latex', '公式'] },
  { id: 'mathInline', label: '行内公式', icon: '∑', command: 'text.math.inline', write: true, keywords: ['math', 'latex', '公式', '行内'] },
  { id: 'wikilink', label: '引用笔记', icon: '[[', ...PANEL('wikilink'), write: true, keywords: ['wikilink', '引用笔记', '双链'], slash: 'always' },
  { id: 'filelink', label: '引用文件 / 模板', icon: '📄', ...PANEL('filelink'), write: true, keywords: ['file', 'template', '引用文件', '模板'], slash: 'always' },
  { id: 'attachment', label: '附件', icon: '📎', ...PANEL('attachment'), write: true, keywords: ['attachment', 'file', '附件', '文件'], slash: 'always' },
  ...CALLOUT_ACTIONS,
  { id: 'hr', label: '分割线', icon: '—', command: 'block.insertHr', write: true, keywords: ['hr', 'divider', '分割线'] },
]

/** 大纲（文本面与分页文档面共用）：面板由 Chrome 渲染，条目来自内容面的 outline 查询 */
const OUTLINE_ACTION: EditorAction = { id: 'outline', label: '大纲', icon: '☰', command: 'view.toggleOutline', keywords: ['outline', '目录', '大纲'], ui: true }

/** 文本面工具栏：顺序即界面顺序，移动端横向滚动 */
export const TEXT_TOOLBAR: readonly ToolbarGroup[] = [
  {
    id: 'blocks',
    label: '段落',
    actions: [
      // 标题级别收成一个下拉（旧编辑器的“正文 / 标题 1–4”下拉）：编辑器栏通常只有 600 多像素宽，
      // 平铺 5 个按钮会把“插入”“查找”“源码”这些更常用的入口挤进“更多”里。
      // 「引用」也在这个下拉里（飞书的段落样式菜单同样如此）：腾出的位置给了格式刷和清除格式，1280 宽的屏幕上全部按钮仍放得下。
      // 下拉按钮上显示的是光标所在段落现在的样式（H2、引用…），见 EditorChrome 的 dropdownIcon
      {
        id: 'heading',
        label: '段落格式',
        icon: 'H',
        command: 'menu.heading',
        write: true,
        check: { kind: 'block', block: 'heading' },
        keywords: ['heading', '标题'],
        children: [
          { id: 'paragraph', label: '正文', icon: '¶', command: 'block.setHeading', args: { level: 0 }, write: true, shortcut: 'Ctrl+Alt+0', check: { kind: 'block', block: 'paragraph' }, keywords: ['正文', 'p'] },
          { id: 'heading.1', label: '一级标题', icon: 'H1', command: 'block.setHeading', args: { level: 1 }, write: true, shortcut: 'Ctrl+Alt+1', check: { kind: 'block', block: 'heading', level: 1 }, keywords: ['h1', '标题'] },
          { id: 'heading.2', label: '二级标题', icon: 'H2', command: 'block.setHeading', args: { level: 2 }, write: true, shortcut: 'Ctrl+Alt+2', check: { kind: 'block', block: 'heading', level: 2 }, keywords: ['h2', '标题'] },
          { id: 'heading.3', label: '三级标题', icon: 'H3', command: 'block.setHeading', args: { level: 3 }, write: true, shortcut: 'Ctrl+Alt+3', check: { kind: 'block', block: 'heading', level: 3 }, keywords: ['h3', '标题'] },
          { id: 'heading.4', label: '四级标题', icon: 'H4', command: 'block.setHeading', args: { level: 4 }, write: true, shortcut: 'Ctrl+Alt+4', check: { kind: 'block', block: 'heading', level: 4 }, keywords: ['h4', '标题'] },
          // Markdown 有 6 级标题，下拉里要能选全（以前只到 H4，H5 / H6 只能在斜杠菜单里找）
          { id: 'heading.5', label: '五级标题', icon: 'H5', command: 'block.setHeading', args: { level: 5 }, write: true, shortcut: 'Ctrl+Alt+5', check: { kind: 'block', block: 'heading', level: 5 }, keywords: ['h5', '标题'] },
          { id: 'heading.6', label: '六级标题', icon: 'H6', command: 'block.setHeading', args: { level: 6 }, write: true, shortcut: 'Ctrl+Alt+6', check: { kind: 'block', block: 'heading', level: 6 }, keywords: ['h6', '标题'] },
          { id: 'quote', label: '引用', icon: '❝', command: 'block.toggleBlockquote', write: true, shortcut: 'Ctrl+Shift+B', check: { kind: 'block', block: 'blockquote' }, keywords: ['quote', '引用'] },
        ],
      },
    ],
  },
  {
    id: 'marks',
    label: '格式',
    actions: [
      { id: 'bold', label: '加粗', icon: 'B', command: 'mark.toggle', args: { mark: 'strong' }, write: true, shortcut: 'Ctrl+B', check: { kind: 'mark', name: 'strong' }, keywords: ['bold', 'strong', '加粗'] },
      { id: 'italic', label: '斜体', icon: 'I', command: 'mark.toggle', args: { mark: 'emphasis' }, write: true, shortcut: 'Ctrl+I', check: { kind: 'mark', name: 'emphasis' }, keywords: ['italic', 'em', '斜体'] },
      { id: 'strike', label: '删除线', icon: 'S', command: 'mark.toggle', args: { mark: 'strike_through' }, write: true, shortcut: 'Ctrl+Shift+X', check: { kind: 'mark', name: 'strike_through' }, keywords: ['strike', '删除线'] },
      { id: 'code', label: '行内代码', icon: '<>', command: 'mark.toggle', args: { mark: 'inlineCode' }, write: true, shortcut: 'Ctrl+`', check: { kind: 'mark', name: 'inlineCode' }, keywords: ['code', '代码'] },
      // 字体：下拉里每一项用自己的字体显示；选中后写成 `<span style="font-family: …">`（和字色同一个标记，阅读时同样显示）
      {
        id: 'font',
        label: '字体',
        icon: 'Aa',
        command: 'mark.color',
        write: true,
        keywords: ['font', '字体', '宋体', '黑体', '楷体'],
        slash: 'never', // 要在下拉里挑，空块里打 / 之后没有地方挑
        choices: [
          { label: '默认字体', args: { prop: 'font-family', key: null }, current: { name: 'noteFont', value: '' } },
          ...NOTE_FONT_FAMILIES.map((font) => ({ label: font.label, args: { prop: 'font-family', key: font.key }, current: { name: 'noteFont', value: font.key }, font: font.hex })),
        ],
      },
      // 字色 / 底色：色板由 Chrome 渲染（和链接条同一类 UI 动作），选色后发 mark.color
      { id: 'color', label: '文字颜色 / 背景色', icon: 'A', command: 'text.color.open', write: true, keywords: ['color', '颜色', '字色', '底色', '背景'], ui: true },
      // 格式刷：先选中有样式的文字，点一下格式刷，再拖选别的文字就刷上同样的样式；双击可以连续刷，Esc 退出（和 Word 一样）
      {
        id: 'painter',
        label: '格式刷',
        description: '格式刷：单击刷一次，双击可以连续刷，按 Esc 退出',
        icon: '🖌',
        command: 'text.formatPainter',
        doubleClickArgs: { sticky: true },
        write: true,
        check: { kind: 'toggle', name: 'painter' },
        keywords: ['painter', 'format', '格式刷'],
        slash: 'never',
      },
      // 清除格式：去掉加粗、斜体、删除线、行内代码、字体和颜色，链接与标题 / 列表不动
      { id: 'clearFormat', label: '清除格式', icon: 'Tx', command: 'text.clearFormat', write: true, shortcut: 'Ctrl+\\', keywords: ['clear', 'format', '清除格式'], slash: 'never' },
    ],
  },
  {
    id: 'lists',
    label: '列表',
    actions: [
      { id: 'bullet', label: '无序列表', icon: '•', command: 'block.toggleBulletList', write: true, shortcut: 'Ctrl+Shift+8', check: { kind: 'list', list: 'bullet_list' }, keywords: ['bullet', '无序列表'] },
      { id: 'ordered', label: '有序列表', icon: '1.', command: 'block.toggleOrderedList', write: true, shortcut: 'Ctrl+Shift+7', check: { kind: 'list', list: 'ordered_list' }, keywords: ['ordered', '有序列表'] },
      { id: 'task', label: '任务列表', icon: '☑', command: 'block.toggleTaskList', write: true, shortcut: 'Ctrl+Shift+9', check: { kind: 'list', list: 'task_list' }, keywords: ['task', 'todo', '任务', '待办'] },
    ],
  },
  {
    id: 'insert',
    label: '插入',
    actions: [
      { id: 'link', label: '链接', icon: '🔗', command: 'text.link.open', write: true, shortcut: 'Ctrl+K', check: { kind: 'mark', name: 'link' }, keywords: ['link', '链接'], ui: true },
      { id: 'image', label: '图片', icon: '🖼', command: 'text.image.open', write: true, keywords: ['image', '图片'], ui: true },
      { id: 'table', label: '表格', icon: '▦', command: 'block.insertTable', args: { rows: 3, cols: 3 }, write: true, keywords: ['table', '表格'] },
      // 旧编辑器的“插入”下拉：代码块、流程图、公式、引用笔记 / 文件、附件、提示块、分隔线
      { id: 'insertMore', label: '插入', icon: '＋', command: 'menu.insert', write: true, children: INSERT_MORE, keywords: ['insert', '插入'] },
    ],
  },
  // 视图动作（查找替换 / 源码 / 大纲）由内置扩展 `builtin/view.ts` 注册，排在这些分组之后（设计规范）
]

/** 斜杠菜单独有的项：工具栏没有按钮的图片 */
const TEXT_SLASH_EXTRA: readonly EditorAction[] = [
  { id: 'image.upload', label: '图片', icon: '🖼', ...PANEL('image'), write: true, keywords: ['image', '图片', '上传'], slash: 'always' },
  AI_CONTINUE_ACTION,
]

/** 展开下拉：子动作平铺，下拉本身不出现 */
export function flattenActions(actions: readonly EditorAction[]): EditorAction[] {
  return actions.flatMap((action) => (action.children ? flattenActions(action.children) : [action]))
}

/**
 * 斜杠菜单项：与工具栏共享同一批动作。
 * 规则：非 ui 且需要写权限的动作都进（内容面自己能执行）；ui 类（链接输入条、查找、大纲、色板）由工具栏承载，
 * 否则回车后光标还停在菜单里、没有任何可见反馈，比没有这个菜单项更糟；
 * 例外是 `slash: 'always'` 的——它们打开选择器 / 文件选择，回车后有可见反馈（旧编辑器的「更多」组就是这些）。
 * 行内格式（加粗 / 斜体等）对「空块里打 /」没有意义，不放进斜杠菜单。
 */
export const TEXT_SLASH_ACTIONS: readonly EditorAction[] = [
  ...flattenActions(TEXT_TOOLBAR.flatMap((group) => group.actions)),
  ...TEXT_SLASH_EXTRA,
].filter((action) => {
  if (action.slash === 'never') return false
  if (action.check?.kind === 'mark') return false
  if (action.slash === 'always') return true
  return !action.ui && action.write === true
})

/**
 * 斜杠菜单「空查询时」的分组和顺序（输入了查询词就不分组，按命中程度排成一列）。
 * 常用的（列表、表格、图片、代码块）排在第一屏，不让六级标题占满开头；四到六级标题仍在菜单里
 * （Markdown 有六级，要能选全），放到最后一组。没列在这里的动作（第三方扩展注册的）归到末尾的「扩展」组。
 */
export const SLASH_SECTIONS: readonly { id: string; label: string; ids: readonly string[] }[] = [
  { id: 'basic', label: '基础', ids: ['paragraph', 'heading.1', 'heading.2', 'heading.3', 'quote'] },
  // AI 组放在「基础」后面而不是最前：空查询时回车选中的仍是「正文」，不会误按出一次 AI 调用（花额度）
  { id: 'ai', label: 'AI', ids: ['ai.continue', 'ai.write'] },
  { id: 'list', label: '列表', ids: ['bullet', 'ordered', 'task'] },
  { id: 'insert', label: '插入', ids: ['table', 'image.upload', 'codeblock', 'hr'] },
  { id: 'ref', label: '引用与附件', ids: ['wikilink', 'filelink', 'attachment'] },
  { id: 'advanced', label: '图表与公式', ids: ['diagram', 'math', 'mathInline'] },
  { id: 'callout', label: '提示块', ids: (Object.keys(CALLOUT_TYPES) as (keyof typeof CALLOUT_TYPES)[]).map((type) => `callout.${type}`) },
  { id: 'headings', label: '更多标题', ids: ['heading.4', 'heading.5', 'heading.6'] },
]

/**
 * 斜杠菜单里各项右侧的 Markdown 快捷输入（规则见 surfaces/text/inputRules.ts）：
 * 让人在用菜单的同时看到「不用菜单也能直接打出来」。手机上不显示（和快捷键提示一样）。
 */
export const SLASH_MARKDOWN_HINTS: Readonly<Record<string, string>> = {
  'heading.1': '#',
  'heading.2': '##',
  'heading.3': '###',
  quote: '>',
  bullet: '-',
  ordered: '1.',
  task: '[]',
  codeblock: '```',
  hr: '---',
  wikilink: '[[',
}

/** 斜杠菜单的一组：标题 + 这一组的动作 */
export interface SlashGroup {
  id: string
  label: string
  items: EditorAction[]
}

/**
 * 空查询时把动作排进分组：先放「最近使用」（最多 3 项，重复出现在自己的组里也保留——回车直接选中上次用的），
 * 再按 SLASH_SECTIONS 的顺序放，最后是不认识的动作。不在 actions 里的 id（例如只读时被过滤掉的）直接跳过。
 */
export function groupSlashActions(actions: readonly EditorAction[], recentIds: readonly string[] = []): SlashGroup[] {
  const byId = new Map(actions.map((action) => [action.id, action]))
  const groups: SlashGroup[] = []
  const recent = recentIds.map((id) => byId.get(id)).filter((action): action is EditorAction => !!action).slice(0, 3)
  if (recent.length) groups.push({ id: 'recent', label: '最近使用', items: recent })
  const placed = new Set<string>()
  for (const section of SLASH_SECTIONS) {
    const items = section.ids.map((id) => byId.get(id)).filter((action): action is EditorAction => !!action)
    for (const item of items) placed.add(item.id)
    if (items.length) groups.push({ id: section.id, label: section.label, items })
  }
  const rest = actions.filter((action) => !placed.has(action.id))
  if (rest.length) groups.push({ id: 'extension', label: '扩展', items: rest })
  return groups
}

/**
 * 斜杠菜单过滤：忽略大小写，空格分词，每个词都要命中才保留。能命中的地方：
 * - 名字（「表格」）、id 和关键词（`table`）；
 * - 名字的全拼和首字母（`biaoge`、`bg`）：中文输入法开着英文模式、或者懒得选字时直接打字母就能找到；
 * 结果按命中程度排序（名字开头 > 名字里 > 拼音开头 > 关键词 > 拼音中间），同分保持原来的顺序，回车选第一项选到的是最像的那个。
 */
export function filterSlashActions(query: string, actions: readonly EditorAction[] = TEXT_SLASH_ACTIONS): EditorAction[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return [...actions]
  const scored: { action: EditorAction; score: number; index: number }[] = []
  actions.forEach((action, index) => {
    const label = action.label.toLowerCase()
    const spoken = [pinyinForms(action.label), ...(action.keywords ?? []).filter((word) => /\p{Script=Han}/u.test(word)).map((word) => pinyinForms(word))]
    const extra = [action.id, ...(action.keywords ?? [])].join(' ').toLowerCase()
    let score = 0
    for (const word of words) {
      let best = 0
      if (label.startsWith(word)) best = 6
      else if (label.includes(word)) best = 5
      else if (spoken.some((forms) => forms.initials.startsWith(word) || forms.full.startsWith(word))) best = 4
      else if (extra.includes(word)) best = 3
      else if (word.length >= 2 && spoken.some((forms) => forms.full.includes(word))) best = 1
      if (!best) return
      score += best
    }
    scored.push({ action, score, index })
  })
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.action)
}

/** 快捷键一览里的一行：说明 + 按键（按 Windows 写法记，显示时 macOS 换成 ⌘⌥⇧，见 host/shortcutLabel.ts） */
export interface ShortcutEntry {
  label: string
  keys: string
}

/**
 * 快捷键一览（Ctrl+/）里工具栏按钮之外的键。按钮自己的快捷键直接从工具栏数据里取（`shortcut` 字段），
 * 按钮提示、下拉菜单和一览三处用的是同一份，不会对不上；keymap.spec 核对这里每个键都真的绑了。
 */
export const TEXT_EXTRA_SHORTCUTS: readonly ShortcutEntry[] = [
  { label: '撤销', keys: 'Ctrl+Z' },
  { label: '重做', keys: 'Ctrl+Shift+Z' },
  { label: '保存', keys: 'Ctrl+S' },
  { label: '换行（不分段）', keys: 'Shift+Enter' },
  { label: '缩进 / 取消缩进（列表、代码块）', keys: 'Tab / Shift+Tab' },
  { label: '跳出代码块', keys: 'Ctrl+Enter' },
  { label: '上移 / 下移当前段落', keys: 'Ctrl+Shift+↑ / Ctrl+Shift+↓' },
  { label: '快捷键一览', keys: 'Ctrl+/' },
]

/** 快捷键一览里的「Markdown 快捷输入」：在段首打这些字，自动变成对应格式（规则见 surfaces/text/inputRules.ts） */
export const TEXT_MARKDOWN_INPUTS: readonly ShortcutEntry[] = [
  { label: '标题', keys: '# 空格（## 是二级）' },
  { label: '无序列表', keys: '- 空格' },
  { label: '有序列表', keys: '1. 空格' },
  { label: '任务列表', keys: '[] 空格' },
  { label: '引用', keys: '> 空格' },
  { label: '代码块', keys: '``` 空格' },
  { label: '分割线', keys: '---' },
  { label: '加粗 / 斜体', keys: '**字** / *字*' },
  { label: '删除线 / 行内代码', keys: '~~字~~ / `字`' },
  { label: '插入菜单', keys: '/ 或 、' },
  { label: '引用笔记', keys: '[[' },
  { label: '撤回刚才的自动格式', keys: '退格' },
]

/** 内容面贡献：Host 按 SurfaceKind 取用；未定义的类型没有工具栏（例如 PDF 只读） */
export interface SurfaceContribution {
  kind: SurfaceKind
  toolbar: readonly ToolbarGroup[]
  slash: readonly EditorAction[]
}

/**
 * 查找：PDF / 代码 / 表格以前只有 Ctrl+F 能打开查找，界面上没有任何入口（旧查看器有放大镜按钮）。
 * 只读面也要有：查找是只读安全的动作。
 */
const FIND_ACTION: EditorAction = { id: 'find', label: '查找', icon: '🔍', command: 'search.open', shortcut: 'Ctrl+F', keywords: ['find', '查找'], ui: true }

/** 代码面只读/编辑共用的视图动作：不提供改写按钮，避免把 Markdown 的格式动作误用到源码上 */
export const CODE_TOOLBAR: readonly ToolbarGroup[] = [
  {
    id: 'view',
    label: '视图',
    actions: [
      { ...FIND_ACTION, label: '查找替换', keywords: ['find', '查找', '替换'] },
      // 旧代码编辑器工具栏上有「换行」，搬进外壳时不能丢
      { id: 'wrap', label: '换行', command: 'view.toggleWrap', check: { kind: 'toggle', name: 'wrap' }, keywords: ['wrap', '换行', '软换行'] },
      { id: 'selectAll', label: '全选', command: 'view.selectAll', shortcut: 'Ctrl+A', keywords: ['select', '全选'] },
      { id: 'focus', label: '聚焦编辑区', command: 'view.focus', keywords: ['focus', '聚焦'] },
    ],
  },
]

/** PDF / 表格：只有查找（缩放、翻页、页签各自在内容面里） */
export const FIND_ONLY_TOOLBAR: readonly ToolbarGroup[] = [{ id: 'view', label: '视图', actions: [FIND_ACTION] }]

/**
 * CSV / TSV 表格的行操作：旧表格编辑器有「每行前加一行 / 删除这一行 / 末尾加一行」，网格里对应成
 * 「按选中的行」操作。xlsx 的网格没有这些命令，所以只给 csv / tsv 格式（见 contributionFor 的 format 参数）。
 */
export const CSV_ROW_TOOLBAR: readonly ToolbarGroup[] = [
  {
    id: 'rows',
    label: '行',
    actions: [
      { id: 'row.insertAbove', label: '上方插入行', command: 'grid.insertRowAbove', write: true, keywords: ['insert', '插入', '行'] },
      { id: 'row.insertBelow', label: '下方插入行', command: 'grid.insertRowBelow', write: true, keywords: ['insert', '插入', '行'] },
      { id: 'row.delete', label: '删除选中行', command: 'grid.deleteRows', write: true, keywords: ['delete', '删除', '行'] },
      { id: 'row.append', label: '末尾加一行', command: 'grid.appendRow', write: true, keywords: ['append', '末尾', '行'] },
    ],
  },
]

/** 分页文档（Word 只读）/ 幻灯片：查找 + 大纲；缩放、翻页、批注 / 备注、放映在内容面自己的工具条里 */
export const PAGE_TOOLBAR: readonly ToolbarGroup[] = [{ id: 'view', label: '视图', actions: [FIND_ACTION, OUTLINE_ACTION] }]

/* ---------------- Word 编辑 ---------------- */

const COLOR_SWATCHES: ReadonlyArray<[string, string]> = [
  ['黑色', '000000'], ['深灰', '595959'], ['红色', 'C00000'], ['橙色', 'ED7D31'], ['黄色', 'FFC000'],
  ['绿色', '00B050'], ['蓝色', '0070C0'], ['深蓝', '1F3864'], ['紫色', '7030A0'],
]
const HIGHLIGHTS: ReadonlyArray<[string, string, string]> = [
  ['黄色', 'yellow', 'FFFF00'], ['绿色', 'green', '00FF00'], ['青色', 'cyan', '00FFFF'],
  ['粉色', 'magenta', 'FF00FF'], ['浅灰', 'lightGray', 'D3D3D3'],
]
const FONT_FAMILIES = ['宋体', '黑体', '楷体', '微软雅黑', 'Arial', 'Calibri', 'Times New Roman', 'Courier New'] as const
const FONT_SIZE_CHOICES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72] as const
const TABLE_SIZES = [[2, 2], [3, 3], [4, 4], [5, 5], [3, 5], [6, 4]] as const

/** Word 画布编辑工具栏：只在编辑面使用（只读预览仍用 PAGE_TOOLBAR）；`write` 动作只读时整颗消失 */
export const PAGE_EDIT_TOOLBAR: readonly ToolbarGroup[] = [
  {
    id: 'marks',
    label: '文字',
    actions: [
      { id: 'docx.bold', label: '粗体', icon: 'B', command: 'docx.bold', write: true, shortcut: 'Ctrl+B', check: { kind: 'mark', name: 'bold' }, keywords: ['bold', '加粗', '粗体'] },
      { id: 'docx.italic', label: '斜体', icon: 'I', command: 'docx.italic', write: true, shortcut: 'Ctrl+I', check: { kind: 'mark', name: 'italic' }, keywords: ['italic', '斜体'] },
      { id: 'docx.underline', label: '下划线', icon: 'U', command: 'docx.underline', write: true, shortcut: 'Ctrl+U', check: { kind: 'mark', name: 'underline' }, keywords: ['underline', '下划线'] },
      { id: 'docx.strike', label: '删除线', icon: 'S', command: 'docx.strike', write: true, check: { kind: 'mark', name: 'strike' }, keywords: ['strike', '删除线'] },
      { id: 'docx.superscript', label: '上标', icon: 'x²', command: 'docx.superscript', write: true, shortcut: 'Ctrl+Shift+=', check: { kind: 'mark', name: 'superscript' } },
      { id: 'docx.subscript', label: '下标', icon: 'x₂', command: 'docx.subscript', write: true, shortcut: 'Ctrl+=', check: { kind: 'mark', name: 'subscript' } },
      {
        id: 'docx.fontFamily', label: '字体', command: 'docx.fontFamily', write: true, ui: true,
        choices: FONT_FAMILIES.map((family) => ({ label: family, args: { family }, current: { name: 'fontFamily', value: family } })),
      },
      {
        id: 'docx.fontSize', label: '字号', command: 'docx.fontSize', write: true, ui: true,
        choices: FONT_SIZE_CHOICES.map((points) => ({ label: String(points), args: { points }, current: { name: 'fontSizePt', value: points } })),
      },
      {
        id: 'docx.textColor', label: '文字颜色', icon: 'A', command: 'docx.textColor', write: true, ui: true,
        choices: [...COLOR_SWATCHES.map(([label, hex]) => ({ label, args: { color: hex }, swatch: `#${hex}` })), { label: '自动', args: { color: null } }],
      },
      {
        id: 'docx.highlight', label: '突出显示', icon: '▇', command: 'docx.highlight', write: true, ui: true,
        choices: [...HIGHLIGHTS.map(([label, name, hex]) => ({ label, args: { color: name }, swatch: `#${hex}` })), { label: '无', args: { color: null } }],
      },
      { id: 'docx.clearFormat', label: '清除格式', icon: 'Tx', command: 'docx.clearFormat', write: true, keywords: ['clear', '清除格式'] },
    ],
  },
  {
    id: 'blocks',
    label: '段落',
    actions: [
      {
        id: 'docx.style', label: '样式', command: 'docx.style', write: true, ui: true,
        choices: [
          { label: '正文', args: { styleId: 'Normal' }, current: { name: 'styleId', value: 'Normal' } },
          { label: '标题 1', args: { styleId: 'Heading1' }, current: { name: 'styleId', value: 'Heading1' } },
          { label: '标题 2', args: { styleId: 'Heading2' }, current: { name: 'styleId', value: 'Heading2' } },
          { label: '标题 3', args: { styleId: 'Heading3' }, current: { name: 'styleId', value: 'Heading3' } },
        ],
      },
      { id: 'docx.align.left', label: '左对齐', icon: '⫷', command: 'docx.align', args: { value: 'left' }, write: true, shortcut: 'Ctrl+L', check: { kind: 'value', name: 'alignment', value: 'left' } },
      { id: 'docx.align.center', label: '居中', icon: '≡', command: 'docx.align', args: { value: 'center' }, write: true, shortcut: 'Ctrl+E', check: { kind: 'value', name: 'alignment', value: 'center' } },
      { id: 'docx.align.right', label: '右对齐', icon: '⫸', command: 'docx.align', args: { value: 'right' }, write: true, shortcut: 'Ctrl+R', check: { kind: 'value', name: 'alignment', value: 'right' } },
      { id: 'docx.align.both', label: '两端对齐', icon: '☰', command: 'docx.align', args: { value: 'both' }, write: true, shortcut: 'Ctrl+J', check: { kind: 'value', name: 'alignment', value: 'both' } },
      {
        id: 'docx.lineSpacing', label: '行距', command: 'docx.lineSpacing', write: true, ui: true,
        choices: [['1.0', 240], ['1.15', 276], ['1.5', 360], ['2.0', 480], ['3.0', 720]].map(([label, value]) => ({
          label: String(label), args: { value }, current: { name: 'lineSpacing', value: value as number },
        })),
      },
    ],
  },
  {
    id: 'lists',
    label: '列表',
    actions: [
      { id: 'docx.list.bullet', label: '项目符号', icon: '•', command: 'docx.list', args: { kind: 'bullet' }, write: true, check: { kind: 'list', list: 'bullet_list' }, keywords: ['bullet', '项目符号', '无序'] },
      { id: 'docx.list.numbered', label: '编号', icon: '1.', command: 'docx.list', args: { kind: 'numbered' }, write: true, check: { kind: 'list', list: 'ordered_list' }, keywords: ['numbered', '编号', '有序'] },
      { id: 'docx.outdent', label: '减少缩进', icon: '⇤', command: 'docx.indent', args: { direction: 'decrease' }, write: true },
      { id: 'docx.indent', label: '增加缩进', icon: '⇥', command: 'docx.indent', args: { direction: 'increase' }, write: true },
    ],
  },
  {
    id: 'insert',
    label: '插入',
    actions: [
      {
        id: 'docx.table.insert', label: '插入表格', icon: '▦', command: 'docx.table.insert', write: true, ui: true,
        choices: TABLE_SIZES.map(([rows, columns]) => ({ label: `${rows} × ${columns}`, args: { rows, columns } })),
      },
      { id: 'docx.image', label: '插入图片', icon: '🖼', command: 'docx.image.pick', write: true, ui: true, keywords: ['image', '图片'] },
      {
        id: 'docx.image.wrap', label: '图片环绕', icon: '▣', command: 'docx.image.wrap', write: true, ui: true,
        choices: [['嵌入型', 'inline'], ['四周型', 'square'], ['紧密型', 'tight'], ['上下型', 'topAndBottom'], ['衬于文字下方', 'behind'], ['浮于文字上方', 'inFront']].map(([label, target]) => ({ label: label!, args: { target } })),
      },
      { id: 'docx.pageBreak', label: '分页符', icon: '⤓', command: 'docx.pageBreak', write: true, keywords: ['page break', '分页'] },
    ],
  },
  {
    id: 'table',
    label: '表格',
    actions: [
      { id: 'docx.table.rowAbove', label: '上方插入行', icon: '⤒', command: 'docx.table.row', args: { side: 'above' }, write: true },
      { id: 'docx.table.rowBelow', label: '下方插入行', icon: '⤓', command: 'docx.table.row', args: { side: 'below' }, write: true },
      { id: 'docx.table.colLeft', label: '左侧插入列', icon: '⇤', command: 'docx.table.column', args: { side: 'left' }, write: true },
      { id: 'docx.table.colRight', label: '右侧插入列', icon: '⇥', command: 'docx.table.column', args: { side: 'right' }, write: true },
      { id: 'docx.table.deleteRow', label: '删除行', icon: '−行', command: 'docx.table.deleteRow', write: true },
      { id: 'docx.table.deleteColumn', label: '删除列', icon: '−列', command: 'docx.table.deleteColumn', write: true },
      { id: 'docx.table.merge', label: '合并单元格', icon: '⊞', command: 'docx.table.merge', write: true },
      {
        id: 'docx.table.split', label: '拆分单元格', icon: '⊟', command: 'docx.table.split', write: true, ui: true,
        choices: [[1, 2], [2, 1], [2, 2]].map(([rows, columns]) => ({ label: `${rows} 行 × ${columns} 列`, args: { rows, columns } })),
      },
      {
        id: 'docx.table.shading', label: '单元格底纹', icon: '▨', command: 'docx.table.shading', write: true, ui: true,
        choices: [...[['浅灰', 'D9D9D9'], ['浅黄', 'FFF2CC'], ['浅绿', 'E2EFDA'], ['浅蓝', 'DDEBF7']].map(([label, hex]) => ({ label: label!, args: { color: hex }, swatch: `#${hex}` })), { label: '无底纹', args: { color: null } }],
      },
      {
        id: 'docx.table.borders', label: '边框', icon: '⊡', command: 'docx.table.borders', write: true, ui: true,
        choices: [['所有框线', 'all'], ['外侧框线', 'outside'], ['内部框线', 'inside'], ['无框线', 'none']].map(([label, preset]) => ({ label: label!, args: { preset } })),
      },
      { id: 'docx.table.delete', label: '删除表格', icon: '✕', command: 'docx.table.delete', write: true },
    ],
  },
  {
    id: 'view',
    label: '视图',
    actions: [
      FIND_ACTION,
      OUTLINE_ACTION,
      // 审阅：评论 + 修订侧栏。查看者也能打开（看别人的评论和修订），所以不是 write 动作
      { id: 'docx.review', label: '审阅', icon: '💬', command: 'view.toggleReview', ui: true, check: { kind: 'toggle', name: 'review' }, keywords: ['comment', 'review', '评论', '批注', '修订', '审阅'] },
      // 修订模式：之后的修改都记成修订标记，只有能编辑的人才有
      // 导出：下载保存后的 .docx，或纯文本。Word 的"导出"不是 Markdown，所以不用外壳通用的导出按钮
      {
        id: 'docx.export', label: '导出', icon: '⤓', command: 'export.docx', ui: true,
        choices: [{ label: '下载 Word（.docx）', args: { as: 'docx' } }, { label: '下载纯文本（.txt）', args: { as: 'text' } }],
      },
      // 打印：查看者也能打印，所以不是写动作。走自己的整页位图（所见即所得），不是浏览器对整个页面的原生打印
      { id: 'docx.print', label: '打印', icon: '⎙', command: 'file.print', ui: true, keywords: ['print', '打印'] },
      { id: 'docx.trackChanges', label: '修订', icon: '✎', command: 'docx.trackChanges.toggle', write: true, check: { kind: 'toggle', name: 'trackChanges' }, keywords: ['track', '修订', '留痕'] },
    ],
  },
]

/** Word 画布编辑的内容面贡献；由 OfficeEditor 显式传给 EditorHost（只读预览不用） */
export const PAGE_EDIT_CONTRIBUTION: SurfaceContribution = { kind: 'page', toolbar: PAGE_EDIT_TOOLBAR, slash: [] }

const CONTRIBUTIONS: Partial<Record<SurfaceKind, SurfaceContribution>> = {
  text: { kind: 'text', toolbar: TEXT_TOOLBAR, slash: TEXT_SLASH_ACTIONS },
  code: { kind: 'code', toolbar: CODE_TOOLBAR, slash: [] },
  pdf: { kind: 'pdf', toolbar: FIND_ONLY_TOOLBAR, slash: [] },
  grid: { kind: 'grid', toolbar: FIND_ONLY_TOOLBAR, slash: [] },
  page: { kind: 'page', toolbar: PAGE_TOOLBAR, slash: [] },
  slide: { kind: 'slide', toolbar: PAGE_TOOLBAR, slash: [] },
}

const CSV_CONTRIBUTION: SurfaceContribution = { kind: 'grid', toolbar: [...FIND_ONLY_TOOLBAR, ...CSV_ROW_TOOLBAR], slash: [] }

/**
 * 取某类内容面的内置静态贡献；没有则返回 null。表格按格式区分：csv / tsv 有行操作。
 *
 * 兼容层：界面不再调用它——Host 从注册表取（`contributionWith`），那里已经包含这份数据和第三方扩展。
 * 它留着是因为 `builtin/slide.ext.ts` 靠它读幻灯片的内置工具栏（PPTX 分支往 `CONTRIBUTIONS.slide` 放数据即可），
 * 以及单测拿它当「迁移前的真值」逐项对照注册表的结果。
 */
export function contributionFor(kind: SurfaceKind, format?: string): SurfaceContribution | null {
  if (kind === 'grid' && (format === 'csv' || format === 'tsv')) return CSV_CONTRIBUTION
  return CONTRIBUTIONS[kind] ?? null
}
