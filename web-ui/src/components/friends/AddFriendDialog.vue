<script setup lang="ts">
// 添加好友:按**完整**的用户名或邮箱找人(后端不做模糊搜索,每分钟最多 10 次),找到后可附一句话发申请。
//
// 隐私（设计规范）:
//   - 搜索结果只显示头像、昵称和用户名,不显示邮箱等别的东西;
//   - 找不到、对方不允许被搜到、对方拉黑了我,后端返回的结果完全一样,这里也只写同一句话,不去猜原因;
//   - 对方拉黑了我时,发申请后后端仍返回「已发送」,这里照实显示,不去核对对方列表里有没有这条申请。
import { computed, ref, watch } from 'vue'
import { KbButton, KbField, KbInput, KbTextarea, isComposing, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import FriendPanel from '@/components/friends/FriendPanel.vue'
import { friendRequest, friendSearch, type PublicProfile, type Relation, type RequestStatus } from '@/api/social'
import { useSessionStore } from '@/stores/session'
import { MAX_REQUEST_MESSAGE, charCount, displayName, hasControlChars, socialErrorText } from '@/utils/social'

const emit = defineEmits<{ close: []; sent: [status: RequestStatus] }>()

const session = useSessionStore()
const toast = useToast()

type Phase = 'form' | 'searching' | 'found' | 'notfound' | 'sent'
const query = ref('')
const phase = ref<Phase>('form')
const searchError = ref('')
const user = ref<PublicProfile | null>(null)
const relation = ref<Relation>('none')
const note = ref('')
const sending = ref(false)
const sendError = ref('')
const outcome = ref<RequestStatus | null>(null)

// 改了要找的人,上一次的结果就作废(免得对着旧结果的人发申请)
watch(query, () => {
  if (phase.value === 'found' || phase.value === 'notfound') phase.value = 'form'
  user.value = null
  searchError.value = ''
})

const trimmed = computed(() => query.value.trim())
const isSelf = computed(() => {
  const me = session.user
  const needle = trimmed.value.toLowerCase()
  return !!me && !!needle && (needle === me.username.toLowerCase() || needle === (me.email ?? '').toLowerCase())
})

async function search() {
  if (!trimmed.value || phase.value === 'searching') return
  searchError.value = ''
  if (isSelf.value) {
    searchError.value = '这是你自己的账号。请输入对方的用户名或邮箱。'
    return
  }
  phase.value = 'searching'
  try {
    const reply = await friendSearch(trimmed.value)
    user.value = reply.user
    relation.value = reply.relation
    note.value = ''
    sendError.value = ''
    phase.value = reply.user ? 'found' : 'notfound'
  } catch (err) {
    phase.value = 'form'
    searchError.value = socialErrorText(err, '没能完成搜索。请检查网络后重试。')
  }
}
function onEnter(event: KeyboardEvent) {
  // 中文输入法组字时的回车是选词,不是搜索
  if (!isComposing(event)) void search()
}

const noteError = computed(() => {
  if (charCount(note.value.trim()) > MAX_REQUEST_MESSAGE) return `附言最多 ${MAX_REQUEST_MESSAGE} 个字,请删短一些。`
  if (hasControlChars(note.value)) return '附言不能包含换行等特殊字符。'
  return ''
})

async function send() {
  const target = user.value
  if (!target || sending.value || noteError.value) return
  sending.value = true
  sendError.value = ''
  try {
    const reply = await friendRequest(target.id, note.value.trim() || undefined)
    outcome.value = reply.status
    phase.value = 'sent'
    emit('sent', reply.status)
    if (reply.status === 'friends') toast.push(`你和${displayName(target)}已经是好友了`)
  } catch (err) {
    sendError.value = socialErrorText(err, '没能发出申请。请稍后重试。')
  } finally {
    sending.value = false
  }
}

function again() {
  query.value = ''
  note.value = ''
  user.value = null
  outcome.value = null
  phase.value = 'form'
}

const RESULT_TEXT: Record<RequestStatus, string> = {
  requested: '申请已发送。对方通过后你们就是好友了,申请 7 天内有效。',
  friends: '对方之前也向你发过申请,你们现在已经是好友了。',
  already_friends: '你们已经是好友了。',
  already_pending: '你已经向对方发过申请了,请等对方处理。',
}
// 能发申请的关系只有「没关系」和「对方先向我申请了」(后者发申请就等于通过)
const canSend = computed(() => phase.value === 'found' && (relation.value === 'none' || relation.value === 'pending_in'))
</script>

<template>
  <FriendPanel title="添加好友" @close="emit('close')">
    <div class="kb-af" data-testid="add-friend">
      <template v-if="phase !== 'sent'">
        <KbField label="对方的用户名或邮箱" hint="需要输入完整的用户名或邮箱,不支持模糊搜索。" :error="searchError" v-slot="{ id, describedby, invalid }">
          <div class="kb-af-search">
            <KbInput
              :id="id"
              v-model="query"
              :aria-describedby="describedby"
              :aria-invalid="invalid"
              placeholder="例如 user_yi 或 name@example.com"
              maxlength="254"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              enterkeyhint="search"
              data-testid="add-friend-query"
              @keydown.enter="onEnter"
            />
            <KbButton :disabled="!trimmed || phase === 'searching'" data-testid="add-friend-search" @click="search">{{ phase === 'searching' ? '搜索中…' : '搜索' }}</KbButton>
          </div>
        </KbField>

        <p v-if="phase === 'notfound'" class="m kb-af-note" role="status" data-testid="add-friend-notfound">
          没有找到这个用户。请确认输入的是完整的用户名或邮箱;对方也可能设置了不被搜索。
        </p>

        <div v-if="phase === 'found' && user" class="kb-af-found" data-testid="add-friend-found">
          <div class="kb-af-who">
            <UserAvatar :user-id="user.id" :name="displayName(user)" :file="user.avatar" :size="48" />
            <div class="kb-af-name">
              <b>{{ displayName(user) }}</b>
              <span class="m">@{{ user.username }}</span>
            </div>
          </div>
          <p v-if="relation === 'friend'" class="kb-af-state" data-testid="add-friend-state">你们已经是好友了。</p>
          <p v-else-if="relation === 'pending_out'" class="kb-af-state" data-testid="add-friend-state">你已经向对方发过申请了,请等对方处理。</p>
          <template v-else>
            <p v-if="relation === 'pending_in'" class="kb-af-state" data-testid="add-friend-state">对方已经向你发来好友申请,同意后你们就是好友了。</p>
            <KbField v-else label="附言(选填)" :error="noteError" :hint="`${charCount(note.trim())} / ${MAX_REQUEST_MESSAGE}`" v-slot="{ id, describedby, invalid }">
              <KbTextarea :id="id" v-model="note" :rows="2" placeholder="让对方知道你是谁,例如:我是上周的同事" :aria-describedby="describedby" :aria-invalid="invalid" data-testid="add-friend-note" />
            </KbField>
          </template>
          <p v-if="sendError" class="kb-af-error" role="alert">{{ sendError }}</p>
        </div>
      </template>

      <div v-else class="kb-af-done" role="status" data-testid="add-friend-done">
        <b>{{ outcome === 'requested' ? '申请已发送' : '已处理' }}</b>
        <p class="m">{{ outcome ? RESULT_TEXT[outcome] : '' }}</p>
      </div>
    </div>

    <template #footer>
      <template v-if="phase === 'sent'">
        <KbButton @click="again">继续添加</KbButton>
        <KbButton variant="primary" @click="emit('close')">完成</KbButton>
      </template>
      <template v-else>
        <KbButton @click="emit('close')">{{ phase === 'found' && !canSend ? '关闭' : '取消' }}</KbButton>
        <KbButton v-if="canSend" variant="primary" :disabled="sending || !!noteError" data-testid="add-friend-send" @click="send">
          {{ sending ? '发送中…' : relation === 'pending_in' ? '同意并加为好友' : '发送申请' }}
        </KbButton>
      </template>
    </template>
  </FriendPanel>
</template>

<style scoped>
.kb-af { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
.kb-af-search { display: flex; gap: var(--sp-2); min-width: 0; }
.kb-af-search :deep(.kb-input) { flex: 1 1 auto; min-width: 0; }
.kb-af-note { margin: 0; }
.kb-af-found { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); border: var(--hl) solid var(--b); border-radius: var(--r2); min-width: 0; }
.kb-af-who { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.kb-af-name { display: flex; flex-direction: column; min-width: 0; }
.kb-af-name b, .kb-af-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-af-name b { font-size: var(--text-16); font-weight: var(--fw-title); }
.kb-af-state { margin: 0; }
.kb-af-error { margin: 0; color: var(--status-danger-text); }
.kb-af-done { display: flex; flex-direction: column; gap: var(--sp-2); }
.kb-af-done p { margin: 0; }
.kb-af-done b { font-size: var(--text-16); font-weight: var(--fw-title); }
</style>
