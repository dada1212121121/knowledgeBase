<script setup lang="ts">
// 代码 / 文本 / Markdown 源码编辑器(CodeMirror 6,MIT)。
//   - 编辑与只读共用一个组件:行号、按扩展名高亮、折叠、查找替换、撤销重做、软换行开关;
//   - 颜色字号圆角全部取 kb-ui 的 CSS 变量(utils/editorTheme.ts),深浅色切换不重建;
//   - 手机:触屏下字号不小于 16px(避免 iOS 聚焦缩放)、关闭自动大写/纠错、工具栏按钮 ≥ 36px;
//   - Ctrl/Cmd+S 触发 save,Esc(没有查找面板时)让编辑器失焦,Tab 不会把键盘焦点锁死。
// 体积:核心约 300 kB,语言包按扩展名异步加载。页面里请用 defineAsyncComponent 引入。
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import { isMarkdownName, languageLabel, loadLanguage } from '@/utils/editorLanguage'
import { kbHighlight, kbTheme, zhPhrases } from '@/utils/editorTheme'
import type { CollabProvider } from '@/collab/provider'
import { TEXT_ROOT } from '@/collab/protocol'

const props = withDefaults(
  defineProps<{
    modelValue: string
    /** 文件名或路径:决定语法高亮;不传就是纯文本 */
    filename?: string
    readonly?: boolean
    toolbar?: boolean
    placeholder?: string
    /** 高亮并滚到的行区间(1 起,含两端),只读查看命中位置用 */
    highlightLines?: [number, number] | null
    ariaLabel?: string
    /** 多人在线编辑:内容来自这个连接里的 Y.Text,modelValue 只作初始占位 */
    collab?: CollabProvider | null
    /** 统一外壳里查找条属于 Host：关掉 CodeMirror 自带的 Ctrl+F 面板，避免两套查找状态 */
    externalFind?: boolean
  }>(),
  { collab: null, filename: '', readonly: false, toolbar: true, placeholder: '', highlightLines: null, ariaLabel: '代码编辑器', externalFind: false },
)
const emit = defineEmits<{
  'update:modelValue': [value: string]
  save: []
  focus: []
  blur: []
  /** 光标 / 选区：统一外壳据此把锚点交给 Session（行、列、选中文字） */
  selection: [payload: { line: number; column: number; from: number; to: number; text: string }]
}>()

const host = ref<HTMLElement | null>(null)
const view = shallowRef<EditorView | null>(null)

const language = new Compartment()
const wrapping = new Compartment()
const editing = new Compartment()
const tone = new Compartment()
const marks = new Compartment()

/* ---------- 软换行:用户选过就记住;没选过时 Markdown / 纯文本 / 窄屏默认换行,代码在宽屏默认不换 ---------- */
const WRAP_KEY = 'kb.editor.wrap'
function storedWrap(): boolean | null {
  try {
    const value = localStorage.getItem(WRAP_KEY)
    return value === null ? null : value === '1'
  } catch {
    return null
  }
}
function autoWrap(): boolean {
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 820px)').matches
  return narrow || isMarkdownName(props.filename) || !props.filename || languageLabel(props.filename) === '纯文本'
}
const userWrap = ref<boolean | null>(storedWrap())
const wrap = computed(() => userWrap.value ?? autoWrap())
function toggleWrap() {
  userWrap.value = !wrap.value
  try {
    localStorage.setItem(WRAP_KEY, userWrap.value ? '1' : '0')
  } catch {
    /* 隐私模式写不了就算了,本次会话内仍然生效 */
  }
}

/* ---------- 状态栏 ---------- */
const cursor = ref({ line: 1, col: 1 })
const stats = ref({ lines: 1, chars: 0 })
const canUndo = ref(false)
const canRedo = ref(false)
const label = computed(() => languageLabel(props.filename))

function isDark(): boolean {
  return document.documentElement.getAttribute('data-tone') !== 'light'
}

function lineMarks(range: [number, number] | null, state: EditorState) {
  if (!range) return []
  const total = state.doc.lines
  const from = Math.min(Math.max(1, range[0]), total)
  const to = Math.min(Math.max(from, range[1]), total)
  const out = []
  for (let line = from; line <= to; line += 1) out.push(Decoration.line({ class: 'kb-ce-hit' }).range(state.doc.line(line).from))
  return [EditorView.decorations.of(Decoration.set(out))]
}

let lastEmitted = props.modelValue
/** 父级主动替换内容(切文件 / 取消编辑)时置位:这类变化不回传 update:modelValue */
let applyingExternal = false
let languageToken = 0

function syncStatus(state: EditorState) {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  cursor.value = { line: line.number, col: head - line.from + 1 }
  stats.value = { lines: state.doc.lines, chars: state.doc.length }
  // 协作时撤销栈在 Yjs 里,按钮一直可点
  canUndo.value = props.collab ? true : undoDepth(state) > 0
  canRedo.value = props.collab ? true : redoDepth(state) > 0
}

