<script setup lang="ts">
// 「我的」页:手机上进入其余所有入口的地方(侧栏在手机上不存在)。
// 上面是账号卡片(进个人设置),中间是按功能表过滤后的导航清单,最后是 AI 助手 / 外观 / 退出登录。
// 桌面上也能打开(地址 /mine),只是用不到。
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { KbIcon } from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { buildNavGroups } from '@/layouts/shell/navModel'
import { useFeature } from '@/composables/useFeature'
import { logout } from '@/api/client'
import { PATHS, TAB_PAGES } from '@/router/paths'
import { usePanelsStore } from '@/stores/panels'
import { useSessionStore } from '@/stores/session'
import { useShellStore } from '@/stores/shell'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const panels = usePanelsStore()
const shell = useShellStore()
const { items, sources, drafts, activeJobs } = storeToRefs(shell)
const hasAssistant = useFeature('ai.assistant')

const name = computed(() => session.user?.display_name || session.user?.username || '')

// 标签栏里已经有的入口(首页 / 知识库 / 搜索)不在这里重复
const groups = computed(() =>
  buildNavGroups({
    has: (feature) => session.has(feature),
    route,
    counts: { items: items.value, sources: sources.value, drafts: drafts.value, jobs: activeJobs.value },
  })
    // AI 助手在手机上是全屏抽屉(下面单独一行),不再列出独立页面入口
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.id !== 'assistant' && (typeof item.to !== 'string' || !TAB_PAGES.includes(item.to))),
    }))
    .filter((group) => group.items.length),
)

async function signOut() {
  try {
    await logout()
  } catch {
    // 会话已经失效时也照样回登录页
  }
  window.location.href = '/login'
}
function openAssistant() {
  panels.toggleAssistant(true)
}
</script>

<template>
  <AppShell>
    <template #breadcrumb><b>我的</b></template>
    <div class="kb-mine" data-testid="mine">
      <RouterLink v-if="session.user" class="card kb-mine-profile" :to="PATHS.me" data-testid="mine-profile">
        <UserAvatar :user-id="session.user.id" :name="name" :file="session.user.avatar" :size="48" />
        <span class="kb-mine-who">
          <b class="kb-mine-name">{{ name }}</b>
          <span class="m kb-mine-sub">{{ session.user.email || session.user.username }}</span>
        </span>
        <KbIcon name="forward" class="kb-mine-go" />
      </RouterLink>

      <section v-for="group in groups" :key="group.id" class="card kb-mine-group">
        <div v-if="group.label" class="kb-mine-head">{{ group.label }}</div>
        <RouterLink v-for="item in group.items" :key="item.id" class="kb-mine-row" :to="item.to" :data-nav-id="item.id">
          <KbIcon :name="item.icon" />
          <span class="kb-mine-label">{{ item.label }}</span>
          <em v-if="item.count" class="kb-nav-badge">{{ item.count }}</em>
          <span v-else-if="item.text" class="m kb-mine-text">{{ item.text }}</span>
          <KbIcon name="forward" class="kb-mine-go" />
        </RouterLink>
      </section>

      <section class="card kb-mine-group">
        <button v-if="hasAssistant" type="button" class="kb-mine-row" data-feature="ai.assistant" data-testid="mine-assistant" @click="openAssistant">
          <KbIcon name="sparkles" /><span class="kb-mine-label">AI 助手</span><KbIcon name="forward" class="kb-mine-go" />
        </button>
        <RouterLink class="kb-mine-row" :to="PATHS.appearance">
          <KbIcon name="palette" /><span class="kb-mine-label">外观</span><KbIcon name="forward" class="kb-mine-go" />
        </RouterLink>
        <RouterLink class="kb-mine-row" :to="PATHS.guide" data-testid="mine-guide">
          <KbIcon name="book" /><span class="kb-mine-label">使用指南</span><KbIcon name="forward" class="kb-mine-go" />
        </RouterLink>
      </section>

      <section class="card kb-mine-group">
        <button type="button" class="kb-mine-row is-danger" data-testid="mine-signout" @click="signOut">
          <KbIcon name="logout" /><span class="kb-mine-label">退出登录</span>
        </button>
      </section>
    </div>
  </AppShell>
</template>

<style scoped>
.kb-mine {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  min-width: 0;
}
.kb-mine-profile {
  display: flex;
  align-items: center;
  gap: var(--gap);
  padding: var(--card-py) var(--card-px);
  min-height: 72px;
}
.kb-mine-who { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.kb-mine-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(16px * var(--fs)); font-weight: 600; }
.kb-mine-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-mine-group { overflow: hidden; }
.kb-mine-head { padding: var(--gap-sm) var(--card-px) var(--gap-xs); font-size: calc(12px * var(--fs)); color: var(--m); }
.kb-mine-row {
  display: flex;
  align-items: center;
  gap: var(--gap);
  width: 100%;
  min-height: var(--list-row-h);
  padding: 0 var(--card-px);
  border: 0;
  border-top: var(--hl) solid var(--b);
  background: transparent;
  color: var(--t);
  font: inherit;
  font-size: calc(15px * var(--fs));
  text-align: left;
  cursor: pointer;
}
.kb-mine-head + .kb-mine-row, .kb-mine-group > .kb-mine-row:first-child { border-top: 0; }
.kb-mine-row > svg:first-child { flex: none; color: var(--m); }
.kb-mine-row.is-danger { color: var(--status-danger-text); }
.kb-mine-row.is-danger > svg:first-child { color: inherit; }
.kb-mine-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-mine-text { flex: none; }
.kb-mine-go { flex: none; color: var(--m2); }
.kb-mine-row:active, .kb-mine-profile:active { background: var(--hover); }
</style>
