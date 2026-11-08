<script setup lang="ts">
// 通知抽屉里的一行:头像(或种类图标)、一句话、第二行、种类和时间。
// 有地方可去的整行是按钮;没有的(被移出协作者、系统公告)只是文字,只能标为已读。
// 未读用「粗体 + 小圆点 + 读屏文字」三重提示,不只靠颜色。
import { computed } from 'vue'
import { KbIcon } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import type { NotificationItem } from '@/stores/notifications'
import { describeNotification, kindInfo } from '@/utils/notifications'
import { displayName, formatWhen } from '@/utils/social'

const props = defineProps<{ item: NotificationItem; clickable: boolean }>()
defineEmits<{ open: []; read: [] }>()

const unread = computed(() => !props.item.read_at)
const info = computed(() => kindInfo(props.item.kind))
const view = computed(() => describeNotification(props.item))
</script>

<template>
  <li class="kb-nr" :class="{ 'is-unread': unread }" data-testid="notification-item" :data-kind="item.kind" :data-unread="unread">
    <component :is="clickable ? 'button' : 'div'" :type="clickable ? 'button' : undefined" class="kb-nr-main" :class="{ 'is-link': clickable }" @click="clickable && $emit('open')">
      <span class="kb-nr-lead">
        <UserAvatar v-if="view.actor" :user-id="view.actor.id" :name="displayName(view.actor)" :file="view.actor.avatar" :size="36" />
        <span v-else class="kb-nr-icon"><KbIcon :name="info.icon" :size="18" /></span>
      </span>
      <span class="kb-nr-body">
        <span class="kb-nr-title">{{ view.title }}</span>
        <span v-if="view.detail" class="kb-nr-detail">{{ view.detail }}</span>
        <span class="kb-nr-meta">
          <span v-if="unread" class="kb-sr">未读,</span>{{ info.label }} · {{ formatWhen(item.created_at) }}
        </span>
      </span>
      <span v-if="unread" class="kb-nr-dot" aria-hidden="true"></span>
    </component>
    <button v-if="unread" type="button" class="kb-icon-btn kb-nr-read" :aria-label="`标为已读:${view.title}`" data-testid="notification-read" @click.stop="$emit('read')">
      <KbIcon name="check" :size="16" />
    </button>
  </li>
</template>

<style scoped>
.kb-nr { display: flex; align-items: flex-start; gap: var(--sp-1); border-top: var(--hl) solid var(--b); min-width: 0; }
.kb-nr:first-child { border-top: 0; }
.kb-nr-main { flex: 1 1 auto; display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3) 0; min-width: 0; text-align: left; background: none; border: 0; color: inherit; font: inherit; }
.kb-nr-main.is-link { cursor: pointer; border-radius: var(--r2); }
.kb-nr-main.is-link:hover { background: var(--table-row-hover); }
.kb-nr-main.is-link:focus-visible { outline: none; box-shadow: var(--accent-ring); }
.kb-nr-lead { flex: none; }
.kb-nr-icon { display: grid; place-items: center; width: var(--sp-6); height: var(--sp-6); border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-text); }
.kb-nr-body { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; flex: 1 1 auto; }
.kb-nr-title { overflow-wrap: anywhere; }
.is-unread .kb-nr-title { font-weight: var(--fw-medium); }
.kb-nr-detail { color: var(--text-secondary); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.kb-nr-meta { color: var(--text-tertiary); font-size: var(--text-12); }
.kb-nr-dot { flex: none; width: var(--sp-2); height: var(--sp-2); margin-top: var(--sp-2); border-radius: var(--r-pill); background: var(--accent); }
.kb-nr-read { flex: none; margin-top: var(--sp-2); }
</style>
