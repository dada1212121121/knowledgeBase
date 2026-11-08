// 调试用:把一个页面的 DOM 归一化打印出来(去掉空白、内联样式值),便于和原型 HTML 逐块对比。
// 用法:node e2e/dump-dom.mjs <url>
import { chromium } from '@playwright/test'

const url = process.argv[2]
const browser = await chromium.launch({ chromiumSandbox: false })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'load' })
const html = await page.evaluate(() => {
  const walk = (node) => {
    if (node.nodeType === 3) {
      const text = node.textContent.trim()
      return text ? text : ''
    }
    if (node.nodeType !== 1) return ''
    const el = node
    const attrs = [...el.attributes]
      .filter((attr) => !['style', 'src', 'data-v-app'].includes(attr.name))
      .map((attr) => `${attr.name}="${attr.value}"`)
      .join(' ')
    const inner = [...el.childNodes].map(walk).join('')
    return `<${el.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}>${inner}</${el.tagName.toLowerCase()}>`
  }
  return walk(document.body)
})
console.log(html)
await browser.close()
