// 使用指南的离线版本(单文件 HTML,也是生成 PDF 的底稿)。纯函数:拿到渲染好的正文和样式表,拼出一个
// 不依赖网络、不依赖应用 CSS 的完整页面。真正读文件、跑浏览器的是 scripts/build-guide.ts。
import type { GuideHeading } from './guideDoc'

/**
 * 离线版没有应用的主题变量,这里补一份浅色色板(印出来更清楚)。
 * 变量名必须覆盖 styles/guide.css 里用到的全部变量,guideExport.spec.ts 会逐个核对。
 */
export const LIGHT_PALETTE = `:root {
  --t: #18181b;
  --t2: #52525b;
  --m: #6b6b74;
  --b2: rgba(0, 0, 0, 0.14);
  --hl: 1px;
  --surface-2: #f4f4f5;
  --surface-3: #ececee;
  --accent: #4f5bd5;
  --accent-text: #3a45b0;
  --accent-soft: rgba(79, 91, 213, 0.1);
  --status-warning: #c99a1e;
  --r-xs: 4px;
  --r1: 6px;
  --mono: ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Noto Sans Mono CJK SC', 'Noto Sans CJK SC', monospace;
}`

/** 中文优先的字体栈:macOS / Windows / Linux 上都有一个能显示汉字的 */
const FONT_STACK = `'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC', system-ui, sans-serif`

const PAGE_CSS = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 24px 16px 64px; background: #fff; color: var(--t); font: 15px/1.8 ${FONT_STACK}; }
.kb-guide-doc { max-width: 52em; margin: 0 auto; }
.kb-guide-cover { margin: 0 0 1.6em; padding-bottom: 1em; border-bottom: 2px solid var(--accent); }
.kb-guide-cover h1 { margin: 0 0 0.3em; font-size: 2em; }
.kb-guide-cover p { margin: 0; color: var(--m); }
.kb-guide-contents { margin: 0 0 2em; padding: 1em 1.4em; background: var(--surface-2); border-radius: var(--r1); }
.kb-guide-contents b { display: block; margin-bottom: 0.4em; }
.kb-guide-contents ol { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: 2em; }
.kb-guide-contents li { margin: 0.15em 0; break-inside: avoid; }
.kb-guide-contents li.is-sub { padding-left: 1.2em; font-size: 0.92em; }
.kb-guide-contents a { color: var(--t2); text-decoration: none; }
.kb-guide-contents a:hover { color: var(--accent-text); text-decoration: underline; }
@media (max-width: 640px) { .kb-guide-contents ol { columns: 1; } }
@media print {
  body { padding: 0; font-size: 12px; }
  .kb-guide-doc { max-width: none; }
  .kb-guide-contents { break-after: page; }
  .kb-guide-article h2 { break-before: auto; }
}
`

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface StandaloneInput {
  title: string
  /** `renderGuide` 渲染出来的正文,图片已经换成内嵌的 data URL */
  bodyHtml: string
  headings: GuideHeading[]
  /** styles/guide.css 的内容 */
  articleCss: string
}

/** 拼出完整的单文件页面:封面、目录、正文。不含任何脚本,也不引用任何外部资源。 */
export function buildStandaloneHtml({ title, bodyHtml, headings, articleCss }: StandaloneInput): string {
  // 正文第一行是一级标题,封面已经写了一遍,去掉正文里的,免得标题连着出现两次
  const body = bodyHtml.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>\s*/, '')
  const contents = headings
    .map((item) => `<li class="${item.level === 3 ? 'is-sub' : ''}"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`)
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${LIGHT_PALETTE}
${PAGE_CSS}
${articleCss}
</style>
</head>
<body>
<main class="kb-guide-doc">
<header class="kb-guide-cover">
<h1>${escapeHtml(title)}</h1>
<p>创建访问令牌、用 MCP 连接客户端、放进和更新内容。</p>
</header>
<nav class="kb-guide-contents" aria-label="目录">
<b>目录</b>
<ol>
${contents}
</ol>
</nav>
<article class="kb-guide-article">
${body}
</article>
</main>
</body>
</html>
`
}
