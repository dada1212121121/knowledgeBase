/**
 * 行内公式节点视图：渲染 KaTeX，点一下就地编辑
 *
 * 旧编辑器（Crepe 的 Latex 功能）把 `$E=mc^2$` 渲染成公式，点击后弹出输入框改源码；
 * 新文本面之前只显示 `$…$` 源码（“阅读态才渲染”），编辑时看不到公式长什么样，是退步。
 * 节点本身不变（math_inline{value}，保存仍写 `$value$`，房间格式不变），这里只改显示与编辑方式。
 */
import type { Node as PMNode } from 'prosemirror-model'
import type { NodeViewConstructor } from 'prosemirror-view'
import { renderLatex } from './richPreview'

export const mathInlineView: NodeViewConstructor = (node, view, getPos) => {
  let current = node
  let editing = false
  let token = 0
  const dom = document.createElement('span')
  dom.className = 'kb-text-math'
  dom.dataset.type = 'math_inline'
  dom.contentEditable = 'false'

  async function paint() {
    const mine = ++token
    const value = String(current.attrs.value ?? '')
    dom.dataset.value = value
    dom.title = value
    // 先放源码占位：KaTeX 是异步加载的，加载期间（或加载失败）至少看得到内容
    dom.textContent = `$${value}$`
    if (!value.trim()) return
    const rendered = await renderLatex(value, false)
    if (mine === token && !editing) dom.replaceChildren(rendered)
  }
  void paint()

  const commit = (value: string) => {
    const pos = getPos()
    editing = false
    if (pos === undefined) return
    const next = value.trim()
    // 清空 = 删掉这个公式
    const tr = next ? view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, value: next }) : view.state.tr.delete(pos, pos + current.nodeSize)
    view.dispatch(tr)
    view.focus()
  }

  const edit = () => {
    if (editing || !view.editable) return
    editing = true
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'kb-text-math-input'
    input.value = String(current.attrs.value ?? '')
    input.setAttribute('aria-label', '公式（LaTeX）')
    input.spellcheck = false
    input.addEventListener('keydown', (event) => {
      // 组字中的回车是上屏，不是确认
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') {
        event.preventDefault()
        commit(input.value)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        editing = false
        void paint()
        view.focus()
      }
    })
    input.addEventListener('blur', () => editing && commit(input.value))
    dom.replaceChildren(input)
    input.focus()
    input.select()
  }
  dom.addEventListener('click', (event) => {
    event.preventDefault()
    edit()
  })

  return {
    dom,
    update: (next: PMNode) => {
      if (next.type !== current.type) return false
      const changed = next.attrs.value !== current.attrs.value
      current = next
      if (changed && !editing) void paint()
      return true
    },
    stopEvent: (event: Event) => editing && event.target instanceof Node && dom.contains(event.target),
    ignoreMutation: () => true,
    destroy: () => {
      token += 1
    },
  }
}
