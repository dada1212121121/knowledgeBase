<script setup lang="ts">
// 别人分享给我的文件夹 / 集合：与知识库「目录」页面 UI 与分类方式完全一致。
// 顶部分类药丸（Pills）：全部、笔记、文档、代码。
// 视图切换 Tabs：列表、目录。
// 目录树使用标准 KbTreeRow，层级展开集合、分类及子目录/文件，支持点击进入与查看/编辑权限标记。
import { computed, onMounted, ref, watch } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbIcon, KbInput, KbSkeleton, KbTreeRow } from '@kb-ui/index'
import type { ShareAccess, ShareTarget } from '@/api/share'
import { fileChip } from '@/utils/files'
import { relativeTime, shareErrorText } from '@/utils/share'

export interface Row {
  id: string
  kind: string
  source: string
  title: string | null
  symbol: string | null
  insight_kind?: string | null
  updated_at: number
  chunks?: number
}

export interface DisplayItem {
  id: string
  kind: 'insight' | 'doc' | 'code'
  source: string
  name: string
  sub: string
  title: string | null
  symbol: string | null
  insight_kind?: string | null
  updated_at: number
  editable: boolean
}

export interface SubFolderGroup {
  name: string
  path: string
  files: DisplayItem[]
}

const props = defineProps<{ target: ShareTarget; access: ShareAccess }>()
const emit = defineEmits<{ open: [target: ShareTarget, title: string] }>()

const PAGE = 100
const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')
const rows = ref<Row[]>([])
const loaded = ref(0)
const total = ref(0)
const page = ref(1)
const more = ref(false)
const searchQuery = ref('')
const sidebarTab = ref<'tree' | 'files'>('tree')
const activeKind = ref<string>('')
const activeDir = ref<string>('')
const rootOpen = ref<boolean>(true)
const facetOpen = ref<Record<string, boolean>>({
  doc: false,
  insight: false,
  code: false,
})
const dirOpen = ref<Record<string, boolean>>({})

const listable = computed(() => props.target.kind === 'collection' || props.target.kind === 'dir')

/** 当前目录的前缀路径（规整去除首尾斜杠） */
const currentPrefix = computed(() => {
  if (props.target.kind === 'dir') {
    return (props.target.path ?? '').trim().replace(/^\/+|\/+$/g, '')
  }
  return ''
})

/** 根节点标题显示（集合名称或文件夹名称） */
const rootLabel = computed(() => {
  if (props.target.kind === 'dir') {
    return props.target.path?.split('/').pop() || props.target.path || '文件夹'
  }
  return props.target.collection || '_global'
})

/** 网页来源是网址，附件在笔记里引用：这两种不在列表里单独出现 */
const addressable = (row: Row) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(row.source) || row.kind === 'insight'

/** 支持在线编辑的文件扩展名 */
const EDITABLE_EXTS = new Set([
  'md', 'markdown', 'txt', 'text', 'json', 'yaml', 'yml', 'xml', 'toml',
  'rs', 'ts', 'js', 'jsx', 'tsx', 'py', 'go', 'c', 'cpp', 'h', 'hpp',
  'css', 'scss', 'less', 'html', 'sql', 'sh', 'bash', 'csv', 'tsv',
  'log', 'ini', 'env', 'docx', 'xlsx', 'pptx',
])

function isEditableFile(source: string, kind: string): boolean {
  if (kind === 'insight') return true
  const dot = source.lastIndexOf('.')
  if (dot < 0) return true
  const ext = source.slice(dot + 1).toLowerCase()
  return EDITABLE_EXTS.has(ext)
}

const KIND_LABEL: Record<string, string> = {
  insight: '笔记',
  doc: '文档',
  code: '代码',
  external: '外部',
  note: '笔记',
  decision: '决策',
  pitfall: '坑',
  howto: '做法',
  convention: '约定',
}

const kindText = (value: string | null | undefined) => (value ? (KIND_LABEL[value] ?? value) : '')
const compact = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))

