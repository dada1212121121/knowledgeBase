<script setup lang="ts">
// 多人在线编辑的状态条:同步状态 + 断开 / 被收回权限时的说明与出路。
// "谁在这篇文档里"(头像)搬到了顶栏的 CollabAvatars:头像是常驻信息,状态条只在有话要说时才占地方。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { KbButton } from '@kb-ui/index'
import type { CollabProvider, CollabState } from '@/collab/provider'
import { INFO_TTL_MS, autoDismiss, dismissNotice, pushNotice, type ShownNotice } from '@/collab/notices'
import { statusText } from '@/collab/status'

const props = defineProps<{ provider: CollabProvider }>()
const state = ref<CollabState>(props.provider.getState())
// 提示放在这里而不是编辑器里:文档被替换(权限变化、内容在别处被改)时编辑器会整个重建,挂在它身上的提示会被一起清掉,
// 而「你的修改没有保存」恰恰就是在那一刻发出的
const notices = ref<ShownNotice[]>([])
let noticeSeq = 0
const noticeTimers = new Map<number, number>()
let offState: (() => void) | null = null
let offNotice: (() => void) | null = null

function drop(id: number) {
  window.clearTimeout(noticeTimers.get(id))
  noticeTimers.delete(id)
  notices.value = dismissNotice(notices.value, id)
}

function bind(provider: CollabProvider) {
  offState?.()
  offNotice?.()
  offState = provider.subscribe((next) => {
    state.value = next
  })
  offNotice = provider.on('notice', (notice) => {
    const id = ++noticeSeq
    // 同样的话会替换旧的那条:旧条目的计时要一起清掉,否则它会提前把新的收起来
    for (const old of notices.value) if (old.text === notice.text) drop(old.id)
    notices.value = pushNotice(notices.value, notice, id)
    if (autoDismiss(notice)) noticeTimers.set(id, window.setTimeout(() => drop(id), INFO_TTL_MS))
  })
}
watch(() => props.provider, bind, { immediate: true })
onBeforeUnmount(() => {
  offState?.()
  offNotice?.()
  for (const timer of noticeTimers.values()) window.clearTimeout(timer)
})

const text = computed(() => statusText(state.value))
/**
 * 一切正常(已同步、没被终止、可写)时折叠成一个小圆点:文字还在 DOM 里给读屏软件和测试用,只是不占一行。
 * 连接中 / 同步中 / 断线 / 被终止 / 只读都有话要说,展开成整行。
 */
const quiet = computed(() => state.value.status === 'synced' && !state.value.end && state.value.writable)
</script>

<template>
  <div class="kb-collab-bar" :class="{ 'is-quiet': quiet }" data-testid="collab-bar" :data-status="state.status">
    <!-- 圆点和文字在同一个元素里:窄屏换行时它们不会被拆到两行 -->
    <span :key="`${state.status}:${quiet}`" class="kb-collab-status" data-testid="collab-status" role="status" :title="quiet ? text : undefined">
      <span class="kb-collab-dot" :class="`is-${state.status}`" aria-hidden="true"></span><template v-if="quiet"><span class="kb-sr">{{ text }}</span><span aria-hidden="true">已同步</span></template><template v-else>{{ text }}</template>
    </span>
    <template v-if="state.end">
      <KbButton v-if="state.end.reopenable" size="sm" data-testid="collab-reopen" @click="provider.reopen()">重新打开</KbButton>
    </template>
    <KbButton v-else-if="state.status === 'offline'" size="sm" data-testid="collab-retry" @click="provider.retryNow()">立即重试</KbButton>
  </div>
  <ul v-if="notices.length" class="kb-collab-notices" data-testid="collab-notices">
    <li v-for="notice in notices" :key="notice.id" class="kb-collab-notice" :class="`is-${notice.tone}`" :role="notice.tone === 'warn' ? 'alert' : 'status'">
      <span class="kb-collab-notice-text">{{ notice.text }}</span>
      <button type="button" class="kb-collab-notice-x" aria-label="知道了" @click="drop(notice.id)">知道了</button>
    </li>
  </ul>
</template>

<style>
.kb-collab-bar { box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; min-height: var(--sp-5); color: var(--text-secondary); font-size: var(--text-12); }
/* 状态变了（连接中 → 已同步 → 离线）：文字淡入、圆点换色有过渡，不是一帧硬切 */
.kb-collab-status { animation: kb-fade-in var(--dur-base) var(--ease-out) both; }
.kb-collab-dot { transition: background-color var(--dur-base) var(--ease-out); }
.kb-collab-dot { display: inline-block; width: var(--sp-2); height: var(--sp-2); margin-right: var(--sp-2); border-radius: 50%; background: var(--text-secondary); vertical-align: baseline; }
.kb-collab-dot.is-synced { background: var(--status-success-text); }
.kb-collab-dot.is-syncing, .kb-collab-dot.is-connecting { background: var(--status-warning-text); }
.kb-collab-dot.is-offline, .kb-collab-dot.is-closed { background: var(--status-danger-text); }
.kb-collab-status { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
.kb-collab-bar > .kb-btn { flex: none; }
/* 一切正常:收成「● 已同步」一小段,并进元信息行,不占一整行。完整的一句话(已同步 · 多人编辑中)用 .kb-sr 留给读屏软件和 tooltip */
.kb-collab-bar.is-quiet { width: auto; min-height: 0; display: inline-flex; }
/* 提示:在元信息行里独占一整行(flex-basis 100%),警告用状态色的淡底,和文档里的其它提示条一个样式 */
.kb-collab-notices { flex: 1 1 100%; display: flex; flex-direction: column; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.kb-collab-notice { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); color: var(--text-secondary); background: var(--surface-2); border: var(--hl) solid var(--b2); border-radius: var(--r2); }
.kb-collab-notice.is-warn { background: color-mix(in srgb, var(--status-warning) 9%, var(--surface-1)); border-color: color-mix(in srgb, var(--status-warning) 35%, transparent); }
.kb-collab-notice-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.kb-collab-notice-x { flex: none; min-height: 28px; padding: 0 var(--sp-3); color: var(--text-primary); background: transparent; border: var(--hl) solid var(--b2); border-radius: var(--r1); cursor: pointer; font: inherit; }
.kb-collab-notice-x:focus-visible { outline: none; box-shadow: var(--ring); }
@media (pointer: coarse) { .kb-collab-notice-x { min-height: 44px; min-width: 44px; } }
.kb-collab-bar.is-quiet .kb-collab-status { white-space: nowrap; }
/* 连接中 / 同步中只是几百毫秒的过渡状态，也排在元信息行里、不独占一整行：
   否则连上后这一整行消失，下面的内容整体往上跳一截 */
.kb-collab-bar[data-status='connecting'], .kb-collab-bar[data-status='syncing'] { width: auto; min-height: 0; display: inline-flex; }
.kb-collab-bar[data-status='connecting'] .kb-collab-status, .kb-collab-bar[data-status='syncing'] .kb-collab-status { white-space: nowrap; }
</style>
