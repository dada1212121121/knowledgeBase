/**
 * docx 只读面的锚点：页码 + 原文片段 ↔ 渲染结果里的 Range
 *
 * 为什么锚点只带"页码 + 文字"：docx-preview 是真 DOM 分页，没有稳定的块 id，
 * 页码缩放后不变，文字片段不随缩放 / 字体替换变化。搜索命中、批注、大纲、AI 引用都用这一种形状，
 * 与 PDF 的 `{page, rect}` 并列（Anchor 联合类型里的 `page` 一支，原本没有任何面在用）。
 */
import { findTextRange } from '@/utils/domHighlight'
import type { ViewerHit } from '@/utils/viewerHit'
import type { Anchor } from '../../types'
import { pageElements, pageOfNode } from './docx-read'

export type PageAnchor = Extract<Anchor, { kind: 'page' }>

/** 锚点里留多少字：够在整篇里唯一定位一句话，又不把整段拷进选区事件 */
const QUOTE_MAX = 120

const squash = (value: string) => value.replace(/\s+/g, ' ').trim()

/** 范围 → 锚点：起点所在的页 + 范围开头的文字。选区没碰到任何页返回 null */
export function anchorFromRange(range: Range, host: HTMLElement): PageAnchor | null {
  let page = pageOfNode(host, range.startContainer)
  // 全选时起点是容器本身而不是某一页：取选区碰到的第一页
  if (!page) page = pageElements(host).findIndex((section) => range.intersectsNode(section)) + 1
  if (!page) return null
  return { kind: 'page', page, text: squash(range.toString()).slice(0, QUOTE_MAX) }
}

/**
 * 锚点 → 范围：先在锚点页里找（几乎总在那一页，也避开整篇的重复句），找不到再扫全文。
 * `page` 为 0 表示调用方不知道页码（搜索命中的块没带页码时），直接扫全文。
 */
export function rangeFromAnchor(host: HTMLElement, anchor: PageAnchor): Range | null {
  const text = squash(anchor.text ?? '')
  if (!text) return null
  const section = anchor.page >= 1 ? pageElements(host)[anchor.page - 1] : undefined
  if (section) {
    const inPage = findTextRange(section, text, 2)
    if (inPage) return inPage
  }
  return findTextRange(host, text, 2)
}

/** 搜索命中（viewerHit.deriveHit 的结果）→ 统一锚点；没有可定位的文字时返回 undefined */
export function hitToPageAnchor(hit: Pick<ViewerHit, 'text' | 'page'>): PageAnchor | undefined {
  if (!hit.text.trim()) return undefined
  return { kind: 'page', page: hit.page ?? 0, text: squash(hit.text).slice(0, QUOTE_MAX) }
}
