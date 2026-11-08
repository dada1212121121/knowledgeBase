<script setup lang="ts">
// 拉黑名单:我拉黑的人,可以随时取消。
// 隐私:这里只给最少的信息(头像、昵称、用户名、拉黑时间)。对方永远不会收到被拉黑的通知,也看不到这一页。
import { ref } from 'vue'
import { KbButton, KbEmpty, KbSkeleton, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import type { BlockedUser } from '@/api/social'
import { useFriendsStore } from '@/stores/friends'
import { displayName, formatWhen, socialErrorText } from '@/utils/social'

const store = useFriendsStore()
const toast = useToast()
const busyId = ref('')
const error = ref('')

async function unblock(row: BlockedUser) {
  if (busyId.value) return
  busyId.value = row.user.id
  error.value = ''
  try {
    await store.unblock(row.user.id)
    toast.push(`已取消拉黑${displayName(row.user)}`)
  } catch (err) {
    error.value = socialErrorText(err, '没能取消拉黑。请稍后重试。')
  } finally {
    busyId.value = ''
  }
}
</script>

<template>
  <section class="card kb-bl" data-testid="block-list" aria-label="已拉黑">
    <KbSkeleton v-if="store.blocksStatus === 'loading' || store.blocksStatus === 'idle'" variant="list" :lines="3" class="kb-bl-pad" />

    <KbEmpty v-else-if="store.blocksStatus === 'error'" icon="failed" title="没能加载拉黑名单" :description="store.blocksError" data-testid="blocks-error">
      <template #action><KbButton variant="primary" @click="store.loadBlocks()">重新加载</KbButton></template>
    </KbEmpty>

    <template v-else>
      <p v-if="error" class="kb-bl-error" role="alert" data-testid="block-error">{{ error }}</p>
      <KbEmpty
        v-if="!store.blocked.length"
        icon="shield"
        title="没有拉黑任何人"
        description="被你拉黑的人不能向你申请好友、不能把文档分享给你,而且他们不会知道。需要时可以在好友详情或收到的申请里拉黑。"
        data-testid="blocks-empty"
      />
      <template v-else>
        <p class="m kb-bl-hint">被拉黑的人不会收到通知。取消拉黑不会恢复好友关系,对方需要重新申请。</p>
        <ul class="kb-bl-list" role="list">
          <li v-for="row in store.blocked" :key="row.user.id" class="kb-bl-item" data-testid="block-row">
            <UserAvatar :user-id="row.user.id" :name="displayName(row.user)" :file="row.user.avatar" :size="40" />
            <div class="kb-bl-body">
              <b>{{ displayName(row.user) }}</b>
              <span class="m">@{{ row.user.username }} · 拉黑于 {{ formatWhen(row.since) }}</span>
            </div>
            <KbButton size="sm" :disabled="busyId === row.user.id" :aria-label="`取消拉黑${displayName(row.user)}`" data-testid="block-undo" @click="unblock(row)">取消拉黑</KbButton>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
.kb-bl { min-width: 0; overflow: hidden; }
.kb-bl-pad { padding: var(--card-pad-ui); }
.kb-bl-hint { margin: 0; padding: var(--sp-3) var(--card-pad-ui) var(--sp-2); font-size: var(--text-12); }
.kb-bl-error { margin: 0; padding: var(--sp-3) var(--card-pad-ui) 0; color: var(--status-danger-text); }
.kb-bl-list { list-style: none; margin: 0; padding: 0; }
.kb-bl-item { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--card-pad-ui); min-width: 0; }
.kb-bl-item + .kb-bl-item { border-top: var(--hl) solid var(--b); }
/* 按钮不随名字变长而被挤窄(窄了文字会从按钮边框里漏出来) */
.kb-bl-item :deep(.kb-btn) { flex: none; white-space: nowrap; }
.kb-bl-body { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.kb-bl-body b { font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.kb-bl-body .m { font-size: var(--text-12); overflow-wrap: anywhere; }
</style>
