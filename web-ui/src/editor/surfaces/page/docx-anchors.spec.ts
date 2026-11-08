/**
 * docx 只读面锚点测试：范围 ↔ {page, text}，搜索命中 → 锚点
 */
import { describe, expect, it } from 'vitest'
import { anchorFromRange, hitToPageAnchor, rangeFromAnchor } from './docx-anchors'
import { pageElements } from './docx-read'

function build(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = `
  <section class="kbdocx"><p>目录：合同条款 ........ 3</p><p>第一页的正文</p></section>
  <section class="kbdocx"><p>第二页</p></section>
  <section class="kbdocx"><p>合同条款</p><p>甲方应当按期支付货款。</p></section>`
  document.body.appendChild(host)
  return host
}

describe('锚点', () => {
  it('1. 范围 → 锚点：起点所在页 + 范围开头的文字（空白压成单个空格）', () => {
    const host = build()
    const text = pageElements(host)[2]!.querySelectorAll('p')[1]!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 6)
    expect(anchorFromRange(range, host)).toEqual({ kind: 'page', page: 3, text: '甲方应当按期' })
  })

  it('2. 起点不在任何页里（选区在工具栏等处）：返回 null', () => {
    const host = build()
    const outside = document.createElement('p')
    outside.textContent = '外面的字'
    document.body.appendChild(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    expect(anchorFromRange(range, host)).toBeNull()
  })

  it('3. 锚点 → 范围：优先在锚点页里找，避开前面页的同名文字（目录里也有「合同条款」）', () => {
    const host = build()
    const range = rangeFromAnchor(host, { kind: 'page', page: 3, text: '合同条款' })!
    expect(range.startContainer.parentElement!.closest('section')).toBe(pageElements(host)[2])
    // 页码不知道（0）：扫全文，命中第一处（目录那一页）
    const loose = rangeFromAnchor(host, { kind: 'page', page: 0, text: '合同条款' })!
    expect(loose.startContainer.parentElement!.closest('section')).toBe(pageElements(host)[0])
  })

  it('4. 页码对不上时退回全文扫描；文字找不到或为空返回 null', () => {
    const host = build()
    expect(rangeFromAnchor(host, { kind: 'page', page: 2, text: '甲方应当按期' })).not.toBeNull()
    expect(rangeFromAnchor(host, { kind: 'page', page: 1, text: '不存在的一句话' })).toBeNull()
    expect(rangeFromAnchor(host, { kind: 'page', page: 1, text: '   ' })).toBeNull()
  })
})

describe('hitToPageAnchor', () => {
  it('5. 命中句子 → 统一锚点；没有页码用 0；没有文字不产生锚点', () => {
    expect(hitToPageAnchor({ text: '  合同  条款\n约定 ', page: null })).toEqual({ kind: 'page', page: 0, text: '合同 条款 约定' })
    expect(hitToPageAnchor({ text: '句子', page: 4 })).toEqual({ kind: 'page', page: 4, text: '句子' })
    expect(hitToPageAnchor({ text: '   ', page: 4 })).toBeUndefined()
  })
})
