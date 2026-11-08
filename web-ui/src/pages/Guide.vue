<script setup lang="ts">
// 使用指南:所有登录用户都能看的操作说明,内容来自 docs/guide/USER_GUIDE.md(只维护这一份,
// 离线 HTML 和 PDF 也由它生成,见 scripts/build-guide.ts)。
//   - 宽屏:左侧是正文,右侧粘性目录;窄屏:目录折成正文上方的「目录」。
//   - 页内链接(#锚点)手动滚动并把焦点移到标题:路由是 history 模式,默认的锚点跳转会被当成路由变化。
//   - AI 总开关关闭时,指南里 `::: ai` 标出的段落整段不显示(术语表:AI 关闭后全站没有 AI 字样)。
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { KbPageHeader, useMedia } from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import AiGuideCard from '@/components/AiGuideCard.vue'
import InAppDownloadNote from '@/components/InAppDownloadNote.vue'
import { useSessionStore } from '@/stores/session'
import { sanitizeMarkdownHtml } from '@/utils/sanitizeHtml'
import { GUIDE_DOWNLOAD_NAMES, GUIDE_FILES, renderGuide } from '@/utils/guideDoc'
import source from '../../../docs/guide/USER_GUIDE.md?raw'
import '@/styles/guide.css'

const route = useRoute()
const session = useSessionStore()
const article = ref<HTMLElement | null>(null)
const wide = useMedia('(min-width: 900px)')

const doc = computed(() => renderGuide(source, { ai: session.aiEnabled }))
// 清洗之后 id 还在(标题锚点),外链的 target 会被去掉,点击时由 onClick 统一处理
const html = computed(() => sanitizeMarkdownHtml(doc.value.html))

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

function jump(id: string) {
  // 逐个比较 id,不拼选择器:地址里的 #锚点 是用户可控的字符串,拼进选择器要处理转义
  const target = [...(article.value?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((el) => el.id === id)
  if (!target) return
  target.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })
  // 标题本来不能聚焦;临时给 tabindex,读屏软件和键盘用户的位置才会跟过去
  target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
}

function onClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a')
  const href = link?.getAttribute('href') ?? ''
  if (!link || event.defaultPrevented) return
  if (href.startsWith('#')) {
    event.preventDefault()
    jump(decodeURIComponent(href.slice(1)))
    return
  }
  // 外链:清洗时 target 被去掉了,这里补上新窗口 + noopener;Ctrl / ⌘ / 中键保持浏览器默认
  if (/^https?:\/\//i.test(href) && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
    event.preventDefault()
    window.open(href, '_blank', 'noopener,noreferrer')
  }
}

// 从别处带着 #锚点 进来(例如令牌卡片里的「怎么用」)
onMounted(async () => {
  if (!route.hash) return
  await nextTick()
  jump(decodeURIComponent(route.hash.slice(1)))
})
</script>

