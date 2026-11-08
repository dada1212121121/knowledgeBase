/**
 * 流程图（mermaid）与公式（KaTeX）的渲染
 *
 * 与旧编辑器一致：两者都是**按需加载**——笔记里没有流程图 / 公式就不下载 mermaid（≈ 数 MB）和 KaTeX；
 * 渲染失败不抛出，返回一个带原因的错误元素（旧编辑器同样“语法有误：…”一行）。
 * mermaid 用 `securityLevel: 'strict'`，SVG 由它生成后才插入，不执行笔记里的任何脚本。
 */

import { mermaidFailureText } from '@/utils/chunkError'

let mermaidSeq = 0

function errorBox(className: string, message: string): HTMLElement {
  const box = document.createElement('div')
  box.className = `${className} is-error`
  box.textContent = message
  return box
}

/** 把 mermaid 源码渲染成图；失败返回错误元素（保留源码由调用方决定） */
export async function renderMermaid(source: string): Promise<HTMLElement> {
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: document.documentElement.getAttribute('data-tone') === 'light' ? 'default' : 'dark',
      fontFamily: 'inherit',
    })
    const { svg } = await mermaid.render(`kb-text-mermaid-${++mermaidSeq}`, source)
    const host = document.createElement('div')
    host.className = 'kb-mermaid'
    host.innerHTML = svg
    return host
  } catch (error) {
    return errorBox('kb-mermaid', mermaidFailureText(error))
  }
}

let katexReady: Promise<typeof import('katex')> | null = null

/** 渲染公式；display = 块级居中。语法有误时 KaTeX 在 throwOnError:false 下自己把源码标红，不会抛 */
export async function renderLatex(source: string, display: boolean): Promise<HTMLElement> {
  try {
    const { default: katex } = await (katexReady ??= import('katex').then(async (mod) => {
      await import('katex/dist/katex.min.css')
      return mod
    }))
    const host = document.createElement(display ? 'div' : 'span')
    host.className = display ? 'kb-math-block' : 'kb-math-inline'
    host.innerHTML = katex.renderToString(source, { displayMode: display, throwOnError: false, trust: false })
    return host
  } catch (error) {
    return errorBox('kb-math-block', `公式渲染失败:${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 这个代码块语言有没有预览：mermaid 与 LaTeX（含 `$$` 公式块，语言就是 LaTeX） */
export function previewKind(language: string): 'mermaid' | 'latex' | null {
  const lang = language.trim().toLowerCase()
  if (lang === 'mermaid') return 'mermaid'
  if (lang === 'latex' || lang === 'math' || lang === 'tex') return 'latex'
  return null
}
