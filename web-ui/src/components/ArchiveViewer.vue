<script setup lang="ts">
// 压缩包查看:目录树(含大小)+ 点开条目预览。zip(含 jar / apk / iWork 等 zip 壳)、tar、tar.gz、单文件 gz。
//   条目预览:文本 → 带语法高亮;图片 → 缩放查看;其它 → 十六进制前 4 KB。条目 ≤ 256 KB 才读(再大提示下载整个包)。
//   窄屏(< 760)列表和预览二选一,预览里有「返回」。
// 7z / rar / bz2 / xz 浏览器端没有可用解码器,会明确说明而不是空白。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KbIcon } from '@kb-ui/index'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import { ArchiveError, openArchive, treeRows, type Archive, type ArchiveEntry } from '@/utils/archive'
import { fetchOriginal, OriginalError } from '@/utils/fetchOriginal'
import { hexLines, humanSize } from '@/utils/hexdump'
import { decodeBytes, sniffMagic, sniffTextEncoding } from '@/utils/sniff'
import { highlightToHtml } from '@/utils/staticHighlight'

const props = defineProps<{ url: string; name: string }>()
const emit = defineEmits<{ error: [message: string] }>()

const READ_MAX = 256 * 1024
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
const archive = ref<Archive | null>(null)
const filter = ref('')
const selected = ref<ArchiveEntry | null>(null)
const preview = ref<{ kind: 'text' | 'image' | 'hex' | 'big' | 'none'; html?: string; src?: string; note?: string }>({ kind: 'none' })
const previewing = ref(false)
const narrow = ref(false)
const host = ref<HTMLElement | null>(null)
let abort: AbortController | null = null
let observer: ResizeObserver | null = null
let token = 0

const rows = computed(() => {
  const all = treeRows(archive.value?.entries ?? [])
  const query = filter.value.trim().toLowerCase()
  return query ? all.filter((row) => !row.entry.dir && row.entry.path.toLowerCase().includes(query)) : all
})
const totals = computed(() => {
  const files = (archive.value?.entries ?? []).filter((entry) => !entry.dir)
  return { count: files.length, size: files.reduce((sum, entry) => sum + entry.size, 0) }
})

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }

async function load() {
  abort?.abort()
  abort = new AbortController()
  phase.value = 'loading'
  selected.value = null
  preview.value = { kind: 'none' }
  try {
    const buffer = await fetchOriginal(props.url, { signal: abort.signal })
    archive.value = await openArchive(new Uint8Array(buffer), props.name)
    phase.value = 'ready'
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return
    phase.value = 'error'
    message.value = error instanceof ArchiveError || error instanceof OriginalError ? error.message : '压缩包读取失败'
    emit('error', message.value)
  }
}

async function open(entry: ArchiveEntry) {
  if (entry.dir || !archive.value) return
  const mine = ++token
  selected.value = entry
  previewing.value = true
  if (entry.size > READ_MAX * 8) {
    preview.value = { kind: 'big', note: `这个文件有 ${humanSize(entry.size)}，不在页内展开。` }
    return
  }
  preview.value = { kind: 'none', note: '读取中…' }
  const bytes = await archive.value.read(entry, READ_MAX)
  if (mine !== token) return
  const magic = sniffMagic(bytes)
  const mime = IMAGE_MIME[magic ?? ''] ?? (/\.svg$/i.test(entry.path) ? 'image/svg+xml' : '')
  if (mime) {
    let binary = ''
    for (const value of bytes) binary += String.fromCharCode(value)
    preview.value = { kind: 'image', src: `data:${mime};base64,${btoa(binary)}` }
    return
  }
  const encoding = sniffTextEncoding(bytes)
  if (encoding && !magic) {
    const html = await highlightToHtml(decodeBytes(bytes, encoding), entry.path)
    if (mine !== token) return
    preview.value = { kind: 'text', html, note: entry.size > bytes.byteLength ? `只显示前 ${humanSize(bytes.byteLength)}` : '' }
    return
  }
  preview.value = { kind: 'hex', html: hexLines(bytes.subarray(0, 4096)).join('\n'), note: `二进制，显示前 ${humanSize(Math.min(4096, bytes.byteLength))}` }
}

function back() {
  previewing.value = false
}

onMounted(() => {
  void load()
  if (host.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => (narrow.value = (host.value?.clientWidth ?? 1000) < 760))
    observer.observe(host.value)
  }
})
watch(() => props.url, () => void load())
onBeforeUnmount(() => {
  abort?.abort()
  observer?.disconnect()
})
</script>