function classifyKind(row: Row): 'insight' | 'code' | 'doc' {
  if (row.kind === 'insight') return 'insight'
  if (row.kind === 'code') return 'code'
  const dot = row.source.lastIndexOf('.')
  const ext = dot > 0 ? row.source.slice(dot + 1).toLowerCase() : ''
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'json', 'yaml', 'yml', 'toml', 'sql', 'sh'].includes(ext)) {
    return 'code'
  }
  return 'doc'
}

const nameOf = (row: Row) => {
  if (row.kind === 'insight') {
    return row.title || row.symbol || '笔记'
  }
  return row.source.split('/').pop() || row.source
}

const dirOf = (row: Row) => {
  if (row.kind === 'insight') {
    return row.insight_kind ? `笔记 · ${kindText(row.insight_kind)}` : '笔记'
  }
  return row.source.split('/').slice(0, -1).join('/') || '当前目录'
}

/** 所有去重可寻址条目 */
const allDisplayItems = computed<DisplayItem[]>(() => {
  const prefix = currentPrefix.value
  const seen = new Set<string>()
  const list: DisplayItem[] = []

  for (const row of rows.value) {
    if (!addressable(row) || row.source.startsWith('_attachments/')) continue
    const key = row.kind === 'insight' ? row.id : row.source
    if (seen.has(key)) continue
    seen.add(key)

    const kind = classifyKind(row)
    const name = nameOf(row)
    let sub = ''
    if (kind === 'insight') {
      sub = row.insight_kind ? kindText(row.insight_kind) : '笔记'
    } else {
      const cleanSrc = row.source.replace(/^\/+|\/+$/g, '')
      let rel = cleanSrc
      if (prefix && cleanSrc.startsWith(prefix + '/')) {
        rel = cleanSrc.slice(prefix.length + 1)
      }
      const dirPart = rel.split('/').slice(0, -1).join('/')
      sub = dirPart || prefix || '当前目录'
    }

    list.push({
      id: row.id,
      kind,
      source: row.source,
      name,
      sub,
      title: row.title,
      symbol: row.symbol,
      insight_kind: row.insight_kind,
      updated_at: row.updated_at,
      editable: !!props.access.can.edit && isEditableFile(row.source, row.kind),
    })
  }

  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
})

/** 分类计数（与知识库 Browser.vue 严格对齐） */
const kindCounts = computed(() => {
  let doc = 0
  let insight = 0
  let code = 0
  for (const item of allDisplayItems.value) {
    if (item.kind === 'insight') insight++
    else if (item.kind === 'code') code++
    else doc++
  }
  return { doc, insight, code }
})

const totalCount = computed(() => allDisplayItems.value.length)

/** 分类药丸 Pills：全部、笔记、文档、代码 */
const categoryPills = computed(() => [
  { value: '', label: '全部', count: kindCounts.value.code + kindCounts.value.doc + kindCounts.value.insight || totalCount.value },
  ...(kindCounts.value.insight ? [{ value: 'insight', label: '笔记', count: kindCounts.value.insight }] : []),
  ...(kindCounts.value.doc ? [{ value: 'doc', label: '文档', count: kindCounts.value.doc }] : []),
  ...(kindCounts.value.code ? [{ value: 'code', label: '代码', count: kindCounts.value.code }] : []),
])

function setCategoryPill(val: string) {
  activeKind.value = activeKind.value === val ? '' : val
  activeDir.value = ''
  sidebarTab.value = 'files'
}

function selectFacet(kind: string) {
  facetOpen.value[kind] = !facetOpen.value[kind]
  activeKind.value = activeKind.value === kind ? '' : kind
  activeDir.value = ''
}

