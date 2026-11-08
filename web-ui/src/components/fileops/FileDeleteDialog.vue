<script setup lang="ts">
// 删除确认。文案按来源区分后果,不把所有删除都说成「进回收站」:
// 上传 / 压缩包副本进 KB_HOME/trash(30 天可恢复);本地目录 / 项目 / 网页 / Git 只移除索引,原件不动。
import { computed } from 'vue'
import { KbButton, KbDialog } from '@kb-ui/index'
import { ORIGIN_LABEL, type FileActions, type FileOp } from './types'
import FileOpProgress from './FileOpProgress.vue'
import { useReferenceImpact } from './useReferenceImpact'

const props = defineProps<{
  actions: FileActions
  busy: boolean
  error: string
  result: FileOp | null
}>()
const references = useReferenceImpact(props.actions)
const emit = defineEmits<{ close: []; confirm: [] }>()

const canRestore = computed(() => props.actions.origin === 'upload' || props.actions.origin === 'archive')
const title = computed(() => (props.actions.folder ? '删除这个文件夹?' : '删除这个文件?'))
const subtitle = computed(() =>
  props.actions.folder
    ? props.actions.origin === 'unknown'
      ? `里面有 ${props.actions.files} 个文件,来源不同`
      : `里面有 ${props.actions.files} 个文件`
    : ORIGIN_LABEL[props.actions.origin],
)
</script>

<template>
  <KbDialog :title="title" :subtitle="subtitle" plain width="480px" data-testid="file-delete-dialog" @close="emit('close')">
    <div class="kb-file-delete">
      <p v-if="canRestore">
        文件会移到回收站,<b>30 天内可以恢复</b>;分享链接会立刻失效,恢复后不会自动恢复分享。
      </p>
      <p v-else-if="actions.folder && actions.origin === 'unknown'">
        这个文件夹里混有不同来源:<b>上传 / 压缩包副本会进回收站(30 天内可恢复)</b>,本地目录、项目、网页、Git 的文件只移除索引,<b>原件不动</b>。
        分享链接会立刻失效,恢复后不会自动恢复分享。
      </p>
      <p v-else>
        这只会把内容从知识库索引里移除,<b>不会改动磁盘上的原件</b>,也不会再去同步它。
      </p>
      <p v-if="actions.folder" class="m">文件夹会按路径段边界处理(<code>docs</code> 不会碰到 <code>docs2</code>)。</p>
      <p v-if="references" class="kb-file-impact" data-testid="file-delete-references">
        有 {{ references }} 篇文档引用了它,删除后这些链接会失效;系统只提示,不会自动改正文。
      </p>
      <p v-if="error" class="kb-file-error" role="alert">{{ error }}</p>
      <FileOpProgress :busy="busy" :result="result" />
    </div>
    <template #footer>
      <KbButton :disabled="busy" @click="emit('close')">取消</KbButton>
      <KbButton variant="danger" :disabled="busy" data-testid="file-delete-confirm" @click="emit('confirm')">
        {{ busy ? '正在删除…' : actions.folder ? '删除文件夹' : '删除' }}
      </KbButton>
    </template>
  </KbDialog>
</template>

<style scoped>
.kb-file-delete { display: grid; gap: 9px; font-size: var(--text-13); line-height: 1.65; }
.kb-file-delete p { margin: 0; }
.kb-file-delete code { padding: 1px 4px; border-radius: var(--r-xs); background: var(--hover); font-size: var(--text-12); }
.kb-file-error { color: var(--status-danger-text); }
.kb-file-impact { padding: 8px 10px; border-radius: var(--r2); background: var(--surface-2); color: var(--t2); }
</style>