async function applyLanguage() {
  const token = ++languageToken
  const support = await loadLanguage(props.filename)
  if (token !== languageToken || !view.value) return
  view.value.dispatch({ effects: language.reconfigure(support ?? []) })
}

function applyMarks() {
  const current = view.value
  if (current) current.dispatch({ effects: marks.reconfigure(lineMarks(props.highlightLines, current.state)) })
}

function scrollToHit() {
  const current = view.value
  if (!current || !props.highlightLines) return
  const line = Math.min(Math.max(1, props.highlightLines[0]), current.state.doc.lines)
  current.dispatch({ effects: EditorView.scrollIntoView(current.state.doc.line(line).from, { y: 'center' }) })
}

let toneObserver: MutationObserver | null = null
/** 协作时:没连上 / 内容没就绪 / 被降级只读,一律只读 */
const collabLocked = ref(!!props.collab)
let offCollabState: (() => void) | null = null
let collabUndo: { undo: () => unknown; redo: () => unknown } | null = null

onMounted(async () => {
  if (!host.value) return
  // 协作:内容以 Y.Text 为准。yCollab 要求编辑器初始内容和 Y.Text 当前内容一致,之后的同步它自己处理
  let collabExtensions: import('@codemirror/state').Extension[] = []
  let initialDoc = props.modelValue
  if (props.collab) {
    const provider = props.collab
    const [{ yCollab }, Y] = await Promise.all([import('y-codemirror.next'), import('yjs')])
    // 加载期间组件可能已经被卸载
    if (!host.value) return
    const ytext = provider.doc.getText(TEXT_ROOT)
    const undoManager = new Y.UndoManager(ytext)
    collabUndo = undoManager
    collabExtensions = [yCollab(ytext, provider.awareness, { undoManager })]
    initialDoc = ytext.toString()
    offCollabState = provider.subscribe((next) => {
      collabLocked.value = !(next.writable && (next.ready || next.everSynced))
      applyEditing()
    })
  }
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            // 页面级也监听 ⌘S;编辑器里按下时只走 save 事件,别让两条路径各存一次
            preventDefault: true,
            stopPropagation: true,
            run: () => {
              if (props.readonly) return false
              emit('save')
              return true
            },
          },
        ]),
      ),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      // 协作时撤销栈由 Yjs 管(只撤销自己的修改),不能再叠一个 CodeMirror 自己的 history
      props.collab ? [] : history(),
      foldGutter({ openText: '▾', closedText: '▸' }),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      props.externalFind ? [] : search({ top: true }),
      syntaxHighlighting(kbHighlight),
      keymap.of([
        ...defaultKeymap,
        ...(props.collab ? [] : historyKeymap),
        ...(props.externalFind ? [] : searchKeymap),
        ...foldKeymap,
        indentWithTab,
        // Esc:关掉查找面板后再按一次,让编辑器失焦(键盘用户借此离开,不被 Tab 锁住)
        { key: 'Escape', run: (target) => (target.contentDOM.blur(), true) },
      ]),
      EditorState.phrases.of(zhPhrases),
      EditorView.contentAttributes.of({
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
        'aria-label': props.ariaLabel,
      }),
      props.placeholder ? placeholderExt(props.placeholder) : [],
      kbTheme,
      language.of([]),
      wrapping.of(wrap.value ? EditorView.lineWrapping : []),
      editing.of(editingExtensions()),
      ...collabExtensions,
      tone.of(EditorView.darkTheme.of(isDark())),
      marks.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternal) {
          lastEmitted = update.state.doc.toString()
          emit('update:modelValue', lastEmitted)
        }
        if (update.docChanged || update.selectionSet) {
          syncStatus(update.state)
          const range = update.state.selection.main
          // 行/列按选区起点算（锚点要能落回开头；用 head 会把「选中三个字」记成第 4 列）
          const start = update.state.doc.lineAt(range.from)
          emit('selection', {
            line: start.number,
            column: range.from - start.from + 1,
            from: range.from,
            to: range.to,
            text: update.state.sliceDoc(range.from, range.to),
          })
        }
        if (update.focusChanged) {
          if (update.view.hasFocus) emit('focus')
          else emit('blur')
        }
      }),
    ],
  })
  view.value = new EditorView({ state, parent: host.value })
  syncStatus(state)
  applyMarks()
  void applyLanguage().then(scrollToHit)
  toneObserver = new MutationObserver(() => view.value?.dispatch({ effects: tone.reconfigure(EditorView.darkTheme.of(isDark())) }))
  toneObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tone'] })
})

onBeforeUnmount(() => {
  offCollabState?.()
  toneObserver?.disconnect()
  view.value?.destroy()
  view.value = null
})

