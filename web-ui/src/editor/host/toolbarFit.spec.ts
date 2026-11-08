import { describe, expect, it } from 'vitest'
import { fitToolbar, type ToolbarItemWidth } from './toolbarFit'

const action = (width: number): ToolbarItemWidth => ({ kind: 'action', width })
const sep = (width = 5): ToolbarItemWidth => ({ kind: 'sep', width })

describe('工具栏溢出（fitToolbar）', () => {
  it('1. 全部放得下：不收任何按钮，也不给「更多」留位置', () => {
    expect(fitToolbar([action(30), action(30), sep(), action(30)], 200, 60, 4)).toBe(4)
    // 恰好放满也算放得下
    expect(fitToolbar([action(50), action(50)], 104, 60, 4)).toBe(2)
  })

  it('2. 放不下：给「更多」留出位置后按顺序装，后面的全部进菜单', () => {
    // 7 个共 234 > 200；给更多 60 + 间距 4 → 预算 136；30+4+30+4+30+4+30 = 132 → 4 个
    expect(fitToolbar(Array.from({ length: 7 }, () => action(30)), 200, 60, 4)).toBe(4)
  })

  it('3. 竖线不会孤零零挂在末尾', () => {
    // 共 181 > 150；预算 150-60-4 = 86：30+4+30+4+5 = 73，下一个 70 放不下 → 前 3 项，但第 3 项是竖线 → 退回 2
    expect(fitToolbar([action(30), action(30), sep(), action(70), action(30)], 150, 60, 4)).toBe(2)
  })

  it('4. 一个都放不下时全部进菜单；空工具栏返回 0', () => {
    expect(fitToolbar([action(100), action(100)], 120, 60, 4)).toBe(0)
    expect(fitToolbar([], 100, 60, 4)).toBe(0)
  })

  it('5. 1440 宽笔记编辑器的真实尺寸：23 个按钮放不下时末尾的「查找替换 / 大纲」进菜单', () => {
    // 实测（e2e 量的）：工具栏可用 614 px，按钮 28~36 px，6 根竖线，间距 4
    const groups = [5, 4, 4, 3, 4, 3]
    const items: ToolbarItemWidth[] = []
    groups.forEach((count, index) => {
      if (index > 0) items.push(sep(5))
      for (let i = 0; i < count; i += 1) items.push(action(28))
    })
    const fit = fitToolbar(items, 614, 56, 4)
    expect(fit).toBeLessThan(items.length)
    expect(items[fit - 1].kind).toBe('action')
  })
})
