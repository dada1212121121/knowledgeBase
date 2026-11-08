<script setup lang="ts">
// 好友详情面板:改备注名和分组(只改我这一边,对方看到的不变)、删除好友。
// 备注和分组的上限、控制字符规则与后端一致(kb-core/src/social.rs),前端先拦一遍,错误就近显示在输入框下面。
import { computed, ref } from 'vue'
import { KbButton, KbField, KbInput, isComposing, useConfirm, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import FriendPanel from '@/components/friends/FriendPanel.vue'
import type { Friend } from '@/api/social'
import { useFriendsStore } from '@/stores/friends'
import { MAX_GROUP, MAX_REMARK, blockConfirmText, charCount, friendSubtitle, friendTitle, hasControlChars, socialErrorText } from '@/utils/social'

const props = defineProps<{ friend: Friend; groups: string[] }>()
const emit = defineEmits<{ close: [] }>()

const store = useFriendsStore()
const confirm = useConfirm()
const toast = useToast()

const remark = ref(props.friend.remark ?? '')
const group = ref(props.friend.group_name ?? '')
const saving = ref(false)
const error = ref('')

const remarkError = computed(() => {
  if (charCount(remark.value.trim()) > MAX_REMARK) return `备注名最多 ${MAX_REMARK} 个字,请删短一些。`
  if (hasControlChars(remark.value)) return '备注名不能包含换行等特殊字符。'
  return ''
})
const groupError = computed(() => {
  if (charCount(group.value.trim()) > MAX_GROUP) return `分组名最多 ${MAX_GROUP} 个字,请删短一些。`
  if (hasControlChars(group.value)) return '分组名不能包含换行等特殊字符。'
  return ''
})
const dirty = computed(() => remark.value.trim() !== (props.friend.remark ?? '') || group.value.trim() !== (props.friend.group_name ?? ''))
const canSave = computed(() => dirty.value && !remarkError.value && !groupError.value && !saving.value)

async function save() {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  try {
    await store.updateFriend(props.friend.id, { remark: remark.value, group_name: group.value })
    toast.push('已保存')
    emit('close')
  } catch (err) {
    error.value = socialErrorText(err, '没能保存备注。请稍后重试。')
  } finally {
    saving.value = false
  }
}
function onEnter(event: KeyboardEvent) {
  // 中文输入法组字时的回车是选词,不是提交
  if (isComposing(event)) return
  void save()
}

async function remove() {
  const name = friendTitle(props.friend)
  const ok = await confirm.ask({
    title: `删除好友「${name}」?`,
    message: '删除后你们不再是好友,对方也会从他的好友列表里看不到你。已经分享的内容不会被收回,需要的话到对应文档的分享设置里移除对方。之后想再联系,要重新发好友申请。',
    confirmText: '删除好友',
    tone: 'danger',
    doneText: '已删除',
    action: () => store.removeFriend(props.friend.id),
  })
  if (ok) emit('close')
}

async function block() {
  const ok = await confirm.ask({ ...blockConfirmText(friendTitle(props.friend)), action: () => store.block(props.friend.id) })
  if (ok) emit('close')
}
</script>

<template>
  <FriendPanel title="好友" @close="emit('close')">
    <div class="kb-fm" data-testid="friend-manage">
      <div class="kb-fm-who">
        <UserAvatar :user-id="friend.id" :name="friend.display_name || friend.username" :file="friend.avatar" :size="48" />
        <div class="kb-fm-name">
          <b>{{ friendTitle(friend) }}</b>
          <span class="m">{{ friendSubtitle(friend) }}</span>
        </div>
      </div>

      <KbField label="备注名" :error="remarkError" :hint="`只有你看得到,最多 ${MAX_REMARK} 个字`" v-slot="{ id, describedby, invalid }">
        <KbInput :id="id" v-model="remark" :aria-describedby="describedby" :aria-invalid="invalid" placeholder="例如:产品部的小林" autocomplete="off" @keydown.enter="onEnter" />
      </KbField>
      <KbField label="分组" :error="groupError" :hint="`用来归类好友,最多 ${MAX_GROUP} 个字`" v-slot="{ id, describedby, invalid }">
        <KbInput :id="id" v-model="group" list="kb-fm-groups" :aria-describedby="describedby" :aria-invalid="invalid" placeholder="例如:同事" autocomplete="off" @keydown.enter="onEnter" />
      </KbField>
      <datalist id="kb-fm-groups"><option v-for="name in groups" :key="name" :value="name" /></datalist>

      <p v-if="error" class="kb-fm-error" role="alert">{{ error }}</p>

      <div class="kb-fm-danger">
        <span class="m">不想再保持好友关系?</span>
        <span class="kb-fm-danger-actions">
          <KbButton variant="danger" size="sm" data-testid="friend-remove" @click="remove">删除好友</KbButton>
          <KbButton variant="danger" size="sm" data-testid="friend-block" @click="block">拉黑</KbButton>
        </span>
      </div>
    </div>
    <template #footer>
      <KbButton @click="emit('close')">取消</KbButton>
      <KbButton variant="primary" :disabled="!canSave" data-testid="friend-save" @click="save">{{ saving ? '保存中…' : '保存' }}</KbButton>
    </template>
  </FriendPanel>
</template>

<style scoped>
.kb-fm { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
.kb-fm-who { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.kb-fm-name { display: flex; flex-direction: column; min-width: 0; }
.kb-fm-name b, .kb-fm-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-fm-name b { font-size: var(--text-16); font-weight: var(--fw-title); }
.kb-fm-error { margin: 0; color: var(--status-danger-text); }
.kb-fm-danger-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.kb-fm-danger { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; padding-top: var(--sp-4); border-top: var(--hl) solid var(--b); }
</style>
