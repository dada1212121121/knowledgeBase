<script setup lang="ts">
// 阅读态 Markdown 正文。
//
// 为什么不用编辑器外壳的文本面来读:
// 文本面是所见即所得编辑器,只读也照样建 ProseMirror + 插件栈,一篇 200 KB 的笔记要付整个内核的成本,
// 而且阅读时根本用不到光标 / 命令。(起这是全站唯一的 Markdown 阅读管线:助手回答、分享页、文件预览共用;
// 原来的 md-editor-v3 预览整包近 900 KB 且有未修复的 XSS 公告,已卸载。)
// 所以阅读态单独一条极简管线:markdown-it 解析 → DOMPurify 清洗 → 链接改写 → 按需增强(公式 / 流程图)。
//
// 三条硬边界:
// 1. 原始 HTML 一律不开(`html: false`),渲染结果再过一遍 `sanitizeMarkdownHtml`;
// 2. 公式 / 流程图只在正文里真的出现时动态 import,普通笔记不为它们付一个字节;
// 3. 只改渲染出来的 DOM,Markdown 原文一个字都不动。
//
// 大文档渐进渲染(`progressive`):
// 200 KB 的笔记整篇「解析 → 清洗 → 挂 DOM → 布局」是一条 300~400 ms 的长任务(4× 降速实测),打开期间卡住输入和滚动。
// 超过阈值的正文改走分段管线:整篇在同源模块 Worker 里解析一次(引用式链接、松散列表这类跨块语义与整篇一致),
// 按顶层块切成几 KB 一段的 HTML;主线程每帧只清洗并挂上几段,段与段之间让出主线程,先出的段立刻可读可滚。
// 目录的标题列表由 Worker 一次给全;点到还没挂上的标题时,先把它之前的段挂完再滚过去(ensureHeading)。
// 打印前同步把剩下的段挂完(beforeprint),不会打印出半篇。小文档(以及没开 progressive 的调用方:助手流式回答等)仍然同步一次渲染完。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { mermaidFailureText } from '@/utils/chunkError'
import { ATTACHMENT_MARK, attachmentExt, attachmentKind, attachmentMeta } from '@/utils/attachments'
import { splitImageWidth } from '@/utils/imageSize'
import '@/styles/attachCard.css'
import '@/styles/proseMarks.css'
import '@/styles/kbColor.css'
import { sanitizeMarkdownHtml } from '@/utils/sanitizeHtml'
import { createMarkdownRenderer, type MarkdownHeading } from '@/utils/markdownRenderer'
import { renderMarkdownChunksAsync } from '@/utils/markdownChunksAsync'
import { adaptBatch, afterNextFrame, yieldToMain } from '@/utils/frameYield'
import { resolveDocLinkClick, rewriteDocLinks, type DocLinkOptions, type DocLinkRoot } from '@/utils/docLinkDom'
import type { LinkContext, LinkState } from '@/utils/links'

const props = withDefaults(
  defineProps<{
    source: string
    /** 当前文档位置;不给就不改写链接(只渲染纯文本)。 */
    linkContext?: LinkContext | null
    /** 链接体检结果:缺目标 / 没权限会标出来,点击时给一句原因。 */
    linkStates?: Record<string, LinkState>
    /** 分享页不允许跳笔记。 */
    allowNotes?: boolean
    /** 点击文件链接时在新窗口打开(分享页没有查看器可切换)。 */
    openInNewTab?: boolean
    /**
     * 大文档渐进渲染(见文件头)。只给「整篇文档」的阅读页打开:内容会一段一段长出来,
     * 而助手的流式回答每个 token 都换一次 source,从头分段只会闪烁。
     */
    progressive?: boolean
  }>(),
  { linkContext: null, linkStates: () => ({}), allowNotes: true, openInNewTab: false, progressive: false },
)
const emit = defineEmits<{
  openAttachment: [target: { collection: string; path: string; fragment?: string }]
  openNote: [id: string]
  linkError: [message: string]
  /** 渲染后的小节列表(标题级别 + 文本),目录用它;文档切换 / 改动都会重发 */
  headings: [value: { level: number; text: string }[]]
}>()

