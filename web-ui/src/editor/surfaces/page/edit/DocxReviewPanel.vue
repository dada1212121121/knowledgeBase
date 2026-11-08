<script setup lang="ts">
/**
 * 审阅侧栏：评论 + 修订两个页签。
 *
 * 只负责显示与收集输入；所有动作都抛事件交给 Surface 里的控制器，控制器做权限 / 校验 / 刷新。
 * 只读时仍显示全部内容（查看者要能看评论和修订），但所有会改文档的控件不渲染——不是禁用后点了报错。
 */
import { computed, ref } from 'vue'
import { KbButton } from '@kb-ui/index'
import { commentPermissions, relativeTime, splitByState, type CommentThread, type CommentView } from './docx-comments'
import { previewText, summarizeByAuthor, type RevisionView } from './docx-revisions'

const props = defineProps<{
  tab: 'comments' | 'revisions'
  threads: readonly CommentThread[]
  revisions: readonly RevisionView[]
  editable: boolean
  /** 修订模式开着（之后的修改都记成修订） */
  tracking: boolean
  /** 操作失败的提示（引擎拒绝 / 校验不过） */
  notice: string
  busy: boolean
}>()
const emit = defineEmits<{
  'update:tab': [tab: 'comments' | 'revisions']
  close: []
  'add-comment': [text: string]
  reply: [parentId: string, text: string]
  resolve: [id: string, done: boolean]
  'remove-comment': [comment: CommentView]
  'remove-thread': [thread: CommentThread]
  'reveal-comment': [id: string]
  'reveal-revision': [id: string]
  decide: [id: string, accept: boolean]
  'decide-all': [accept: boolean]
  'toggle-tracking': []
  dismiss: []
}>()

const permissions = computed(() => commentPermissions(props.editable))
const groups = computed(() => splitByState(props.threads))
const showResolved = ref(false)
const draft = ref('')
const replyOpen = ref<string | null>(null)
const replyDraft = ref('')
const authors = computed(() => summarizeByAuthor(props.revisions))

function submitDraft(): void {
  const text = draft.value
  if (!text.trim()) return
  emit('add-comment', text)
  draft.value = ''
}

function submitReply(parentId: string): void {
  if (!replyDraft.value.trim()) return
  emit('reply', parentId, replyDraft.value)
  replyDraft.value = ''
  replyOpen.value = null
}

defineExpose({ focusDraft: () => document.querySelector<HTMLTextAreaElement>('[data-testid="docx-comment-draft"]')?.focus() })
</script>

