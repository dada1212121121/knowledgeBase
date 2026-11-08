<script setup lang="ts">
// 好友页:好友、申请、已拉黑、隐私四个页签,右上角「添加好友」。
// 页面骨架:标题与主操作 → 页签 → 内容;加载 / 空 / 报错在各自的面板里,「没有开通」在这里整体处理。
// 页签记在地址里(?tab=requests),通知抽屉里点「好友申请」能直接落在申请页签上。
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KbButton, KbEmpty, KbPageHeader, KbTabs } from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import AddFriendDialog from '@/components/friends/AddFriendDialog.vue'
import BlockList from '@/components/friends/BlockList.vue'
import FriendList from '@/components/friends/FriendList.vue'
import FriendRequests from '@/components/friends/FriendRequests.vue'
import PrivacyPanel from '@/components/friends/PrivacyPanel.vue'
import { useFeature } from '@/composables/useFeature'
import { useLiveEvents, type LiveEvent } from '@/composables/useLiveEvents'
import { useFriendsStore } from '@/stores/friends'

const store = useFriendsStore()
const enabled = useFeature('collab.friends')
// 功能点没开,或者后端对好友能力返回 403 / 404:都显示「没有开通」
const off = computed(() => !enabled.value || store.forbidden)
const adding = ref(false)

type Tab = 'friends' | 'requests' | 'blocked' | 'privacy'
const TAB_NAMES: readonly Tab[] = ['friends', 'requests', 'blocked', 'privacy']
const TAB_LABELS: Record<Tab, string> = { friends: '好友', requests: '申请', blocked: '已拉黑', privacy: '隐私' }
const route = useRoute()
const router = useRouter()
const tabFromQuery = (): Tab => TAB_NAMES.find((name) => name === route.query.tab) ?? 'friends'
const tab = ref<Tab>(tabFromQuery())
// 地址变了(已经在好友页时从通知里点了「好友申请」)跟着变;自己切页签时把页签写回地址
watch(() => route.query.tab, () => (tab.value = tabFromQuery()))
watch(tab, (value) => {
  if (value !== tabFromQuery()) void router.replace({ query: value === 'friends' ? {} : { tab: value } })
})
const tabs = computed(() => [
  { value: 'friends', label: TAB_LABELS.friends, count: store.friends.length || undefined },
  // 待处理的数量是最需要一眼看到的,所以只数「收到的」
  { value: 'requests', label: TAB_LABELS.requests, count: store.incoming.length || undefined },
  // 拉黑名单和隐私设置第一次打开对应页签时才去取(多数时候用不到)
  { value: 'blocked', label: TAB_LABELS.blocked, count: store.blocksStatus === 'ready' && store.blocked.length ? store.blocked.length : undefined },
  { value: 'privacy', label: TAB_LABELS.privacy },
])
function ensureLoaded(value: Tab) {
  if (off.value) return
  if (value === 'blocked' && store.blocksStatus === 'idle') void store.loadBlocks()
  if (value === 'privacy' && store.privacyStatus === 'idle') void store.loadPrivacy()
}
watch(tab, ensureLoaded)

function loadAll() {
  void store.loadFriends()
  void store.loadRequests()
  ensureLoaded(tab.value)
}
onMounted(() => {
  if (enabled.value) loadAll()
})
// 功能表是异步到的(刷新页面时先按「有」处理),晚到的结果可能让这页从可用变成不可用,反过来也一样
watch(enabled, (value) => {
  if (value && store.friendsStatus === 'idle') loadAll()
})

// 收到申请 / 申请有了结果:对应的数据在后台静默刷新,不闪骨架屏
useLiveEvents((event: LiveEvent) => {
  if (event.type !== 'notify' || off.value) return
  const kind = (event.data.notification as { kind?: string } | undefined)?.kind
  if (kind === 'friend_request') void store.loadRequests({ silent: true })
  if (kind === 'friend_result') {
    void store.loadFriends({ silent: true })
    void store.loadRequests({ silent: true })
  }
})

function onSent(status: string) {
  // 发出去的申请要出现在「我发出的」里;对方先申请过时发申请等于通过,好友列表也要多一个人
  void store.loadRequests({ silent: true })
  if (status === 'friends') void store.loadFriends({ silent: true })
}
</script>

<template>
  <AppShell>
    <div class="kb-friends" data-testid="friends">
      <KbPageHeader title="好友" description="好友之间分享文档更方便:分享时优先出现在选择列表里。">
        <template v-if="!off" #actions>
          <KbButton variant="primary" data-testid="friend-add" @click="adding = true">添加好友</KbButton>
        </template>
      </KbPageHeader>

      <KbEmpty v-if="off" icon="lock" title="你的账号没有开通这个功能" description="好友功能需要管理员为你的账号开通。请联系管理员。" data-testid="friends-off" />
      <template v-else>
        <KbTabs v-model="tab" :tabs="tabs" />
        <div role="tabpanel" :aria-label="TAB_LABELS[tab]">
          <FriendList v-if="tab === 'friends'" @add="adding = true" />
          <FriendRequests v-else-if="tab === 'requests'" @add="adding = true" />
          <BlockList v-else-if="tab === 'blocked'" />
          <PrivacyPanel v-else />
        </div>
      </template>

      <AddFriendDialog v-if="adding" @close="adding = false" @sent="onSent" />
    </div>
  </AppShell>
</template>

<style scoped>
.kb-friends { display: flex; flex-direction: column; gap: var(--gap); width: 100%; max-width: 1280px; margin: 0 auto; min-width: 0; }
</style>
