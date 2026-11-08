<script setup lang="ts">
// 申请权限（设计规范）:没有权限、或权限不够(只读想编辑)时,选申请的角色 + 附言发给所有者和「可管理」的人。
// 同一个人对同一份内容 24 小时内只能申请一次,被拉黑时后端表面上也是成功(不让对方知道被拉黑)——
// 所以「已发出」不代表对方一定收到,界面也不承诺别的,只说「对方处理后你会收到通知」。
import { computed, ref } from 'vue'
import { KbButton, KbDialog, KbInput, KbSelect, KbSheet, PHONE_QUERY, useMedia, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import { accessRequest, type GrantRole, type PublicProfile, type ShareTarget } from '@/api/share'
import { personName, requestableRoles, roleLabel, roleOptions, shareErrorText } from '@/utils/share'

const props = withDefaults(
  defineProps<{
    target: ShareTarget
    /** 内容的名字(标题 / 文件名) */
    title: string
    /** 我现在的角色;没有权限是 null */
    currentRole?: string | null
    /** 对方(所有者) */
    owner?: PublicProfile | null
    /** 默认选哪一档;不在可选范围里就退回可选的最高档 */
    initialRole?: GrantRole
  }>(),
  { currentRole: null, owner: null, initialRole: 'editor' },
)
const emit = defineEmits<{ close: []; sent: [role: GrantRole] }>()

const toast = useToast()
const phone = useMedia(PHONE_QUERY)

const MAX_MESSAGE = 200
const roles = computed(() => requestableRoles(props.currentRole))
const role = ref<GrantRole>(roles.value.includes(props.initialRole) ? props.initialRole : (roles.value[roles.value.length - 1] ?? 'viewer'))
const message = ref('')
const error = ref('')
const sending = ref(false)

const tooLong = computed(() => Array.from(message.value).length > MAX_MESSAGE)
const heading = computed(() => (props.currentRole ? '申请更高的权限' : '申请访问权限'))

async function send() {
  if (sending.value || tooLong.value || !roles.value.length) return
  sending.value = true
  error.value = ''
  try {
    await accessRequest(props.target, role.value, message.value)
    toast.push('申请已发出,对方处理后你会收到通知')
    emit('sent', role.value)
    emit('close')
  } catch (err) {
    // 24 小时内重复申请(403)、已经有这个权限(400)等,服务端的话本来就是写给人看的
    error.value = shareErrorText(err, '申请没有发出去,请稍后再试。')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <component :is="phone ? KbSheet : KbDialog" :title="heading" v-bind="phone ? {} : { width: '480px' }" @close="emit('close')">
    <form class="kb-req" data-testid="request-access" @submit.prevent="send">
      <p v-if="!roles.length" class="kb-req-note" data-testid="request-none">你已经有「{{ roleLabel(currentRole) }}」权限,这份内容不需要再申请。想要更高的权限,请直接联系所有者。</p>
      <template v-else>
        <div class="kb-req-to">
          <UserAvatar v-if="owner" :user-id="owner.id" :name="personName(owner)" :file="owner.avatar" :size="32" />
          <span>
            向 <b>{{ owner ? personName(owner) : '所有者' }}</b> 申请「{{ title }}」。<br />
            <span class="kb-req-sub">所有者和有「可管理」权限的人会收到通知,同意后你会收到结果。24 小时内同一份内容只能申请一次。</span>
          </span>
        </div>
        <label class="kb-req-field">
          想要的权限
          <KbSelect v-model="role" :options="roleOptions(roles)" aria-label="申请的权限" data-testid="request-role" />
        </label>
        <label class="kb-req-field">
          附言(可选)
          <KbInput v-model="message" multiline placeholder="说明一下为什么需要,例如:我在整理发布流程,需要补充回滚步骤" aria-label="附言" data-testid="request-message" />
          <small :class="{ 'is-over': tooLong }" role="status">{{ Array.from(message).length }} / {{ MAX_MESSAGE }}{{ tooLong ? ',太长了,请删减' : '' }}</small>
        </label>
        <p v-if="error" class="kb-req-error" role="alert" data-testid="request-error">{{ error }}</p>
      </template>
    </form>
    <template #footer>
      <KbButton @click="emit('close')">{{ roles.length ? '取消' : '知道了' }}</KbButton>
      <KbButton v-if="roles.length" variant="primary" :disabled="sending || tooLong" data-testid="request-send" @click="send">{{ sending ? '发送中…' : '发送申请' }}</KbButton>
    </template>
  </component>
</template>

<style>
.kb-req { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-req-to { display: flex; gap: var(--sp-3); align-items: flex-start; font-size: var(--text-14); line-height: var(--lh-body); }
.kb-req-sub { color: var(--text-tertiary); font-size: var(--text-12); }
.kb-req-field { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; font-size: var(--text-13); color: var(--text-secondary); }
.kb-req-field .kb-textarea { width: 100%; min-height: 88px; }
.kb-req-field small { color: var(--text-tertiary); font-size: var(--text-12); }
.kb-req-field small.is-over { color: var(--status-danger-text); }
.kb-req-error { margin: 0; color: var(--status-danger-text); font-size: var(--text-13); line-height: var(--lh-body); }
.kb-req-note { margin: 0; color: var(--text-secondary); font-size: var(--text-14); line-height: var(--lh-body); }
</style>
