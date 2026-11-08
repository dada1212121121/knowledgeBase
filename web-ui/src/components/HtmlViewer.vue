<script setup lang="ts">
// 网页文件(html / htm / xhtml / mht):三种看法。
//   阅读:清洗后进阅读视图(统一排版、可高亮命中句、字号可调);
//   网页:沙箱 iframe 原样排版(不执行脚本、不联网、不能碰应用),看原始样式用;
//   源码:CodeMirror 只读。
// 无论哪种,脚本都不会执行:阅读视图过 sanitizeDocHtml,iframe 带 sandbox="" + 页内 CSP。
import DOMPurify from 'dompurify'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KbSegmented } from '@kb-ui/index'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import CodeEditor from '@/components/CodeEditor.vue'
import ReaderDoc from '@/components/ReaderDoc.vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import { fetchOriginalHead, OriginalError } from '@/utils/fetchOriginal'
import { decodeBytes, sniffTextEncoding } from '@/utils/sniff'

const props = defineProps<{ url: string; name: string; hitText?: string }>()
const emit = defineEmits<{ error: [message: string] }>()

const HEAD = 4 * 1024 * 1024
const source = ref('')
const truncated = ref(false)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
const mode = ref<'read' | 'page' | 'source'>('read')
let abort: AbortController | null = null

const modes = [
  { value: 'read', label: '阅读' },
  { value: 'page', label: '网页' },
  { value: 'source', label: '源码' },
]

/** 页面自己声明的编码(<meta charset> / http-equiv)优先,其次内容嗅探 */
function charsetOf(bytes: Uint8Array): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const match = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)
  return match?.[1]?.toLowerCase() ?? null
}

async function load() {
  abort?.abort()
  abort = new AbortController()
  phase.value = 'loading'
  try {
    const head = await fetchOriginalHead(props.url, HEAD, abort.signal)
    const declared = charsetOf(head.bytes)
    let label: string = sniffTextEncoding(head.bytes) ?? 'utf-8'
    if (declared) {
      try {
        new TextDecoder(declared)
        label = declared
      } catch {
        /* 不认识的编码名,用嗅探结果 */
      }
    }
    source.value = decodeBytes(head.bytes, label)
    truncated.value = head.truncated
    phase.value = 'ready'
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return
    phase.value = 'error'
    message.value = error instanceof OriginalError ? error.message : '读取网页失败'
    emit('error', message.value)
  }
}

/** 阅读视图用:只要 <body> 里的内容,去掉标题栏 / 导航 / 页脚这类样板 */
const readable = computed(() => {
  const doc = new DOMParser().parseFromString(source.value, 'text/html')
  for (const node of doc.querySelectorAll('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]')) node.remove()
  const main = doc.querySelector('main, article, [role="main"]') ?? doc.body
  const title = doc.title ? `<h1>${doc.title.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)}</h1>` : ''
  return title + (main?.innerHTML ?? '')
})
const sections = computed(() => [{ title: '网页', html: readable.value }])

/** 隔离渲染:保留样式,去掉一切能执行 / 联网 / 嵌入的东西;iframe 自己再加 sandbox 和 CSP */
const isolated = computed(() => {
  const clean = DOMPurify.sanitize(source.value, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'link', 'meta', 'base', 'noscript', 'video', 'audio', 'source', 'canvas'],
    FORBID_ATTR: ['srcset', 'ping', 'formaction'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,|#)/i,
  })
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>body{margin:16px;background:#fff;color:#111;font:15px/1.7 system-ui,sans-serif}img{max-width:100%}</style>${clean}`
})

onMounted(() => void load())
watch(() => props.url, () => void load())
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <ViewerLoading v-if="phase === 'loading'" label="正在读取网页…" />
  <div v-else-if="phase === 'error'" class="kb-dr-error" role="alert">{{ message }}</div>
  <div v-else class="kb-hv">
    <ViewerToolbar label="网页查看工具栏">
      <template #start>
        <span class="tag">HTML</span>
        <KbSegmented v-model="mode" :options="modes" />
      </template>
      <template #center>
        <span v-if="truncated" class="m">只显示前 4 MB</span>
      </template>
      <template #tools>
        <slot name="tools" />
      </template>
    </ViewerToolbar>
    <ReaderDoc v-if="mode === 'read'" :sections="sections" :hit-text="hitText" />
    <iframe v-else-if="mode === 'page'" class="kb-hv-frame" sandbox="" referrerpolicy="no-referrer" :srcdoc="isolated" title="网页预览(隔离)"></iframe>
    <CodeEditor v-else :model-value="source" :filename="name || 'page.html'" :readonly="true" aria-label="网页源码(只读)" />
  </div>
</template>

<style>
.kb-hv {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-hv-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.kb-hv-frame {
  flex: 1;
  min-height: 320px;
  width: 100%;
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: #fff; /* tokens-allow: 网页纸面永远是白的 */
}
</style>
