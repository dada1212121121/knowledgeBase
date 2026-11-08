// 当前打开的文档(UI-3):文档页登记,AI 助手读取。
//   - doc:助手的「当前页面」显示文档标题(不再显示「条目 ins_xxxx」),提问时附上可读引用让助手去读它;
//   - insert:正在编辑时登记「把一段 Markdown 插进正文光标处」,助手的回答就能一键插回文档;不在编辑时为 null。
//   - editor:正在编辑时登记可执行的编辑器动作与「保存 / 撤销」等宿主动作,给 ⌘K 命令面板用;
//     命令列表用函数而不是快照:外壳就绪前是空数组,就绪后同一次登记里就能列出全部动作。
// 只是页面之间的通知板:不持久化,文档页卸载 / 退出编辑时自己撤销登记。
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

export interface ActiveDoc {
  /** 笔记 id(文件没有) */
  noteId: string | null
  title: string
}

/** 命令面板里的一条编辑器命令(标签 / 快捷键由编辑器自己给,外壳只负责展示) */
export interface EditorPaletteCommand {
  id: string
  label: string
  hint?: string
  keywords?: string
}

export interface EditorPaletteBridge {
  /** 取当前可用的动作;函数形式保证工具栏过滤、只读 / 源码模式的最新状态被算进去 */
  commands: () => EditorPaletteCommand[]
  run: (id: string) => void | Promise<void>
}

export const useActiveDocStore = defineStore('activeDoc', () => {
  const doc = shallowRef<ActiveDoc | null>(null)
  const insert = shallowRef<((markdown: string) => Promise<boolean>) | null>(null)
  const editor = shallowRef<EditorPaletteBridge | null>(null)
  /** 登记;返回撤销函数(只撤自己登记的那一份,后来者登记的不受影响) */
  function register(next: ActiveDoc, inserter: ((markdown: string) => Promise<boolean>) | null): () => void {
    doc.value = next
    insert.value = inserter
    return () => {
      if (doc.value === next) {
        doc.value = null
        insert.value = null
      }
    }
  }
  /** 登记编辑器命令桥(正在编辑时才有):退出编辑 / 切换文档 / 卸载时撤销,别让面板列出打不出去的命令 */
  function registerEditor(bridge: EditorPaletteBridge): () => void {
    editor.value = bridge
    return () => {
      if (editor.value === bridge) editor.value = null
    }
  }
  return { doc, insert, editor, register, registerEditor }
})