/** 超过这么多字符才走渐进渲染（约 16 KB：同步渲染 + 布局在 4× 降速下已经接近一条长任务） */
const PROGRESSIVE_MIN_CHARS = 16_000
/** 每一批挂多少 HTML 字符：一批的清洗 + 挂载 + 随后那一帧的布局都要压在长任务线（50 ms）之内，按实测帧耗时自适应 */
const BATCH_START_CHARS = 4500
const BATCH_MIN_CHARS = 1800
const BATCH_MAX_CHARS = 16_000
/**
 * 第一批只挂一段（Worker 切出来的第一段本来就小，见 FIRST_CHUNK_CHARS）：第一次布局要付一笔和内容多少无关的预热开销
 * （字体回退 / 字形缓存，4× 降速下 20~30 ms），再叠上一整批正文，这一帧就会越过长任务线。
 */
const BATCH_FIRST_CHARS = 1
/** 一帧（从这批挂完到下一个任务开始）超过它就缩小批量，低于下限就放大 */
const FRAME_SLOW_MS = 34
const FRAME_FAST_MS = 22
/** 目录跳转要「先渲染到那里」时，每个切片最多干多久再让出主线程 */
const TURBO_SLICE_MS = 12

const host = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
/** 渲染进度，写在根节点的 data-render 上：渐进渲染全部落到 DOM 才是 done（基线脚本据此确定长任务观测窗口的终点） */
const renderState = ref<'rendering' | 'done'>('done')
/** 异步增强(公式 / 流程图)的序号:文档换了一次,旧的渲染结果不能再往新 DOM 上写 */
let seq = 0
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
let katexReady: Promise<typeof import('katex')> | null = null

/** 一次渐进渲染的状态：Worker 给的 HTML 段，以及挂到了第几段 */
interface Job {
  chunks: string[]
  /** 下一个要挂的段 */
  next: number
  headings: MarkdownHeading[]
  headingsThrough: number[]
}
let job: Job | null = null

// 解析器只有同步路径才在主线程用（小文档 / 未开 progressive）：大文档在 Worker 里解析，主线程不必为它付构造开销（注册规则、编译正则）
let md: ReturnType<typeof createMarkdownRenderer> | null = null
const renderer = () => (md ??= createMarkdownRenderer())

const linkOptions = (): DocLinkOptions => ({
  context: props.linkContext as LinkContext,
  linkStates: props.linkStates,
  allowNotes: props.allowNotes,
  outsideMessage: props.openInNewTab ? '这个链接不在本次分享的范围内' : '没有权限打开这个链接',
})

/** 标题列表:取清洗后的 DOM,和用户真正看到的标题一致(源码里的 `#` 不算)。 */
function collectHeadings(root: HTMLElement): MarkdownHeading[] {
  return [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].map((node) => ({
    level: Number(node.tagName.slice(1)),
    text: (node.textContent ?? '').trim(),
  }))
}

/** 任务列表:markdown-it 不认 `- [ ]` 的勾选框,这里把开头的标记换成只读勾选框(阅读态不可改)。 */
function decorateTasks(root: DocLinkRoot): void {
  for (const item of root.querySelectorAll<HTMLLIElement>('li')) {
    const first = item.firstChild
    if (!first || first.nodeType !== Node.TEXT_NODE) continue
    const match = /^\s*\[([ xX])\]\s+/.exec(first.nodeValue ?? '')
    if (!match) continue
    first.nodeValue = (first.nodeValue ?? '').slice(match[0].length)
    const box = document.createElement('span')
    box.className = match[1] === ' ' ? 'kb-task-box' : 'kb-task-box is-done'
    box.setAttribute('role', 'img')
    box.setAttribute('aria-label', match[1] === ' ' ? '未完成' : '已完成')
    item.classList.add('kb-task-item')
    item.insertBefore(box, item.firstChild)
  }
}

/** 宽表格:包一层横向滚动容器(手机上 4 列带长路径的表会把正文撑破)。 */
function decorateTables(root: DocLinkRoot): void {
  for (const table of [...root.querySelectorAll<HTMLTableElement>('table')]) {
    if (table.parentElement?.classList.contains('kb-table-scroll')) continue
    const box = document.createElement('div')
    box.className = 'kb-table-scroll'
    table.replaceWith(box)
    box.append(table)
  }
}

/**
 * 附件链接 `[📎 名字](地址 "大小")` → 附件卡片（和编辑器里同一个样式，见 styles/attachCard.css）：
 * 去掉 📎 标记、给链接本身加 kb-attach / 类型色 / 扩展名 / 「类型 · 大小」。点击仍是原来的链接行为（打开预览 / 下载）
 */
