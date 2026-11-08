<script setup lang="ts">
// 移动:目标知识库 + 该知识库已有目录,不要求用户记路径;需要新目录时再展开输入框。
// 跨知识库时目录来自目标库的 item_facets,切换目标库会重新拉一次。
// 文件夹不能移进自己或自己的子目录——服务端也会拒绝,这里先拦一次是为了给出更直白的提示。
import { computed, ref, watch } from 'vue'
import { KbButton, KbDialog, KbInput, KbSelect, type SelectOption } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import type { FileActions, FileOp } from './types'
import FileOpProgress from './FileOpProgress.vue'
import { useReferenceImpact } from './useReferenceImpact'

const props = withDefaults(
  defineProps<{
    actions: FileActions
    dirs: string[]
    /** 可选的目标知识库;为空时只能在本知识库内移动。 */
    collections?: string[]
    busy: boolean
    error: string
    result: FileOp | null
  }>(),
  { collections: () => [] },
)
const references = useReferenceImpact(props.actions)
const emit = defineEmits<{ close: []; confirm: [collection: string, dir: string, name: string] }>()

/** 「新建目录」是下拉里的一个动作,不是真实路径;用两个下划线避免和正常目录重名。 */
const NEW_DIR = '__kb_new_dir__'
const collection = ref(props.actions.collection)
const dir = ref('')
const manualDir = ref('')
const name = ref('')
const localError = ref('')
const remoteDirs = ref<string[]>([])
const loadingDirs = ref(false)
const creating = computed(() => dir.value === NEW_DIR)
const currentName = computed(() => props.actions.path.split('/').pop() ?? props.actions.path)
const targetDir = computed(() => (creating.value ? manualDir.value.trim().replace(/^\/+|\/+$/g, '') : dir.value))
const cross = computed(() => collection.value !== props.actions.collection)
const sourceDirs = computed(() => (cross.value ? remoteDirs.value : props.dirs))
const target = computed(() => {
  const chosen = name.value.trim() || currentName.value
  return targetDir.value ? `${targetDir.value}/${chosen}` : chosen
})
const collectionOptions = computed<SelectOption[]>(() =>
  (props.collections.length ? props.collections : [props.actions.collection]).map((entry) => ({ value: entry, label: entry })),
)
/** 只列目标知识库里已经出现过的目录;根目录永远可选。 */
const dirOptions = computed<SelectOption[]>(() => {
  const seen = new Set<string>()
  const entries = sourceDirs.value
    .map((entry) => entry.trim().replace(/^\/+|\/+$/g, ''))
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false
      seen.add(entry)
      // 同库移动时文件夹不能移进自己或自己的子目录,下拉里就不给这些选项。
      if (!cross.value && props.actions.folder && (entry === props.actions.path || entry.startsWith(`${props.actions.path}/`))) return false
      return true
    })
    .sort((a, b) => a.localeCompare(b))
  return [
    { value: '', label: '知识库根目录' },
    ...entries.map((entry) => ({ value: entry, label: entry })),
    { value: NEW_DIR, label: '新建目录…' },
  ]
})

async function loadDirs() {
  if (!cross.value) return
  loadingDirs.value = true
  localError.value = ''
  try {
    const result = await callCapability<{ kinds: unknown[]; dirs?: string[] }>('item_facets', {
      collection: collection.value,
      status: 'active',
    })
    remoteDirs.value = result.dirs ?? []
  } catch {
    // 目录列表读不到不影响移动:用户仍可选根目录或直接新建目录。
    remoteDirs.value = []
    localError.value = '读取目标知识库的目录失败,可以直接选根目录或新建目录'
  } finally {
    loadingDirs.value = false
  }
}

watch(collection, () => {
  dir.value = ''
  manualDir.value = ''
  remoteDirs.value = []
  void loadDirs()
})

