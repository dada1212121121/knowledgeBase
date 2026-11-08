/**
 * PPTX 只读 Worker 的消息协议（只含类型，主线程与 Worker 两边共用，编译后擦除）
 *
 * 为什么要有这个 Worker：引擎的「解析整份 pptx」「排版一页」都是一次同步的 WASM 调用，放在主线程上
 * 4× 降速下单次 300~750 ms（30 页 deck），任何切片手段都拆不开一次 WASM 调用，只能整个挪走。
 * 主线程只留「把显示列表画到画布上」（paintSlide，纯 Canvas 2D）和图片解码（要 DOM 的格式解不了 Worker）。
 */
import type { SlideDisplayList } from '@betteroffice/pptx'
import type { SlideMatch, SlideSummary } from '../surfaces/slide/types'

export interface ReadFontBytes {
  regular: Uint8Array
  bold: Uint8Array
}

/** 主线程 → Worker。`id` 由客户端分配，回包带同一个 id */
export type ReadRequest =
  /** 预热：只初始化 WASM（模块由主线程编译好后整个交过来），此时还没有文档 */
  | { op: 'init'; wasm: WebAssembly.Module }
  /** 打开文档：解析、读目录；不排版（中文度量要先看文字里有没有中文才登记） */
  | { op: 'open'; bytes: Uint8Array; latin: ReadFontBytes; families: readonly string[] }
  /** 把中文度量字体登记进引擎（之后的排版才会用中文字宽） */
  | { op: 'registerCjk'; bytes: Uint8Array }
  /** 排版第一页（页面尺寸以它为准）并取出每页纯文字（读屏与命中判断同步读，不能每次问 Worker） */
  | { op: 'prepare' }
  | { op: 'layout'; index: number }
  | { op: 'media'; assetId: string }
  | { op: 'search'; query: string }

export interface ReadOpenReply {
  summaries: SlideSummary[]
  /** 字体提示等非致命问题 */
  notices: string[]
  /** 整份 deck 的文字（用来决定要预取哪些字形片、要不要登记中文度量） */
  deckText: string
  needsCjk: boolean
}

export interface ReadPrepareReply {
  /** 空演示文稿没有第一页：此时只能用 EMU 尺寸（交给外壳报「没有幻灯片」） */
  firstList: SlideDisplayList | null
  emuSize: { width: number; height: number }
  /** 与 SlideBackend.slideText 一致：该页所有文本流用换行连起来 */
  texts: string[]
}

export type ReadResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { name: string; message: string } }

export type { SlideMatch }
