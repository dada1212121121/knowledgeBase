<script setup lang="ts">
// 头像菜单:个人设置、外观、快捷键、(管理员)系统状态、退出登录。
// 退出登录不再放在顶栏最显眼的位置(误点代价高),收进这里。
// 管理员头像上的小圆点 = 系统有告警(取代以前给所有人看的底部状态栏);菜单里写明是什么告警。
//
// 菜单用 Teleport 送到 <body> 并按触发按钮的位置固定定位:侧栏、顶栏都有 overflow 裁剪,
// 菜单留在原地会被切掉。两种出现位置:顶栏头像(往下展开)和文档工作台侧栏底部(往右上展开)。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { KbIcon } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import { useSessionStore } from '@/stores/session'
import { PATHS } from '@/router/paths'
import type { SystemAlert } from './types'

const props = withDefaults(defineProps<{ alerts: SystemAlert[]; showShortcuts: boolean; variant?: 'avatar' | 'nav' }>(), { variant: 'avatar' })
const emit = defineEmits<{ signout: []; shortcuts: [] }>()

const session = useSessionStore()
const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const position = ref<Record<string, string>>({})

const name = computed(() => session.user?.display_name || session.user?.username || '')
// 导航里的账号按钮侧栏展开时能看到名字:无障碍名称要把可见的名字当作独立的词放进去(WCAG 2.5.3),
// 括号会把名字和前后文字粘成一个词,axe 认不出来,所以用空格分隔
const triggerLabel = computed(() =>
  props.variant === 'nav'
    ? `账号菜单 ${name.value}${props.alerts.length ? ' 系统有告警' : ''}`
    : `账号菜单(${name.value})${props.alerts.length ? ',系统有告警' : ''}`,
)

function items(): HTMLElement[] {
  return [...(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
}
function place() {
  const box = trigger.value?.getBoundingClientRect()
  if (!box) return
  position.value =
    props.variant === 'nav'
      ? {
          left: `${Math.round(box.right + 8)}px`,
          bottom: `${Math.max(8, Math.round(window.innerHeight - box.bottom))}px`,
          top: 'auto',
          right: 'auto',
        }
      : {
          top: `${Math.round(box.bottom + 6)}px`,
          right: `${Math.max(8, Math.round(window.innerWidth - box.right))}px`,
          bottom: 'auto',
          left: 'auto',
        }
}
async function show() {
  place()
  open.value = true
  await nextTick()
  items()[0]?.focus()
}
function hide(returnFocus = true) {
  if (!open.value) return
  open.value = false
  if (returnFocus) void nextTick(() => trigger.value?.focus())
}
function onTriggerKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' && !open.value) {
    event.preventDefault()
    void show()
  }
}
function onMenuKey(event: KeyboardEvent) {
  const list = items()
  const index = list.indexOf(document.activeElement as HTMLElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    list[(index + 1) % list.length]?.focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    list[(index - 1 + list.length) % list.length]?.focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    list[0]?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    list[list.length - 1]?.focus()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    hide()
  } else if (event.key === 'Tab') {
    hide(false)
  }
}
function onDocumentPointer(event: Event) {
  const target = event.target as Node
  if (open.value && !trigger.value?.contains(target) && !menu.value?.contains(target)) hide(false)
}
const onResize = () => hide(false)
onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointer, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointer, true)
  window.removeEventListener('resize', onResize)
})

function pick(action: 'signout' | 'shortcuts') {
  hide(false)
  if (action === 'signout') emit('signout')
  else emit('shortcuts')
}
</script>

<template>
  <div v-if="session.user" class="kb-account" :class="{ 'is-nav': variant === 'nav' }">
    <button
      ref="trigger"
      type="button"
      :class="variant === 'nav' ? 'kb-nav-item kb-me-link' : 'kb-top-avatar'"
      :aria-label="triggerLabel"
      :title="variant === 'nav' ? `账号 · ${name}` : undefined"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-testid="account-trigger"
      @click="open ? hide() : show()"
      @keydown="onTriggerKey"
    >
      <UserAvatar :user-id="session.user.id" :name="name" :file="session.user.avatar" :size="variant === 'nav' ? 20 : 28" :css-initial="variant === 'nav'" />
      <span v-if="variant === 'nav'" class="kb-me-name kb-nl">{{ name }}</span>
      <i v-if="props.alerts.length" class="kb-alert-dot" role="status" aria-label="系统有告警" data-testid="alert-dot"></i>
    </button>
    <Teleport to="body">
      <Transition name="kb-pop">
        <div
          v-if="open"
          ref="menu"
          class="kb-menu"
          role="menu"
          aria-label="账号"
          data-testid="account-menu"
          :style="position"
          style-allow="菜单位置由触发按钮的实际位置决定"
          @keydown="onMenuKey"
        >
          <div class="kb-menu-head">
            <b class="kb-menu-name">{{ name }}</b>
            <span class="kb-menu-sub">{{ session.user.email || session.user.username }}</span>
          </div>
          <RouterLink class="kb-menu-item" role="menuitem" :to="PATHS.me" @click="hide(false)"><KbIcon name="user" />个人设置</RouterLink>
          <RouterLink class="kb-menu-item" role="menuitem" :to="PATHS.appearance" @click="hide(false)"><KbIcon name="palette" />外观</RouterLink>
          <RouterLink class="kb-menu-item" role="menuitem" :to="PATHS.guide" data-testid="menu-guide" @click="hide(false)"><KbIcon name="book" />使用指南</RouterLink>
          <button v-if="showShortcuts" type="button" class="kb-menu-item" role="menuitem" @click="pick('shortcuts')"><KbIcon name="terminal" />快捷键</button>
          <template v-if="session.has('sys.ops')">
            <RouterLink class="kb-menu-item" role="menuitem" :to="PATHS.system" @click="hide(false)">
              <KbIcon name="pulse" />系统状态<i v-if="props.alerts.length" class="kb-menu-pip" aria-hidden="true"></i>
            </RouterLink>
            <div v-for="alert in props.alerts" :key="alert.id" class="kb-menu-alert" data-testid="alert-text">{{ alert.text }}</div>
          </template>
          <div class="kb-menu-sep" role="separator"></div>
          <button type="button" class="kb-menu-item is-danger" role="menuitem" data-testid="signout" @click="pick('signout')"><KbIcon name="logout" />退出登录</button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
