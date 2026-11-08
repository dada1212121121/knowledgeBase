<script setup lang="ts">
/**
 * Code Surface 的视图层
 *
 * 只做三件事：把现有 CodeEditor 搬进统一外壳、把光标/选区翻译成 Surface 事件、把查找/撤销暴露给命令层。
 * CodeMirror 的配置、语言包、主题完全复用 `components/CodeEditor.vue`，不在这里重写扩展，
 * 否则「行为不变」就成了一句空话——两套配置迟早会漂移。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { EditorView } from '@codemirror/view'
import CodeEditor from '@/components/CodeEditor.vue'
import type { CollabProvider } from '@/collab/provider'

const props = withDefaults(
  defineProps<{
    /** 打开时的显示文本（已归一化成 LF） */
    initialText: string
    /** 文件名 / 路径：决定语法高亮 */
    filename?: string
    /** 只读（PDF 之外的代码查看也走这里） */
    readonly?: boolean
    /** 多人编辑：CodeEditor 自己绑房间的 Y.Text、别人的光标与只撤自己的撤销 */
    collab?: CollabProvider | null
  }>(),
  { filename: '', readonly: false, collab: null },
)

const emit = defineEmits<{
  change: [text: string]
  selection: [payload: { line: number; column: number; from: number; to: number; text: string }]
}>()

/** 局部只读开关：命令层可以随时改，不需要重建整个 Vue 应用 */
const localReadonly = ref(props.readonly)
watch(() => props.readonly, (value) => (localReadonly.value = value))

const editor = ref<InstanceType<typeof CodeEditor> | null>(null)
/** 由控制器在 mount 时注入：CodeMirror 的 Mod-s 只发事件，真正保存仍由 Host 会话负责 */
let saveRequest: (() => void) | null = null
const view = () => editor.value?.getView() ?? null
function getView() {
  return view()
}

function requestSave() {
  saveRequest?.()
}
function setSaveRequest(handler: (() => void) | null) {
  saveRequest = handler
}
onBeforeUnmount(() => {
  saveRequest = null
})

function getText(): string {
  return editor.value?.getText() ?? props.initialText
}
function setReadonly(value: boolean) {
  localReadonly.value = value
}
function focus() {
  editor.value?.focus()
}
function undo() {
  editor.value?.undo()
}
function redo() {
  editor.value?.redo()
}
function toggleWrap() {
  editor.value?.toggleWrap()
}
function isWrapping(): boolean {
  return editor.value?.isWrapping() ?? false
}
/** 跳到某一行并选中该行（搜索命中 / 代码锚点共用） */
function revealLine(line: number) {
  const current = view()
  if (!current) return
  const target = Math.min(Math.max(1, Math.round(line)), current.state.doc.lines)
  const info = current.state.doc.line(target)
  current.dispatch({ selection: { anchor: info.from, head: info.from } })
  current.dispatch({ effects: EditorView.scrollIntoView(info.from, { y: 'center' }) })
  current.focus()
}
function selectAll() {
  const current = view()
  if (!current) return
  current.dispatch({ selection: { anchor: 0, head: current.state.doc.length } })
  current.focus()
}
/** 按文档偏移选中区间（查找命中用；CodeMirror 的位置就是字符串下标） */
function selectRange(from: number, to: number) {
  const current = view()
  if (!current) return
  const length = current.state.doc.length
  const start = Math.min(Math.max(0, from), length)
  const end = Math.min(Math.max(start, to), length)
  current.dispatch({ selection: { anchor: start, head: end } })
  current.dispatch({ effects: EditorView.scrollIntoView(start, { y: 'center' }) })
  current.focus()
}
function getScrollTop(): number {
  return view()?.scrollDOM.scrollTop ?? 0
}
function setScrollTop(value: number) {
  const current = view()
  if (current) current.scrollDOM.scrollTop = value
}

defineExpose({ getText, setReadonly, focus, undo, redo, toggleWrap, isWrapping, revealLine, selectAll, selectRange, getScrollTop, setScrollTop, getView, setSaveRequest })
</script>

<template>
  <div class="kb-code-surface" data-testid="code-surface">
    <CodeEditor
      ref="editor"
      :model-value="initialText"
      :filename="filename"
      :collab="collab"
      :toolbar="false"
      :readonly="localReadonly"
      external-find
      aria-label="文件内容"
      @update:model-value="emit('change', $event)"
      @selection="emit('selection', $event)"
      @save="requestSave"
    />
  </div>
</template>

<style>
.kb-code-surface {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.kb-code-surface .kb-ce {
  border: 0;
  border-radius: 0;
  min-height: 0;
}
/* 统一外壳自己管状态栏与工具栏，代码面只保留编辑区 */
.kb-code-surface .kb-ce-host {
  height: 100%;
}
</style>
