/**
 * docx 只读渲染后端的纯函数测试（设计规范）：页、大纲、复制文本
 */
import { describe, expect, it } from 'vitest'
import { collectOutline, currentPage, DOCX_CLASS, fragmentToText, labelImages, pageElements, pageOfNode, repairShapes, revealPages, sanitizeLinks, SHOWN_CLASS, selectionClipboard, STAGING_CLASS } from './docx-read'

/** 搭一份 docx-preview 风格的 DOM：每页一个 section.kbdocx，页眉页脚是 section 里的 header / footer */
function build(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = `
  <section class="kbdocx"><header><p>公司名称</p></header>
    <p class="kbdocx_title">文档标题</p>
    <p class="kbdocx_heading1">第一章 概述</p>
    <p>正文第一段。</p>
    <table><tbody>
      <tr><td><p>姓名</p></td><td><p>年龄</p><p>(岁)</p></td></tr>
      <tr><td><p>张三</p></td><td><p>30</p></td></tr>
    </tbody></table>
    <footer><p>第 1 页</p></footer></section>
  <section class="kbdocx"><header><p>公司名称</p></header>
    <p class="kbdocx_heading2">1.1 背景</p>
    <p class="kbdocx_heading1">   </p>
    <p>正文第二页。</p>
    <footer><p>第 2 页</p></footer></section>`
  document.body.appendChild(host)
  return host
}

describe('页', () => {
  it('1. pageElements 按文档顺序返回 section；pageOfNode 从 1 起，不在页内为 0', () => {
    const host = build()
    const pages = pageElements(host)
    expect(pages).toHaveLength(2)
    expect(pageOfNode(host, pages[1]!.querySelector('p.kbdocx_heading2')!.firstChild)).toBe(2)
    expect(pageOfNode(host, host)).toBe(0)
    expect(pageOfNode(host, null)).toBe(0)
  })

  it('2. currentPage：视口中线落在哪页就是哪页，中线之下没有页取最后一页', () => {
    const host = build()
    const scroller = document.createElement('div')
    const [first, second] = pageElements(host)
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    scroller.getBoundingClientRect = () => rect(0, 400)
    first!.getBoundingClientRect = () => rect(-300, 150)
    second!.getBoundingClientRect = () => rect(160, 900)
    expect(currentPage(scroller, host)).toBe(2)
    first!.getBoundingClientRect = () => rect(-300, 250)
    expect(currentPage(scroller, host)).toBe(1)
    second!.getBoundingClientRect = () => rect(-900, -10)
    first!.getBoundingClientRect = () => rect(-1500, -1000)
    expect(currentPage(scroller, host)).toBe(2)
  })
})

describe('大纲', () => {
  const classes = new Map([
    ['kbdocx_title', 1],
    ['kbdocx_heading1', 1],
    ['kbdocx_heading2', 2],
  ])
  it('3. 按文档顺序收集标题段落，带页码；页眉页脚和空标题不收；级别最多到 4', () => {
    const host = build()
    expect(collectOutline(host, classes)).toEqual([
      { level: 1, text: '文档标题', page: 1 },
      { level: 1, text: '第一章 概述', page: 1 },
      { level: 2, text: '1.1 背景', page: 2 },
    ])
    expect(collectOutline(host, new Map([['kbdocx_heading1', 9]]))[0]!.level).toBe(4)
  })
  it('4. 没有标题样式表时大纲为空', () => {
    expect(collectOutline(build(), new Map())).toEqual([])
  })
})

describe('fragmentToText', () => {
  it('5. 段落一行；表格行一行、单元格用制表符，单元格里的多段并成一行', () => {
    const host = build()
    const text = fragmentToText(pageElements(host)[0]!.querySelector('table')!)
    expect(text).toBe('姓名\t年龄 (岁)\n张三\t30')
  })
  it('6. 空段落保留为空行，连续空行压成一个，首尾空行去掉', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p></p><p>甲</p><p></p><p></p><p></p><p>乙</p><p></p>'
    expect(fragmentToText(div)).toBe('甲\n\n乙')
  })
  it('7. br 换行', () => {
    const div = document.createElement('div')
    div.innerHTML = '<p>第一行<br>第二行</p>'
    expect(fragmentToText(div)).toBe('第一行\n第二行')
  })
})

