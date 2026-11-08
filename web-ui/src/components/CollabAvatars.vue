<script setup lang="ts">
// 多人在线编辑的"谁在这篇文档里"(腾讯文档式):头像堆 + 点开的"正在编辑"列表。
// 放在编辑页顶栏的操作区最前面。我自己排第一,其他人按名字排;每个头像外圈是这个人的光标颜色,
// 和文档里他的光标、名牌是同一个颜色,看头像就知道光标是谁的。
// 身份以服务端认定的为准(光标和名字都是服务端改写过的),这里只读 awareness,不信客户端自报。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { KbSheet } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import { lookupAvatars } from '@/api/avatars'
import type { CollabProvider, CollabState } from '@/collab/provider'
import { cursorColor, textOn } from '@/collab/cursor'
import { ActivityTracker } from '@/collab/activity'
import { peersOf, splitStack, stackOf, type Peer } from '@/collab/status'

const props = defineProps<{ provider: CollabProvider; max?: number }>()
const state = ref<CollabState>(props.provider.getState())
const peers = ref<Peer[]>([])
const open = ref(false)
/** 此刻光标刚动过的人(头像上亮一个小点):判定见 collab/activity.ts */
const activeIds = ref<Set<string>>(new Set())
/** 点了某个人但他还没把光标放进正文:跳不过去,在名单里说一声,而不是点了没反应 */
const noCursor = ref('')
let tracker = new ActivityTracker()
let activityTimer = 0
let offState: (() => void) | null = null
let offAwareness: (() => void) | null = null

function syncActivity(provider: CollabProvider) {
  tracker.observe(provider.awareness.getStates(), provider.awareness.clientID)
  activeIds.value = new Set(peers.value.filter((peer) => tracker.isActive(peer.id)).map((peer) => peer.id))
  // 到点灭灯:按最早一个过期的时间安排下一次刷新,不轮询
  window.clearTimeout(activityTimer)
  const left = tracker.nextExpiry()
  if (left !== null) activityTimer = window.setTimeout(() => syncActivity(provider), left + 20)
}

function bind(provider: CollabProvider) {
  offState?.()
  offAwareness?.()
  tracker = new ActivityTracker()
  const refresh = () => {
    peers.value = peersOf(provider.awareness.getStates(), provider.awareness.clientID)
    syncActivity(provider)
  }
  offState = provider.subscribe((next) => {
    state.value = next
    refresh()
  })
  provider.awareness.on('change', refresh)
  offAwareness = () => provider.awareness.off('change', refresh)
  refresh()
}
watch(() => props.provider, bind, { immediate: true })
watch(() => state.value.docEpoch, () => bind(props.provider))
onBeforeUnmount(() => {
  offState?.()
  offAwareness?.()
  window.clearTimeout(activityTimer)
})

/** 点名单里的人:跳到他的光标,关掉名单让出视野;他没有光标就留着名单并提示 */
function reveal(person: Peer) {
  if (person.me) return
  noCursor.value = ''
  if (props.provider.revealPeer(person.id)) open.value = false
  else noCursor.value = person.id
}

// 断线 / 被终止时不再显示"还在线"的人:连接没了,名单是过期的
const live = computed(() => !state.value.end && state.value.status !== 'offline' && state.value.status !== 'closed')
const everyone = computed(() => stackOf(live.value ? peers.value : [], state.value.me))
const split = computed(() => splitStack(everyone.value, props.max ?? 4))
const count = computed(() => everyone.value.length)

function ringStyle(person: Peer) {
  const color = cursorColor(person.color)
  return { '--ring': color, '--ring-ink': textOn(color) }
}
const label = computed(() => (count.value > 1 ? `${count.value} 人正在编辑,点开查看` : '只有你在编辑,点开查看'))

