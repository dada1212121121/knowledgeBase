<script setup lang="ts">
// 任意文本文件的只读查看:后端没给原文(超过 512 KB、或扩展名不认识)时自己读原件开头 2 MB。
// 编码按内容判断(UTF-8 / UTF-16 / GB18030);发现是二进制就 emit('binary'),外层换十六进制视图。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CodeEditor from '@/components/CodeEditor.vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import { fetchOriginalHead, OriginalError } from '@/utils/fetchOriginal'
import { humanSize } from '@/utils/hexdump'
import { decodeBytes, sniffTextEncoding } from '@/utils/sniff'

const props = defineProps<{ url: string; name: string; highlightLines?: [number, number] | null }>()
const emit = defineEmits<{ binary: []; error: [message: string] }>()

const HEAD = 2 * 1024 * 1024
const text = ref('')
const encoding = ref('')
const truncated = ref(false)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
let abort: AbortController | null = null

async function load() {
  abort?.abort()
  abort = new AbortController()
  phase.value = 'loading'
  try {
    const head = await fetchOriginalHead(props.url, HEAD, abort.signal)
    const detected = sniffTextEncoding(head.bytes)
    if (!detected) {
      emit('binary')
      return
    }
    encoding.value = detected
    text.value = decodeBytes(head.bytes, detected)
    truncated.value = head.truncated
    phase.value = 'ready'
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return
    phase.value = 'error'
    message.value = error instanceof OriginalError ? error.message : '读取文件失败'
    emit('error', message.value)
  }
}
onMounted(() => void load())
watch(() => props.url, () => void load())
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <ViewerLoading v-if="phase === 'loading'" label="正在读取文件…" />
  <div v-else-if="phase === 'error'" class="kb-dr-error" role="alert">{{ message }}</div>
  <div v-else class="kb-tf">
    <div v-if="truncated" class="kb-rd-banner">文件较大，只显示前 {{ humanSize(HEAD) }}（完整内容请下载原件）。</div>
    <CodeEditor :model-value="text" :filename="name" :readonly="true" :highlight-lines="highlightLines ?? null" aria-label="文件内容(只读)" />
    <div v-if="encoding && encoding !== 'utf-8'" class="m kb-tf-note">编码：{{ encoding }}</div>
  </div>
</template>

<style>
.kb-tf {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kb-tf-note {
  font-size: var(--text-11);
}
</style>