describe('selectionClipboard', () => {
  it('8. 选一段正文：不带页眉页脚；保留表格形状；html 与纯文本都有', () => {
    const host = build()
    const page = pageElements(host)[0]!
    const range = document.createRange()
    range.setStartBefore(page.querySelector('p.kbdocx_heading1')!)
    range.setEndAfter(page.querySelector('footer')!)
    const clip = selectionClipboard(range, host)!
    expect(clip.text).toBe('第一章 概述\n正文第一段。\n姓名\t年龄 (岁)\n张三\t30')
    expect(clip.html).not.toContain('<footer')
    expect(clip.html).toContain('<table')
  })
  it('9. 整页都在选区里（全选）：页眉页脚一起复制', () => {
    const host = build()
    const range = document.createRange()
    range.selectNodeContents(host)
    const clip = selectionClipboard(range, host)!
    expect(clip.text).toContain('公司名称')
    expect(clip.text).toContain('第 2 页')
  })
  it('10. 选区折叠返回 null（交给浏览器默认行为）；选区整个在页眉里是有意复制页眉，保留', () => {
    const host = build()
    const range = document.createRange()
    range.setStart(host, 0)
    range.collapse(true)
    expect(selectionClipboard(range, host)).toBeNull()
    const head = document.createRange()
    head.selectNodeContents(pageElements(host)[0]!.querySelector('header')!)
    expect(selectionClipboard(head, host)!.text).toBe('公司名称')
  })
})

describe('labelImages', () => {
  it('12. 没有 alt 的图片补通用说明；已有 alt（含空串=装饰图）的不改', () => {
    const root = document.createElement('div')
    root.innerHTML = '<img id="a"><img id="b" alt="流程图"><img id="c" alt="">'
    labelImages(root)
    const alt = (id: string) => root.querySelector<HTMLImageElement>(`#${id}`)!.getAttribute('alt')
    expect(alt('a')).toBe('文档图片')
    expect(alt('b')).toBe('流程图')
    expect(alt('c')).toBe('')
  })
})

describe('sanitizeLinks', () => {
  it('11. 只放行 http(s) / mailto / 文内锚点；javascript: 去掉 href；外链强制 noopener', () => {
    const root = document.createElement('div')
    root.innerHTML = '<a id="a" href="https://x.test/">a</a><a id="b" href="javascript:alert(1)">b</a><a id="c" href="#sec">c</a><a id="d" href="mailto:a@b.c">d</a>'
    sanitizeLinks(root)
    const get = (id: string) => root.querySelector<HTMLAnchorElement>(`#${id}`)!
    expect(get('a').rel).toContain('noopener')
    expect(get('a').target).toBe('_blank')
    expect(get('b').hasAttribute('href')).toBe(false)
    expect(get('c').target).toBe('')
    expect(get('d').getAttribute('href')).toBe('mailto:a@b.c')
  })
})