<template>
  <aside class="kb-dex-review" data-testid="docx-review-panel" aria-label="审阅">
    <header class="kb-dex-review-head">
      <div class="kb-dex-review-tabs" role="tablist" aria-label="审阅内容">
        <button type="button" role="tab" class="kb-dex-review-tab" :class="{ 'is-active': tab === 'comments' }" :aria-selected="tab === 'comments'" data-testid="docx-tab-comments" @click="emit('update:tab', 'comments')">
          评论 <span class="mono">{{ threads.length }}</span>
        </button>
        <button type="button" role="tab" class="kb-dex-review-tab" :class="{ 'is-active': tab === 'revisions' }" :aria-selected="tab === 'revisions'" data-testid="docx-tab-revisions" @click="emit('update:tab', 'revisions')">
          修订 <span class="mono">{{ revisions.length }}</span>
        </button>
      </div>
      <button type="button" class="btn sm kb-ghost" aria-label="关闭审阅栏" data-testid="docx-review-close" @click="emit('close')">✕</button>
    </header>

    <div v-if="notice" class="kb-dex-review-notice" role="alert" data-testid="docx-review-notice">
      <span>{{ notice }}</span>
      <button type="button" class="btn sm kb-ghost" aria-label="知道了" @click="emit('dismiss')">知道了</button>
    </div>

    <!-- 评论 -->
    <div v-if="tab === 'comments'" class="kb-dex-review-body" role="tabpanel">
      <form v-if="permissions.canComment" class="kb-dex-comment-new" @submit.prevent="submitDraft">
        <textarea
          v-model="draft"
          class="kb-dex-review-input"
          rows="2"
          placeholder="先在文档里选中文字，再在这里写评论"
          aria-label="新评论"
          data-testid="docx-comment-draft"
          @keydown.ctrl.enter.prevent="submitDraft"
          @keydown.meta.enter.prevent="submitDraft"
        />
        <KbButton size="sm" variant="primary" type="submit" :disabled="busy || !draft.trim()" data-testid="docx-comment-submit">评论</KbButton>
      </form>

      <p v-if="!threads.length" class="kb-dex-review-empty" data-testid="docx-comments-empty">还没有评论</p>

      <ul class="kb-dex-threads">
        <li v-for="thread in groups.open" :key="thread.root.id" class="kb-dex-thread" :data-comment-id="thread.root.id" data-testid="docx-comment-thread">
          <button type="button" class="kb-dex-comment" @click="emit('reveal-comment', thread.root.id)">
            <span class="kb-dex-comment-meta"><strong>{{ thread.root.author }}</strong> · {{ relativeTime(thread.root.date) }}</span>
            <span class="kb-dex-comment-text" data-testid="docx-comment-text">{{ thread.root.text }}</span>
          </button>
          <ul v-if="thread.replies.length" class="kb-dex-replies">
            <li v-for="reply in thread.replies" :key="reply.id" class="kb-dex-reply" data-testid="docx-comment-reply">
              <span class="kb-dex-comment-meta"><strong>{{ reply.author }}</strong> · {{ relativeTime(reply.date) }}</span>
              <span class="kb-dex-comment-text">{{ reply.text }}</span>
              <button v-if="permissions.canDelete(reply)" type="button" class="btn sm kb-ghost" :aria-label="`删除 ${reply.author} 的回复`" @click="emit('remove-comment', reply)">删除</button>
            </li>
          </ul>
          <div v-if="permissions.canComment" class="kb-dex-thread-actions">
            <button type="button" class="btn sm" data-testid="docx-comment-reply-open" @click="replyOpen = replyOpen === thread.root.id ? null : thread.root.id">回复</button>
            <button v-if="permissions.canResolve" type="button" class="btn sm" data-testid="docx-comment-resolve" @click="emit('resolve', thread.root.id, true)">解决</button>
            <button v-if="permissions.canDelete(thread.root)" type="button" class="btn sm kb-ghost" data-testid="docx-comment-delete" @click="emit('remove-thread', thread)">删除</button>
          </div>
          <form v-if="replyOpen === thread.root.id" class="kb-dex-comment-new" @submit.prevent="submitReply(thread.root.id)">
            <textarea v-model="replyDraft" class="kb-dex-review-input" rows="2" placeholder="写回复" :aria-label="`回复 ${thread.root.author}`" data-testid="docx-comment-reply-draft" @keydown.ctrl.enter.prevent="submitReply(thread.root.id)" />
            <KbButton size="sm" variant="primary" type="submit" :disabled="busy || !replyDraft.trim()" data-testid="docx-comment-reply-submit">回复</KbButton>
          </form>
        </li>
      </ul>

      <section v-if="groups.resolved.length" class="kb-dex-resolved">
        <button type="button" class="kb-dex-resolved-toggle" :aria-expanded="showResolved" data-testid="docx-resolved-toggle" @click="showResolved = !showResolved">
          已解决 {{ groups.resolved.length }} {{ showResolved ? '▾' : '▸' }}
        </button>
        <ul v-if="showResolved" class="kb-dex-threads">
          <li v-for="thread in groups.resolved" :key="thread.root.id" class="kb-dex-thread is-resolved" :data-comment-id="thread.root.id" data-testid="docx-comment-resolved">
            <span class="kb-dex-comment-meta"><strong>{{ thread.root.author }}</strong> · {{ relativeTime(thread.root.date) }}</span>
            <span class="kb-dex-comment-text">{{ thread.root.text }}</span>
            <button v-if="permissions.canResolve" type="button" class="btn sm" data-testid="docx-comment-reopen" @click="emit('resolve', thread.root.id, false)">重新打开</button>
          </li>
        </ul>
      </section>
    </div>

    <!-- 修订 -->
    <div v-else class="kb-dex-review-body" role="tabpanel">
      <div v-if="editable" class="kb-dex-tracking">
        <label class="kb-dex-tracking-switch">
          <input type="checkbox" :checked="tracking" data-testid="docx-tracking-toggle" @change="emit('toggle-tracking')" />
          修订模式：之后的修改都记成修订
        </label>
      </div>
      <p v-if="!revisions.length" class="kb-dex-review-empty" data-testid="docx-revisions-empty">没有修订</p>
      <template v-else>
        <p class="kb-dex-review-summary" data-testid="docx-revisions-summary">{{ authors.map((item) => `${item.author} ${item.count} 处`).join('、') }}</p>
        <div v-if="editable" class="kb-dex-thread-actions">
          <button type="button" class="btn sm" :disabled="busy" data-testid="docx-accept-all" @click="emit('decide-all', true)">全部接受</button>
          <button type="button" class="btn sm" :disabled="busy" data-testid="docx-reject-all" @click="emit('decide-all', false)">全部拒绝</button>
        </div>
        <ul class="kb-dex-threads">
          <li v-for="revision in revisions" :key="revision.revisionId" class="kb-dex-thread" :data-kind="revision.kind" data-testid="docx-revision">
            <button type="button" class="kb-dex-comment" @click="emit('reveal-revision', revision.revisionId)">
              <span class="kb-dex-comment-meta">
                <span class="kb-dex-kind" :class="`is-${revision.kind}`">{{ revision.label }}</span>
                <strong>{{ revision.author }}</strong> · {{ relativeTime(revision.date) }}
              </span>
              <span class="kb-dex-comment-text">{{ previewText(revision.preview) }}</span>
            </button>
            <div v-if="editable" class="kb-dex-thread-actions">
              <button type="button" class="btn sm" :disabled="busy" data-testid="docx-revision-accept" @click="emit('decide', revision.revisionId, true)">接受</button>
              <button type="button" class="btn sm" :disabled="busy" data-testid="docx-revision-reject" @click="emit('decide', revision.revisionId, false)">拒绝</button>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.kb-dex-review {
  width: 300px;
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border-left: var(--hl) solid var(--border-subtle);
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
}
.kb-dex-review-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: var(--hl) solid var(--border-subtle);
}
.kb-dex-review-tabs {
  display: flex;
  gap: 4px;
}
.kb-dex-review-tab {
  padding: 4px 10px;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  cursor: pointer;
}
.kb-dex-review-tab.is-active {
  color: var(--text-primary);
  background: var(--surface-hover);
  font-weight: 600;
}
.kb-dex-review-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-dex-review-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  color: var(--text-primary);
  background: var(--accent-soft);
}
.kb-dex-comment-new {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}
.kb-dex-review-input {
  width: 100%;
  resize: vertical;
  padding: 6px 8px;
  color: var(--text-primary);
  background: var(--surface-1);
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
  font: inherit;
}
.kb-dex-review-empty,
.kb-dex-review-summary {
  margin: 0;
  color: var(--text-tertiary);
}
.kb-dex-threads,
.kb-dex-replies {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-dex-replies {
  margin-left: 12px;
  padding-left: 8px;
  border-left: 2px solid var(--border-subtle);
  gap: 6px;
}
.kb-dex-thread {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
}
.kb-dex-thread.is-resolved {
  opacity: 0.7;
}
.kb-dex-comment {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
}
.kb-dex-comment-meta {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
}
.kb-dex-comment-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.kb-dex-reply {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kb-dex-thread-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.kb-dex-resolved-toggle {
  padding: 4px 0;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.kb-dex-kind {
  margin-right: 6px;
  padding: 0 6px;
  border-radius: var(--r1);
  background: var(--surface-hover);
}
.kb-dex-kind.is-deletion {
  text-decoration: line-through;
}
.kb-dex-tracking-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
@media (max-width: 760px) {
  /* 手机：审阅栏盖在文档上方，不挤压页面 */
  .kb-dex-review {
    position: absolute;
    inset: 0 0 0 auto;
    width: min(88vw, 340px);
    z-index: 40;
    box-shadow: -4px 0 12px rgba(0, 0, 0, 0.2);
  }
}
</style>
