<script setup lang="ts">
// 树行(03 浏览器左栏):缩进 + 展开箭头(带旋转动画)+ 名称 + 计数。
// 用 depth 控制缩进(每级 14px),不在页面里写 padding。actions 插槽放行内小按钮。
//
// 点击分工:点箭头只展开 / 收起(toggle),点其余部分是选中(select)。
// 箭头的可点区域撑满整行高度,不再只有 12px 图标那么大,手指和鼠标都不用瞄准。
// 键盘按 WAI-ARIA tree 的约定:↑↓ 逐行移动,Home / End 到首尾,
// → 展开或进入第一个子项,← 收起或回到父项,Enter / 空格选中。
const props = withDefaults(
  defineProps<{
    label: string
    count?: string | number
    depth?: number
    /** undefined = 叶子(不显示箭头占位以外的东西);true/false = 展开/收起 */
    open?: boolean
    active?: boolean
    mono?: boolean
  }>(),
  { count: '', depth: 0, open: undefined, active: false, mono: false },
)
// select 带上触发它的事件:调用方要看 Ctrl / ⌘ / Shift(多选),不关心的调用方忽略参数即可
const emit = defineEmits<{ select: [event?: MouseEvent | KeyboardEvent]; toggle: [] }>()

/** 叶子的箭头只是占位(visibility:hidden),但仍然保证点到它不会误触发展开 */
function onCaret() {
  if (props.open !== undefined) emit('toggle')
}

/** 同一棵树里按显示顺序排好的所有行;收起的子项不在 DOM 里,所以不用再判断可见性 */
function rowsOf(row: HTMLElement): HTMLElement[] {
  const tree = row.closest('[role=tree]')
  return tree ? [...tree.querySelectorAll<HTMLElement>('[role=treeitem]')] : [row]
}
const levelOf = (row: HTMLElement) => Number(row.getAttribute('aria-level') ?? 1)

function onKeydown(event: KeyboardEvent) {
  // 行内的小按钮(例如分享)自己处理键盘;它们冒泡上来的按键不算「在这一行上按的」
  if (event.target !== event.currentTarget) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('select', event)
    return
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const row = event.currentTarget as HTMLElement
  const rows = rowsOf(row)
  const index = rows.indexOf(row)
  let target: HTMLElement | undefined
  if (event.key === 'ArrowDown') target = rows[index + 1]
  else if (event.key === 'ArrowUp') target = rows[index - 1]
  else if (event.key === 'Home') target = rows[0]
  else if (event.key === 'End') target = rows[rows.length - 1]
  else if (event.key === 'ArrowRight') {
    if (props.open === false) emit('toggle')
    else if (props.open === true) {
      const next = rows[index + 1]
      if (next && levelOf(next) > levelOf(row)) target = next
    } else return
  } else if (event.key === 'ArrowLeft') {
    if (props.open === true) emit('toggle')
    else target = rows.slice(0, index).reverse().find((candidate) => levelOf(candidate) < levelOf(row))
  } else return
  event.preventDefault()
  target?.focus()
}
</script>

<template>
  <div
    class="ni kb-tree-item"
    :class="{ on: active }"
    :style="{ '--depth': depth }"
    role="treeitem"
    tabindex="0"
    :aria-level="depth + 1"
    :aria-expanded="open"
    :aria-selected="active"
    @click="emit('select', $event)"
    @keydown="onKeydown"
  >
    <span class="row kb-tree-label">
      <span class="m2 kb-tree-caret" :class="{ 'is-open': open === true, 'is-leaf': open === undefined }" aria-hidden="true" @click.stop="onCaret">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4.5 3l3 3-3 3" />
        </svg>
      </span>
      <span class="kb-tree-text" :class="{ mono }" :title="label">{{ label }}</span>
    </span>
    <span v-if="count !== ''" class="cnt">{{ count }}</span>
    <!-- 行内操作(例如「分享」):不触发选中;鼠标设备悬停 / 聚焦时才露出,触屏常驻(没有悬停可用) -->
    <span v-if="$slots.actions" class="kb-tree-actions" @click.stop @keydown.enter.stop><slot name="actions" /></span>
  </div>
</template>
