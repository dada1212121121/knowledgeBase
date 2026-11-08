#!/usr/bin/env node
// 生成使用指南的离线版本:单文件 HTML(截图内嵌)和 PDF。
//   npm run guide        (由 vite-node 运行,所以能直接引用 src 下的 .ts 和 @/ 别名)
// 输出:web-ui/public/guide/knowledgeBase-user-guide.html 与 .pdf
// 文件名用 ASCII:内置静态服务按百分号编码的路径查文件,中文名找不到;用户保存时的中文名由页面里的 download 属性给。
//
// 前置:截图已经在 public/guide/img/ 里(node e2e/guide-shots.mjs 生成)。
// 离线版固定包含 AI 相关的段落:文件是构建时生成一次的,不跟某个站点的 AI 总开关走。
import { chromium } from '@playwright/test'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renderGuide } from '../src/utils/guideDoc'
import { buildStandaloneHtml } from '../src/utils/guideExport'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'public/guide')
const HTML_FILE = join(OUT, 'knowledgeBase-user-guide.html')
const PDF_FILE = join(OUT, 'knowledgeBase-user-guide.pdf')

const source = await readFile(join(ROOT, '../docs/guide/USER_GUIDE.md'), 'utf8')
const articleCss = await readFile(join(ROOT, 'src/styles/guide.css'), 'utf8')

// 先把用到的截图都读成 data URL(渲染函数是同步的)
const images = new Map()
for (const match of source.matchAll(/\]\((img\/[A-Za-z0-9_-]+\.png)\)/g)) {
  const rel = match[1]
  if (!images.has(rel)) images.set(rel, `data:image/png;base64,${(await readFile(join(OUT, rel))).toString('base64')}`)
}

const rendered = renderGuide(source, {
  ai: true,
  resolveImage: (src) => {
    const url = images.get(src)
    if (!url) throw new Error(`指南引用了不存在的截图:${src}`)
    return url
  },
})
const html = buildStandaloneHtml({ title: rendered.title, bodyHtml: rendered.html, headings: rendered.headings, articleCss })
await mkdir(OUT, { recursive: true })
await writeFile(HTML_FILE, html)

const browser = await chromium.launch({ chromiumSandbox: false })
try {
  const page = await browser.newPage()
  await page.setContent(html, { waitUntil: 'load' })
  await page.pdf({
    path: PDF_FILE,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    // 页脚模板不继承页面样式,字号字体要自己写;汉字用系统里能找到的中文字体
    footerTemplate:
      `<div style="width:100%;font-size:9px;color:#6b6b74;text-align:center;font-family:'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif">` +
      `${rendered.title} · 第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>`,
  })
} finally {
  await browser.close()
}

const kb = async (file) => `${((await stat(file)).size / 1024).toFixed(0)} KB`
console.log(`✓ ${HTML_FILE.replace(`${ROOT}/`, '')} ${await kb(HTML_FILE)}`)
console.log(`✓ ${PDF_FILE.replace(`${ROOT}/`, '')} ${await kb(PDF_FILE)}`)
