// 软键盘与可视视口(设计规范)。
//
// 软键盘弹出时两类环境表现不同:
//   - Android Chrome(默认 resizes-content):布局视口跟着缩,100dvh 已经是对的,固定定位的元素自动在键盘上面;
//   - iOS Safari:布局视口不变,只有 visualViewport 缩小——固定定位的元素会被键盘盖住。
// 所以不能只看 visualViewport.height,要和「布局视口高度」(documentElement.clientHeight)比:
//   键盘占用 = 布局高度 − 可视高度 − 可视顶部偏移。布局视口已经跟着缩的环境里这个值是 0,不会重复计算。
//
// 结果写到 <html>:
//   --kbd-inset  键盘占用的像素(给外壳和底部固定的元素留位置)
//   data-kbd     open / closed——键盘打开时底部标签栏让位
// 并在键盘弹出、输入框聚焦时把它滚到可见位置,不被键盘挡住。
//   --kbd-reserve  压在内容底部的东西的总高度(编辑器贴键盘的格式工具栏 + 打开着的菜单底部面板),由编辑器写;
//                  滚动到可见位置时要把这一截也让出来。
//
// 外壳和编辑器都要用:useVisualViewport 可以被多处调用,监听和变量只装一份(最后一个用的人卸载时才拆);
// keyboardState 是同一份状态的响应式视图,组件拿它决定「键盘开了没」,不必各自再监听 visualViewport。
import { onBeforeUnmount, onMounted, reactive } from 'vue'
import { caretScrollDelta } from '@/utils/editorMobile'

/** 低于这个高度的变化不当成软键盘(地址栏伸缩只有几十像素)。 */
export const KEYBOARD_MIN_PX = 120

export function computeKeyboardInset(input: { layoutHeight: number; viewportHeight: number; viewportTop: number }): number {
  return Math.max(0, Math.round(input.layoutHeight - input.viewportHeight - input.viewportTop))
}

/** 当前焦点是不是一个会弹软键盘的元素。 */
export function isTextEntry(element: Element | null): boolean {
  if (!element) return false
  const el = element as HTMLElement
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  const type = (el as HTMLInputElement).type
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image'].includes(type)
}

/** 软键盘状态(响应式):open = 键盘打开且有输入框聚焦;inset = 键盘占用的像素 */
export const keyboardState = reactive({ open: false, inset: 0 })

/** 最近的可滚动祖先(只看样式,不看当前是否溢出);都没有就是窗口 */
function scrollParent(element: Element): HTMLElement | null {
  let node = element.parentElement
  while (node) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
    node = node.parentElement
  }
  return null
}

/** 光标所在行的矩形;折叠光标在空行里量出来全是 0,退一步用它所在元素的矩形 */
function caretRect(host: HTMLElement): { top: number; bottom: number } {
  const selection = window.getSelection()
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null
  if (range) {
    const rect = range.getBoundingClientRect()
    if (rect.height > 0) return { top: rect.top, bottom: rect.bottom }
    const anchor = range.startContainer
    const element = anchor instanceof Element ? anchor : anchor.parentElement
    if (element && host.contains(element)) {
      const box = element.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom }
    }
  }
  const box = host.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom }
}

/**
 * 把 host 里的一个矩形(通常是光标行)滚进可见区:host 最近的可滚动祖先里、软键盘以上、--kbd-reserve 以上。
 * --kbd-reserve 是所有压在内容底部的东西的总高度(贴键盘的工具栏 + 打开着的菜单底部面板)。
 * 长文档里要滚的是光标所在的那一行,不是整个编辑区:对整块 scrollIntoView(center) 会把光标带到几屏之外。
 */
