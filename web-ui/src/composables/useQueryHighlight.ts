// 从检索结果点进文档后,把整篇文档里命中的词都高亮出来,并滚到第一处。
//
// 走 CSS Custom Highlight API(`::highlight(kb-query)`),不改 DOM 结构,所以不会打乱编辑器、
// 不会进入保存的内容。文档是异步渲染的(Markdown 编辑器、预览、代码查看器都是),所以监听子树变化,
// 稍等一下再重算;不支持这个 API 的浏览器(旧版 Firefox)什么也不画,也不报错。
import { onBeforeUnmount, watch, type Ref } from 'vue'
import { clearHighlight, findAllRanges, paintHighlights, revealRange } from '@/utils/domHighlight'

export const QUERY_HIGHLIGHT = 'kb-query'
/** DOM 变化后等多久再重算:编辑器一次渲染会触发很多次变化,合并成一次。 */
const REPAINT_MS = 120

export function useQueryHighlight(options: {
  /** 文档所在的容器 */
  root: Ref<HTMLElement | null>
  /** 要高亮的词;空数组就是不高亮 */
  terms: Ref<string[]>
  /** 换了文档就重新滚到第一处(同一篇里编辑、重绘不再滚) */
  docKey: Ref<string | null>
  /** 为 false 时不画(正在编辑 / 新建) */
  enabled: Ref<boolean>
}) {
  let observer: MutationObserver | null = null
  let timer = 0
  let revealedFor: string | null = null

  function paint() {
    const { root, terms, docKey, enabled } = options
    if (!root.value || !enabled.value || !terms.value.length) {
      clearHighlight(QUERY_HIGHLIGHT)
      return
    }
    const ranges = findAllRanges(root.value, terms.value)
    paintHighlights(QUERY_HIGHLIGHT, ranges)
    const key = docKey.value
    if (ranges.length && key !== revealedFor) {
      revealedFor = key
      revealRange(ranges[0]!)
    }
  }

  function schedule() {
    window.clearTimeout(timer)
    timer = window.setTimeout(paint, REPAINT_MS)
  }

  function stop() {
    observer?.disconnect()
    observer = null
    window.clearTimeout(timer)
  }

  watch(
    [options.root, options.terms, options.enabled, options.docKey],
    ([root], [previousRoot, , , previousKey]) => {
      if (options.docKey.value !== previousKey) revealedFor = null
      if (root !== previousRoot) stop()
      if (root && !observer) {
        observer = new MutationObserver(schedule)
        observer.observe(root, { childList: true, subtree: true, characterData: true })
      }
      schedule()
    },
    { flush: 'post', immediate: true },
  )

  onBeforeUnmount(() => {
    stop()
    clearHighlight(QUERY_HIGHLIGHT)
  })

  return { repaint: schedule }
}
