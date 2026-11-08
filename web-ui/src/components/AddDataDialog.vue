<script setup lang="ts">
// 添加数据(设计稿):先选来源类型(服务器目录 / Git / 网页 / 上传文件 / 压缩包 / 新建笔记),
// 再填该类型需要的内容。上传类先在对话框里攒一份文件清单,点「开始解析」才真正开始上传
// (目标集合与标签在这时才确定,所以不能一选就传);其余类型调用 `add_source`。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  KbButton,
  KbDialog,
  KbDropzone,
  KbIcon,
  KbInput,
  KbSegmented,
  KbSelect,
  KbSwitch,
  KbTagEditor,
  PHONE_QUERY,
  useMedia,
  useToast,
  type IconName,
} from '@kb-ui/index'

import { callCapability } from '@/api/client'
import { relativePathOf, requestUpload } from '@/api/upload'
import { useFeature } from '@/composables/useFeature'
import { useUploadStore } from '@/stores/upload'
import { FORMAT_CHIPS, fileChip, formatSize } from '@/utils/files'
import { normalizeFolder, withFolderPrefix } from '@/utils/uploadFolder'

type AddKind = 'local_dir' | 'git' | 'web' | 'upload' | 'archive' | 'note'

const props = withDefaults(
  defineProps<{
    collections: string[]
    maxFileMb?: number | null
    initialKind?: AddKind
    /** 能选的来源类型;不传 = 全部。普通用户只给网页 / 上传 / 压缩包 / 笔记,服务器目录和 Git 是管理员的事(管理 → 项目与集合)。 */
    kinds?: AddKind[]
    /** 预填的网址 / 路径(首页「粘贴网址」入口用) */
    initialUri?: string
    /** 预选的集合 */
    initialCollection?: string
    /** 网页来源「AI 规范化」开关的初始值(后端 `list_sources.ai_extract_default`) */
    aiExtractDefault?: boolean
  }>(),
  { maxFileMb: null, initialKind: 'upload', kinds: undefined, initialUri: '', initialCollection: '', aiExtractDefault: true },
)
const emit = defineEmits<{ close: []; added: [] }>()

const toast = useToast()
const uploads = useUploadStore()
// 手机上没有「拖入」,浏览器也不支持选文件夹(webkitdirectory),文案和选项要对齐导入页
const phone = useMedia(PHONE_QUERY)

const TYPES: { kind: AddKind; title: string; sub: string; icon: IconName }[] = [
  { kind: 'local_dir', title: '服务器目录', sub: '服务器上的路径 · 定时或手动同步', icon: 'dir' },
  { kind: 'git', title: 'Git 仓库', sub: '克隆并定时拉取', icon: 'branch' },
  { kind: 'web', title: '网页 / 站点', sub: 'URL 抓取，可设深度', icon: 'globe' },
  { kind: 'upload', title: '上传文件', sub: '多选 · 文件夹 · 拖拽', icon: 'upload' },
  { kind: 'archive', title: '压缩包', sub: 'zip 递归解析', icon: 'archive' },
  { kind: 'note', title: '新建笔记', sub: '直接写 Markdown', icon: 'note' },
]

const offered = computed(() => {
  const list = props.kinds?.length ? TYPES.filter((item) => props.kinds!.includes(item.kind)) : TYPES
  // 手机上没有文件夹和拖拽,说明换成能做的事
  return phone.value ? list.map((item) => (item.kind === 'upload' ? { ...item, sub: '多选 · 拍照 · 相册' } : item)) : list
})
// 初始类型不在可选范围里(例如只给管理员类型的页面却传了上传)就取第一个可选的
const kind = ref<AddKind>(offered.value.some((item) => item.kind === props.initialKind) ? props.initialKind : (offered.value[0]?.kind ?? props.initialKind))
const isUpload = computed(() => kind.value === 'upload' || kind.value === 'archive')

const collection = ref(props.initialCollection || props.collections[0] || '')
const tags = ref<string[]>([])
/** 目标文件夹(上传 / 压缩包):文件放进集合里的哪个目录。不填 = 集合根目录 */
const folder = ref('')
const folderCheck = computed(() => normalizeFolder(folder.value))
const folderError = computed(() => (folderCheck.value.ok ? '' : folderCheck.value.reason))
const name = ref('')
const uri = ref(props.initialUri)
const depth = ref(1)
const allowHosts = ref('')
/** 网页来源:抓到的页面再交给内置模型整理成规范化结果(原文照常入库)。没有「自动提炼与审核」功能点时不显示、不传 */
const canAiExtract = useFeature('ai.extract')
const aiExtract = ref(props.aiExtractDefault)
/** 提取要求:留空让模型自动判断页面类型、尽量全面地整理;个别网站可以写清要什么 */
const extractPrompt = ref('')
/** 与后端 `MAX_EXTRACT_PROMPT_CHARS` 一致 */
const EXTRACT_PROMPT_MAX = 2000
const extractPromptError = computed(() =>
  aiExtract.value && extractPrompt.value.trim().length > EXTRACT_PROMPT_MAX ? `提取要求不能超过 ${EXTRACT_PROMPT_MAX} 个字` : '',
)
const busy = ref(false)

