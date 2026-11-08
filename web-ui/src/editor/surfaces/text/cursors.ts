/**
 * 光标辅助插件：gap cursor / drop cursor / 空文档占位提示
 *
 * - gap cursor：光标落不进去的位置（文档开头 / 末尾紧挨着表格、分割线、代码块，两个相邻块之间）
 *   没有它就没法在那里继续写字——少了它「文末是表格」的笔记没法接着写；
 * - drop cursor：拖动块 / 文件时显示落点的竖线；
 * - 占位提示：整篇文档为空时在第一行显示“输入正文，输入 / 唤出插入菜单”（与旧编辑器同一句话）。
 *
 * gapcursor / dropcursor 是 package.json 的直接依赖（之前经 Milkdown 的 prose 再导出取，Milkdown 已卸载）。
 */
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export const EMPTY_DOC_PLACEHOLDER = '输入正文，输入 / 唤出插入菜单'

/** 整篇文档只有一个空段落时，给这个段落加占位提示（CSS 的 ::before 读 data-placeholder） */
export function placeholderPlugin(text: string, editable: () => boolean): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const { doc } = state
        if (!editable() || doc.childCount !== 1) return null
        const only = doc.firstChild
        if (!only || only.type.name !== 'paragraph' || only.content.size > 0) return null
        return DecorationSet.create(doc, [Decoration.node(0, only.nodeSize, { class: 'kb-text-empty', 'data-placeholder': text })])
      },
    },
  })
}

export function cursorPlugins(): Plugin[] {
  // dropCursor 的颜色走 CSS 变量：不写字面色值（check-tokens 约束），主题切换自动跟随
  return [gapCursor(), dropCursor({ color: 'var(--accent)', width: 2 })]
}
