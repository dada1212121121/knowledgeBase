<script setup lang="ts">
/**
 * AI 写作条（UI-3）：工具栏下面的二级条，和表格工具条、查找条同一个位置——不跟着光标飘（e846e33f 的原则）。
 *
 * 只管显示和发事件：取选区、调后端、写回正文都在 Host（EditorHost）和内容面里。
 * - 空闲：润色 / 总结 / 翻译 / 续写四个快捷动作，外加「写下要求」输入框（回车生成）
 * - 生成中：一句状态 + 停止（丢弃这次结果）
 * - 有结果：替换类（润色 / 翻译 / 按要求改选中的）显示逐字对比；插入类（总结 / 续写 / 写一段）显示全文；
 *   按钮：替换选中 / 插入到下方 / 插入、重新生成、放弃
 * 结果在用户点按钮之前不会写进文档（和 AI 修改建议一样「先看再收」）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { AiApplyMode, AiWriteAction } from '../types'
import ToolIcon from './ToolIcon.vue'
import { namedToolIcon } from './toolIcons'
import { diffWords } from './aiDiff'

export interface AiWriterView {
  phase: 'idle' | 'running' | 'ready' | 'error'
  /** 最近一次运行的动作（重新生成用它） */
  action: AiWriteAction | null
  /** 「按要求写」最近一次的要求 */
  instruction: string
  /** 发起时有没有选中文字（决定能「替换」还是只能「插入」） */
  hasSelection: boolean
  /** 选中的原文（Markdown），替换类的对比用 */
  original: string
  result: string
  error: string
}

const props = defineProps<{ state: AiWriterView }>()
const emit = defineEmits<{
  run: [action: AiWriteAction, instruction?: string]
  apply: [mode: AiApplyMode]
  close: []
}>()

const QUICK: readonly { action: AiWriteAction; label: string; title: string }[] = [
  { action: 'polish', label: '润色', title: '润色选中的文字：改通顺、改准确，意思不变' },
  { action: 'summarize', label: '总结', title: '总结选中的内容，结果插到它下面' },
  { action: 'translate', label: '翻译', title: '中文译成英文，其它语言译成中文' },
  { action: 'continue', label: '续写', title: '接着光标前的内容往下写一两段' },
]

const instruction = ref(props.state.instruction)
const input = ref<HTMLInputElement | null>(null)
watch(
  () => props.state.instruction,
  (value) => (instruction.value = value),
)

/** 替换类动作：结果是要替换选中内容的（显示对比）；其余是插入（显示全文） */
const replacing = computed(() => props.state.hasSelection && (props.state.action === 'polish' || props.state.action === 'translate' || props.state.action === 'custom'))
const segments = computed(() => (replacing.value ? diffWords(props.state.original, props.state.result) : []))
/** 主按钮：替换类是「替换选中」，总结是「插入到下方」，没选中时是「插入」 */
const primary = computed<AiApplyMode>(() => (!props.state.hasSelection ? 'cursor' : replacing.value ? 'replace' : 'below'))
const runningLabel = computed(() => QUICK.find((item) => item.action === props.state.action)?.label ?? 'AI')

function submit(event?: KeyboardEvent) {
  // 输入法组字中的回车是上屏，不是提交
  if (event && (event.isComposing || event.keyCode === 229)) return
  event?.preventDefault()
  const text = instruction.value.trim()
  if (!text) return
  emit('run', 'custom', text)
}

function rerun() {
  if (props.state.action) emit('run', props.state.action, props.state.action === 'custom' ? props.state.instruction : undefined)
}

/** 打开时没有指定动作：焦点放进输入框，可以直接写要求 */
function focusInput() {
  void nextTick(() => input.value?.focus({ preventScroll: true }))
}
defineExpose({ focusInput })
</script>

