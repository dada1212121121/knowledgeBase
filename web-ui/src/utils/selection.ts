// 多选的纯逻辑（设计规范）:Ctrl/⌘ + 点击切换、Shift + 点击连选、选择模式下点击切换、一次最多 500 项。
// 列表(知识库页的文档列表、目录树)、「我的分享」表格共用同一套规则,所以放在这里单测,组件只管接事件。

/** 一次最多选多少项(后端 grant_batch / link_create 的上限)。 */
export const MAX_SELECTION = 500

export interface PickMode {
  /** Ctrl / ⌘ 按着 */
  ctrl: boolean
  /** Shift 按着 */
  shift: boolean
  /** 已经处在选择模式(点过「选择」或长按进入) */
  selecting: boolean
}

export interface SelectionState {
  selected: string[]
  /** Shift 连选的起点:最近一次明确点中的那一项 */
  anchor: string | null
  selecting: boolean
}

export interface PickResult extends SelectionState {
  /** false = 这是一次普通点击,不该改选择,调用方照常「打开」这一项 */
  handled: boolean
  /** 超过上限被截掉了多少项(0 = 没超) */
  dropped: number
}

/** 范围:`order` 里从 a 到 b(含两端,不分先后);任何一端不在列表里返回 null。 */
export function rangeBetween(order: string[], a: string, b: string): string[] | null {
  const from = order.indexOf(a)
  const to = order.indexOf(b)
  if (from < 0 || to < 0) return null
  return order.slice(Math.min(from, to), Math.max(from, to) + 1)
}

function capped(keys: string[], max: number): { keys: string[]; dropped: number } {
  return keys.length > max ? { keys: keys.slice(0, max), dropped: keys.length - max } : { keys, dropped: 0 }
}

/**
 * 点了 `key` 之后的选择状态。
 *  - Shift + 点击且有起点:起点到这一项之间全选(并上已选的),起点不变;
 *  - Ctrl/⌘ + 点击:切换这一项并进入选择模式;
 *  - 选择模式下(或已有选中项)的普通点击:切换这一项;
 *  - 其余是普通点击:不改选择,`handled: false`。
 * 顺序以 `order`(当前可见的列表顺序)为准;超过 `max` 的部分被丢掉并报告 `dropped`。
 */
export function pick(order: string[], state: SelectionState, key: string, mode: PickMode, max = MAX_SELECTION): PickResult {
  const keep = (selected: string[], anchor: string | null, selecting: boolean): PickResult => {
    const { keys, dropped } = capped(selected, max)
    return { selected: keys, anchor, selecting: selecting || keys.length > 0, handled: true, dropped }
  }
  const has = state.selected.includes(key)
  const toggled = () => (has ? state.selected.filter((item) => item !== key) : [...state.selected, key])

  if (mode.shift && state.anchor) {
    const span = rangeBetween(order, state.anchor, key)
    if (span) return keep([...new Set([...state.selected, ...span])], state.anchor, true)
  }
  if (mode.ctrl) return keep(toggled(), key, true)
  if (mode.selecting || state.selecting || state.selected.length > 0) return keep(toggled(), key, true)
  return { ...state, handled: false, dropped: 0 }
}

/** 全选当前可见的项(超过上限只取前 max 项)。 */
export function selectAll(order: string[], max = MAX_SELECTION): { selected: string[]; dropped: number } {
  const { keys, dropped } = capped(order, max)
  return { selected: keys, dropped }
}

/** 数据换了(翻页、筛选、搜索)之后,丢掉已经不在当前列表里的选中项;`keepAll` 时原样保留(跨页选择)。 */
export function pruneSelection(selected: string[], order: string[], keepAll = false): string[] {
  if (keepAll) return selected
  const visible = new Set(order)
  return selected.filter((key) => visible.has(key))
}