/** 文档分类下的子目录和直接文件 */
const docSubFolders = computed<SubFolderGroup[]>(() => {
  const prefix = currentPrefix.value
  const groups = new Map<string, DisplayItem[]>()
  for (const file of allDisplayItems.value) {
    if (file.kind !== 'doc') continue
    const cleanSrc = file.source.replace(/^\/+|\/+$/g, '')
    let rel = cleanSrc
    if (prefix && cleanSrc.startsWith(prefix + '/')) {
      rel = cleanSrc.slice(prefix.length + 1)
    }
    const parts = rel.split('/')
    if (parts.length > 1) {
      const folderName = parts[0]
      if (!groups.has(folderName)) groups.set(folderName, [])
      groups.get(folderName)!.push(file)
    }
  }
  return Array.from(groups.entries()).map(([name, files]) => ({
    name,
    path: prefix ? `${prefix}/${name}` : name,
    files,
  }))
})

const directDocs = computed(() => {
  const prefix = currentPrefix.value
  return allDisplayItems.value.filter((file) => {
    if (file.kind !== 'doc') return false
    const cleanSrc = file.source.replace(/^\/+|\/+$/g, '')
    let rel = cleanSrc
    if (prefix && cleanSrc.startsWith(prefix + '/')) {
      rel = cleanSrc.slice(prefix.length + 1)
    }
    return !rel.includes('/')
  })
})

const notesList = computed(() => allDisplayItems.value.filter((f) => f.kind === 'insight'))
const codeFiles = computed(() => allDisplayItems.value.filter((f) => f.kind === 'code'))

/** 扁平列表视图下的过滤结果 */
const filteredFilesList = computed(() => {
  let list = allDisplayItems.value
  if (activeKind.value) {
    list = list.filter((item) => item.kind === activeKind.value)
  }
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((item) =>
    item.name.toLowerCase().includes(q) ||
    item.source.toLowerCase().includes(q) ||
    (item.title && item.title.toLowerCase().includes(q)),
  )
})

const hasAnyItems = computed(() => allDisplayItems.value.length > 0)

async function load(next = 1) {
  if (!listable.value) {
    status.value = 'ready'
    return
  }
  if (next === 1) status.value = 'loading'
  try {
    const result = await props.access.call<{ items: Row[]; total: number }>('list_items', {
      collection: props.target.collection,
      ...(props.target.kind === 'dir' ? { path_prefix: props.target.path } : {}),
      status: 'active',
      sort: 'source',
      order: 'asc',
      group_by_file: true,
      page: next,
      page_size: PAGE,
    })
    rows.value = next === 1 ? result.items : [...rows.value, ...result.items]
    loaded.value = (next === 1 ? 0 : loaded.value) + result.items.length
    total.value = result.total
    page.value = next
    more.value = result.items.length > 0 && loaded.value < result.total
    status.value = 'ready'
  } catch (err) {
    errorText.value = shareErrorText(err, '目录没有加载出来。检查网络后重试。')
    status.value = 'error'
  }
}

onMounted(() => void load())
watch(
  () => [props.target.kind, props.target.collection, props.target.path],
  () => {
    searchQuery.value = ''
    activeKind.value = ''
    activeDir.value = ''
    void load()
  },
)

function openSubDir(sub: SubFolderGroup) {
  emit(
    'open',
    {
      kind: 'dir',
      space_id: props.target.space_id,
      collection: props.target.collection,
      path: sub.path,
    },
    sub.name,
  )
}

function openFile(item: DisplayItem) {
  const base = { space_id: props.target.space_id, collection: props.target.collection }
  emit(
    'open',
    item.kind === 'insight' ? { kind: 'insight', ...base, id: item.id } : { kind: 'file', ...base, path: item.source },
    item.name,
  )
}
</script>