const collectionOptions = computed(() => props.collections.map((item) => ({ value: item, label: item })))
watch(
  () => props.collections,
  (names) => {
    if (!collection.value && names.length) collection.value = props.initialCollection || names[0]!
  },
)
watch(
  () => props.initialCollection,
  (val) => {
    if (val && props.collections.includes(val)) collection.value = val
  },
)

/* ---------------- 上传类:待传清单 ---------------- */
const staged = ref<File[]>([])
const keyOf = (file: File) => `${relativePathOf(file)}:${file.size}`
const stagedRows = computed(() =>
  staged.value.map((file) => ({ file, key: keyOf(file), name: relativePathOf(file), size: formatSize(file.size), chip: fileChip(file.name) })),
)
const totalBytes = computed(() => staged.value.reduce((sum, file) => sum + file.size, 0))

function stage(files: File[]) {
  const known = new Set(staged.value.map(keyOf))
  const fresh = files.filter((file) => !known.has(keyOf(file)))
  staged.value = [...staged.value, ...fresh]
}
function unstage(key: string) {
  staged.value = staged.value.filter((file) => keyOf(file) !== key)
}

const dropNote = computed(() => {
  const mb = props.maxFileMb
  const limit = mb ? ` · 单文件 ≤ ${mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`}` : ''
  if (kind.value === 'archive') return `支持 .zip · 自动递归解包${limit}`
  return phone.value ? `支持多选 · .zip 自动解包${limit}` : `支持多选 · 整个文件夹 · .zip 自动解包${limit}`
})

/* 对话框打开期间由它接管拖放:拖到对话框任何位置都进待传清单(而不是被全局遮罩直接开传) */
const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')
function onWindowDragOver(event: DragEvent) {
  if (hasFiles(event)) event.preventDefault()
}
function onWindowDrop(event: DragEvent) {
  if (!hasFiles(event)) return
  event.preventDefault()
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  if (!isUpload.value) kind.value = 'upload'
  stage(files)
}
onMounted(() => {
  uploads.captureDrops = true
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
})
onBeforeUnmount(() => {
  uploads.captureDrops = false
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
})

/* ---------------- 提交 ---------------- */
const uriLabel = computed(() =>
  kind.value === 'note' ? '笔记正文' : kind.value === 'web' ? '网址' : kind.value === 'git' ? '仓库地址' : '路径',
)
const uriPlaceholder = computed(
  () =>
    ({ local_dir: '/srv/workspace/docs', git: 'git@github.com:team/repo.git', web: 'https://docs.example.com/', note: '# 标题\n\n正文…' })[
      kind.value as 'local_dir' | 'git' | 'web' | 'note'
    ] ?? '',
)
const canSubmit = computed(() => {
  if (busy.value || !collection.value) return false
  if (isUpload.value && !folderCheck.value.ok) return false
  if (kind.value === 'web' && extractPromptError.value) return false
  return isUpload.value ? staged.value.length > 0 : uri.value.trim().length > 0
})
const primaryLabel = computed(() => (isUpload.value ? '开始解析' : '添加'))
const summary = computed(() =>
  isUpload.value
    ? staged.value.length
      ? `${staged.value.length} 个文件 · ${formatSize(totalBytes.value)}`
      : '还没有选择文件'
    : '',
)

async function submit() {
  if (!canSubmit.value) return
  if (isUpload.value) {
    const hasFolder = staged.value.some((file) => relativePathOf(file) !== file.name)
    // 目标文件夹在这里一次性加到路径前面:预检、续传、入库用的都是带前缀的路径
    const target = folderCheck.value.ok ? folderCheck.value.folder : ''
    requestUpload(withFolderPrefix(staged.value, target), { collection: collection.value, tags: tags.value, skipPreview: !hasFolder })
    toast.push(`已加入上传队列(${staged.value.length} 个文件)`)
    emit('close')
    return
  }
  busy.value = true
  try {
    await callCapability('add_source', {
      kind: kind.value,
      name: name.value.trim() || undefined,
      uri: uri.value.trim(),
      collection: collection.value,
      tags: tags.value,
      depth: kind.value === 'web' ? depth.value : undefined,
      allow_hosts: allowHosts.value
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
      // 没有功能点时不传:后端按「没有权限 → 关」处理,不会因为默认值被拒
      ...(kind.value === 'web' && canAiExtract.value
        ? { ai_extract: aiExtract.value, extract_prompt: aiExtract.value ? extractPrompt.value.trim() : '' }
        : {}),
    })
    toast.push('数据源已添加')
    emit('added')
    emit('close')
  } catch (err) {
    toast.push(`添加失败:${err instanceof Error ? err.message : ''}`, 'danger')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <KbDialog
    plain
    width="760px"
    title="添加数据"
    subtitle="选择来源类型；上传的文件会进入解析队列，可在「导入」页的「导入记录」里查看进度"
    @close="emit('close')"
  >
    <div class="kb-add-types" role="radiogroup" aria-label="来源类型">
      <button
        v-for="item in offered"
        :key="item.kind"
        type="button"
        class="stype"
        :class="{ on: kind === item.kind }"
        role="radio"
        :aria-checked="kind === item.kind"
        @click="kind = item.kind"
      >
        <span class="ico"><KbIcon :name="item.icon" :size="14" /></span>
        <span class="kb-add-type-text">
          <div class="kb-add-type-title">{{ item.title }}</div>
          <div class="sub2">{{ item.sub }}</div>
        </span>
      </button>
    </div>

    <template v-if="isUpload">
      <div class="kb-add-zone">
        <KbDropzone
          compact
          :folder="kind === 'upload' && !phone"
          :accept="kind === 'archive' ? '.zip' : ''"
          :title="phone ? '选择要添加的文件' : '拖入文件或文件夹即可添加'"
          :description="dropNote"
          @files="stage"
        >
          <span v-for="chip in FORMAT_CHIPS" :key="chip.label" class="kb-fmt mono" :class="`is-${chip.tone}`">{{ chip.label }}</span>
        </KbDropzone>
      </div>
      <div v-if="stagedRows.length" class="kb-add-files">
        <div v-for="row in stagedRows" :key="row.key" class="kb-add-file">
          <span class="kb-fmt mono" :class="`is-${row.chip.tone}`">{{ row.chip.label }}</span>
          <span class="kb-add-file-name" :title="row.name">{{ row.name }}</span>
          <span class="m mono kb-add-file-size">{{ row.size }}</span>
          <span class="tag kb-add-file-tag">待上传</span>
          <button type="button" class="kb-add-x" :aria-label="`移除 ${row.name}`" @click="unstage(row.key)">
            <KbIcon name="close" :size="12" />
          </button>
        </div>
      </div>
    </template>

    <div class="kb-add-fields">
      <template v-if="!isUpload">
        <span class="m">{{ uriLabel }}</span>
        <div class="kb-add-wide">
          <KbInput v-model="uri" :multiline="kind === 'note'" :placeholder="uriPlaceholder" :aria-label="uriLabel" />
        </div>
        <template v-if="kind === 'web'">
          <span class="m">抓取深度</span>
          <KbSegmented
            :model-value="String(depth)"
            :options="[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
            ]"
            @update:model-value="(value: string) => (depth = Number(value))"
          />
          <span class="m">域名白名单</span>
          <KbInput v-model="allowHosts" placeholder="留空 = 只允许上面的域名" aria-label="域名白名单" />
          <template v-if="canAiExtract">
            <span class="m">AI 规范化</span>
            <div class="kb-add-wide" data-testid="add-ai-extract">
              <KbSwitch v-model="aiExtract" label="抓到的页面再用 AI 整理成规范化内容(原文照常入库,会用到 AI 额度)" />
            </div>
            <template v-if="aiExtract">
              <span class="m">提取要求</span>
              <div class="kb-add-folder kb-add-wide">
                <KbInput
                  v-model="extractPrompt"
                  multiline
                  placeholder="留空自动提取。例:只要产品名称、价格、规格参数和发布日期"
                  aria-label="提取要求(可不填)"
                  data-testid="add-extract-prompt"
                />
                <span v-if="extractPromptError" class="kb-add-folder-err" role="alert" data-testid="add-extract-prompt-error">{{ extractPromptError }}</span>
              </div>
            </template>
          </template>
        </template>
        <span class="m">显示名</span>
        <KbInput v-model="name" placeholder="留空时自动取" aria-label="显示名" />
      </template>

      <span class="m">目标集合</span>
      <KbSelect v-model="collection" :options="collectionOptions" class="kb-add-select" />
      <template v-if="isUpload">
        <span class="m">目标文件夹</span>
        <div class="kb-add-folder kb-add-wide">
          <KbInput v-model="folder" placeholder="可不填,不填放在集合根目录。例如:手册/2026" aria-label="目标文件夹(可不填)" data-testid="add-folder" :aria-invalid="!!folderError" />
          <span v-if="folderError" class="kb-add-folder-err" role="alert" data-testid="add-folder-error">{{ folderError }}</span>
          <span v-else-if="folderCheck.ok && folderCheck.folder" class="m kb-add-folder-hint">文件会放进 {{ folderCheck.folder }}/(没有就新建)</span>
        </div>
      </template>
      <span class="m">标签</span>
      <div :class="['inp', 'kb-add-tags', { 'kb-add-wide': !isUpload }]"><KbTagEditor v-model="tags" /></div>
    </div>

    <template #footer>
      <span class="m kb-add-summary">{{ summary }}</span>
      <span class="kb-row">
        <KbButton @click="emit('close')">取消</KbButton>
        <KbButton variant="primary" :disabled="!canSubmit" @click="submit">{{ primaryLabel }}</KbButton>
      </span>
    </template>
  </KbDialog>
</template>
