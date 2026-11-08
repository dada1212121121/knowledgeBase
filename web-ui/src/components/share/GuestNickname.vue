<script setup lang="ts">
// 游客的昵称:默认是「访客 + 4 位编号」,可以自己改一个(1–20 字,不含 < >)。评论和修改会记在这个名字名下,
// 所有者能在审计里认出是哪个访客。名字存在服务端(按游客 cookie),换设备不会跟着走。
import { nextTick, ref } from 'vue'
import { KbButton, KbInput, isComposing, useToast } from '@kb-ui/index'
import { publicRename } from '@/api/share'
import { validateNickname } from '@/utils/publicShare'
import { shareErrorText } from '@/utils/share'

const props = defineProps<{ token: string; nickname: string }>()
const emit = defineEmits<{ renamed: [nickname: string] }>()

const toast = useToast()
const editing = ref(false)
const draft = ref('')
const error = ref('')
const busy = ref(false)
const input = ref<HTMLElement | null>(null)

async function start() {
  draft.value = props.nickname
  error.value = ''
  editing.value = true
  await nextTick()
  input.value?.querySelector('input')?.focus()
}
async function save() {
  if (busy.value) return
  const problem = validateNickname(draft.value)
  if (problem) {
    error.value = problem
    return
  }
  busy.value = true
  error.value = ''
  try {
    const done = await publicRename(props.token, draft.value.trim())
    emit('renamed', done.nickname)
    editing.value = false
    toast.push(`现在你是「${done.nickname}」`)
  } catch (err) {
    error.value = shareErrorText(err, '改名没有成功,请稍后再试。')
  } finally {
    busy.value = false
  }
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !isComposing(event)) {
    event.preventDefault()
    void save()
  } else if (event.key === 'Escape') {
    editing.value = false
  }
}
</script>

<template>
  <span class="kb-guest" data-testid="guest-nickname">
    <template v-if="!editing">
      <span class="kb-guest-name" data-testid="guest-name">{{ nickname }}</span>
      <button type="button" class="kb-guest-edit" data-testid="guest-rename" @click="start">改名</button>
    </template>
    <form v-else class="kb-guest-form" @submit.prevent="save">
      <span ref="input" class="kb-guest-input"><KbInput v-model="draft" placeholder="1–20 个字" aria-label="你的昵称" data-testid="guest-input" @keydown="onKey" /></span>
      <KbButton size="sm" variant="primary" :disabled="busy" data-testid="guest-save" @click="save">保存</KbButton>
      <KbButton size="sm" :disabled="busy" @click="editing = false">取消</KbButton>
      <span v-if="error" class="kb-guest-error" role="alert" data-testid="guest-error">{{ error }}</span>
    </form>
  </span>
</template>

<style>
.kb-guest { display: inline-flex; align-items: center; gap: var(--sp-2); min-width: 0; flex-wrap: wrap; }
.kb-guest-name { font-size: var(--text-13); color: var(--text-primary); max-width: 12em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-guest-edit { border: 0; background: none; padding: 0 var(--sp-1); color: var(--accent-text, var(--accent)); font: inherit; font-size: var(--text-13); text-decoration: underline; cursor: pointer; }
.kb-guest-edit:focus-visible { outline: none; box-shadow: var(--accent-ring); }
.kb-guest-form { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; min-width: 0; }
.kb-guest-input { display: inline-block; width: 12em; max-width: 100%; }
.kb-guest-input .kb-input { width: 100%; }
.kb-guest-error { flex-basis: 100%; color: var(--status-danger-text); font-size: var(--text-12); }
@media (pointer: coarse) { .kb-guest-edit { min-height: 44px; min-width: 44px; } }
</style>
