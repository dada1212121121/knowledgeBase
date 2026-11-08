<script setup lang="ts">
// 「新建经验」表单(聊天里的 @insight 用)。写当前项目;没有项目就写 _global。
import { ref } from 'vue'
import { KbButton, KbDialog, KbFormRow, KbInput, KbSegmented, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'

const props = defineProps<{
  open: boolean
  project: string
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()
const title = ref('')
const body = ref('')
const kind = ref('note')
const saving = ref(false)

const kinds = [
  { value: 'note', label: '笔记' },
  { value: 'howto', label: '做法' },
  { value: 'decision', label: '决策' },
  { value: 'pitfall', label: '坑' },
  { value: 'convention', label: '约定' },
]

async function save() {
  if (!title.value.trim() || !body.value.trim() || saving.value) return
  saving.value = true
  try {
    await callCapability('save_insight', {
      title: title.value.trim(),
      body: body.value.trim(),
      kind: kind.value,
      project: props.project || undefined,
      global: !props.project,
    })
    toast.push('经验已保存')
    title.value = ''
    body.value = ''
    emit('saved')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : '保存失败', 'danger')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <KbDialog v-if="open" title="新建经验" :subtitle="project ? `写入项目 ${project}` : '写入 _global'" @close="emit('close')">
    <KbFormRow label="标题">
      <KbInput v-model="title" placeholder="一句话说清" />
    </KbFormRow>
    <KbFormRow label="正文">
      <textarea v-model="body" class="kb-insight-body" rows="6" placeholder="markdown,写清背景 / 做法 / 结论" />
    </KbFormRow>
    <KbFormRow label="种类">
      <KbSegmented v-model="kind" :options="kinds" />
    </KbFormRow>
    <template #footer>
      <span class="kb-spacer"></span>
      <KbButton @click="emit('close')">取消</KbButton>
      <KbButton variant="primary" :disabled="!title.trim() || !body.trim() || saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </KbButton>
    </template>
  </KbDialog>
</template>

<style scoped>
.kb-insight-body {
  width: 100%;
  min-height: 120px;
  padding: 8px;
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r1);
  background: var(--bg);
  color: var(--text-primary);
  font: inherit;
  resize: vertical;
}
</style>