export function scrollRectIntoView(host: HTMLElement, rect: { top: number; bottom: number }, options?: { scroller?: HTMLElement | null }) {
  // 调用方（新文本面）自己知道哪一层真的在滚：scrollParent 只看样式，会选中一个 overflow:auto 却从不溢出的外壳
  const scroller = options && 'scroller' in options ? (options.scroller ?? null) : scrollParent(host)
  const vv = window.visualViewport
  // getBoundingClientRect 是布局视口坐标;可视视口的下沿 = offsetTop + height
  const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
  const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: visibleBottom }
  const reserve = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kbd-reserve')) || 0
  const delta = caretScrollDelta({
    caret: rect,
    viewTop: Math.max(box.top, vv?.offsetTop ?? 0),
    viewBottom: Math.min(box.bottom, visibleBottom),
    reserveBottom: reserve,
  })
  if (!delta) return
  if (scroller) scroller.scrollBy({ top: delta })
  else window.scrollBy({ top: delta })
}

// 全局只装一份监听:外壳、编辑器各调一次 useVisualViewport 也不会互相拆台
let users = 0
let uninstall: (() => void) | null = null
let currentUpdate: () => void = () => undefined

function install(): () => void {
  const root = typeof document === 'undefined' ? null : document.documentElement

  function update() {
    if (!root) return
    const vv = window.visualViewport
    const inset = vv
      ? computeKeyboardInset({ layoutHeight: root.clientHeight, viewportHeight: vv.height, viewportTop: vv.offsetTop })
      : 0
    root.style.setProperty('--kbd-inset', `${inset}px`)
    // 键盘是否打开:占用够大,或者(布局视口跟着缩的环境)视口比窗口矮得多且有输入框聚焦
    const shrunk = vv ? window.innerHeight - vv.height >= KEYBOARD_MIN_PX : false
    const open = (inset >= KEYBOARD_MIN_PX || shrunk) && isTextEntry(document.activeElement)
    root.dataset.kbd = open ? 'open' : 'closed'
    keyboardState.open = open
    keyboardState.inset = inset
    if (open) revealFocused()
  }

  let revealTimer: ReturnType<typeof setTimeout> | undefined
  function revealFocused() {
    if (revealTimer) clearTimeout(revealTimer)
    // 等键盘动画稳定一拍再滚(iOS 上 resize 事件先于最终布局)
    revealTimer = setTimeout(() => {
      const active = document.activeElement as HTMLElement | null
      if (!active || !isTextEntry(active)) return
      if (active.isContentEditable) {
        scrollRectIntoView(active, caretRect(active))
        return
      }
      active.scrollIntoView({ block: 'center', inline: 'nearest' })
      // scrollIntoView 的「居中」按**布局视口**算:iOS 上布局视口不随键盘缩,键盘盖住的下半部分也算在里面。
      // 竖屏键盘只占四成,居中之后输入框仍在键盘上方;手机横屏键盘占一半,可视区只剩 ~190px,
      // 居中点正好落在键盘上沿,输入框下半截被盖住。所以滚完再按**可视视口**核对一次,仍被盖住就补滚。
      scrollRectIntoView(active, active.getBoundingClientRect())
    }, 60)
  }
  const onFocusChange = () => update()

  update()
  window.visualViewport?.addEventListener('resize', update)
  window.visualViewport?.addEventListener('scroll', update)
  document.addEventListener('focusin', onFocusChange)
  document.addEventListener('focusout', onFocusChange)
  currentUpdate = update

  return () => {
    window.visualViewport?.removeEventListener('resize', update)
    window.visualViewport?.removeEventListener('scroll', update)
    document.removeEventListener('focusin', onFocusChange)
    document.removeEventListener('focusout', onFocusChange)
    if (revealTimer) clearTimeout(revealTimer)
    root?.style.removeProperty('--kbd-inset')
    if (root) root.dataset.kbd = 'closed'
    keyboardState.open = false
    keyboardState.inset = 0
    currentUpdate = () => undefined
  }
}

export function useVisualViewport() {
  onMounted(() => {
    if (users === 0) uninstall = install()
    users += 1
  })
  onBeforeUnmount(() => {
    users = Math.max(0, users - 1)
    if (users === 0) {
      uninstall?.()
      uninstall = null
    }
  })

  return { update: () => currentUpdate() }
}
