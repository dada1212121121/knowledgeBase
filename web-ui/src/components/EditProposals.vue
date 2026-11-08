<script setup lang="ts">
// AI 的修改建议:AI 经 MCP 调 doc_edit 时默认只提建议,这里列出当前文档上还在等待的建议,
// 人逐条看「原文 → 新文字」再接受或拒绝。接受时服务端按文档当时的内容重新定位:
// 正在多人编辑就实时并进房间(编辑器自己会刷新),否则直接改存储里的正文并生成版本(通知页面重新加载)。
import { computed, onMounted, ref, watch } from 'vue'
import { KbButton } from '@kb-ui/index'
import { callCapability, CapabilityError } from '@/api/client'
import { useLiveEvents } from '@/composables/useLiveEvents'
import { timeAgo } from '@/utils/agent'

export interface EditProposal {
  id: string
  author: string
  note: string
  edits: Array<{ old: string; new: string }>
  status: 'pending' | 'accepted' | 'rejected' | 'failed'
  result?: string | null
  created_at: number
}

type Call = <T>(capability: string, args?: Record<string, unknown>) => Promise<T>

const props = defineProps<{
  /** 文件所在的集合(笔记不用) */
  collection?: string
  /** 文件相对路径 */
  path?: string
  /** 笔记 id(和 path 二选一) */
  noteId?: string
  /** 别人分享给我的文档:经 ShareAccess 调(带 X-KB-Space);缺省调自己的知识库 */
  call?: Call
}>()
const invoke: Call = (capability, args) => (props.call ? props.call(capability, args) : callCapability(capability, args))
const emit = defineEmits<{
  /** 建议被接受且没有并进房间(改的是存储里的正文):页面要重新加载内容 */
  applied: [live: boolean]
  /** 「在正文里找到」:页面在正文里选中这段原文并滚过去(返回找没找到由页面提示) */
  locate: [text: string]
}>()

const proposals = ref<EditProposal[]>([])
const open = ref(false)
const busy = ref('')
const message = ref('')

const target = computed(() => (props.noteId ? `note:${props.noteId}` : props.path ? `file:${props.path}` : ''))
const args = computed(() => (props.noteId ? { note_id: props.noteId } : { collection: props.collection, path: props.path }))
const pending = computed(() => proposals.value.filter((proposal) => proposal.status === 'pending'))

async function load() {
  if (!target.value) {
    proposals.value = []
    return
  }
  const asked = target.value
  try {
    const data = await invoke<{ proposals: EditProposal[] }>('doc_proposals', { ...args.value, status: 'pending' })
    if (asked === target.value) proposals.value = data.proposals ?? []
  } catch {
    // 列不出来(没有权限、文档刚删掉)就当没有建议,不打扰阅读
    if (asked === target.value) proposals.value = []
  }
}

async function decide(proposal: EditProposal, accept: boolean) {
  busy.value = proposal.id
  message.value = ''
  try {
    const result = await invoke<{ status: string; error?: string; live?: boolean }>('doc_proposal_decide', { id: proposal.id, accept })
    if (result.status === 'failed') {
      message.value = `没能应用:${result.error ?? '原文找不到了'}`
    } else if (accept) {
      emit('applied', !!result.live)
    }
  } catch (error) {
    message.value = error instanceof CapabilityError ? error.message : String(error)
  } finally {
    busy.value = ''
    await load()
  }
}

function who(author: string) {
  return author.startsWith('mcp:') ? `AI(${author.slice(4)})` : author.startsWith('agent') ? 'AI 助手' : author
}

onMounted(load)
watch(target, () => {
  open.value = false
  message.value = ''
  void load()
})
// 新建议 / 别处处理了建议:当前文档的就重新拉一次
useLiveEvents((event) => {
  if (event.type !== 'proposal.changed' || event.data.target !== target.value) return
  if (props.collection && !props.noteId && event.data.collection !== props.collection) return
  void load()
})

defineExpose({ reload: load })
</script>

<template>
  <section v-if="pending.length || message" class="kb-proposals" data-testid="edit-proposals" aria-label="AI 的修改建议">
    <div class="kb-proposals-bar">
      <span v-if="pending.length">AI 提了 {{ pending.length }} 条修改建议,接受后才会生效</span>
      <span v-if="message" class="kb-proposals-error" role="alert">{{ message }}</span>
      <KbButton v-if="pending.length" size="sm" :aria-expanded="open" @click="open = !open">{{ open ? '收起' : '查看' }}</KbButton>
    </div>
    <ol v-if="open && pending.length" class="kb-proposals-list">
      <li v-for="proposal in pending" :key="proposal.id" class="kb-proposal" :data-proposal="proposal.id">
        <div class="kb-proposal-head">
          <strong>{{ who(proposal.author) }}</strong>
          <span class="kb-hint">{{ timeAgo(proposal.created_at) }}</span>
          <span v-if="proposal.note" class="kb-proposal-note">{{ proposal.note }}</span>
        </div>
        <div v-for="(edit, index) in proposal.edits" :key="index" class="kb-proposal-edit">
          <del class="kb-proposal-old">{{ edit.old }}</del>
          <ins v-if="edit.new" class="kb-proposal-new">{{ edit.new }}</ins>
          <span v-else class="kb-hint">(删掉)</span>
          <!-- 先看看原文在哪儿、上下文是什么，再决定接不接受 -->
          <KbButton v-if="edit.old.trim()" size="sm" class="kb-proposal-locate" data-action="locate" @click="emit('locate', edit.old)">在正文里找到</KbButton>
        </div>
        <div class="kb-proposal-actions">
          <KbButton size="sm" variant="primary" :disabled="!!busy" data-action="accept" @click="decide(proposal, true)">接受</KbButton>
          <KbButton size="sm" :disabled="!!busy" data-action="reject" @click="decide(proposal, false)">拒绝</KbButton>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.kb-proposals {
  margin: 0 0 var(--sp-2);
  border: 1px solid var(--b);
  border-radius: var(--r2);
  background: var(--surface-1);
  padding: var(--sp-2) var(--sp-3);
}
.kb-proposals-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs);
}
.kb-proposals-error {
  color: var(--status-danger-text);
}
.kb-proposals-list {
  list-style: none;
  margin: var(--sp-2) 0 0;
  padding: 0;
  display: grid;
  gap: var(--sp-2);
  max-height: 40vh;
  overflow: auto;
}
.kb-proposal {
  border-top: 1px solid var(--b);
  padding-top: var(--sp-2);
  display: grid;
  gap: var(--sp-1);
}
.kb-proposal-head {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: baseline;
  font-size: var(--fs);
}
.kb-proposal-note {
  color: var(--text-secondary);
}
.kb-proposal-edit {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  font-size: var(--fs);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.kb-proposal-old {
  color: var(--status-danger-text);
  text-decoration: line-through;
}
.kb-proposal-new {
  color: var(--status-success-text);
  text-decoration: none;
}
.kb-proposal-actions {
  display: flex;
  gap: var(--sp-2);
}
</style>
