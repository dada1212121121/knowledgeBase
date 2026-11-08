<script setup lang="ts">
// 文件夹上传预览(文件夹预览):文件数 / 总大小 / 按类型分布 + 包含·排除·大小上限·.gitignore + 目标集合与标签 + 目录树。
// 确认之前一个字节都不传;被排除的条目在树里划线显示。
import { computed, onMounted, ref } from 'vue'
import { KbButton, KbDialog, KbInput, KbSelect, KbSwitch, KbTagEditor } from '@kb-ui/index'

import { callCapability } from '@/api/client'
import { relativePathOf } from '@/api/upload'
import { GROUP_ORDER, fileGroup, formatSize } from '@/utils/files'
import { parseGlobs } from '@/utils/glob'

const props = defineProps<{ files: File[]; collection: string; collections: string[] }>()
const emit = defineEmits<{ confirm: [files: File[], options: { collection: string; tags: string[] }]; close: [] }>()

const include = ref('')
const exclude = ref('node_modules/**, .git/**, dist/**, target/**')
const respectGitignore = ref(true)
const maxMb = ref(512)
const target = ref(props.collection)
const tags = ref<string[]>([])
/** 服务端的分片大小(取自配置;读不到就不写在底部说明里) */
const chunkMb = ref<number | null>(null)

