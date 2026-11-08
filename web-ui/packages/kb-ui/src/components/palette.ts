// 命令面板与外壳之间的契约(类型放独立文件:`<script setup>` 里不能写 export)。
//
// 为什么要有这层:面板本身属于共享包,不应该认识应用层的 http 客户端(`@/api/client`)
// 外壳把「怎么调能力」「页面地址是什么」注入进来,面板只负责交互。

/** 能力调用(外壳传 `callCapability`) */
export type PaletteCall = <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<T>

/** 面板跳转用到的页面地址(外壳传 `PATHS`) */
export interface PalettePaths {
  search: string
  review: string
  kb: string
  eval: string
  me: string
  system: string
  appearance: string
  guide: string
  projects: string
  import: string
  audit: string
}

/** 笔记条目:只声明面板用到的字段,不依赖 api 客户端的响应类型 */
export interface PaletteItem {
  id: string
  collection?: string
  source: string
  title?: string | null
}
