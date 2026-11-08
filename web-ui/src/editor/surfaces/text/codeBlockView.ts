/**
 * 代码块节点视图：语言选择、复制、流程图 / 公式预览
 *
 * 对应旧编辑器（Crepe 的 CodeMirror 功能）里代码块的用户可见部分：
 * - 顶部语言选择（可输入任意语言名，常用语言给候选）；
 * - 复制按钮；
 * - mermaid / LaTeX 块默认只显示渲染结果（previewOnlyByDefault），点“编辑源码”才露出源码，再点收起；
 * - 语法高亮由 codeHighlight.ts 的装饰负责，这里不管。
 *
 * 保存格式不受影响：节点仍是 code_block{language,kbMath}，序列化与协同房间格式都不变；
 * 头部与预览是 contenteditable=false 的附加 DOM，ProseMirror 不读它们（ignoreMutation / stopEvent）。
 */
import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorView, NodeViewConstructor } from 'prosemirror-view'
import { filterCodeLanguages } from './codeLanguages'
import { previewKind, renderLatex, renderMermaid } from './richPreview'

let seq = 0

export const codeBlockView: NodeViewConstructor = (node, view, getPos) => {
  const id = ++seq
  const dom = document.createElement('div')
  // kb-tok：语法高亮的颜色规则（tokens/browser.css 的 `.kb-tok .tok-*`，取 --code-* 变量），与文件浏览器 / 旧编辑器同一组
  dom.className = 'kb-code-block kb-tok'

  /* ---- 头部：语言 / 预览开关 / 复制 ---- */
  const head = document.createElement('div')
  head.className = 'kb-code-head'
  head.contentEditable = 'false'
  // 语言选择：输入框 + 自绘菜单。不用原生 datalist：它的弹层由浏览器画（深色主题下是一块白底），
  // 而且只列出和输入框里现有文字匹配的项，选了 bash 再点开就只剩 bash 一项
  const langBox = document.createElement('span')
  langBox.className = 'kb-code-langbox'
  const langInput = document.createElement('input')
  langInput.className = 'kb-code-lang'
  langInput.type = 'text'
  langInput.placeholder = '语言'
  langInput.setAttribute('aria-label', '代码语言')
  langInput.setAttribute('role', 'combobox')
  langInput.setAttribute('aria-expanded', 'false')
  langInput.setAttribute('aria-autocomplete', 'list')
  langInput.setAttribute('aria-controls', `kb-code-langs-${id}`)
  langInput.spellcheck = false
  langInput.autocomplete = 'off'
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  caret.setAttribute('class', 'kb-code-caret')
  caret.setAttribute('viewBox', '0 0 16 16')
  caret.setAttribute('width', '10')
  caret.setAttribute('height', '10')
  caret.setAttribute('aria-hidden', 'true')
  const caretPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  caretPath.setAttribute('d', 'M4 6l4 4 4-4')
  caretPath.setAttribute('fill', 'none')
  caretPath.setAttribute('stroke', 'currentColor')
  caretPath.setAttribute('stroke-width', '1.8')
  caretPath.setAttribute('stroke-linecap', 'round')
  caretPath.setAttribute('stroke-linejoin', 'round')
  caret.appendChild(caretPath)
  langBox.append(langInput, caret)
  const menu = document.createElement('div')
  menu.className = 'kb-code-langmenu'
  menu.id = `kb-code-langs-${id}`
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', '代码语言')
  menu.contentEditable = 'false'
  menu.hidden = true
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'kb-code-btn kb-code-toggle'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'kb-code-btn kb-code-copy'
  copy.textContent = '复制'
  copy.setAttribute('aria-label', '复制代码')
  head.append(langBox, toggle, copy)

  /* ---- 正文 + 预览 ---- */
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  pre.appendChild(code)
  const preview = document.createElement('div')
  preview.className = 'kb-code-preview'
  preview.contentEditable = 'false'
  preview.setAttribute('aria-label', '预览')
  dom.append(head, pre, preview, menu)

  let current = node
  /** 预览开着：mermaid / LaTeX 且内容非空时默认开，用户点“编辑源码”后关 */
  let previewing = false
  let userChoice: boolean | null = null
  let renderToken = 0

  const canPreview = () => previewKind(String(current.attrs.language ?? '')) !== null
  const wantPreview = () => canPreview() && (userChoice ?? current.textContent.trim().length > 0)

  async function paintPreview() {
    const token = ++renderToken
    const kind = previewKind(String(current.attrs.language ?? ''))
    const source = current.textContent
    if (!kind || !source.trim()) {
      preview.replaceChildren()
      return
    }
    const host = kind === 'mermaid' ? await renderMermaid(source) : await renderLatex(source, true)
    // 渲染是异步的：期间内容 / 语言又变了，丢弃过期结果
    if (token === renderToken) preview.replaceChildren(host)
  }

  function sync() {
    const lang = String(current.attrs.language ?? '')
    dom.dataset.language = lang
    langInput.dataset.committed = lang
    if (langInput.value !== lang && dom.ownerDocument.activeElement !== langInput) langInput.value = lang
    const next = wantPreview()
    previewing = next
    dom.classList.toggle('is-previewing', next)
    pre.hidden = next
    preview.hidden = !next
    toggle.hidden = !canPreview()
    toggle.textContent = next ? '编辑源码' : '预览'
    toggle.setAttribute('aria-pressed', String(!next))
    if (next) void paintPreview()
    copy.disabled = false
  }
  sync()

  /* ---- 交互 ---- */
  const setLanguage = (language: string) => {
    const pos = getPos()
    if (pos === undefined || !view.editable) return
    // 没变就不发事务（回车选项后失焦又会再提交一次，不能多出一步撤销）
    if (String(current.attrs.language ?? '') === language.trim()) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: language.trim() }))
  }
  langInput.addEventListener('change', () => setLanguage(langInput.value))

  /* ---- 语言菜单 ---- */
  let menuItems: string[] = []
  let activeIndex = -1
  let navigated = false
  const isMenuOpen = () => !menu.hidden
  function paintMenu() {
    menu.replaceChildren()
    const currentId = langInput.dataset.committed ?? ''
    menuItems = []
    for (const item of filterCodeLanguages(langInput.value)) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'kb-code-langitem'
      row.setAttribute('role', 'option')
      row.dataset.lang = item.id
      if (item.id.toLowerCase() === currentId.toLowerCase()) row.classList.add('is-current')
      const name = document.createElement('span')
      name.textContent = item.id
      row.appendChild(name)
      if (item.hint) {
        const hint = document.createElement('small')
        hint.textContent = item.hint
        row.appendChild(hint)
      }
      menu.appendChild(row)
      menuItems.push(item.id)
    }
    if (!menuItems.length) {
      const empty = document.createElement('div')
      empty.className = 'kb-code-langempty'
      empty.textContent = '没有这个语言，回车直接使用输入的名字'
      menu.appendChild(empty)
    }
  }
  function highlight(index: number) {
    activeIndex = index
    menu.querySelectorAll('.kb-code-langitem').forEach((el, at) => {
      el.classList.toggle('is-active', at === index)
      el.setAttribute('aria-selected', String(at === index))
      if (at === index) (el as HTMLElement).scrollIntoView?.({ block: 'nearest' })
    })
  }
  function placeMenu() {
    const rect = langInput.getBoundingClientRect()
    const room = window.innerHeight - rect.bottom
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 200))}px`
    if (room < 280 && rect.top > room) {
      menu.style.top = ''
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px`
    } else {
      menu.style.bottom = ''
      menu.style.top = `${rect.bottom + 4}px`
    }
  }
  function openMenu() {
    if (!view.editable) return
    paintMenu()
    menu.hidden = false
    langInput.setAttribute('aria-expanded', 'true')
    placeMenu()
    navigated = false
    // 当前语言在列表里就把它滚到可见位置并标出来
    highlight(menuItems.findIndex((item) => item.toLowerCase() === (langInput.dataset.committed ?? '').toLowerCase()))
  }
  function closeMenu() {
    menu.hidden = true
    langInput.setAttribute('aria-expanded', 'false')
    activeIndex = -1
  }
  function choose(language: string) {
    langInput.value = language
    closeMenu()
    setLanguage(language)
    view.focus()
  }

  langInput.addEventListener('focus', openMenu)
  langInput.addEventListener('click', () => (isMenuOpen() ? undefined : openMenu()))
  langInput.addEventListener('input', () => {
    if (!isMenuOpen()) openMenu()
    paintMenu()
    navigated = false
    highlight(menuItems.length ? 0 : -1)
  })
  caret.addEventListener('mousedown', (event) => {
    event.preventDefault()
    if (isMenuOpen()) closeMenu()
    else {
      langInput.focus()
      openMenu()
    }
  })
  // 点菜单项不能让输入框失焦（否则菜单先关了，click 就落空）
  menu.addEventListener('mousedown', (event) => event.preventDefault())
  menu.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.kb-code-langitem')
    if (row?.dataset.lang) choose(row.dataset.lang)
  })
  langInput.addEventListener('blur', () => {
    closeMenu()
    // 没选菜单项、直接打了字就离开：按输入的内容提交
    if (langInput.value.trim() !== (langInput.dataset.committed ?? '')) setLanguage(langInput.value)
  })
  langInput.addEventListener('keydown', (event) => {
    // 输入法组字中的回车 / 方向键是选词，不是菜单操作
    if (event.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!isMenuOpen()) return openMenu()
      if (!menuItems.length) return
      navigated = true
      const step = event.key === 'ArrowDown' ? 1 : -1
      highlight((activeIndex + step + menuItems.length) % menuItems.length)
      return
    }
    if (event.key === 'Escape' && isMenuOpen()) {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    // 回车：方向键选过项就用选中的；否则按输入框里的字提交（info string 本来就是自由文本）
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(navigated && activeIndex >= 0 ? menuItems[activeIndex]! : langInput.value)
    }
  })
  toggle.addEventListener('click', () => {
    userChoice = !previewing
    sync()
    if (!previewing) {
      // 露出源码后把光标放进去，直接就能改
      const pos = getPos()
      if (pos !== undefined) focusInside(view, pos)
    }
  })
  let copyTimer = 0
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(current.textContent)
      copy.textContent = '已复制'
    } catch {
      copy.textContent = '复制失败'
    }
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copy.textContent = '复制'), 1500)
  })
  // 头部按钮不抢焦点（点复制不应让编辑器失焦、选区消失）；语言输入框需要焦点所以不拦
  head.addEventListener('mousedown', (event) => {
    if (event.target !== langInput) event.preventDefault()
  })

  return {
    dom,
    contentDOM: code,
    update: (next: PMNode) => {
      if (next.type !== current.type) return false
      const textChanged = next.textContent !== current.textContent
      const langChanged = next.attrs.language !== current.attrs.language
      current = next
      if (langChanged) userChoice = null
      if (langChanged || textChanged) sync()
      return true
    },
    stopEvent: (event: Event) => event.target instanceof Node && (head.contains(event.target) || preview.contains(event.target) || menu.contains(event.target)),
    ignoreMutation: (mutation) => {
      if (mutation.type === 'selection') return false
      return !code.contains(mutation.target)
    },
    selectNode: () => dom.classList.add('ProseMirror-selectednode'),
    deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
    destroy: () => {
      menu.hidden = true
      window.clearTimeout(copyTimer)
      renderToken += 1
    },
  }
}

/** 把光标放进 pos 处代码块的正文开头 */
function focusInside(view: EditorView, pos: number): void {
  const inside = view.state.doc.resolve(Math.min(pos + 1, view.state.doc.content.size))
  view.dispatch(view.state.tr.setSelection(TextSelection.near(inside, 1)))
  view.focus()
}
