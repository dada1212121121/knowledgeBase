<script setup lang="ts">
// 好友列表:搜索、点一行(或「管理」)打开详情面板改备注 / 分组 / 删除。
// 四种状态:加载(骨架屏)、空(给下一步)、出错(可重试)、没有符合搜索的好友。「没有开通」由页面整体处理。
import { computed, ref } from 'vue'
import { KbButton, KbEmpty, KbInput, KbResponsiveTable, KbSkeleton, type RtColumn } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import FriendManageDialog from '@/components/friends/FriendManageDialog.vue'
import type { Friend } from '@/api/social'
import { useFriendsStore } from '@/stores/friends'
import { filterFriends, formatWhen, friendSubtitle, friendTitle } from '@/utils/social'

defineEmits<{ add: [] }>()

const store = useFriendsStore()
const query = ref('')
const managing = ref<Friend | null>(null)

const visible = computed(() => filterFriends(store.friends, query.value))
// 已有的分组名,给详情面板里的分组输入框做候选,少打错字
const groups = computed(() => [...new Set(store.friends.map((item) => item.group_name).filter((name): name is string => !!name))])

const columns: RtColumn[] = [
  { key: 'name', label: '好友', mobile: 'primary' },
  { key: 'group_name', label: '分组' },
  { key: 'since', label: '加好友时间' },
]
const open = (row: Friend) => (managing.value = row)
</script>

<template>
  <section class="card kb-fl" data-testid="friend-list" aria-label="好友列表">
    <KbSkeleton v-if="store.friendsStatus === 'loading' || store.friendsStatus === 'idle'" variant="list" :lines="5" class="kb-fl-pad" />

    <KbEmpty v-else-if="store.friendsStatus === 'error'" icon="failed" title="没能加载好友列表" :description="store.friendsError" data-testid="friends-error">
      <template #action><KbButton variant="primary" @click="store.loadFriends()">重新加载</KbButton></template>
    </KbEmpty>

    <KbEmpty v-else-if="!store.friends.length" icon="users" title="还没有好友" description="输入对方完整的用户名或邮箱,发出好友申请。对方通过后,分享文档时就能在好友里直接选到。" data-testid="friends-empty">
      <template #action><KbButton variant="primary" @click="$emit('add')">添加好友</KbButton></template>
    </KbEmpty>

    <template v-else>
      <div class="kb-fl-bar">
        <KbInput v-model="query" type="search" placeholder="搜索好友" aria-label="搜索好友(备注、昵称、用户名、分组)" enterkeyhint="search" autocomplete="off" data-testid="friend-filter" />
        <span class="m kb-fl-count" data-testid="friend-count">共 {{ store.friends.length }} 位好友</span>
      </div>
      <KbEmpty v-if="!visible.length" size="sm" icon="search" :title="`没有符合「${query.trim()}」的好友`" description="换个关键词试试,或者清除搜索。">
        <template #action><KbButton @click="query = ''">清除搜索</KbButton></template>
      </KbEmpty>
      <KbResponsiveTable v-else :columns="columns" :rows="visible" clickable @row-click="open">
        <template #cell-name="{ row }">
          <span class="kb-fl-who">
            <UserAvatar :user-id="row.id" :name="row.display_name || row.username" :file="row.avatar" :size="36" />
            <span class="kb-fl-name">
              <b>{{ friendTitle(row) }}</b>
              <span class="m">{{ friendSubtitle(row) }}</span>
            </span>
          </span>
        </template>
        <template #cell-group_name="{ row }">{{ row.group_name || '未分组' }}</template>
        <template #cell-since="{ row }">{{ formatWhen(row.since) }}</template>
        <template #row-actions="{ row }">
          <KbButton size="sm" :aria-label="`管理好友:${friendTitle(row)}`" data-testid="friend-manage-btn" @click="open(row)">管理</KbButton>
        </template>
      </KbResponsiveTable>
    </template>

    <FriendManageDialog v-if="managing" :friend="managing" :groups="groups" @close="managing = null" />
  </section>
</template>

<style scoped>
.kb-fl { min-width: 0; overflow: hidden; }
.kb-fl-pad { padding: var(--card-pad-ui); }
.kb-fl-bar { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--card-pad-ui); border-bottom: var(--hl) solid var(--b); flex-wrap: wrap; }
.kb-fl-bar :deep(.kb-input) { flex: 1 1 12em; min-width: 0; }
/* 手机上卡内的搜索条和下面的条目(kb-rt-card,左右 12px)用同一条左边线,不再比条目内容多缩进 8px */
@media (max-width: 599px) { .kb-fl-bar { padding-left: var(--gap); padding-right: var(--gap); } }
.kb-fl-count { white-space: nowrap; }
.kb-fl-who { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.kb-fl-name { display: flex; flex-direction: column; min-width: 0; }
.kb-fl-name b, .kb-fl-name .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-fl-name b { font-weight: var(--fw-medium); }
</style>