watch(
  () => props.modelValue,
  (value) => {
    const current = view.value
    // 协作时内容以房间为准,父级传来的只是它自己跟踪的副本
    if (!current || props.collab || value === lastEmitted) return
    lastEmitted = value
    // 外部替换(切换文件、取消编辑):不进撤销栈,否则 Ctrl+Z 会撤回到上一个文件
    applyingExternal = true
    try {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      })
    } finally {
      applyingExternal = false
    }
  },
)
watch(() => props.filename, () => void applyLanguage())
watch(wrap, (value) => view.value?.dispatch({ effects: wrapping.reconfigure(value ? EditorView.lineWrapping : []) }))
function editingExtensions() {
  const locked = props.readonly || collabLocked.value
  return [EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]
}
function applyEditing() {
  view.value?.dispatch({ effects: editing.reconfigure(editingExtensions()) })
}
watch(() => props.readonly, applyEditing)
watch(
  () => props.highlightLines,
  () => {
    applyMarks()
    scrollToHit()
  },
  { deep: true },
)

function find() {
  const current = view.value
  if (!current) return
  openSearchPanel(current)
}
function doUndo() {
  if (collabUndo) collabUndo.undo()
  else if (view.value) undo(view.value)
  view.value?.focus()
}
function doRedo() {
  if (collabUndo) collabUndo.redo()
  else if (view.value) redo(view.value)
  view.value?.focus()
}
defineExpose({
  focus: () => view.value?.focus(),
  /** 给格式化工具栏用:拿到底层 EditorView */
  getView: () => view.value,
  getText: () => view.value?.state.doc.toString() ?? '',
  find,
  closeFind: () => view.value && closeSearchPanel(view.value),
  undo: doUndo,
  redo: doRedo,
  /** 软换行开关（外壳工具栏用；和自带工具栏的「换行」按钮是同一个状态，选择记在本机） */
  toggleWrap,
  isWrapping: () => wrap.value,
})
</script>

<template>
  <div class="kb-ce" :class="{ 'is-readonly': readonly }">
    <div v-if="toolbar" class="kb-ce-bar">
      <span class="mono kb-ce-lang">{{ label }}</span>
      <span v-if="readonly" class="tag kb-ce-ro">只读</span>
      <span class="kb-spacer"></span>
      <template v-if="!readonly">
        <button type="button" class="btn sm kb-ce-btn" :disabled="!canUndo" aria-label="撤销" title="撤销 (Ctrl/⌘ Z)" @click="doUndo">撤销</button>
        <button type="button" class="btn sm kb-ce-btn" :disabled="!canRedo" aria-label="重做" title="重做 (Ctrl/⌘ Shift Z)" @click="doRedo">重做</button>
      </template>
      <button type="button" class="btn sm kb-ce-btn" aria-label="查找" title="查找 (Ctrl/⌘ F)" @click="find">
        <KbIcon name="search" :size="12" /><span class="kb-ce-btn-text">查找</span>
      </button>
      <button type="button" class="btn sm kb-ce-btn" :class="{ ac: wrap }" :aria-pressed="wrap" title="软换行" @click="toggleWrap">换行</button>
    </div>
    <div ref="host" class="kb-ce-host"></div>
    <div v-if="toolbar" class="kb-ce-status mono">
      <span>第 {{ cursor.line }} 行,第 {{ cursor.col }} 列</span>
      <span class="kb-ce-status-more">{{ stats.lines }} 行 · {{ stats.chars }} 字符</span>
    </div>
  </div>
</template>

<style>
.kb-ce {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: calc(var(--row-h) * 8);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: var(--input-bg);
  overflow: hidden;
  transition: border-color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out);
}
.kb-ce:not(.is-readonly):focus-within {
  border-color: var(--ac);
}
.kb-ce.is-readonly {
  background: var(--surface-sunken);
}
.kb-ce-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: var(--hl) solid var(--b);
  background: var(--surface-1);
}
.kb-ce-lang {
  color: var(--m);
  font-size: calc(12px * var(--fs));
}
.kb-ce-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.kb-ce-host {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}
.kb-ce-host .cm-editor {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.kb-ce-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 10px;
  border-top: var(--hl) solid var(--b);
  background: var(--surface-1);
  color: var(--m);
  font-size: calc(11px * var(--fs));
  white-space: nowrap;
  overflow: hidden;
}
/* 触屏:字号 ≥16px 防 iOS 聚焦时缩放页面;按钮至少 44px(项目的触屏最小可点区域)。
   两个字的「换行」按钮宽度只有 ~42px,手机上「查找」只剩图标 36px,宽度也要补到 44 */
@media (pointer: coarse) {
  .kb-ce .cm-editor {
    font-size: calc(16px * var(--fs));
  }
  .kb-ce-btn {
    min-height: 44px;
    min-width: 44px;
    justify-content: center;
  }
  .kb-ce .cm-panel.cm-search input.cm-textfield,
  .kb-ce .cm-panel.cm-search button.cm-button {
    min-height: 36px;
    font-size: calc(16px * var(--fs));
  }
}
@media (max-width: 520px) {
  .kb-ce-btn-text,
  .kb-ce-status-more {
    display: none;
  }
}
</style>