function decorateAttachments(root: ParentNode): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const text = link.textContent ?? ''
    if (!text.startsWith(ATTACHMENT_MARK)) continue
    const name = text.slice(ATTACHMENT_MARK.length).trim()
    if (!name) continue
    link.textContent = name
    link.classList.add('kb-attach', `is-${attachmentKind(name)}`)
    link.dataset.ext = attachmentExt(name)
    link.dataset.meta = attachmentMeta(name, link.getAttribute('title') ?? '')
    // 卡片上已经有「类型 · 大小」，悬停再弹一个同样的 title 提示是重复的
    link.removeAttribute('title')
  }
}

/** 图片地址里的 `#w=宽度` 拆出来写成 width 属性（高度不写，浏览器按原图比例算）：阅读时和编辑时显示的大小一样 */
function applyImageWidths(root: ParentNode): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const { src, width } = splitImageWidth(image.getAttribute('src') ?? '')
    if (!width) continue
    image.setAttribute('src', src)
    image.setAttribute('width', String(width))
  }
}

/**
 * 一段 HTML → 清洗 + 全部装饰 → 可以直接挂上去的片段。
 * 装饰在 `<template>` 的片段里做，不在已经挂上的 DOM 里改：片段里的 <img> 不会先按原始相对路径发一次请求，
 * 也不会让浏览器对「挂上去又被改掉」的节点多算一遍样式。
 */
function prepare(htmlText: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = sanitizeMarkdownHtml(htmlText)
  const fragment = template.content
  decorateTasks(fragment)
  decorateTables(fragment)
  // 先拆图片宽度（地址里的 #w=）再改写地址：改写链接的逻辑不该碰到这个片段
  applyImageWidths(fragment)
  decorateAttachments(fragment)
  if (props.linkContext) rewriteDocLinks(fragment, linkOptions())
  return fragment
}

/** 行内公式 / 公式块:占位节点换成 katex 输出。katex 只在真的出现公式时才下载。 */
async function enhanceMath(root: HTMLElement, current: number): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>('.kb-math')]
  if (!nodes.length) return
  const { default: katex } = await (katexReady ??= import('katex').then(async (mod) => {
    // 样式跟着公式一起进来:CSS 不进来,渲染出来的公式会是一堆没有排版的 span
    await import('katex/dist/katex.min.css')
    return mod
  }))
  if (current !== seq) return
  let sliceStart = performance.now()
  for (const node of nodes) {
    // 公式很多的文档：每干满一个切片就让出一次，不把渲染几百个公式做成一条长任务
    if (performance.now() - sliceStart > TURBO_SLICE_MS) {
      await yieldToMain()
      if (current !== seq) return
      sliceStart = performance.now()
    }
    const tex = node.dataset.tex ?? node.textContent ?? ''
    try {
      node.innerHTML = katex.renderToString(tex, {
        displayMode: node.classList.contains('is-block'),
        throwOnError: false,
        trust: false,
        output: 'html',
      })
      node.classList.add('is-rendered')
    } catch {
      // 公式写错不炸整篇:保留 TeX 原文,给一个可辨认的样式
      node.classList.add('is-error')
    }
  }
}

/** 流程图:把 ```mermaid 代码块换成图;失败保留代码块并给一行原因。 */
async function enhanceMermaid(root: HTMLElement, current: number): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')].filter((code) =>
    /(^|\s)language-mermaid(\s|$)/.test(code.className),
  )
  if (!blocks.length) return
  mermaidReady ??= import('mermaid').then((mod) => {
    mod.default.initialize({
      startOnLoad: false,
      // strict:图里的 HTML 标签 / 点击回调一律不执行,正文来源不可信
      securityLevel: 'strict',
      theme: document.documentElement.getAttribute('data-tone') === 'light' ? 'default' : 'dark',
      fontFamily: 'inherit',
    })
    return mod.default
  })
  const mermaid = await mermaidReady
  if (current !== seq) return
  let index = 0
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre) continue
    try {
      const { svg } = await mermaid.render(`kb-md-mermaid-${++index}`, code.textContent ?? '')
      if (current !== seq) return
      const box = document.createElement('div')
      box.className = 'kb-mermaid'
      box.innerHTML = svg
      pre.replaceWith(box)
    } catch (error) {
      const box = document.createElement('div')
      box.className = 'kb-mermaid is-error'
      box.textContent = mermaidFailureText(error)
      pre.replaceWith(box)
    }
  }
}

