<script setup lang="ts">
// 二进制文件:十六进制 + ASCII 对照(前 64 KB),顶部说明识别出的类型。没有渲染器的格式最后都落到这里,
// 至少能看到文件头、魔数和里面夹带的字符串,而不是一句「没有可预览的内容」。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import { fetchOriginalHead, OriginalError } from '@/utils/fetchOriginal'
import { hexLines, humanSize } from '@/utils/hexdump'
import { sniffMagic } from '@/utils/sniff'

const props = defineProps<{ url: string; name: string; reason?: string }>()

const HEAD = 64 * 1024
const KINDS: Record<string, string> = {
  pdf: 'PDF 文档', zip: 'ZIP 容器', ole: 'Microsoft 复合文档（OLE）', gzip: 'gzip 压缩', bzip2: 'bzip2 压缩', xz: 'xz 压缩', '7z': '7-Zip 压缩包',
  rar: 'RAR 压缩包', png: 'PNG 图片', jpg: 'JPEG 图片', gif: 'GIF 图片', webp: 'WebP 图片', bmp: 'BMP 图片', tiff: 'TIFF 图片', heic: 'HEIC 图片',
  ico: 'ICO 图标', mp3: 'MP3 音频', wav: 'WAV 音频', flac: 'FLAC 音频', ogg: 'Ogg 媒体', mp4: 'MP4 / MOV 媒体', webm: 'WebM / MKV 媒体', avi: 'AVI 视频',
}
const bytes = ref<Uint8Array>(new Uint8Array())
const truncated = ref(false)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
let abort: AbortController | null = null

const kind = computed(() => KINDS[sniffMagic(bytes.value) ?? ''] ?? '')
const dump = computed(() => hexLines(bytes.value).join('\n'))

async function load() {
  abort?.abort()
  abort = new AbortController()
  phase.value = 'loading'
  try {
    const head = await fetchOriginalHead(props.url, HEAD, abort.signal)
    bytes.value = head.bytes
    truncated.value = head.truncated
    phase.value = 'ready'
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return
    phase.value = 'error'
    message.value = error instanceof OriginalError ? error.message : '读取文件失败'
  }
}
onMounted(() => void load())
watch(() => props.url, () => void load())
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <ViewerLoading v-if="phase === 'loading'" label="正在读取文件…" />
  <div v-else-if="phase === 'error'" class="kb-dr-error" role="alert">{{ message }}</div>
  <div v-else class="kb-bv">
    <ViewerToolbar class="kb-bv-head" aria-label="二进制文件信息栏" :sticky="false">
      <template #start>
        <b :title="name">{{ name }}</b>
        <span class="tag">二进制</span>
        <span v-if="kind" class="tag ac">{{ kind }}</span>
      </template>
      <template #end>
        <span class="m">{{ truncated ? `显示前 ${humanSize(HEAD)}` : `${humanSize(bytes.byteLength)}` }}</span>
        <slot name="tools" />
      </template>
    </ViewerToolbar>
    <p v-if="reason" class="m kb-bv-reason">{{ reason }}</p>
    <p v-else class="m kb-bv-reason">这种格式没有页内渲染器，下面是文件内容的十六进制视图；需要完整内容请下载原件。</p>
    <pre class="kb-bv-dump mono" tabindex="0" aria-label="十六进制内容">{{ dump }}</pre>
  </div>
</template>

<style>
.kb-bv {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: var(--surface-sunken);
}
.kb-bv-head {
  border-radius: var(--r1);
  background: var(--surface-1);
}
.kb-bv-head b {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kb-bv-reason {
  margin: 0;
}
.kb-bv-dump {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  color: var(--t2);
  background: var(--surface-1);
  border: var(--hl) solid var(--b);
  border-radius: var(--r1);
  font-size: var(--text-12);
  line-height: 1.6;
  outline: none;
}
@media (max-width: 599px) {
  .kb-bv-dump {
    font-size: var(--text-11);
  }
}
</style>
