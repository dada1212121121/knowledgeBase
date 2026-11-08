<script setup lang="ts">
// 写评论 / 写回复的输入框:自己管草稿、发送中、就近的报错。
// 发送由父组件通过 `send` 完成(带上集合、来源、父评论等),失败就抛错:这里把原因写在输入框下面、不自动消失,
// 内容留在输入框里可以直接重试;成功才清空。
import { computed, nextTick, onMounted, ref } from 'vue'
import { KbButton, KbInput, isComposing } from '@kb-ui/index'
import { commentErrorText } from '@/utils/comments'
import { applyMention, candidateSourceLabel, extractMentions, filterCandidates, mentionQuery, type MentionCandidate } from '@/utils/mentions'

const props = withDefaults(
  defineProps<{
    /** 第二个参数是正文里 @ 到的用户名(不带 @);服务端只通知该通知的人,其余静默忽略 */
    send: (body: string, mentions: string[]) => Promise<void>
    /** 可 @ 的人。不传 / 为空 = 不提供 @(游客不能 @ 人)。候选只是方便输入,不是授权 */
    candidates?: MentionCandidate[]
    /** 测试钩子前缀:顶层评论 comment,回复 reply */
    name?: string
    label: string
    placeholder?: string
    submitText?: string
    /** 出现时自动聚焦(点「回复」展开的回复框) */
    autofocus?: boolean
    cancelable?: boolean
    /** 后端没有给评论设长度上限;2000 字只是防手滑(一次贴进整篇文章),不是后端规则 */
    maxLength?: number
  }>(),
  { name: 'comment', placeholder: '', submitText: '发表评论', autofocus: false, cancelable: false, maxLength: 2000, candidates: () => [] },
)
const emit = defineEmits<{ cancel: [] }>()

const draft = ref('')
const posting = ref(false)
const error = ref('')
const input = ref<{ $el: HTMLTextAreaElement } | null>(null)

const caret = ref(0)
const picked = ref(0)
const open = ref(true)
const query = computed(() => (props.candidates?.length && open.value ? mentionQuery(draft.value, caret.value) : null))
const options = computed(() => (query.value ? filterCandidates(props.candidates ?? [], query.value.query) : []))
function syncCaret(event: Event) {
  const el = event.target as HTMLTextAreaElement
  caret.value = el.selectionStart ?? el.value.length
  open.value = true
  picked.value = 0
}
function choose(candidate: MentionCandidate) {
  const at = query.value
  if (!at) return
  const next = applyMention(draft.value, at.start, caret.value, candidate.username)
  draft.value = next.text
  void nextTick(() => {
    const el = input.value?.$el
    el?.focus()
    el?.setSelectionRange(next.caret, next.caret)
    caret.value = next.caret
  })
}

const length = computed(() => Array.from(draft.value).length)
const tooLong = computed(() => length.value > props.maxLength)
const canSend = computed(() => !!draft.value.trim() && !tooLong.value && !posting.value)

async function submit() {
  if (!canSend.value) return
  posting.value = true
  error.value = ''
  try {
    const body = draft.value.trim()
    await props.send(body, extractMentions(body))
    draft.value = ''
  } catch (err) {
    error.value = commentErrorText(err, '评论没有发出去,请稍后再试。')
  } finally {
    posting.value = false
  }
}

function onKey(event: KeyboardEvent) {
  if (isComposing(event)) return
  if (options.value.length) {
    // 候选浮层开着:上下选、回车 / Tab 确认、Esc 只关浮层
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      picked.value = (picked.value + step + options.value.length) % options.value.length
      return
    }
    if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'Tab') {
      event.preventDefault()
      choose(options.value[picked.value]!)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      open.value = false
      return
    }
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void submit()
  } else if (event.key === 'Escape' && props.cancelable) {
    event.preventDefault()
    emit('cancel')
  }
}

onMounted(() => {
  if (props.autofocus) void nextTick(() => input.value?.$el.focus())
})
defineExpose({ focus: () => input.value?.$el.focus() })
</script>

<template>
  <form class="kb-cmt-form" :data-testid="`${name}-form`" @submit.prevent="submit">
    <KbInput
      ref="input"
      v-model="draft"
      multiline
      :placeholder="placeholder || `${label}(Ctrl + Enter 发送)`"
      :aria-label="label"
      :data-testid="`${name}-input`"
      @keydown="onKey"
      @keyup="syncCaret"
      @click="syncCaret"
      @input="syncCaret"
    />
    <ul v-if="options.length" class="kb-cmt-mentions" role="listbox" aria-label="提到谁" :data-testid="`${name}-mentions`">
      <li v-for="(candidate, at) in options" :key="candidate.id" role="option" :aria-selected="at === picked">
        <button type="button" class="kb-cmt-mention-opt" :class="{ 'is-on': at === picked }" :data-testid="`${name}-mention-${candidate.username}`" @mousedown.prevent="choose(candidate)">
          <b>{{ candidate.remark || candidate.display_name || candidate.username }}</b>
          <span>@{{ candidate.username }}</span>
          <small>{{ candidateSourceLabel(candidate.source) }}</small>
        </button>
      </li>
    </ul>
    <div class="kb-cmt-actions">
      <small :class="{ 'is-over': tooLong }">{{ tooLong ? `${length} / ${maxLength},太长了,请删减` : '' }}</small>
      <span class="kb-cmt-btns">
        <KbButton v-if="cancelable" size="sm" :data-testid="`${name}-cancel`" @click="emit('cancel')">取消</KbButton>
        <KbButton variant="primary" :size="cancelable ? 'sm' : 'md'" :disabled="!canSend" :data-testid="`${name}-send`" @click="submit">{{ posting ? '发送中…' : submitText }}</KbButton>
      </span>
    </div>
    <p v-if="error" class="kb-cmt-error" role="alert" :data-testid="`${name}-error`">{{ error }}</p>
  </form>
</template>
