<script setup lang="ts">
// 扩展名认不出来的文件:读原件、看魔数和容器内部,告诉外层该当什么格式来看。
// 本身不画界面(只有加载中的占位),结论走 resolved 事件。读不到原件时 emit('failed'),外层退回十六进制 / 文字层。
import JSZip from 'jszip'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import { fetchOriginal } from '@/utils/fetchOriginal'
import { openOle } from '@/utils/legacyOffice'
import { resolveSniffed, sniffMagic, type Resolved } from '@/utils/sniff'

const props = defineProps<{ url: string }>()
const emit = defineEmits<{ resolved: [value: Resolved]; failed: [message: string] }>()

const label = ref('正在识别文件类型…')
let abort: AbortController | null = null

async function run() {
  abort?.abort()
  abort = new AbortController()
  try {
    const buffer = await fetchOriginal(props.url, { signal: abort.signal })
    const bytes = new Uint8Array(buffer)
    const magic = sniffMagic(bytes)
    let zipNames: string[] = []
    let zipMime = ''
    let oleNames: string[] = []
    if (magic === 'zip') {
      try {
        const zip = await JSZip.loadAsync(bytes)
        zipNames = Object.keys(zip.files)
        zipMime = (await zip.file('mimetype')?.async('string'))?.trim() ?? ''
      } catch {
        /* 读不开就按普通压缩包处理,ArchiveViewer 会给出具体原因 */
      }
    } else if (magic === 'ole') {
      try {
        oleNames = openOle(bytes).names
      } catch {
        /* 同上,落到二进制 */
      }
    }
    emit('resolved', resolveSniffed(bytes, zipNames, zipMime, oleNames))
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return
    emit('failed', error instanceof Error ? error.message : '读取文件失败')
  }
}
onMounted(() => void run())
watch(() => props.url, () => void run())
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <ViewerLoading :label="label" />
</template>