<template>
  <div class="kb-editor-chrome-sub kb-ai-bar" role="group" aria-label="AI 写作" data-testid="editor-ai-bar" :data-phase="state.phase">
    <span class="kb-ai-bar-badge" aria-hidden="true"><ToolIcon :paths="namedToolIcon('sparkles')" :size="14" />AI</span>

    <template v-if="state.phase === 'idle' || state.phase === 'error'">
      <div class="kb-ai-bar-quick" role="group" aria-label="快捷动作">
        <button
          v-for="item in QUICK"
          :key="item.action"
          type="button"
          class="btn sm"
          :title="item.title"
          :data-ai-action="item.action"
          @mousedown.prevent
          @click="emit('run', item.action)"
        >
          {{ item.label }}
        </button>
      </div>
      <input
        ref="input"
        v-model="instruction"
        class="kb-ai-bar-input"
        type="text"
        enterkeyhint="send"
        placeholder="或者写下要求，例如：改成更正式的语气 / 写一段开头"
        aria-label="要 AI 做什么"
        data-testid="editor-ai-input"
        @keydown.enter="submit"
        @keydown.esc.prevent="emit('close')"
      />
      <button type="button" class="btn sm pri" :disabled="!instruction.trim()" data-testid="editor-ai-submit" @mousedown.prevent @click="submit()">生成</button>
      <p v-if="state.phase === 'error'" class="kb-ai-bar-error" role="alert" data-testid="editor-ai-error">{{ state.error }}</p>
    </template>

    <template v-else-if="state.phase === 'running'">
      <span class="kb-ai-bar-status" role="status" data-testid="editor-ai-running"><span class="kb-ai-bar-dot" aria-hidden="true"></span>正在{{ runningLabel === 'AI' ? '生成' : runningLabel }}…</span>
      <span class="kb-spacer"></span>
      <button type="button" class="btn sm" data-testid="editor-ai-stop" @mousedown.prevent @click="emit('close')">停止</button>
    </template>

    <template v-else>
      <div class="kb-ai-bar-preview" data-testid="editor-ai-preview" :class="{ 'is-diff': replacing }" tabindex="0" aria-label="AI 结果预览">
        <template v-if="replacing">
          <template v-for="(segment, index) in segments" :key="index">
            <del v-if="segment.kind === 'remove'" class="kb-ai-del">{{ segment.text }}</del>
            <ins v-else-if="segment.kind === 'add'" class="kb-ai-ins">{{ segment.text }}</ins>
            <span v-else>{{ segment.text }}</span>
          </template>
        </template>
        <template v-else>{{ state.result }}</template>
      </div>
      <div class="kb-ai-bar-actions">
        <button v-if="state.hasSelection" type="button" class="btn sm" :class="{ pri: primary === 'replace' }" data-testid="editor-ai-replace" @mousedown.prevent @click="emit('apply', 'replace')">替换选中</button>
        <button v-if="state.hasSelection" type="button" class="btn sm" :class="{ pri: primary === 'below' }" data-testid="editor-ai-below" @mousedown.prevent @click="emit('apply', 'below')">插入到下方</button>
        <button v-else type="button" class="btn sm pri" data-testid="editor-ai-insert" @mousedown.prevent @click="emit('apply', 'cursor')">插入</button>
        <button type="button" class="btn sm" data-testid="editor-ai-retry" @mousedown.prevent @click="rerun">重新生成</button>
        <button type="button" class="btn sm" data-testid="editor-ai-discard" @mousedown.prevent @click="emit('close')">放弃</button>
        <span class="kb-ai-bar-note">AI 生成，写进文档前请核对</span>
      </div>
    </template>

    <button type="button" class="btn sm kb-ghost kb-ai-bar-close" aria-label="关闭 AI 写作" data-testid="editor-ai-close" @mousedown.prevent @click="emit('close')">
      <ToolIcon :paths="namedToolIcon('close')" :size="12" />
    </button>
  </div>
</template>

<style scoped>
.kb-ai-bar {
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.kb-ai-bar-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-text);
  font-size: calc(12px * var(--fs));
  font-weight: 600;
}
.kb-ai-bar-quick {
  display: inline-flex;
  gap: 4px;
}
.kb-ai-bar-input {
  flex: 1 1 220px;
  min-width: 0;
  height: var(--ctl-h);
  padding: 0 10px;
  border: var(--hl) solid var(--control-line);
  border-radius: var(--r2);
  background: var(--surface-sunken);
  color: var(--text-primary);
  font: inherit;
  font-size: calc(13px * var(--fs));
}
.kb-ai-bar-input:focus-visible {
  outline: none;
  box-shadow: var(--accent-ring);
}
.kb-ai-bar-error {
  flex-basis: 100%;
  margin: 0;
  color: var(--status-danger-text);
  font-size: calc(13px * var(--fs));
}
.kb-ai-bar-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: calc(13px * var(--fs));
}
.kb-ai-bar-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: kb-ai-pulse var(--dur-page) var(--ease-in-out) infinite alternate;
}
@keyframes kb-ai-pulse {
  from {
    opacity: 0.35;
  }
  to {
    opacity: 1;
  }
}
.kb-ai-bar-preview {
  flex-basis: 100%;
  max-height: 220px;
  overflow: auto;
  padding: 8px 10px;
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r2);
  background: var(--surface-sunken);
  color: var(--text-primary);
  font-size: calc(14px * var(--fs));
  line-height: var(--lh-body, 1.65);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.kb-ai-del {
  color: var(--status-danger-text);
  text-decoration: line-through;
  background: color-mix(in srgb, var(--status-danger) 10%, transparent);
}
.kb-ai-ins {
  color: var(--status-success-text);
  text-decoration: none;
  background: color-mix(in srgb, var(--status-success) 12%, transparent);
}
.kb-ai-bar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.kb-ai-bar-note {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
}
.kb-ai-bar-close {
  margin-left: auto;
}
@media (prefers-reduced-motion: reduce) {
  .kb-ai-bar-dot {
    animation: none;
  }
}
</style>