function confirm() {
  localError.value = ''
  const next = targetDir.value
  const newName = name.value.trim()
  if (creating.value && !next) {
    localError.value = '请选择已有目录,或填写新目录路径'
    return
  }
  if (next.split('/').some((part) => part === '..' || part === '.')) {
    localError.value = '目标目录不能包含 . 或 ..'
    return
  }
  if (newName === '.' || newName === '..') {
    localError.value = '新名字不能是 . 或 ..'
    return
  }
  if (newName.includes('/') || newName.includes('\\')) {
    localError.value = '新名字不能带路径分隔符'
    return
  }
  if (!cross.value && props.actions.folder && (next === props.actions.path || next.startsWith(`${props.actions.path}/`))) {
    localError.value = '不能把文件夹移进它自己里面'
    return
  }
  emit('confirm', collection.value, next, newName)
}
</script>

<template>
  <KbDialog title="移动" :subtitle="actions.path" plain width="500px" data-testid="file-move-dialog" @close="emit('close')">
    <div class="kb-file-move">
      <label v-if="collections.length > 1">
        <span>目标知识库</span>
        <KbSelect
          v-model="collection"
          :options="collectionOptions"
          class="kb-file-move-collection"
          data-testid="file-move-collection"
          aria-label="目标知识库"
        />
        <span class="m">跨知识库移动会把文件、版本、批注和解析队列一起迁过去,原库不再保留。</span>
      </label>
      <label>
        <span>移动到</span>
        <KbSelect
          v-model="dir"
          :options="dirOptions"
          :disabled="busy || loadingDirs"
          class="kb-file-move-dir"
          data-testid="file-move-dir"
          aria-label="目标目录"
        />
        <span class="m">{{ loadingDirs ? '正在读取目标知识库的目录…' : '下拉里是目标知识库已有的目录;要放到新目录就选「新建目录…」' }}。</span>
      </label>
      <label v-if="creating">
        <span>新目录路径</span>
        <KbInput v-model="manualDir" data-testid="file-move-new-dir" placeholder="例如 archive/2026" />
      </label>
      <label>
        <span>新名字 <span class="m">(可选)</span></span>
        <KbInput v-model="name" :placeholder="currentName" />
      </label>
      <p class="m">
        将移动到 <code>{{ collection }}/{{ target }}</code
        >。{{ cross ? '跨知识库移动只支持上传 / 压缩包里的托管副本;移动后会按目标库重建索引。' : '只支持同一数据源内的托管副本;移动后会重建索引。' }}
      </p>
      <p v-if="localError" class="kb-file-error" role="alert">{{ localError }}</p>
      <p v-if="references" class="kb-file-impact" data-testid="file-move-references">
        有 {{ references }} 篇文档按旧路径引用了它,移动后这些链接会失效;系统只提示,不会自动改正文。
      </p>
      <p v-if="error" class="kb-file-error" role="alert">{{ error }}</p>
      <FileOpProgress :busy="busy" :result="result" />
    </div>
    <template #footer>
      <KbButton :disabled="busy" @click="emit('close')">取消</KbButton>
      <KbButton variant="primary" :disabled="busy || loadingDirs" data-testid="file-move-confirm" @click="confirm">
        {{ busy ? '正在移动…' : '移动' }}
      </KbButton>
    </template>
  </KbDialog>
</template>

<style scoped>
.kb-file-move { display: grid; gap: 12px; font-size: var(--text-13); line-height: 1.55; }
.kb-file-move label { display: grid; gap: 6px; }
.kb-file-move label > span { font-weight: 600; }
.kb-file-move label > span.m { font-weight: 400; }
.kb-file-move :deep(.kb-select) { display: block; }
.kb-file-move :deep(.kb-select > .btn) { width: 100%; justify-content: space-between; }
.kb-file-move p { margin: 0; }
.kb-file-move code { padding: 1px 4px; border-radius: var(--r-xs); background: var(--hover); font-size: var(--text-12); }
.kb-file-error { color: var(--status-danger-text); }
.kb-file-impact { padding: 8px 10px; border-radius: var(--r2); background: var(--surface-2); color: var(--t2); }
</style>
