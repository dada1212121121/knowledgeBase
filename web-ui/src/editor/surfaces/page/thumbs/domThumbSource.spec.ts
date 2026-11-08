/**
 * 只读预览缩略图后端测试（补全）：克隆体不能混进正文的页选择器、不与正文冲突、不可交互、按盒子缩放
 */
import { describe, expect, it } from 'vitest'
import { cloneForThumbnail, createDomThumbSource } from './domThumbSource'

const PAGE = `<section class="kbdocx" style="width: 612pt; min-height: 792pt; padding: 72pt">
  <header><p>页眉</p></header>
  <article>
    <p id="bm1" class="kbdocx_heading1">第一章 <a href="#bm1">目录链接</a> <a href="https://example.com/x">外链</a></p>
    <table><tbody><tr><td>单元格</td></tr></tbody></table>
    <img src="data:image/png;base64,AAAA" alt="文档图片" />
    <svg><defs><linearGradient id="g1"><stop offset="0" stop-color="red" /></linearGradient><clipPath id="c1"><rect width="10" height="10" /></clipPath></defs>
      <rect id="shape" fill="url(#g1)" clip-path="url(#c1)" width="50" height="50" /><use href="#g1" /></svg>
    <video src="x.mp4"></video><script>alert(1)</script>
  </article>
  <footer><p>页脚</p></footer>
</section>`

function pageFrom(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.firstElementChild as HTMLElement
}

describe('cloneForThumbnail', () => {
  it('外壳是 div 而不是 section.kbdocx：不会被「页」的选择器当成一页（页数、页码、查找都按它取页）', () => {
    const host = document.createElement('div')
    host.innerHTML = PAGE + PAGE
    document.body.appendChild(host)
    const clone = cloneForThumbnail(host.firstElementChild as HTMLElement, 'kbdocx')
    document.body.appendChild(clone)
    expect(clone.tagName).toBe('DIV')
    expect(clone.classList.contains('kbdocx')).toBe(true)
    // docx-preview 的样式表按 .kbdocx 限定后代选择器，所以类名要留
    expect(document.querySelectorAll('section.kbdocx')).toHaveLength(2)
    expect(document.querySelectorAll('.kbdocx-wrapper')).toHaveLength(0)
    clone.remove()
    host.remove()
  })

  it('保留页面自己的内联版式（宽 / 最小高 / 页边距）和全部内容（页眉页脚、表格、图片）', () => {
    const clone = cloneForThumbnail(pageFrom(PAGE), 'kbdocx')
    expect(clone.style.width).toBe('612pt')
    expect(clone.style.minHeight).toBe('792pt')
    expect(clone.querySelector('header')?.textContent).toContain('页眉')
    expect(clone.querySelector('footer')?.textContent).toContain('页脚')
    expect(clone.querySelector('table td')?.textContent).toBe('单元格')
    expect(clone.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('不与正文冲突：去掉 id 与链接，去掉脚本 / 视频；整页对读屏隐藏且 inert', () => {
    const clone = cloneForThumbnail(pageFrom(PAGE), 'kbdocx')
    expect(clone.querySelector('#bm1')).toBeNull()
    expect(clone.querySelector('p')?.hasAttribute('id')).toBe(false)
    expect(clone.querySelectorAll('a[href]')).toHaveLength(0)
    expect(clone.querySelector('script, video')).toBeNull()
    expect(clone.getAttribute('aria-hidden')).toBe('true')
    expect(clone.hasAttribute('inert')).toBe(true)
  })

  it('SVG 里的 id 改名，url(#…) 与 href="#…" 引用跟着改（否则渐变 / 裁切失效，也不会指到正文里同名的元素）', () => {
    const original = pageFrom(PAGE)
    const clone = cloneForThumbnail(original, 'kbdocx', 'kbt3-')
    const rect = clone.querySelector('rect[width="50"]')!
    expect(rect.getAttribute('fill')).toBe('url(#kbt3-g1)')
    expect(rect.getAttribute('clip-path')).toBe('url(#kbt3-c1)')
    expect(clone.querySelector('linearGradient')?.getAttribute('id')).toBe('kbt3-g1')
    expect(clone.querySelector('use')?.getAttribute('href')).toBe('#kbt3-g1')
    // 原页不受影响
    expect(original.querySelector('rect[width="50"]')?.getAttribute('fill')).toBe('url(#g1)')
    expect(original.querySelector('#g1')).not.toBeNull()
  })
})

describe('createDomThumbSource', () => {
  it('按盒子宽度缩小：scale = 盒子宽 / 页面未缩放宽；外层裁成盒子大小', async () => {
    const pages = [pageFrom(PAGE)]
    const source = createDomThumbSource({ pages: () => pages, naturalSize: () => ({ width: 816, height: 1056 }), className: 'kbdocx' })
    const clip = await source.render(0, { width: 144, height: 186, dpr: 1 }, new AbortController().signal)
    expect(clip.style.width).toBe('144px')
    expect(clip.style.height).toBe('186px')
    const sheet = clip.firstElementChild as HTMLElement
    expect(sheet.style.transform).toBe(`scale(${144 / 816})`)
    expect(sheet.style.transformOrigin).toBe('top left')
    // 横条里盒子更小，缩放跟着变，不需要别的参数
    const strip = await source.render(0, { width: 56, height: 72, dpr: 1 }, new AbortController().signal)
    expect((strip.firstElementChild as HTMLElement).style.transform).toBe(`scale(${56 / 816})`)
  })

  it('页不存在 / 已取消：拒绝，队列据此记失败或放弃', async () => {
    const source = createDomThumbSource({ pages: () => [], naturalSize: () => null, className: 'kbdocx' })
    await expect(source.render(3, { width: 144, height: 186, dpr: 1 }, new AbortController().signal)).rejects.toThrow('没有第 4 页')
    const controller = new AbortController()
    controller.abort()
    await expect(source.render(0, { width: 144, height: 186, dpr: 1 }, controller.signal)).rejects.toThrow()
  })

  it('文档重新渲染后 pages() 换了一批元素：下一次生成取新的那一批', async () => {
    let pages = [pageFrom(PAGE)]
    const source = createDomThumbSource({ pages: () => pages, naturalSize: () => ({ width: 816, height: 1056 }), className: 'kbdocx' })
    const first = await source.render(0, { width: 144, height: 186, dpr: 1 }, new AbortController().signal)
    expect(first.querySelector('header')?.textContent).toContain('页眉')
    pages = [pageFrom(PAGE.replace('页眉', '新页眉'))]
    const second = await source.render(0, { width: 144, height: 186, dpr: 1 }, new AbortController().signal)
    expect(second.querySelector('header')?.textContent).toContain('新页眉')
  })
})
