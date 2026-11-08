/**
 * 工具栏放不下时，哪些按钮收进「更多」菜单。
 *
 * 以前工具栏是横向滚动：1440 宽的笔记编辑器 23 个按钮里有 4 个（分割线、代码块、查找替换、大纲）在可视区外，
 * 而滚动条细得几乎看不见，用户根本不知道还有按钮。改成：放得下的按顺序显示，放不下的从某一个开始全部进「更多」。
 *
 * 纯函数：输入每一项的宽度（按钮与分组竖线按显示顺序排列），返回「前多少项留在工具栏上」。
 * 组件只负责量宽度和响应尺寸变化，规则都在这里，单测直接驱动。
 */

export interface ToolbarItemWidth {
  /** 'action' 是按钮；'sep' 是分组之间的竖线（跟在它后面的按钮一起显示或一起收起） */
  kind: 'action' | 'sep'
  width: number
}

/**
 * @param items     按显示顺序排列的按钮 / 竖线宽度（px）
 * @param available 工具栏可用宽度（px，已扣掉固定显示的插槽内容）
 * @param moreWidth 「更多」按钮的宽度（px）
 * @param gap       相邻两项之间的间距（px）
 * @returns 留在工具栏上的项数（items 的前缀长度）；全部放得下时返回 items.length
 */
export function fitToolbar(items: readonly ToolbarItemWidth[], available: number, moreWidth: number, gap = 0): number {
  const total = items.reduce((sum, item, index) => sum + item.width + (index > 0 ? gap : 0), 0)
  if (total <= available) return items.length
  // 放不下：先给「更多」按钮留出位置，再从头往后装
  const budget = available - moreWidth - gap
  let used = 0
  let fit = 0
  for (let index = 0; index < items.length; index += 1) {
    const next = used + items[index].width + (index > 0 ? gap : 0)
    if (next > budget) break
    used = next
    fit = index + 1
  }
  // 竖线不单独留在末尾：后面的按钮都收进菜单了，留一根竖线挂在「更多」前面没有意义
  while (fit > 0 && items[fit - 1].kind === 'sep') fit -= 1
  return fit
}