const collectionOptions = computed(() => props.collections.map((name) => ({ value: name, label: name })))
const sizeOptions = [50, 100, 512, 1024, 2048].map((mb) => ({ value: mb, label: mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB` }))

onMounted(async () => {
  try {
    const config = await callCapability<{ upload?: { chunk_mb?: number; max_file_mb?: number } }>('get_config')
    chunkMb.value = config.upload?.chunk_mb ?? null
    // 单文件上限默认 512 MB;服务端上限更低时跟着降到不超过它的最近一档
    const limit = config.upload?.max_file_mb
    if (limit && limit < maxMb.value) maxMb.value = [...sizeOptions].reverse().find((item) => item.value <= limit)?.value ?? sizeOptions[0]!.value
  } catch {
    // 读不到配置不影响预览
  }
})

/** 默认跳过的目录(近似 .gitignore 的常见项;真正的忽略规则在服务端扫描器里)。 */
const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__']

const relPaths = computed(() => props.files.map((file) => relativePathOf(file)))
const excludeRules = computed(() => parseGlobs(exclude.value))
const includeRules = computed(() => parseGlobs(include.value))

/** 每个文件是否会被上传,以及原因。 */
const decisions = computed(() =>
  props.files.map((file, index) => {
    const relPath = relPaths.value[index] ?? file.name
    if (file.size > maxMb.value * 1024 * 1024) return { file, relPath, keep: false, reason: 'size' as const }
    if (respectGitignore.value && relPath.split('/').some((segment) => IGNORED_DIRS.includes(segment))) {
      return { file, relPath, keep: false, reason: 'ignored' as const }
    }
    if (excludeRules.value.some((rule) => rule.test(relPath) || rule.test(`${relPath}/`))) {
      return { file, relPath, keep: false, reason: 'excluded' as const }
    }
    if (includeRules.value.length && !includeRules.value.some((rule) => rule.test(relPath))) {
      return { file, relPath, keep: false, reason: 'not-included' as const }
    }
    return { file, relPath, keep: true, reason: '' as const }
  }),
)
const kept = computed(() => decisions.value.filter((item) => item.keep))
const excludedCount = computed(() => decisions.value.length - kept.value.length)
const totalSize = computed(() => kept.value.reduce((sum, item) => sum + item.file.size, 0))

const fmt = (value: number) => value.toLocaleString()

/** 共同的顶层文件夹名(拖进来的是一个文件夹时);否则为空 */
const root = computed(() => {
  const first = relPaths.value[0]?.split('/')
  if (!first || first.length < 2) return ''
  return relPaths.value.every((path) => path.startsWith(`${first[0]}/`)) ? first[0]! : ''
})
const title = computed(() => (root.value ? `上传文件夹 · ${root.value}/` : `上传 ${fmt(props.files.length)} 个文件`))

/** 按类型分布(只算会上传的):固定顺序 PDF → Word → …,其余扩展名按数量排在后面 */
const groups = computed(() => {
  const map = new Map<string, { key: string; name: string; tone: string; count: number; bytes: number }>()
  for (const item of kept.value) {
    const group = fileGroup(item.file.name)
    const entry = map.get(group.key) ?? { ...group, count: 0, bytes: 0 }
    entry.count += 1
    entry.bytes += item.file.size
    map.set(group.key, entry)
  }
  const rank = (key: string) => {
    const index = GROUP_ORDER.indexOf(key)
    return index < 0 ? GROUP_ORDER.length : index
  }
  return [...map.values()].sort((left, right) => rank(left.key) - rank(right.key) || right.count - left.count).slice(0, 8)
})
const share = (count: number) => `${(count / Math.max(1, kept.value.length)) * 100}%`

/* ---------------- 目录树 ---------------- */
interface TreeNode {
  name: string
  kept: number
  out: number
  dirs: Map<string, TreeNode>
  files: { name: string; reason: string; size: number }[]
}
const newNode = (name: string): TreeNode => ({ name, kept: 0, out: 0, dirs: new Map(), files: [] })

const reasonText = (reason: string, size = 0) =>
  reason === 'size' ? (size ? `超限 ${formatSize(size)}` : '超限') : reason === 'not-included' ? '未包含' : '排除'

interface TreeRow {
  depth: number
  label: string
  count: string
  keep: boolean
}
const MAX_TREE_ROWS = 80
const tree = computed<TreeRow[]>(() => {
  const top = newNode(root.value)
  for (const item of decisions.value) {
    const segments = item.relPath.split('/')
    const inside = root.value ? segments.slice(1) : segments
    const dirs = inside.slice(0, -1)
    const fileName = inside[inside.length - 1] ?? item.relPath
    const chain: TreeNode[] = [top]
    let node = top
    for (const dir of dirs) {
      let child = node.dirs.get(dir)
      if (!child) {
        child = newNode(dir)
        node.dirs.set(dir, child)
      }
      chain.push(child)
      node = child
    }
    for (const entry of chain) {
      if (item.keep) entry.kept += 1
      else entry.out += 1
    }
    if (!item.keep) node.files.push({ name: fileName, reason: item.reason, size: item.file.size })
  }

  const rows: TreeRow[] = []
  const walk = (node: TreeNode, depth: number) => {
    const children = [...node.dirs.values()].sort((left, right) => left.name.localeCompare(right.name))
    // 先列还有文件会上传的目录,再列整个被排除的目录,最后是单个被排除的文件
    for (const child of children.filter((item) => item.kept > 0)) {
      rows.push({ depth, label: `▾ ${child.name}/`, count: fmt(child.kept), keep: true })
      walk(child, depth + 1)
    }
    for (const child of children.filter((item) => item.kept === 0).sort((left, right) => right.out - left.out)) {
      rows.push({ depth, label: `${child.name}/`, count: `排除${child.out > 1 ? ` · ${fmt(child.out)}` : ''}`, keep: false })
    }
    for (const file of node.files) {
      rows.push({ depth, label: file.name, count: reasonText(file.reason, file.size), keep: false })
    }
  }
  if (root.value) rows.push({ depth: 0, label: `▾ ${root.value}/`, count: fmt(top.kept), keep: true })
  walk(top, root.value ? 1 : 0)
  return rows.slice(0, MAX_TREE_ROWS)
})

function confirm() {
  emit('confirm', kept.value.map((item) => item.file), { collection: target.value, tags: tags.value })
}
</script>

<template>
  <KbDialog plain no-autofocus width="880px" :title="title" subtitle="确认前预览；目录结构会保留为集合内路径" @close="emit('close')">
    <div class="kb-fp">
      <div class="kb-fp-left">
        <div class="row">
          <span class="mono kb-fp-big">{{ fmt(kept.length) }}</span>
          <span class="m kb-fp-unit">个文件 · <span class="mono">{{ formatSize(totalSize) }}</span></span>
          <span class="m kb-fp-excl">已排除 {{ fmt(excludedCount) }} 个</span>
        </div>
        <div class="kb-fp-bar">
          <i
            v-for="item in groups"
            :key="item.key"
            :class="`is-${item.tone}`"
            :style="{ width: share(item.count) }"
            style-allow="分布条宽度 = 该类型文件数占比"
          ></i>
        </div>
        <div>
          <div v-for="item in groups" :key="item.key" class="kb-fp-type">
            <span class="kb-fmt mono" :class="`is-${item.tone}`">{{ item.key }}</span>
            <span class="kb-fp-type-name">{{ item.name }}</span>
            <span class="mono kb-fp-type-count">{{ fmt(item.count) }}</span>
            <span class="m mono kb-fp-type-size">{{ formatSize(item.bytes) }}</span>
          </div>
        </div>
      </div>

      <div class="kb-fp-right">
        <div class="kb-fp-form">
          <span class="m">包含</span>
          <KbInput v-model="include" class="mono" placeholder="**/*.{pdf,docx,md}(留空 = 全部)" aria-label="包含规则" />
          <span class="m">排除</span>
          <KbInput v-model="exclude" class="mono" placeholder="node_modules/**, *.tmp" aria-label="排除规则" />
          <span class="m">单文件上限</span>
          <KbSelect v-model="maxMb" :options="sizeOptions" class="mono kb-fp-select" />
          <span class="m">.gitignore</span>
          <KbSwitch v-model="respectGitignore" label="遵守" />
          <span class="m">目标集合</span>
          <KbSelect v-model="target" :options="collectionOptions" class="kb-fp-select" />
          <span class="m">标签</span>
          <div class="inp kb-fp-tags"><KbTagEditor v-model="tags" /></div>
        </div>
        <div class="card kb-fp-tree" aria-label="目录树">
          <div class="kb-fp-final" data-testid="folder-final-path">
            最终路径:{{ target }}/{{ root ? root + '/' : '' }}({{ kept.length }} 个文件)
          </div>
          <div
            v-for="(row, index) in tree"
            :key="`${row.label}-${index}`"
            class="row mono kb-fp-node"
            :class="{ 'kb-strike': !row.keep }"
            :data-depth="row.depth"
          >
            {{ row.label }}<span class="m kb-fp-node-count">{{ row.count }}</span>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <span class="m kb-fp-note">
        分片续传<template v-if="chunkMb"> · {{ chunkMb }} MB / 片</template> · 失败自动重试 3 次 · 离开页面后继续在后台上传
      </span>
      <span class="kb-row">
        <KbButton @click="emit('close')">取消</KbButton>
        <KbButton variant="primary" :disabled="!kept.length || !target" @click="confirm">
          上传 {{ fmt(kept.length) }} 个文件
        </KbButton>
      </span>
    </template>
  </KbDialog>
</template>