<template>
  <AppShell>
    <template #breadcrumb><b>使用指南</b></template>
    <div class="kb-guide" data-testid="guide">
      <KbPageHeader title="使用指南" description="创建访问令牌、用 MCP 连接客户端、放进和更新内容。">
        <template #actions>
          <a class="btn pri" :href="GUIDE_FILES.pdf" :download="GUIDE_DOWNLOAD_NAMES.pdf" data-testid="guide-pdf">下载 PDF</a>
          <a class="btn" :href="GUIDE_FILES.html" :download="GUIDE_DOWNLOAD_NAMES.html" data-testid="guide-html">下载网页版</a>
        </template>
      </KbPageHeader>
      <InAppDownloadNote />
      <!-- 在操作说明上方:每个用户自己的 AI 接入指南(带本人的 admin key,可下载) -->
      <AiGuideCard />

      <div class="kb-guide-body">
        <!-- 宽屏:目录常驻,不给可折叠的 summary(键盘按 Enter 也不能把它折没);窄屏:折在正文上面,点开才占地方 -->
        <nav class="kb-guide-toc" aria-label="目录" data-testid="guide-toc">
          <component :is="wide ? 'div' : 'details'" class="kb-guide-toc-fold">
            <component :is="wide ? 'b' : 'summary'" class="kb-guide-toc-title">目录</component>
            <ol>
              <li v-for="item in doc.headings" :key="item.id" :class="{ 'is-sub': item.level === 3 }">
                <a :href="`#${item.id}`" @click.prevent="jump(item.id)">{{ item.text }}</a>
              </li>
            </ol>
          </component>
        </nav>
        <!-- eslint-disable vue/no-v-html -- 源文是仓库里的受信 Markdown,渲染时已关闭原始 HTML,又过了一遍 DOMPurify -->
        <article ref="article" class="kb-guide-article" data-testid="guide-article" @click="onClick" v-html="html"></article>
        <!-- eslint-enable vue/no-v-html -->
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.kb-guide { display: flex; flex-direction: column; gap: var(--gap); width: 100%; min-width: 0; }
.kb-guide-body { display: grid; grid-template-columns: minmax(0, 1fr) 15em; gap: var(--gap-xl, 24px); align-items: start; min-width: 0; }
/* 正文的阅读宽度(46em)在 guide.css 里定,那里用 margin:0 auto 居中是为了离线 HTML/PDF;
   页面内居中会让正文比页头、上面的卡片向右缩进 126px,整页的左基准线断掉,所以页面里改成左对齐 */
.kb-guide-body > .kb-guide-article { grid-column: 1; grid-row: 1; width: 100%; margin: 0; font-size: calc(15px * var(--fs)); }
/* guide.css 的 1.7em 是给离线 HTML/PDF 定的(正文 16px 时标题 27px);页面里正文字号 15px,
   一级标题按 1.7em 算 25.5px,比页头标题(20px)还大,层级是反的。页面内把文档标题压到与页头同级,
   二三级依次落下来;离线导出仍用 guide.css 的字号 */
.kb-guide-body :deep(.kb-guide-article h1) { font-size: calc(20px * var(--fs)); }
.kb-guide-body :deep(.kb-guide-article h2) { font-size: calc(17px * var(--fs)); }
.kb-guide-body :deep(.kb-guide-article h3) { font-size: calc(15px * var(--fs)); font-weight: 600; }
.kb-guide-toc { grid-column: 2; grid-row: 1; position: sticky; top: var(--gap); max-height: calc(100dvh - 8em); overflow: auto; font-size: calc(13px * var(--fs)); }
.kb-guide-toc-title { display: block; font-weight: 600; padding: var(--sp-2) 0; list-style: none; }
.kb-guide-toc-title::-webkit-details-marker { display: none; }
.kb-guide-toc ol { margin: 0; padding: 0; list-style: none; border-left: var(--hl) solid var(--b2); }
.kb-guide-toc li a { display: block; padding: 5px var(--sp-3); color: var(--t2); text-decoration: none; border-radius: 0 var(--r1) var(--r1) 0; }
.kb-guide-toc li.is-sub a { padding-left: var(--sp-5); color: var(--m); }
.kb-guide-toc li a:hover { color: var(--t); background: var(--hover); }
.kb-guide-toc li a:focus-visible { outline: none; box-shadow: var(--ring); }
@media (max-width: 899px) {
  /* 窄屏:目录排到正文上面,默认收起,点开是整行列表;触屏上每一项至少 44px 高 */
  .kb-guide-body { grid-template-columns: minmax(0, 1fr); }
  .kb-guide-body > .kb-guide-article { grid-row: 2; }
  .kb-guide-toc { grid-column: 1; grid-row: 1; position: static; max-height: none; border: var(--hl) solid var(--b2); border-radius: var(--r2); padding: 0 var(--sp-3); }
  .kb-guide-toc-title { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
}
@media (pointer: coarse) {
  .kb-guide-toc li a { min-height: 44px; display: flex; align-items: center; }
}
</style>
