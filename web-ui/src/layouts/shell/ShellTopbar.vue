<script setup lang="ts">
// 统一顶栏:[侧栏开关] 标题 / 面包屑 ……… 页面操作 · ⌘K · AI 助手 · 通知 · 头像菜单。
//
// 标题、面包屑和页面操作不是这里写的:各页面的 <AppShell> 用 Teleport 把内容送进
// #kb-slot-bc(桌面标题)/ #kb-slot-mbar(手机标题)/ #kb-slot-actions(页面操作)。
// 已经不再有的东西:刷新(数据靠 WebSocket 自动更新,需要手动刷新的页面自己放)、
// 退出(进了头像菜单)、底部状态栏(改成管理员头像上的告警圆点)。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KbIcon } from '@kb-ui/index'
import { phoneBackTarget } from './navModel'
import { useViewport } from '@/composables/useViewport'
import { canGoBack, useStandalone } from '@/composables/useStandalone'
import { useFeature } from '@/composables/useFeature'
import { useNavStore } from '@/stores/nav'
import { useNotificationsStore } from '@/stores/notifications'
import { usePanelsStore } from '@/stores/panels'
import ShellAccountMenu from './ShellAccountMenu.vue'
import type { SystemAlert } from './types'

defineProps<{ alerts: SystemAlert[]; showShortcuts: boolean }>()
defineEmits<{ search: []; signout: []; shortcuts: [] }>()

const nav = useNavStore()
const route = useRoute()
const router = useRouter()
const viewport = useViewport()
// 只有标签栏形态(没有侧栏)才需要返回键;桌面 / 平板用侧栏和面包屑
const backTo = computed(() => (viewport.navKind.value === 'tabbar' && !nav.workbench ? phoneBackTarget(route) : null))
const panels = usePanelsStore()
const notifications = useNotificationsStore()
const hasAssistant = useFeature('ai.assistant')
const unread = computed(() => notifications.unread)
// 独立窗口(装成 PWA)里没有浏览器的后退 / 刷新按钮,顶栏补上
const { standalone } = useStandalone()
const hasHistory = computed(() => (route.fullPath, canGoBack()))
function reload() {
  window.location.reload()
}
const toggleTitle = computed(() => (nav.hasSidebar ? `${nav.state === 'expanded' ? '收起' : '展开'}侧栏 (⌘B)` : ''))
</script>

<template>
  <header class="kb-topbar" data-testid="topbar">
    <button
      v-if="nav.hasSidebar"
      type="button"
      class="kb-icon-btn kb-topbar-nav"
      :title="toggleTitle"
      aria-label="切换侧栏"
      :aria-expanded="nav.state === 'expanded' || nav.overlayOpen"
      data-testid="nav-toggle"
      @click="nav.toggle()"
    >
      <KbIcon name="sidebar" :size="18" />
    </button>
    <!-- 手机:嵌套页面 / 从「我的」进入的页面,左上角返回(平板和电脑有侧栏,不需要) -->
    <button v-if="backTo" type="button" class="kb-icon-btn kb-topbar-back" aria-label="返回" data-testid="topbar-back" @click="router.push(backTo)">
      <KbIcon name="back" :size="20" />
    </button>
    <!-- 独立窗口:浏览器的后退 / 刷新不在了。手机上已有「返回上级」的页面不再放第二个返回键 -->
    <template v-if="standalone">
      <button
        v-if="!backTo"
        type="button"
        class="kb-icon-btn kb-topbar-history"
        :disabled="!hasHistory"
        aria-label="后退"
        data-testid="topbar-history-back"
        @click="router.back()"
      >
        <KbIcon name="back" :size="18" />
      </button>
      <button type="button" class="kb-icon-btn kb-topbar-reload" aria-label="刷新页面" title="刷新页面" data-testid="topbar-reload" @click="reload">
        <KbIcon name="refresh" :size="16" />
      </button>
    </template>
    <div id="kb-slot-bc" class="bc kb-topbar-bc"></div>
    <div id="kb-slot-mbar" class="kb-topbar-title"></div>
    <span class="kb-topbar-fill"></span>
    <div id="kb-slot-actions" class="kb-topbar-actions"></div>
    <button type="button" class="kb-topbar-search" aria-label="搜索或跳转 ⌘K" title="搜索或跳转 (⌘K)" data-testid="topbar-search" @click="$emit('search')">
      <KbIcon name="search" /><span class="kb-topbar-search-text">搜索或跳转</span><span class="kbd">⌘K</span>
    </button>
    <button
      v-if="hasAssistant"
      type="button"
      class="kb-icon-btn kb-topbar-ai"
      :class="{ 'is-open': panels.assistantOpen, 'is-busy': panels.assistantBusy }"
      data-feature="ai.assistant"
      aria-label="AI 助手"
      :aria-expanded="panels.assistantOpen"
      title="AI 助手 (⌘J)"
      data-testid="assistant-toggle"
      @click="panels.toggleAssistant()"
    >
      <KbIcon name="sparkles" :size="18" />
      <i v-if="panels.assistantBusy" class="kb-pulse-dot" aria-hidden="true"></i>
    </button>
    <button
      type="button"
      class="kb-icon-btn kb-topbar-bell"
      :class="{ 'is-open': panels.notificationsOpen }"
      :aria-label="unread ? `通知,${unread} 条未读` : '通知'"
      title="通知"
      data-testid="bell"
      @click="panels.toggleNotifications()"
    >
      <KbIcon name="bell" :size="18" />
      <em v-if="unread" class="kb-bell-badge" data-testid="bell-badge">{{ unread > 99 ? '99+' : unread }}</em>
    </button>
    <ShellAccountMenu :alerts="alerts" :show-shortcuts="showShortcuts" @signout="$emit('signout')" @shortcuts="$emit('shortcuts')" />
  </header>
</template>