/** 全部内容都在 DOM 里之后：核对目录、标记完成、补公式与流程图 */
function finishDom(root: HTMLElement, current: number, announced: MarkdownHeading[] | null): void {
  const headings = collectHeadings(root)
  // 渐进渲染时目录已经按 Worker 给的标题列表发过一次；只有和真实 DOM 不一致（极少见）才再发
  if (!announced || JSON.stringify(announced) !== JSON.stringify(headings)) emit('headings', headings)
  renderState.value = 'done'
  // 两条增强互不阻塞:一篇笔记里同时有公式和流程图也不会串行等
  void enhanceMath(root, current)
  void enhanceMermaid(root, current)
}

/** 挂上下一段 */
function appendNext(mine: Job): void {
  const root = body.value
  const html = mine.chunks[mine.next]
  mine.next += 1
  if (root && html !== undefined) root.append(prepare(html))
}

/** 把剩下的段全部同步挂上：打印前用，不能打出半篇 */
function flush(): void {
  const mine = job
  if (!mine) return
  while (mine.next < mine.chunks.length) appendNext(mine)
}

/** 逐批把段挂到 DOM 上，批与批之间等一帧画完；批量按实测的帧耗时自适应 */
async function pump(current: number, mine: Job): Promise<void> {
  // 先让出一帧：页面框架（标题、元信息）这次渲染要做的布局（含第一次布局的预热）自己占一帧；
  // 然后发目录（标题列表一次给全：目录马上完整，点到还没挂上的标题走 ensureHeading），目录的布局再占一帧；最后才挂第一批正文。
  // 三样叠在同一帧里，4× 降速下是一条 60 ms 以上的长任务
  await afterNextFrame()
  if (current !== seq) return
  emit('headings', mine.headings)
  await afterNextFrame()
  if (current !== seq) return
  let budget = BATCH_FIRST_CHARS
  let first = true
  while (mine.next < mine.chunks.length) {
    if (current !== seq) return
    let used = 0
    while (mine.next < mine.chunks.length && used < budget) {
      used += mine.chunks[mine.next]!.length
      appendNext(mine)
    }
    if (mine.next >= mine.chunks.length) break
    const handedOver = performance.now()
    await afterNextFrame()
    if (current !== seq) return
    // 从这批挂完到下一个任务开始 = 这一帧（样式 + 布局 + 绘制）的耗时加上等 vsync 的空档
    const frame = performance.now() - handedOver
    // 第一帧含预热开销，不拿来调批量；预热之后回到正常起步量
    budget = first ? BATCH_START_CHARS : adaptBatch(budget, frame, { min: BATCH_MIN_CHARS, max: BATCH_MAX_CHARS, slowMs: FRAME_SLOW_MS, fastMs: FRAME_FAST_MS })
    first = false
  }
  if (current !== seq || !body.value) return
  job = null
  finishDom(body.value, current, mine.headings)
}

async function renderProgressive(current: number): Promise<void> {
  const root = body.value
  if (!root) return
  root.replaceChildren()
  renderState.value = 'rendering'
  const result = await renderMarkdownChunksAsync(props.source ?? '')
  if (current !== seq || !body.value) return
  const mine: Job = { chunks: result.chunks, next: 0, headings: result.headings, headingsThrough: result.headingsThrough }
  job = mine
  await pump(current, mine)
}

function renderSync(current: number): void {
  const root = body.value
  if (!root) return
  // 渲染 + 清洗同步完成:标题 / 链接 / 文字立刻可见,公式与流程图随后补
  root.replaceChildren(prepare(renderer().render(props.source ?? '')))
  finishDom(root, current, null)
}

async function render(): Promise<void> {
  const current = ++seq
  job = null
  const source = props.source ?? ''
  if (props.progressive && source.length >= PROGRESSIVE_MIN_CHARS) {
    await renderProgressive(current)
    return
  }
  renderState.value = 'rendering'
  renderSync(current)
}

/** 链接上下文 / 体检结果变了：只重新标一遍链接状态，不重渲整篇（重渲 200 KB 的笔记是一条 180 ms 的长任务，而内容根本没变） */
function relink(): void {
  const root = body.value
  if (root && props.linkContext) rewriteDocLinks(root, linkOptions())
}

