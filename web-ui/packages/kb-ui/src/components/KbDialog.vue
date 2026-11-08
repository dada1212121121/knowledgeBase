<script setup lang="ts">
// 对话框(设计规范;进出场参考 uilab「确认弹窗」):
//   遮罩 200ms 淡入;卡片从 0.9 倍带一点回弹长出(spring 曲线,走 motion token);收起更快(120ms)。
//   Esc 关闭;打开时焦点进卡片、Tab 在卡片内循环,关闭后焦点还给打开前的元素。
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import KbIcon from './KbIcon.vue'

// 外层是 Teleport + Transition,属性没法自动落到卡片的 DOM 上。
// 调用方常用 data-testid / aria-* 定位对话框,所以关掉自动继承,显式绑到 .kb-dialog 上。
defineOptions({ inheritAttrs: false })

// plain:设计稿的对话框头(标题 + 副标题 + 右上角 ×,无分隔线,内容区不加内边距,由调用方排版)
// width:对话框宽度(默认 560px);手机上一律是贴底的 sheet
// open:是否渲染。调用方一般用 `v-if` 挂载/卸载;这里再兜一层,避免有人把 `:open="false"`
// 当成“关闭”来用(组件不支持“关不掉”的模态:没有 open 时它会一直挂在那儿)
const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    plain?: boolean
    width?: string
    closeOnScrim?: boolean
    noAutofocus?: boolean
    open?: boolean
  }>(),
  { subtitle: '', plain: false, width: '', closeOnScrim: true, noAutofocus: false, open: true },
)
const emit = defineEmits<{ close: [] }>()

const card = ref<HTMLElement | null>(null)
const titleId = `kb-dlg-${Math.random().toString(36).slice(2, 8)}`
let opener: HTMLElement | null = null

function focusables(): HTMLElement[] {
  // 只算 Tab 真的能走到的元素。表单对话框用隐藏的提交按钮实现回车提交(<button type="submit" hidden tabindex="-1">),
  // 它排在可见按钮后面;若把它当成「最后一个」,在真正的最后一个按钮上按 Tab 就不会被拦住,焦点跑到被遮罩盖住的背景页面里
  return [...(card.value?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]') ?? [])].filter(
    (el) => !el.hasAttribute('disabled') && !el.hidden && el.getAttribute('tabindex') !== '-1' && (el as HTMLInputElement).type !== 'hidden',
  )
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    // 弹层上面还压着别的东西时,Esc 留给它:展开的下拉菜单(菜单自己收)、确认框(自己取消),不连带关掉整个弹层
    if (document.querySelector('.kb-pop-layer[data-open="true"], .kb-confirm-wrap')) return
    event.stopPropagation()
    emit('close')
  } else if (event.key === 'Tab') {
    const items = focusables()
    if (!items.length) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
}
onMounted(async () => {
  opener = document.activeElement as HTMLElement | null
  await nextTick()
  // noAutofocus:表单很长 / 首个控件不是主要动作时,只把焦点放在卡片上,不抢第一个输入框
  const first = props.noAutofocus ? null : card.value?.querySelector<HTMLElement>('input,textarea,select')
  ;(first ?? card.value)?.focus({ preventScroll: true })
  document.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  opener?.focus?.({ preventScroll: true })
})
</script>

<template>
  <Teleport v-if="props.open" to="body">
    <Transition name="kb-dlg" appear>
      <div class="kb-dlg-wrap">
        <div class="kb-dlg-scrim" @click="props.closeOnScrim && emit('close')"></div>
        <div
          ref="card"
          class="kb-dialog"
          v-bind="$attrs"
          :class="{ 'is-plain': plain }"
          :style="width ? { '--dialog-w': width } : undefined"
          style-allow="对话框宽度由调用方指定"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <div class="kb-dialog-head">
            <slot name="lead" />
            <div class="kb-dialog-heading">
              <b :id="titleId" class="kb-dialog-title">{{ title }}</b>
              <div v-if="subtitle" class="m kb-dialog-sub">{{ subtitle }}</div>
            </div>
            <span class="kb-spacer">
              <button v-if="plain" type="button" class="kb-dialog-x" aria-label="关闭" @click="emit('close')"><KbIcon name="close" :size="14" /></button>
              <button v-else type="button" class="btn sm" @click="emit('close')">关闭</button>
            </span>
          </div>
          <div class="kb-dialog-body"><slot /></div>
          <div v-if="$slots.footer" class="kb-dialog-foot"><slot name="footer" /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