<template>
  <div ref="host" class="kb-av">
    <ViewerLoading v-if="phase === 'loading'" label="正在读取压缩包目录…" />
    <div v-else-if="phase === 'error'" class="kb-dr-error" role="alert">{{ message }}</div>
    <div v-else class="kb-av-body" :class="{ 'is-narrow': narrow, 'is-previewing': previewing }">
      <section class="kb-av-list" aria-label="压缩包内容">
        <ViewerToolbar class="kb-av-bar" label="压缩包信息">
          <template #start>
            <span class="tag">{{ archive?.kind === 'tar' ? 'TAR' : archive?.kind === 'gzip-file' ? 'GZ' : 'ZIP' }}</span>
            <span class="m">{{ totals.count }} 个文件 · {{ humanSize(totals.size) }}</span>
          </template>
          <template #tools>
            <slot name="tools" />
          </template>
        </ViewerToolbar>
        <input v-model="filter" class="kb-av-filter" type="search" placeholder="按路径筛选…" aria-label="按路径筛选" />
        <div class="kb-av-rows" role="tree">
          <button
            v-for="row in rows"
            :key="row.entry.path"
            type="button"
            class="kb-av-row"
            :class="{ 'is-dir': row.entry.dir, 'is-on': selected?.path === row.entry.path }"
            :style="{ paddingLeft: `${8 + (filter ? 0 : row.depth) * 16}px` }"
            :disabled="row.entry.dir"
            role="treeitem"
            :aria-selected="selected?.path === row.entry.path"
            @click="open(row.entry)"
          >
            <KbIcon :name="row.entry.dir ? 'folder' : 'doc'" :size="12" />
            <span class="kb-av-name" :title="row.entry.path">{{ filter ? row.entry.path : row.name }}</span>
            <span v-if="!row.entry.dir" class="mono m kb-av-size">{{ humanSize(row.entry.size) }}</span>
          </button>
          <p v-if="!rows.length" class="m kb-av-none">没有匹配的文件</p>
        </div>
      </section>
      <section class="kb-av-preview" aria-label="内容预览">
        <div v-if="selected" class="kb-av-phead">
          <button v-if="narrow" type="button" class="btn sm" @click="back"><KbIcon name="chevron" :size="12" class="kb-av-back" /> 返回</button>
          <b class="kb-av-ptitle" :title="selected.path">{{ selected.path }}</b>
          <span class="m">{{ humanSize(selected.size) }}</span>
        </div>
        <div v-if="!selected" class="kb-av-empty m">在左侧选一个文件预览</div>
        <!-- eslint-disable vue/no-v-html -- 高亮结果已转义 -->
        <pre v-else-if="preview.kind === 'text'" class="kb-av-text kb-tok mono" v-html="preview.html"></pre>
        <!-- eslint-enable vue/no-v-html -->
        <div v-else-if="preview.kind === 'image'" class="kb-av-image"><img :src="preview.src" :alt="selected.path" /></div>
        <pre v-else-if="preview.kind === 'hex'" class="kb-av-text mono">{{ preview.html }}</pre>
        <p v-else class="m kb-av-empty">{{ preview.note }}</p>
        <p v-if="selected && preview.note && preview.kind !== 'big' && preview.kind !== 'none'" class="m kb-av-note">{{ preview.note }}</p>
      </section>
    </div>
  </div>
</template>

<style>
.kb-av {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.kb-av-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: var(--surface-1);
  overflow: hidden;
}
.kb-av-list {
  width: min(380px, 42%);
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: var(--hl) solid var(--b);
}
.kb-av-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
}
.kb-av-filter {
  margin: 0 8px 6px;
  height: var(--ctl-h);
  padding: 0 8px;
  color: var(--t);
  background: var(--input-bg);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r1);
}
.kb-av-filter:focus {
  outline: none;
  border-color: var(--ac);
}
.kb-av-rows {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 4px 8px;
}
.kb-av-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: var(--ctl-h);
  padding-right: 8px;
  text-align: left;
  color: var(--t2);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  cursor: pointer;
}
.kb-av-row.is-dir {
  color: var(--m);
  cursor: default;
}
.kb-av-row:not(.is-dir):hover {
  background: var(--hover);
  color: var(--t);
}
.kb-av-row.is-on {
  background: var(--accent-soft);
  color: var(--t);
}
.kb-av-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-av-size {
  flex: none;
  font-size: calc(11px * var(--fs));
}
.kb-av-none {
  padding: 16px;
  text-align: center;
}
.kb-av-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.kb-av-phead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: var(--hl) solid var(--b);
}
.kb-av-ptitle {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-av-back {
  transform: rotate(90deg);
}
.kb-av-empty {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
}
.kb-av-text {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px 14px;
  overflow: auto;
  font-size: calc(13px * var(--fs));
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
}
.kb-av-image {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 12px;
  overflow: auto;
}
.kb-av-image img {
  max-width: 100%;
  max-height: 100%;
  background: repeating-conic-gradient(rgba(var(--ink), 0.06) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
}
.kb-av-note {
  margin: 0;
  padding: 4px 12px;
  border-top: var(--hl) solid var(--b);
}
.kb-av-body.is-narrow .kb-av-list {
  width: 100%;
  border-right: 0;
}
.kb-av-body.is-narrow:not(.is-previewing) .kb-av-preview,
.kb-av-body.is-narrow.is-previewing .kb-av-list {
  display: none;
}
@media (pointer: coarse) {
  .kb-av-row {
    min-height: 44px;
  }
  .kb-av-filter {
    min-height: 36px;
    font-size: calc(16px * var(--fs));
  }
}
</style>
