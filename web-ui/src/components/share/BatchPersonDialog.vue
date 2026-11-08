<script setup lang="ts">
// 「我的分享」里对选中的多项批量改某个人的角色 / 移除某个人（设计规范）。
// 只动他已经有权限的那几项:grant_batch 对没有授权的项会「新增」,而用户说的是「改 / 移除他的角色」,
// 不能顺手把他加到本来没分享给他的项上,所以只把他现有的那些项交给后端。
import { computed, ref } from 'vue'
import { KbButton, KbDialog, KbSelect, KbSheet, PHONE_QUERY, useMedia, useToast } from '@kb-ui/index'
import { grantBatch, type GrantRole, type SharedByMeItem } from '@/api/share'
import { granteesOf, personName, roleLabel, roleOptions, shareErrorText } from '@/utils/share'

const props = defineProps<{ mode: 'role' | 'remove'; items: SharedByMeItem[] }>()
const emit = defineEmits<{ close: []; done: [] }>()

const toast = useToast()
const phone = useMedia(PHONE_QUERY)

const people = computed(() => granteesOf(props.items))
const personId = ref(people.value[0]?.id ?? '')
const role = ref<GrantRole>('viewer')
const error = ref('')
const busy = ref(false)

const person = computed(() => people.value.find((entry) => entry.id === personId.value) ?? null)
/** 他在选中项里真正有权限的那几项(继承来的不算:那些要到上级里改) */
const affected = computed(() => props.items.filter((item) => item.grantees.some((row) => row.user.id === personId.value)))
const ROLE_CHOICES = roleOptions(['viewer', 'commenter', 'editor', 'manager'])

async function submit() {
  if (!person.value || !affected.value.length || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const targets = affected.value.map((item) => item.target)
    if (props.mode === 'role') await grantBatch(targets, [{ user_id: person.value.id, role: role.value }])
    else await grantBatch(targets, [{ user_id: person.value.id }])
    toast.push(props.mode === 'role' ? `已把 ${personName(person.value)} 在 ${targets.length} 项上的角色改为「${roleLabel(role.value)}」` : `已从 ${targets.length} 项里移除 ${personName(person.value)}`)
    emit('done')
    emit('close')
  } catch (err) {
    error.value = shareErrorText(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <component :is="phone ? KbSheet : KbDialog" :title="mode === 'role' ? '批量改角色' : '批量移除协作者'" v-bind="phone ? {} : { width: '480px' }" @close="emit('close')">
    <form class="kb-bpd" data-testid="batch-person" @submit.prevent="submit">
      <p v-if="!people.length" class="kb-bpd-note" data-testid="batch-person-none">选中的这些项都还没有协作者。</p>
      <template v-else>
        <label class="kb-bpd-field">
          改谁
          <KbSelect v-model="personId" :options="people.map((entry) => ({ value: entry.id, label: personName(entry) }))" aria-label="协作者" data-testid="batch-person-select" />
        </label>
        <label v-if="mode === 'role'" class="kb-bpd-field">
          改成
          <KbSelect v-model="role" :options="ROLE_CHOICES" aria-label="新角色" data-testid="batch-person-role" />
        </label>
        <p class="kb-bpd-note" data-testid="batch-person-scope">
          只改他已经有权限的 <b>{{ affected.length }}</b> / {{ items.length }} 项;其余的项他本来就没有权限,不会动。
          <template v-if="mode === 'remove'">移除后他会立刻失去通过这些项得到的权限(通过别的方式得到的不受影响)。</template>
        </p>
        <p v-if="error" class="kb-bpd-error" role="alert" data-testid="batch-person-error">{{ error }}</p>
      </template>
    </form>
    <template #footer>
      <KbButton @click="emit('close')">取消</KbButton>
      <KbButton v-if="people.length" :variant="mode === 'remove' ? 'danger' : 'primary'" :disabled="busy || !affected.length" data-testid="batch-person-submit" @click="submit">
        {{ busy ? '处理中…' : mode === 'remove' ? '移除' : '改角色' }}
      </KbButton>
    </template>
  </component>
</template>

<style>
.kb-bpd { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-bpd-field { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; font-size: var(--text-13); color: var(--text-secondary); }
.kb-bpd-note { margin: 0; font-size: var(--text-13); line-height: var(--lh-body); color: var(--text-secondary); }
.kb-bpd-note b { color: var(--text-primary); }
.kb-bpd-error { margin: 0; color: var(--status-danger-text); font-size: var(--text-13); line-height: var(--lh-body); }
</style>
