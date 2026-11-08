<script setup lang="ts">
// 「转成文章再读」的格式统一入口:老 Word(.doc)、老 PPT(.ppt)、ODT、ODP、RTF、EPUB、邮件(eml / mbox / msg)。
// 读原件字节 → 对应转换器(按需加载)→ ReaderDoc。转换失败(加密 / 损坏 / 格式不对)emit('error'),外层退回提示。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ReaderDoc, { type ReaderSection } from '@/components/ReaderDoc.vue'
import ViewerLoading from '@/components/ViewerLoading.vue'
import { blocksToHtml, mailToHtml, pptSlidesToSections } from '@/utils/docHtml'
import { fetchOriginal, OriginalError } from '@/utils/fetchOriginal'
import { sanitizeDocHtml } from '@/utils/sanitizeHtml'

const props = defineProps<{
  url: string
  /** doc | ppt | odt | odp | rtf | epub | eml | mbox | msg */
  format: string
  hitText?: string
  heading?: string
}>()
const emit = defineEmits<{ error: [message: string] }>()

const sections = ref<ReaderSection[]>([])
const banner = ref('')
const title = ref('')
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const message = ref('')
let abort: AbortController | null = null
let disposed = false

const LEGACY_NOTE = '旧版二进制格式：只显示文字与表格，不含版式、图片和评论。需要完整版面请下载原件。'

function fail(text: string) {
  phase.value = 'error'
  message.value = text
  emit('error', text)
}

async function convert(bytes: Uint8Array, kind: string): Promise<{ sections: ReaderSection[]; banner: string; title: string }> {
  switch (kind) {
    case 'doc': {
      const { extractDoc } = await import('@/utils/legacyOffice')
      return { sections: [{ title: '正文', html: blocksToHtml(extractDoc(bytes)) }], banner: LEGACY_NOTE, title: '' }
    }
    case 'ppt': {
      const { extractPpt } = await import('@/utils/legacyOffice')
      return { sections: pptSlidesToSections(extractPpt(bytes)), banner: LEGACY_NOTE, title: '' }
    }
    case 'odt': {
      const { odtToHtml } = await import('@/utils/odf')
      return { sections: [{ title: '正文', html: await odtToHtml(bytes) }], banner: '', title: '' }
    }
    case 'odp': {
      const { odpToSlides } = await import('@/utils/odf')
      const slides = await odpToSlides(bytes)
      return {
        sections: slides.map((slide, at) => ({
          title: slide.title || `第 ${at + 1} 张`,
          html: `<h2>${slide.title.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!) || `第 ${at + 1} 张`}</h2>${slide.html}${slide.notes ? `<hr><blockquote><p><b>演讲者备注</b></p><p>${slide.notes.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!).replace(/\n/g, '<br>')}</p></blockquote>` : ''}`,
        })),
        banner: '',
        title: '',
      }
    }
    case 'rtf': {
      const { rtfToHtml } = await import('@/utils/rtf')
      const html = rtfToHtml(new TextDecoder('windows-1252').decode(bytes))
      if (!html.trim()) throw new OriginalError('RTF 里没有可显示的文字')
      return { sections: [{ title: '正文', html }], banner: '', title: '' }
    }
    case 'epub': {
      const { openEpub } = await import('@/utils/epub')
      const book = await openEpub(bytes)
      return {
        sections: book.chapters.map((chapter, at) => ({ title: chapter.title, load: () => book.load(at) })),
        banner: '',
        title: [book.title, book.author].filter(Boolean).join(' · '),
      }
    }
    case 'eml':
    case 'emlx': {
      const { parseEml } = await import('@/utils/mail')
      return { sections: [{ title: '邮件', html: mailToHtml(parseEml(bytes)) }], banner: '', title: '' }
    }
    case 'mbox': {
      const { parseMbox } = await import('@/utils/mail')
      const mails = parseMbox(bytes)
      if (!mails.length) throw new OriginalError('邮箱文件里没有邮件')
      return { sections: mails.map((mail, at) => ({ title: mail.subject || `邮件 ${at + 1}`, html: mailToHtml(mail) })), banner: '', title: '' }
    }
    case 'msg': {
      const { parseMsg } = await import('@/utils/mail')
      return { sections: [{ title: '邮件', html: mailToHtml(parseMsg(bytes)) }], banner: '', title: '' }
    }
    default:
      throw new OriginalError(`不支持的格式：${kind}`)
  }
}

async function load() {
  abort?.abort()
  abort = new AbortController()
  disposed = false
  phase.value = 'loading'
  try {
    const buffer = await fetchOriginal(props.url, { signal: abort.signal })
    if (disposed) return
    const result = await convert(new Uint8Array(buffer), props.format.toLowerCase())
    if (disposed) return
    // 先清洗再显示:转换器输出的 HTML 不信任
    sections.value = result.sections.map((section) => (section.html === undefined ? section : { ...section, html: sanitizeDocHtml(section.html) }))
    banner.value = result.banner
    title.value = result.title
    phase.value = 'ready'
  } catch (error) {
    if (disposed || (error as Error)?.name === 'AbortError') return
    fail(error instanceof Error && error.message ? error.message : '这个文件无法在页内阅读')
  }
}

onMounted(() => void load())
watch(() => [props.url, props.format], () => void load())
onBeforeUnmount(() => {
  disposed = true
  abort?.abort()
})
</script>

<template>
  <ViewerLoading v-if="phase === 'loading'" label="正在读取并转换文档…" />
  <div v-else-if="phase === 'error'" class="kb-dr-error" role="alert">{{ message }}</div>
  <ReaderDoc v-else :sections="sections" :banner="banner" :hit-text="hitText" :heading="heading || title">
    <template #tools><slot name="tools" /></template>
  </ReaderDoc>
</template>

<style>
.kb-dr-error {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  color: var(--t2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  background: var(--surface-sunken);
}
</style>
