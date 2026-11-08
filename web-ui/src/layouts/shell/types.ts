// 外壳里导航项的数据形状(侧栏、手机标签栏、「我的」页共用同一份清单,避免三处各写一遍)。
import type { RouteLocationRaw } from 'vue-router'
import type { IconName } from '@kb-ui/index'

export interface NavEntry {
  /** 稳定的标识,测试和高亮都用它。 */
  id: string
  to: RouteLocationRaw
  icon: IconName
  label: string
  /** 红色数字角标(待处理的数量);0 / 缺省不显示。 */
  count?: number
  /** 灰色小字(总数等)。 */
  text?: string
  /** 当前页是否属于这个入口。 */
  active?: boolean
}

export interface NavGroup {
  id: string
  /** 分组标题;没有就不显示标题。 */
  label?: string
  items: NavEntry[]
  /**
   * 能不能折叠(目前只有「管理」):入口多的一组收起来,矮屏上整列才放得下,
   * 不会把最后几个入口切在滚动区边缘(只露半行按钮,看着像排版坏了)。
   */
  collapsible?: boolean
}

export type { SystemAlert } from '@/utils/systemAlerts'