// 在线名单里只有用户 id,没有头像文件名:名单里出现新面孔时批量问一次谁有头像,只给有头像的人取图
// (逐个取图的话,没有头像的人每人一个 404,控制台被刷屏)。游客不查,UserAvatar 自己画固定的游客头像。
const avatarFiles = ref<Record<string, string | null>>({})
watch(
  () => everyone.value.map((person) => person.id).join(','),
  (joined) => {
    const ids = joined ? joined.split(',') : []
    if (!ids.length) return
    void lookupAvatars(ids).then((found) => {
      avatarFiles.value = { ...avatarFiles.value, ...found }
    })
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="everyone.length" class="kb-cstack" :class="{ 'is-dim': !live }" data-testid="collab-stack">
    <button type="button" class="kb-cstack-btn" :aria-label="label" :title="label" aria-haspopup="dialog" @click="open = true">
      <ul class="kb-cstack-list" data-testid="collab-peers">
        <li v-for="person in split.shown" :key="person.id" :data-peer="person.id" :data-me="person.me ? '' : undefined" :data-active="activeIds.has(person.id) ? '' : undefined" :style="ringStyle(person)">
          <UserAvatar :user-id="person.id" :name="person.name" :file="avatarFiles[person.id]" :size="26" />
        </li>
        <li v-if="split.more" class="kb-cstack-more" data-testid="collab-more">+{{ split.more }}</li>
      </ul>
    </button>

    <KbSheet v-if="open" title="正在编辑" no-autofocus @close="open = false">
      <ul class="kb-clist" data-testid="collab-list">
        <li v-for="person in everyone" :key="person.id" class="kb-clist-row" :data-peer="person.id">
          <!-- 别人的行是一个按钮:点了跳到他的光标(腾讯文档的「跟随」);我自己的行没有可跳的地方,保持普通行 -->
          <component
            :is="person.me ? 'div' : 'button'"
            :type="person.me ? undefined : 'button'"
            class="kb-clist-main"
            :class="{ 'is-link': !person.me }"
            :aria-label="person.me ? undefined : `跳到 ${person.name} 的光标`"
            :data-testid="person.me ? undefined : 'collab-jump'"
            @click="reveal(person)"
          >
          <span class="kb-clist-ring" :style="ringStyle(person)"><UserAvatar :user-id="person.id" :name="person.name" :file="avatarFiles[person.id]" :size="32" /></span>
          <span class="kb-clist-name">{{ person.name }}</span>
          <span v-if="person.me" class="kb-clist-tag">你</span>
          <span v-else-if="activeIds.has(person.id)" class="kb-clist-tag is-live" data-testid="collab-active">正在编辑</span>
          <span class="kb-clist-dot" :style="{ background: cursorColor(person.color) }" aria-hidden="true"></span>
          </component>
          <p v-if="noCursor === person.id" class="kb-clist-hint" role="status">他还没有把光标放进正文。</p>
        </li>
      </ul>
      <p v-if="!live" class="kb-clist-note">连接断开了,这份名单可能已经过期。</p>
    </KbSheet>
  </div>
</template>

<style>
.kb-cstack { display: inline-flex; align-items: center; flex: none; }
.kb-cstack-btn { display: inline-flex; align-items: center; padding: 0 2px; border: 0; background: transparent; border-radius: var(--r-pill, 999px); cursor: pointer; color: inherit; min-height: 36px; }
.kb-cstack-btn:focus-visible { outline: 1.5px solid var(--accent); outline-offset: 1px; }
.kb-cstack-list { display: inline-flex; align-items: center; margin: 0; padding: 0; list-style: none; }
/* 头像叠放:后一个压住前一个的一部分,外圈是这个人的光标颜色,再外一圈是背景色把相邻的头像隔开 */
.kb-cstack-list li { margin-left: -6px; border-radius: var(--r-pill); box-shadow: 0 0 0 2px var(--ring, transparent), 0 0 0 4px var(--bg-canvas, var(--surface-1)); }
.kb-cstack-list li:first-child { margin-left: 0; }
.kb-cstack-list li.kb-cstack-more { display: inline-grid; place-items: center; min-width: 26px; height: 26px; padding: 0 6px; box-sizing: border-box; background: var(--surface-3); color: var(--text-secondary); box-shadow: 0 0 0 2px var(--bg-canvas, var(--surface-1)); font-size: var(--text-11); font-weight: var(--fw-title); }
.kb-cstack.is-dim { opacity: 0.5; filter: grayscale(1); }
.kb-clist { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.kb-clist-row { display: flex; flex-direction: column; border-bottom: var(--hl) solid var(--b); }
.kb-clist-row:last-child { border-bottom: 0; }
/* 一行的内容:头像 + 名字 + 标签 + 颜色点。别人的行是按钮,整行可点(触屏至少 52px 高,够 44px) */
.kb-clist-main { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 6px 0; box-sizing: border-box; color: inherit; font: inherit; text-align: left; background: transparent; border: 0; }
.kb-clist-main.is-link { cursor: pointer; border-radius: var(--r2); }
.kb-clist-main.is-link:hover { background: var(--hover); }
.kb-clist-main.is-link:focus-visible { outline: none; box-shadow: var(--ring); }
.kb-clist-hint { margin: 0 0 8px 44px; color: var(--text-secondary); font-size: var(--text-12); }
/* 正在动的人:头像右下角一个小圆点(外圈用背景色把它和头像隔开),同时名单里有文字「正在编辑」,不只靠颜色 */
.kb-cstack-list li[data-active] { position: relative; }
.kb-cstack-list li[data-active]::after { content: ''; position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border-radius: var(--r-pill); background: var(--status-success); box-shadow: 0 0 0 2px var(--bg-canvas, var(--surface-1)); animation: kb-live-pulse 1.6s ease-in-out infinite; }
@keyframes kb-live-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.25); } }
@media (prefers-reduced-motion: reduce) { .kb-cstack-list li[data-active]::after { animation: none; } }
.kb-clist-tag.is-live { background: color-mix(in srgb, var(--status-success) 14%, transparent); color: var(--status-success-text); }
.kb-clist-ring { display: inline-flex; border-radius: var(--r-pill); box-shadow: 0 0 0 2px var(--ring, transparent); }
.kb-clist-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-14); }
.kb-clist-tag { flex: none; padding: 1px 8px; border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-text); font-size: var(--text-12); }
.kb-clist-dot { flex: none; width: 10px; height: 10px; border-radius: var(--r-pill); }
.kb-clist-note { margin: 8px 0 0; color: var(--m); font-size: var(--text-12); }
</style>
