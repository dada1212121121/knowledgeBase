<script setup lang="ts">
// 通知抽屉(铃铛 / 手机标签栏的「通知」打开):按类型筛选、点一条跳到对应位置、全部标为已读。
// 数据和角标是同一份(stores/notifications.ts),WebSocket 的 notify 事件进来时列表和角标一起变。
//
// 四种状态:加载(骨架屏)、空(说明 + 下一步)、出错(可重试,已有列表时错误显示在列表上方)、没有权限。
// 类型筛选只在已经加载的那几页里筛(后端 notification_list 没有按种类过滤的参数),所以这一类没有时
// 如果后面还有更早的通知,会提示并给「加载更多」。
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { KbButton, KbDrawer, KbEmpty, KbSegmented, KbSkeleton } from '@kb-ui/index'
import NotificationRow from '@/layouts/shell/NotificationRow.vue'
import { PATHS } from '@/router/paths'
import { useNotificationsStore, type NotificationItem } from '@/stores/notifications'
import { useSessionStore } from '@/stores/session'
import { CATEGORIES, categoryOf, notificationTarget, type NotificationCategory } from '@/utils/notifications'

const emit = defineEmits<{ close: [] }>()
const router = useRouter()
const notifications = useNotificationsStore()
const session = useSessionStore()

const category = ref<'all' | NotificationCategory>('all')
const unread = computed(() => notifications.unread)
const visible = computed(() => (category.value === 'all' ? notifications.items : notifications.items.filter((item) => categoryOf(item.kind) === category.value)))
const hasMore = computed(() => notifications.nextBeforeId !== null)
const categoryLabel = computed(() => CATEGORIES.find((item) => item.value === category.value)?.label ?? '')

onMounted(() => void notifications.load())

const targetOf = (item: NotificationItem) => notificationTarget(item, session.user?.space_id ?? null)

/** 点一条:标为已读,有去处就关掉抽屉并跳过去。 */
function open(item: NotificationItem) {
  if (!item.read_at) void notifications.markRead({ ids: [item.id] })
  const target = targetOf(item)
  if (!target) return
  emit('close')
  void router.push(target)
}
function markOne(item: NotificationItem) {
  void notifications.markRead({ ids: [item.id] })
}
function goFriends() {
  emit('close')
  void router.push(PATHS.friends)
}
</script>

<template>
  <KbDrawer title="通知" @close="$emit('close')">
    <div class="kb-stack kb-nd" data-testid="notification-drawer">
      <div class="kb-row-between">
        <span class="kb-hint" data-testid="notification-unread">{{ unread ? `${unread} 条未读` : '没有未读通知' }}</span>
        <KbButton size="sm" :disabled="!unread" @click="notifications.markRead({ all: true })">全部标为已读</KbButton>
      </div>
      <KbSegmented v-model="category" :options="CATEGORIES" aria-label="按类型筛选通知" data-testid="notification-filter" />

      <KbSkeleton v-if="notifications.loading" variant="list" :lines="4" />

      <KbEmpty v-else-if="notifications.forbidden" icon="lock" title="你的账号没有开通通知" description="请联系管理员。" data-testid="notification-forbidden" />

      <KbEmpty v-else-if="notifications.error && !notifications.items.length" icon="failed" title="没能加载通知" :description="notifications.error" data-testid="notification-error">
        <template #action><KbButton variant="primary" @click="notifications.load()">重新加载</KbButton></template>
      </KbEmpty>

      <KbEmpty v-else-if="!notifications.items.length" icon="bell" title="还没有通知" description="好友申请、分享、评论和系统公告都会出现在这里。" data-testid="notification-empty">
        <template v-if="session.has('collab.friends')" #action><KbButton @click="goFriends">去看看好友</KbButton></template>
      </KbEmpty>

      <template v-else>
        <p v-if="notifications.error" class="kb-nd-error" role="alert" data-testid="notification-inline-error">{{ notifications.error }}</p>
        <KbEmpty v-if="!visible.length" size="sm" icon="bell" :title="`${categoryLabel}类通知:目前没有`" :description="hasMore ? '更早的通知里可能还有,加载更多看看。' : '换一个类型,或者查看全部。'" data-testid="notification-empty-filter">
          <template #action><KbButton v-if="!hasMore" @click="category = 'all'">查看全部</KbButton></template>
        </KbEmpty>
        <ul v-else class="kb-nd-list" role="list" data-testid="notification-list">
          <NotificationRow v-for="item in visible" :key="item.id" :item="item" :clickable="!!targetOf(item)" @open="open(item)" @read="markOne(item)" />
        </ul>
        <KbButton v-if="hasMore" :disabled="notifications.loadingMore" data-testid="notification-more" @click="notifications.loadMore()">
          {{ notifications.loadingMore ? '加载中…' : '加载更多' }}
        </KbButton>
      </template>
    </div>
  </KbDrawer>
</template>

<style scoped>
.kb-nd { min-width: 0; }
.kb-nd-list { list-style: none; margin: 0; padding: 0; min-width: 0; }
.kb-nd-error { margin: 0; color: var(--status-danger-text); }
</style>
