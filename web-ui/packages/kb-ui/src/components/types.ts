// 组件共享的类型定义(不能在 <script setup> 里 export 类型,统一放这里)。
export interface Column {
  key: string
  label: string
  align?: 'left' | 'right'
  width?: string
  clip?: boolean
  /** 直接加在 <td> 上的 class(例如 `mono m`),比在插槽里再包一层 span 更贴合基线 */
  cellClass?: string
}

/** 时间线的一步(单文件下钻 / 版本历史)。 */
export interface Step {
  title: string
  detail?: string
  state?: 'done' | 'current' | 'failed' | 'pending'
}
