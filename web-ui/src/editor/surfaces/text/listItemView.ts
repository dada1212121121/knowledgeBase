/**
 * 列表项节点视图：任务项的复选框可点击
 *
 * 为什么必须是节点视图：schema 的 toDOM 只能“渲染”一个 `<input type=checkbox>`，点它时浏览器只改了 DOM 的勾选态，
 * ProseMirror 的文档并不知道——保存出来的还是 `[ ]`，刷新就丢；旧编辑器（Crepe 的 ListItem）点复选框会写回 `checked` 属性，
 * 这是任务列表最基本的用法，不能少。
 *
 * DOM 结构与 schema.toDOM 保持一致（li[data-checked] > input + div.kb-task-line），样式、复制粘贴行为不变。
 * 普通列表项不走这里（返回原生 li）：`update` 里发现 checked 从有到无（或相反）就返回 false 让 ProseMirror 重建。
 */
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeViewConstructor } from 'prosemirror-view'
import { toggleTaskItemAt } from './commands'

export const taskListItemView: NodeViewConstructor = (node, view, getPos) => {
  // 普通项：原样 li，正文直接写在里面（与 toDOM 一致）
  if (node.attrs.checked == null) {
    const li = document.createElement('li')
    return { dom: li, contentDOM: li, update: (next: PMNode) => next.type === node.type && next.attrs.checked == null }
  }

  const li = document.createElement('li')
  const box = document.createElement('input')
  box.type = 'checkbox'
  const line = document.createElement('div')
  line.className = 'kb-task-line'
  li.append(box, line)

  const paint = (current: PMNode) => {
    li.dataset.checked = String(current.attrs.checked)
    box.checked = !!current.attrs.checked
    // 复选框本身没有可见文字：用条目正文做可访问名称，读屏才能说出「哪件事已完成」
    box.setAttribute('aria-label', current.textContent || '任务')
  }
  paint(node)

  /**
   * 点击：让浏览器自己先切换勾选态，再通过命令把文档改成同样的值（进撤销栈、协同里同步给别人）。
   * 不能 preventDefault：复选框的 click 被取消后，浏览器会在处理完事件时把勾选态**恢复成点击前的值**，
   * 刚被 paint 写成新值的复选框就又变回旧的，界面和文档对不上。只有不可编辑时才拦下，让它保持原样。
   */
  const onClick = (event: Event) => {
    if (!view.editable) {
      event.preventDefault()
      return
    }
    toggle(view, getPos)
  }
  // 复选框不应该把光标挪走 / 抢焦点：编辑器里点它只是切换状态
  const onMouseDown = (event: Event) => event.preventDefault()
  box.addEventListener('click', onClick)
  box.addEventListener('mousedown', onMouseDown)

  return {
    dom: li,
    contentDOM: line,
    update: (next: PMNode) => {
      if (next.type !== node.type || next.attrs.checked == null) return false
      node = next
      paint(next)
      return true
    },
    // 复选框上的事件由这里处理，不交给 ProseMirror（否则会把点击当成选区操作）
    stopEvent: (event: Event) => event.target === box,
    ignoreMutation: (mutation) => mutation.target === box || mutation.target === li,
    destroy: () => {
      box.removeEventListener('click', onClick)
      box.removeEventListener('mousedown', onMouseDown)
    },
  }
}

/** 只读（含协同房间还没就绪）时不允许改：与正文不可编辑同一条规矩 */
function toggle(view: EditorView, getPos: () => number | undefined) {
  if (!view.editable) return
  const pos = getPos()
  if (pos === undefined) return
  toggleTaskItemAt(pos)(view.state, (tr) => view.dispatch(tr))
}