/**
 * 目录跳转用：按标题序号取元素；还没挂上就先把它之前的段挂完再返回（不等一帧一帧慢慢来，但每个切片都让出主线程）。
 * 文档换了或组件卸载中途返回 null。
 */
async function ensureHeading(index: number): Promise<HTMLElement | null> {
  const existing = headingElementList()[index]
  if (existing) return existing
  const mine = job
  const current = seq
  if (!mine) return null
  const needed = mine.headingsThrough.findIndex((count) => count > index)
  if (needed < 0) return null
  while (mine.next <= needed) {
    const sliceStart = performance.now()
    while (mine.next <= needed && performance.now() - sliceStart < TURBO_SLICE_MS) appendNext(mine)
    if (mine.next <= needed) {
      await yieldToMain()
      if (current !== seq) return null
    }
  }
  return headingElementList()[index] ?? null
}

function headingElementList(): HTMLElement[] {
  return body.value ? [...body.value.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')] : []
}

function onClick(event: MouseEvent): void {
  const hit = resolveDocLinkClick(event.target, props.allowNotes)
  if (!hit) return
  event.preventDefault()
  if (hit.kind === 'problem') {
    emit('linkError', hit.message)
    return
  }
  if (hit.kind === 'note') {
    emit('openNote', hit.id)
    return
  }
  if (props.openInNewTab) {
    const anchor = (event.target as HTMLElement | null)?.closest('a') as HTMLAnchorElement | null
    window.open(anchor?.href ?? '', '_blank', 'noopener,noreferrer')
    return
  }
  emit('openAttachment', { collection: hit.collection, path: hit.path, fragment: hit.fragment })
}

// 正文变了才重渲整篇；链接上下文 / 体检结果变了只重新标链接（体检结果通常在正文渲染之后才回来）
watch(() => props.source, () => void render())
watch(() => [props.linkContext, props.linkStates], relink, { deep: true })
onMounted(() => {
  window.addEventListener('beforeprint', flush)
  void render()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeprint', flush)
  // 卸载后异步增强还会跑完:序号 +1 让它们认不出自己这一轮,不再碰 DOM
  seq += 1
  job = null
})

defineExpose({
  /** 目录跳转用:按文档顺序返回已经挂上的标题元素（渐进渲染中途只有前面一部分） */
  headingElements: headingElementList,
  /** 正文的顶层块（段落、标题、列表、代码块…），阅读 → 编辑交接时按它找回屏幕上正看着的那一块 */
  blockElements: (): HTMLElement[] => (body.value ? ([...body.value.children] as HTMLElement[]) : []),
  /** 目录跳到还没挂上的标题：先渲染到那里再返回元素 */
  ensureHeading,
  /** 把还没挂上的内容同步挂完（打印、导出前） */
  flush,
  focus: () => host.value?.focus(),
})
</script>

<template>
  <article ref="host" class="kb-md-read" tabindex="-1" :data-render="renderState">
    <!-- 宿主页(文件预览)可以往右上角放自己的按钮(如「文字层」);没有就不占位置 -->
    <div class="kb-md-read-tools"><slot name="tools" /></div>
    <!-- 正文由 render 把清洗过的片段挂进来（小文档一次、大文档分段），不用 v-html：Vue 不管这个节点的子节点 -->
    <div ref="body" class="kb-md-read-body" @click="onClick"></div>
  </article>
</template>

<style>
/* 排版对齐编辑器外壳文本面的正文（阅读和编辑看起来是同一篇文档）：
   正文同为 16px，标题阶梯与块间距也取编辑器里的同一组值，点「编辑」时字不会突然变大 */
.kb-md-read {
  /* 默认给侧栏 / 抽屉里的紧凑阅读（助手消息）用 15px；文档页在下面单独放大到与编辑器一致 */
  --prose-size: calc(15px * var(--fs));
  outline: none;
  color: var(--t);
  font-family: var(--sans);
}
/* 文档页（笔记、分享页）正文 16px：和编辑器文本面同一字号，点「编辑」时字不会跳 */
.kb-md-read.kb-md-read-doc {
  --prose-size: calc(16px * var(--fs));
}
.kb-md-read-body {
  font-size: var(--prose-size);
  line-height: 1.75;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.kb-md-read-tools {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.kb-md-read-tools:empty {
  display: none;
}
.kb-md-read-body > * + * {
  margin-top: 0.9em;
}
.kb-md-read-body > :first-child {
  margin-top: 0;
}
.kb-md-read-body p {
  padding: 0;
  line-height: 1.75;
}
.kb-md-read-body h1,
.kb-md-read-body h2,
.kb-md-read-body h3,
.kb-md-read-body h4,
.kb-md-read-body h5,
.kb-md-read-body h6 {
  font-family: var(--sans);
  font-weight: 600;
  color: var(--t);
  letter-spacing: 0;
  scroll-margin-top: 72px;
}
.kb-md-read-body h1 {
  font-size: 1.875em;
  line-height: 1.3;
  margin-top: 1.6em;
}
.kb-md-read-body h2 {
  font-size: 1.5em;
  line-height: 1.35;
  margin-top: 1.55em;
}
.kb-md-read-body h3 {
  font-size: 1.25em;
  line-height: 1.4;
  margin-top: 1.4em;
}
.kb-md-read-body h4 {
  font-size: 1.0625em;
  line-height: 1.5;
  margin-top: 1.3em;
}
.kb-md-read-body h5 {
  font-size: 1em;
  line-height: 1.55;
  margin-top: 1.25em;
}
.kb-md-read-body h6 {
  font-size: 0.875em;
  line-height: 1.6;
  margin-top: 1.2em;
  color: var(--t2);
}
.kb-md-read-body strong {
  font-weight: 600;
}
.kb-md-read-body a {
  color: var(--ac2);
  text-decoration: none;
  border-bottom: var(--hl) solid color-mix(in srgb, var(--ac2) 40%, transparent);
}
.kb-md-read-body a:hover {
  border-bottom-color: var(--ac2);
}
.kb-md-read-body a.kb-wikilink {
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}
.kb-md-read-body a.kb-link-missing {
  text-decoration: underline dashed;
  text-underline-offset: 2px;
  color: var(--status-warning-text, var(--t2));
  cursor: help;
}
.kb-md-read-body img.kb-img-missing {
  opacity: 0.55;
  outline: 1px dashed var(--status-warning, var(--b2));
  outline-offset: 2px;
}
/* 行内代码与编辑器同一套字号 / 内边距 / 底色，阅读和编辑切换时不会变样 */
.kb-md-read-body code {
  display: inline;
  padding: 0.1em 0.35em;
  color: var(--t);
  background: var(--panel2);
  border: 0;
  border-radius: var(--r1);
  font-family: var(--mono);
  font-size: 0.92em;
  line-height: inherit;
  word-break: break-all;
}
.kb-md-read-body pre {
  margin: 0;
  padding: calc(12px * var(--fs));
  overflow-x: auto;
  background: var(--panel2);
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r2);
  line-height: 1.6;
}
.kb-md-read-body pre code {
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  font-size: calc(13px * var(--fs));
  white-space: pre;
  word-break: normal;
}
.kb-md-read-body blockquote {
  margin: 0;
  padding-left: calc(16px * var(--fs));
  border-left: 3px solid var(--border-subtle);
  color: var(--text-secondary);
}
.kb-md-read-body hr {
  height: var(--hl);
  margin: 1.4em 0;
  border: 0;
  background-color: var(--border-subtle);
}
.kb-md-read-body img {
  max-width: 100%;
  /* 有 width 属性（拖拽调整过）时高度按原图比例算，不拉伸 */
  height: auto;
  border-radius: var(--r2);
}
.kb-md-read-body ul,
.kb-md-read-body ol {
  padding-left: 1.5em;
}
.kb-md-read-body li + li {
  margin-top: 0.2em;
}
.kb-md-read-body li > p {
  margin: 0;
}
.kb-md-read-body li.kb-task-item {
  list-style: none;
  margin-left: -1.5em;
  display: flex;
  gap: 0.4em;
  /* 和正文第一行按基线对齐（编辑器里同一做法）：字再大方框也跟着第一行走，不会飘到上面去 */
  align-items: baseline;
}
.kb-task-box {
  flex: none;
  width: 1em;
  height: 1em;
  /* 空方框的基线是它的底边，视觉上偏高：往下挪一点和字的视觉中心对齐 */
  transform: translateY(0.16em);
  border: var(--hl) solid var(--b3);
  border-radius: var(--r-xs);
  background: var(--surface-1);
}
.kb-task-box.is-done {
  background: var(--ac);
  border-color: var(--ac);
}
.kb-md-read-body table {
  display: table;
  width: auto;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 0.94em;
  /* 外层的 .kb-table-scroll 负责和上下文的间距，表格自己不再加一份 */
  margin: 0;
}
.kb-md-read-body th,
.kb-md-read-body td {
  padding: 8px 12px;
  border: var(--hl) solid var(--border-subtle);
  vertical-align: top;
  line-height: 1.6;
}
/* 全站手机端有一条「表格变卡片」的全局规则(components.css:table / tbody / td 变 block、tr 变 flex、th 隐藏),
   正文里的表格不是数据列表,不能被它改写:不然 4 列的宽表在手机上会被压成一屏宽的弹性行,既不横向滚动、列也对不齐。
   和旧编辑器(DocEditor)一样把表格元素还原成真正的表格,宽表就在 .kb-table-scroll 里横向滚动 */
.kb-md-read-body table {
  display: table !important;
}
.kb-md-read-body tbody {
  display: table-row-group !important;
}
.kb-md-read-body thead {
  display: table-header-group !important;
}
.kb-md-read-body tr {
  display: table-row !important;
  min-height: 0 !important;
  padding: 0 !important;
  border: 0 !important;
}
.kb-md-read-body th,
.kb-md-read-body td {
  display: table-cell !important;
  width: auto !important;
  max-width: none !important;
  min-width: 6em;
  padding: 8px 12px !important;
  border: var(--hl) solid var(--border-subtle) !important;
  /* 手机全局把 td 字号压到 13px：表格字号由 table 的 0.94em 决定，单元格继承 */
  font-size: inherit !important;
}
.kb-md-read-body th {
  background: var(--surface-2);
  font-weight: 600;
}
/* 宽表格在正文里横向滚动,不把整页撑破 */
.kb-md-read-body .kb-table-scroll {
  overflow-x: auto;
  scrollbar-width: thin;
  /* 上下间距交给正文的统一块间距（* + *），第一块表格才不会凭空多出一截 */
  margin: 0;
}
/* 手机上宽表格(4 列带长路径的表在 390 宽里有 855px,设计规范):滚动条藏起来(压在正文下面很难看),
   改用两侧的渐隐提示「这边还有内容」。background-attachment: local 的渐变跟着内容滚、scroll 的阴影钉在框边:
   内容滚到头,对应一侧的遮罩盖住阴影,提示自然消失;不用脚本。旧编辑器(DocEditor)里就是这样做的,轻量阅读器翻默认时漏了 */
@media (max-width: 640px) {
  .kb-md-read-body .kb-table-scroll {
    scrollbar-width: none;
    background:
      linear-gradient(to right, var(--bg-canvas) 30%, transparent) left center / 28px 100% no-repeat local,
      linear-gradient(to left, var(--bg-canvas) 30%, transparent) right center / 28px 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, rgba(0, 0, 0, 0.45), transparent) left center / 14px 100% no-repeat scroll,
      radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.45), transparent) right center / 14px 100% no-repeat scroll;
  }
  .kb-md-read-body .kb-table-scroll::-webkit-scrollbar {
    display: none;
  }
}
.kb-mermaid {
  display: flex;
  justify-content: center;
  padding: 8px 0;
  overflow-x: auto;
}
.kb-mermaid svg {
  max-width: 100%;
  height: auto;
}
.kb-mermaid.is-error {
  display: block;
  padding: 8px 12px;
  color: var(--status-danger-text, var(--status-danger));
  background: color-mix(in srgb, var(--status-danger) 8%, transparent);
  border-radius: var(--r1);
  font-size: calc(13px * var(--fs));
  white-space: pre-wrap;
}
.kb-math.is-rendered {
  font-size: 1.02em;
}
.kb-math.is-block {
  display: block;
  margin: 0.8em 0;
  overflow-x: auto;
  overflow-y: hidden;
}
.kb-math.is-block.is-rendered {
  text-align: center;
}
.kb-math.is-error {
  color: var(--status-danger-text, var(--status-danger));
  font-family: var(--mono);
}

@media (max-width: 640px) {
  .kb-md-read {
    --prose-size: calc(16px * var(--fs));
  }
}
</style>
