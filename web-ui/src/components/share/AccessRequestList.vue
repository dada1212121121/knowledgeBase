<script setup lang="ts">
// 访问申请（设计规范）:别人向我(或我「可管理」的内容)申请权限,在这里同意 / 拒绝;下面是我自己发出去的申请。
// 同意时可以改成别的角色(最多授予与自己相同的角色,超过后端会拒绝并说明);同一个人对同一份内容 24 小时内只能申请一次。
// 被别人先处理掉了(404 没有这条待处理的申请)就如实说并刷新,不是默默失败。
import { onMounted, ref } from 'vue'
import { KbBadge, KbButton, KbEmpty, KbSelect, KbSkeleton, useConfirm, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import { accessDecide, accessRequests, type AccessRequestRow, type GrantRole } from '@/api/share'
import { personName, relativeTime, roleLabel, roleOptions, shareErrorText, targetKindLabel, targetName } from '@/utils/share'

const emit = defineEmits<{ count: [pending: number] }>()

const toast = useToast()
const confirmer = useConfirm()

const status = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')
const toDecide = ref<AccessRequestRow[]>([])
const mine = ref<AccessRequestRow[]>([])
/** 每条申请批准时选的角色,默认是对方申请的那一档 */
const chosen = ref<Record<string, GrantRole>>({})
const busy = ref('')
const rowError = ref<Record<string, string>>({})

const ROLE_CHOICES = roleOptions(['viewer', 'commenter', 'editor', 'manager'])

async function load() {
  if (status.value !== 'ready') status.value = 'loading'
  try {
    const result = await accessRequests()
    toDecide.value = result.to_decide ?? []
    mine.value = result.mine ?? []
    chosen.value = Object.fromEntries(toDecide.value.map((row) => [row.id, chosen.value[row.id] ?? row.role]))
    status.value = 'ready'
    emit('count', toDecide.value.length)
  } catch (err) {
    errorText.value = shareErrorText(err, '访问申请没有加载出来。检查网络后重试。')
    status.value = 'error'
  }
}
onMounted(() => void load())

const nameOf = (row: AccessRequestRow) => (row.target ? targetName(row.target, row.title) : row.title || '未命名')

async function decide(row: AccessRequestRow, approve: boolean) {
  if (busy.value) return
  if (!approve) {
    const ok = await confirmer.ask({
      title: `拒绝 ${row.requester ? personName(row.requester) : '对方'} 的申请?`,
      message: '对方会收到通知。同一份内容 24 小时内只能申请一次,所以他一天之内不能再申请。',
      confirmText: '拒绝',
      tone: 'danger',
    })
    if (!ok) return
  }
  busy.value = row.id
  delete rowError.value[row.id]
  try {
    await accessDecide(row.id, approve, approve ? chosen.value[row.id] : undefined)
    toast.push(approve ? `已同意,${row.requester ? personName(row.requester) : '对方'}现在是「${roleLabel(chosen.value[row.id])}」` : '已拒绝')
    await load()
  } catch (err) {
    rowError.value[row.id] = shareErrorText(err)
    // 多半是别人先处理了,或我已经没有权限:重读一遍让列表回到真实状态(错误提示留在这一行不消失)
    if ((err as { status?: number }).status === 404) await load()
  } finally {
    busy.value = ''
  }
}

const STATE: Record<AccessRequestRow['state'], { text: string; tone: 'warning' | 'success' | 'danger' }> = {
  pending: { text: '等待处理', tone: 'warning' },
  approved: { text: '已通过', tone: 'success' },
  rejected: { text: '已拒绝', tone: 'danger' },
}
</script>

<template>
  <div class="kb-ar" data-testid="access-requests">
    <KbSkeleton v-if="status === 'loading'" variant="list" :lines="3" />
    <KbEmpty v-else-if="status === 'error'" icon="failed" title="访问申请没有加载出来" :description="errorText" data-testid="requests-error">
      <template #action><KbButton size="sm" @click="load">重试</KbButton></template>
    </KbEmpty>

    <template v-else>
      <section aria-labelledby="ar-todo">
        <h3 id="ar-todo" class="kb-ar-title">等我处理<span v-if="toDecide.length" class="kb-ar-count">{{ toDecide.length }}</span></h3>
        <KbEmpty v-if="!toDecide.length" icon="inbox" title="现在没有等你处理的申请" description="别人向你申请权限时,会出现在这里,你也会收到通知。" size="sm" data-testid="requests-empty" />
        <ul v-else class="kb-ar-list">
          <li v-for="row in toDecide" :key="row.id" class="kb-ar-card" :data-testid="`request-${row.id}`">
            <div class="kb-ar-who">
              <UserAvatar v-if="row.requester" :user-id="row.requester.id" :name="personName(row.requester)" :file="row.requester.avatar" :size="32" />
              <div class="kb-ar-text">
                <b>{{ row.requester ? personName(row.requester) : '一位用户' }}</b>
                <span>申请「{{ roleLabel(row.role) }}」权限 · {{ relativeTime(row.created_at) }}</span>
              </div>
            </div>
            <p class="kb-ar-target">
              {{ nameOf(row) }}
              <KbBadge v-if="row.target" tone="neutral">{{ targetKindLabel(row.target) }}</KbBadge>
            </p>
            <p v-if="row.message" class="kb-ar-message" data-testid="request-message">「{{ row.message }}」</p>
            <div class="kb-ar-actions">
              <KbSelect v-model="chosen[row.id]" :options="ROLE_CHOICES" size="sm" align="start" aria-label="同意后的角色" :data-testid="`request-role-${row.id}`" />
              <KbButton size="sm" variant="primary" :disabled="busy === row.id" :data-testid="`request-approve-${row.id}`" @click="decide(row, true)">同意</KbButton>
              <KbButton size="sm" variant="danger" :disabled="busy === row.id" :data-testid="`request-reject-${row.id}`" @click="decide(row, false)">拒绝</KbButton>
            </div>
            <p v-if="rowError[row.id]" class="kb-ar-error" role="alert" :data-testid="`request-error-${row.id}`">{{ rowError[row.id] }}</p>
          </li>
        </ul>
      </section>

      <section aria-labelledby="ar-mine">
        <h3 id="ar-mine" class="kb-ar-title">我发出的</h3>
        <p v-if="!mine.length" class="kb-ar-none" data-testid="requests-mine-empty">你还没有向别人申请过权限。打开别人分享给你的内容时,点「申请编辑」即可。</p>
        <ul v-else class="kb-ar-list">
          <li v-for="row in mine" :key="row.id" class="kb-ar-mine" :data-testid="`mine-${row.id}`">
            <div class="kb-ar-text">
              <b>{{ nameOf(row) }}</b>
              <span>申请「{{ roleLabel(row.role) }}」 · {{ relativeTime(row.created_at) }}<template v-if="row.decided_at"> · {{ relativeTime(row.decided_at) }}处理</template></span>
            </div>
            <KbBadge :tone="STATE[row.state]?.tone ?? 'neutral'">{{ STATE[row.state]?.text ?? row.state }}</KbBadge>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style>
.kb-ar { display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; }
.kb-ar-title { margin: 0 0 var(--sp-2); font-size: var(--text-15); font-weight: var(--fw-title); display: flex; align-items: center; gap: var(--sp-2); }
.kb-ar-count { font-size: var(--text-12); font-weight: var(--fw-regular); padding: 0 6px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--status-warning) 22%, transparent); color: var(--status-warning-text); }
.kb-ar-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.kb-ar-card { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border: var(--hl) solid var(--border-subtle); border-radius: var(--r3); background: var(--surface-1); min-width: 0; }
.kb-ar-who { display: flex; align-items: center; gap: var(--sp-3); min-width: 0; }
.kb-ar-text { display: flex; flex-direction: column; min-width: 0; }
.kb-ar-text b { font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.kb-ar-text span { color: var(--text-tertiary); font-size: var(--text-12); }
.kb-ar-target { margin: 0; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--text-14); overflow-wrap: anywhere; }
.kb-ar-message { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: rgb(var(--ink), 0.04); color: var(--text-secondary); font-size: var(--text-13); line-height: var(--lh-body); overflow-wrap: anywhere; }
.kb-ar-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.kb-ar-error { margin: 0; color: var(--status-danger-text); font-size: var(--text-13); line-height: var(--lh-body); }
.kb-ar-none { margin: 0; color: var(--text-tertiary); font-size: var(--text-13); line-height: var(--lh-body); }
.kb-ar-mine { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: var(--hl) solid var(--border-subtle); border-radius: var(--r3); min-width: 0; }
@media (pointer: coarse) {
  .kb-ar-actions .kb-select .btn { min-height: 44px; }
}
</style>