describe('repairShapes（docx-preview 输出的形状补丁）', () => {
  /** 营养系统流程图里一个带文字的椭圆，原样取自 docx-preview 的输出结构 */
  const NODE = '<svg width="104" height="102"><ellipse cx="50%" cy="50%" rx="50%" ry="50%" fill="#4f81bd [3204]"><foreignObject width="100%" height="100%"><p><span>收费处清账医疗费</span></p></foreignObject></ellipse></svg>'

  it('填充色后面的 Word 主题索引被去掉，得到合法颜色', () => {
    const root = document.createElement('div')
    root.innerHTML = NODE
    const result = repairShapes(root)
    expect(root.querySelector('ellipse')!.getAttribute('fill')).toBe('#4f81bd')
    expect(result.colors).toBe(1)
  })

  it('stroke 也一样；命名色（red [12]）也处理', () => {
    const root = document.createElement('div')
    root.innerHTML = '<svg><path stroke="#385d8a [3204]" fill="red [12]"/></svg>'
    repairShapes(root)
    const path = root.querySelector('path')!
    expect(path.getAttribute('stroke')).toBe('#385d8a')
    expect(path.getAttribute('fill')).toBe('red')
  })

  it('文字框从图形里挪出来，和图形同级，文字内容不变——SVG 图形元素不能有子节点，留在里面浏览器不画', () => {
    const root = document.createElement('div')
    root.innerHTML = NODE
    const result = repairShapes(root)
    const ellipse = root.querySelector('ellipse')!
    expect(ellipse.querySelector('foreignObject')).toBeNull()
    expect(ellipse.nextElementSibling?.tagName.toLowerCase()).toBe('foreignobject')
    expect(root.querySelector('foreignObject')!.textContent).toBe('收费处清账医疗费')
    expect(result.textBoxes).toBe(1)
  })

  it('已经合法的结构不动：合法颜色不改，放在 <g> 里的文字框不挪', () => {
    const root = document.createElement('div')
    root.innerHTML = '<svg><g fill="#4f81bd"><foreignObject width="100%" height="100%"><p>x</p></foreignObject></g><rect fill="rgb(1, 2, 3)" stroke="none"/></svg>'
    const before = root.innerHTML
    const result = repairShapes(root)
    expect(root.innerHTML).toBe(before)
    expect(result).toEqual({ colors: 0, textBoxes: 0 })
  })

  it('不是"颜色 + 索引"形状的值不碰（防止误伤 url(#id)、渐变引用等）', () => {
    const root = document.createElement('div')
    root.innerHTML = '<svg><rect fill="url(#grad1)"/><rect fill="none"/><rect fill="#fff [x]"/><rect fill="[3204]"/></svg>'
    const before = root.innerHTML
    expect(repairShapes(root).colors).toBe(0)
    expect(root.innerHTML).toBe(before)
  })

  it('不在 svg 里的东西不碰（正文里恰好有 fill 属性的元素）', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p fill="red [1]">正文</p>'
    expect(repairShapes(root)).toEqual({ colors: 0, textBoxes: 0 })
    expect(root.querySelector('p')!.getAttribute('fill')).toBe('red [1]')
  })

  it('多个形状各自修，文档顺序不变', () => {
    const root = document.createElement('div')
    root.innerHTML = NODE + NODE.replace('收费处清账医疗费', '病区办理出院')
    expect(repairShapes(root)).toEqual({ colors: 2, textBoxes: 2 })
    expect([...root.querySelectorAll('foreignObject')].map((box) => box.textContent)).toEqual(['收费处清账医疗费', '病区办理出院'])
  })
})

describe('分阶段显示（revealPages）', () => {
  const hostWith = (pages: number, staging: boolean): HTMLElement => {
    const host = document.createElement('div')
    host.innerHTML = `<div class="kbdocx-wrapper">${Array.from({ length: pages }, () => `<section class="${DOCX_CLASS}"><p>页</p></section>`).join('')}</div>`
    if (staging) host.classList.add(STAGING_CLASS)
    return host
  }

  it('没带分阶段标记（页数少）：什么也不做，立刻完成', async () => {
    const host = hostWith(3, false)
    expect(await revealPages(host, () => false)).toBe(true)
    expect(host.querySelectorAll(`.${SHOWN_CLASS}`)).toHaveLength(0)
  })

  it('第一批同步显示；全部显示完才摘掉分阶段标记', async () => {
    const host = hostWith(10, true)
    const done = revealPages(host, () => false)
    // 同步部分：第一批（3 页）已经显示，整篇仍在分阶段
    expect(host.querySelectorAll(`.${SHOWN_CLASS}`)).toHaveLength(3)
    expect(host.classList.contains(STAGING_CLASS)).toBe(true)
    expect(await done).toBe(true)
    expect(host.querySelectorAll(`.${SHOWN_CLASS}`)).toHaveLength(10)
    expect(host.classList.contains(STAGING_CLASS)).toBe(false)
  })

  it('中途取消（换了文档 / 卸载）：返回 false，不再继续显示', async () => {
    const host = hostWith(12, true)
    let stop = false
    const done = revealPages(host, () => stop)
    stop = true
    expect(await done).toBe(false)
    expect(host.querySelectorAll(`.${SHOWN_CLASS}`).length).toBeLessThan(12)
  })
})