<template>
  <div class="kb-sfold" data-testid="shared-folder">
    <KbSkeleton v-if="status === 'loading'" variant="list" :lines="5" />
    <KbEmpty v-else-if="status === 'error'" icon="failed" title="目录没有加载出来" :description="errorText" data-testid="shared-folder-error">
      <template #action><KbButton size="sm" @click="load(1)">重试</KbButton></template>
    </KbEmpty>
    <KbEmpty
      v-else-if="!listable"
      icon="folder"
      title="整个知识库的分享不能在这里列出目录"
      description="请让对方改成分享某个集合或文件夹，或者直接分享具体的文档。"
      data-testid="shared-folder-space"
    />
    <KbEmpty
      v-else-if="!hasAnyItems"
      icon="folder"
      title="这里还没有你能看到的文档"
      description="对方新建文档后会自动出现在这里。"
      data-testid="shared-folder-empty"
    />
    <template v-else>
      <div class="kb-sfold-card">
        <!-- 顶部分类药丸 Pills：全部 / 笔记 / 文档 / 代码（完全与知识库 Browser.vue 保持一致） -->
        <div v-if="categoryPills.length > 2" class="kb-sidebar-pills kb-sfold-pills">
          <div class="kb-sidebar-pill-list">
            <button
              v-for="pill in categoryPills"
              :key="pill.value"
              type="button"
              class="kb-sidebar-pill"
              :class="{ 'is-active': activeKind === pill.value }"
              :data-testid="`pill-${pill.value || 'all'}`"
              @click="setCategoryPill(pill.value)"
            >
              {{ pill.label }}<span class="kb-pill-count">{{ compact(pill.count) }}</span>
            </button>
          </div>
        </div>

        <!-- 侧栏模式切换：列表 / 目录（完全与知识库一致） -->
        <div class="kb-sidebar-nav-tabs kb-sfold-tabs">
          <button
            type="button"
            class="kb-sidebar-tab-btn"
            :class="{ 'is-active': sidebarTab === 'files' }"
            data-testid="view-flat"
            @click="sidebarTab = 'files'"
          >
            列表 <span class="mono m">{{ totalCount }}</span>
          </button>
          <button
            type="button"
            class="kb-sidebar-tab-btn"
            :class="{ 'is-active': sidebarTab === 'tree' }"
            data-testid="tab-tree"
            @click="sidebarTab = 'tree'"
          >
            目录
          </button>

          <div class="kb-sfold-tabs-spacer" />

          <KbBadge :tone="access.can.edit ? 'success' : 'neutral'" class="kb-sfold-perm-badge">
            {{ access.can.edit ? '可编辑目录' : '只读' }}
          </KbBadge>
        </div>

        <!-- 目录树视图（与知识库 Browser.vue 目录保持一致） -->
        <div v-if="sidebarTab === 'tree'" class="kb-sidebar-body kb-sfold-tree-body" role="tree" aria-label="集合">
          <!-- 根目录行 -->
          <KbTreeRow
            :label="rootLabel"
            :count="compact(totalCount)"
            :depth="0"
            :open="rootOpen"
            :active="!activeKind && !activeDir"
            data-testid="tree-root"
            @select="activeKind = ''; activeDir = ''"
            @toggle="rootOpen = !rootOpen"
          />

          <template v-if="rootOpen">
            <!-- 文档分类 -->
            <template v-if="kindCounts.doc">
              <KbTreeRow
                label="文档"
                :count="compact(kindCounts.doc)"
                :depth="1"
                :open="facetOpen.doc"
                :active="activeKind === 'doc' && !activeDir"
                data-testid="tree-facet-doc"
                @select="selectFacet('doc')"
                @toggle="facetOpen.doc = !facetOpen.doc"
              />
              <template v-if="facetOpen.doc">
                <!-- 文档下的物理子目录 -->
                <template v-for="sub in docSubFolders" :key="sub.name">
                  <KbTreeRow
                    :label="sub.name"
                    :count="compact(sub.files.length)"
                    :depth="2"
                    mono
                    :open="dirOpen[sub.name]"
                    :active="activeDir === sub.name"
                    :data-testid="`shared-folder-${sub.name}`"
                    @select="openSubDir(sub)"
                    @toggle="dirOpen[sub.name] = !dirOpen[sub.name]"
                  />
                  <template v-if="dirOpen[sub.name]">
                    <div
                      v-for="file in sub.files"
                      :key="file.id"
                      class="kb-sidebar-item kb-sfold-leaf-item"
                      :style="{ paddingLeft: 'calc(14px * 3 + 22px)' }"
                      :data-testid="`shared-row-${file.id}`"
                      @click="openFile(file)"
                    >
                      <span class="kb-fmt mono kb-item-fmt" :class="'is-' + fileChip(file.source).tone">{{ fileChip(file.source).label }}</span>
                      <span class="kb-sidebar-item-title">
                        <span class="kb-sidebar-item-name">{{ file.name }}</span>
                      </span>
                      <KbBadge :tone="file.editable ? 'success' : 'neutral'" class="kb-sfold-perm" :data-testid="`shared-perm-${file.id}`">
                        {{ file.editable ? '可编辑' : '只读' }}
                      </KbBadge>
                    </div>
                  </template>
                </template>

                <!-- 文档直接文件 -->
                <div
                  v-for="file in directDocs"
                  :key="file.id"
                  class="kb-sidebar-item kb-sfold-leaf-item"
                  :style="{ paddingLeft: 'calc(14px * 2 + 22px)' }"
                  :data-testid="`shared-row-${file.id}`"
                  @click="openFile(file)"
                >
                  <span class="kb-fmt mono kb-item-fmt" :class="'is-' + fileChip(file.source).tone">{{ fileChip(file.source).label }}</span>
                  <span class="kb-sidebar-item-title">
                    <span class="kb-sidebar-item-name">{{ file.name }}</span>
                  </span>
                  <KbBadge :tone="file.editable ? 'success' : 'neutral'" class="kb-sfold-perm" :data-testid="`shared-perm-${file.id}`">
                    {{ file.editable ? '可编辑' : '只读' }}
                  </KbBadge>
                </div>
              </template>
            </template>

            <!-- 笔记分类 -->
            <template v-if="kindCounts.insight">
              <KbTreeRow
                label="笔记"
                :count="compact(kindCounts.insight)"
                :depth="1"
                :open="facetOpen.insight"
                :active="activeKind === 'insight'"
                data-testid="tree-facet-insight"
                @select="selectFacet('insight')"
                @toggle="facetOpen.insight = !facetOpen.insight"
              />
              <template v-if="facetOpen.insight">
                <div
                  v-for="note in notesList"
                  :key="note.id"
                  class="kb-sidebar-item kb-sfold-leaf-item"
                  :style="{ paddingLeft: 'calc(14px * 2 + 22px)' }"
                  :data-testid="`shared-row-${note.id}`"
                  @click="openFile(note)"
                >
                  <span class="kb-item-icon is-note" aria-hidden="true">
                    <svg viewBox="0 0 16 16"><path d="M4 2h6l3 3v9H4z" /><path d="M6 8h5M6 11h3.5" /></svg>
                  </span>
                  <span class="kb-sidebar-item-title">
                    <span class="kb-sidebar-item-name">{{ note.name }}</span>
                  </span>
                  <KbBadge v-if="note.insight_kind" tone="neutral">{{ kindText(note.insight_kind) }}</KbBadge>
                  <KbBadge :tone="note.editable ? 'success' : 'neutral'" class="kb-sfold-perm" :data-testid="`shared-perm-${note.id}`">
                    {{ note.editable ? '可编辑' : '只读' }}
                  </KbBadge>
                </div>
              </template>
            </template>

            <!-- 代码分类 -->
            <template v-if="kindCounts.code">
              <KbTreeRow
                label="代码"
                :count="compact(kindCounts.code)"
                :depth="1"
                :open="facetOpen.code"
                :active="activeKind === 'code'"
                data-testid="tree-facet-code"
                @select="selectFacet('code')"
                @toggle="facetOpen.code = !facetOpen.code"
              />
              <template v-if="facetOpen.code">
                <div
                  v-for="code in codeFiles"
                  :key="code.id"
                  class="kb-sidebar-item kb-sfold-leaf-item"
                  :style="{ paddingLeft: 'calc(14px * 2 + 22px)' }"
                  :data-testid="`shared-row-${code.id}`"
                  @click="openFile(code)"
                >
                  <span class="kb-fmt mono kb-item-fmt" :class="'is-' + fileChip(code.source).tone">{{ fileChip(code.source).label }}</span>
                  <span class="kb-sidebar-item-title">
                    <span class="kb-sidebar-item-name">{{ code.name }}</span>
                  </span>
                  <KbBadge :tone="code.editable ? 'success' : 'neutral'" class="kb-sfold-perm" :data-testid="`shared-perm-${code.id}`">
                    {{ code.editable ? '可编辑' : '只读' }}
                  </KbBadge>
                </div>
              </template>
            </template>
          </template>
        </div>

        <!-- 列表视图（平铺列出文档，带搜索） -->
        <div v-else class="kb-sidebar-body kb-sfold-files-body">
          <div class="kb-sfold-search-bar">
            <KbInput
              v-model="searchQuery"
              placeholder="搜索当前内容..."
              clearable
              size="sm"
              class="kb-sfold-search-input"
            />
          </div>

          <div v-if="!filteredFilesList.length" class="kb-sfold-no-hit">
            没有匹配的文档
          </div>

          <template v-else>
            <div
              v-for="item in filteredFilesList"
              :key="item.id"
              class="kb-sidebar-item"
              :data-testid="`shared-row-${item.id}`"
              @click="openFile(item)"
            >
              <span v-if="item.kind === 'insight'" class="kb-item-icon is-note" aria-hidden="true">
                <svg viewBox="0 0 16 16"><path d="M4 2h6l3 3v9H4z" /><path d="M6 8h5M6 11h3.5" /></svg>
              </span>
              <span v-else class="kb-fmt mono kb-item-fmt" :class="'is-' + fileChip(item.source).tone">{{ fileChip(item.source).label }}</span>
              <span class="kb-sidebar-item-title">
                <span class="kb-sidebar-item-name">{{ item.name }}</span>
                <span class="kb-sidebar-item-dir">
                  <template v-if="item.kind === 'insight'">{{ item.insight_kind ? kindText(item.insight_kind) : '笔记' }}</template>
                  <template v-else>{{ item.sub || '文档' }}</template>
                  <span class="kb-item-dot">·</span>
                  <span>{{ relativeTime(item.updated_at) }}</span>
                </span>
              </span>
              <KbBadge v-if="item.insight_kind" tone="neutral">{{ kindText(item.insight_kind) }}</KbBadge>
              <KbBadge :tone="item.editable ? 'success' : 'neutral'" class="kb-sfold-perm" :data-testid="`shared-perm-${item.id}`">
                {{ item.editable ? '可编辑' : '只读' }}
              </KbBadge>
            </div>
          </template>

          <div v-if="more" class="kb-sfold-more">
            <KbButton data-testid="shared-folder-more" @click="load(page + 1)">加载更多</KbButton>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style>
.kb-sfold {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.kb-sfold-card {
  width: 100%;
  background: var(--surface-1);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.kb-sfold-pills {
  padding: 10px 12px 6px;
}

.kb-sfold-tabs {
  padding: 0 12px;
  align-items: center;
}

.kb-sfold-tabs-spacer {
  flex: 1;
}

.kb-sfold-perm-badge {
  flex: none;
  font-size: var(--text-11);
}

.kb-sfold-tree-body,
.kb-sfold-files-body {
  padding: 8px 12px 14px;
  min-height: 180px;
}

.kb-sfold-leaf-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 32px;
}

.kb-sfold-search-bar {
  padding: 4px 0 8px;
}

.kb-sfold-search-input {
  width: 100%;
}

.kb-sfold-no-hit {
  padding: 24px var(--sp-4);
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--text-13);
}

.kb-sfold-more {
  display: flex;
  justify-content: center;
  padding: var(--sp-3) 0 var(--sp-1);
}
</style>
