<script setup lang="ts">
// 好友申请:收到的(通过 / 拒绝 / 忽略)和我发出的(等待对方处理)。
//
// 三种处理的差别要写清楚,免得用户点错（设计规范）:
//   通过 = 成为好友;拒绝 = 通知对方「没有通过」,24 小时内对方不能再申请;忽略 = 不通知对方,对方看到的仍是等待中。
// 申请 7 天没人处理会自动过期。
import { ref } from 'vue'
import { KbButton, KbEmpty, KbSkeleton, useConfirm, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import { CapabilityError } from '@/api/client'
import type { Decision, IncomingRequest, PublicProfile } from '@/api/social'
import { useFriendsStore } from '@/stores/friends'
import { blockConfirmText, displayName, expiresText, formatWhen, socialErrorText } from '@/utils/social'

defineEmits<{ add: [] }>()

const store = useFriendsStore()
const confirm = useConfirm()
const toast = useToast()

/** 正在处理的那一条:它的按钮暂时不可点,别的条不受影响。 */
const busyId = ref('')
/** 上一次处理失败的原因,显示在收到的申请上方(下一次操作时清掉)。 */
const actionError = ref('')

const nameOf = (profile: PublicProfile) => displayName(profile)

async function act(request: IncomingRequest, decision: Decision) {
  if (busyId.value) return
  busyId.value = request.id
  actionError.value = ''
  try {
    await store.decide(request.id, decision)
    const who = nameOf(request.from)
    toast.push(decision === 'accept' ? `你和${who}已经是好友了` : decision === 'reject' ? `已拒绝${who}的申请` : `已忽略${who}的申请`)
  } catch (err) {
    // 404 = 这条申请已经被处理过或过期了(比如在另一个窗口里通过了);列表已经在后台刷新
    actionError.value =
      err instanceof CapabilityError && err.status === 404
        ? '这条申请已经处理过或已过期,列表已更新。'
        : socialErrorText(err, '没能处理这条申请。请稍后重试。')
  } finally {
    busyId.value = ''
  }
}

async function reject(request: IncomingRequest) {
  const ok = await confirm.ask({
    title: `拒绝${nameOf(request.from)}的好友申请?`,
    message: '对方会收到「没有通过」的通知,24 小时内不能再向你申请。如果只是暂时不想处理,可以选「忽略」,对方不会收到通知。',
    confirmText: '拒绝',
  })
  if (ok) await act(request, 'reject')
}

/** 骚扰型申请:直接拉黑(对方不会知道);拉黑会作废这条申请,所以列表会跟着刷新。 */
async function block(request: IncomingRequest) {
  if (busyId.value) return
  const ok = await confirm.ask({
    ...blockConfirmText(nameOf(request.from)),
    action: async () => {
      busyId.value = request.id
      actionError.value = ''
      try {
        await store.block(request.from.id)
      } finally {
        busyId.value = ''
      }
    },
  })
  if (ok) toast.push(`已拉黑${nameOf(request.from)}`)
}
</script>

<template>
  <section class="card kb-rq" data-testid="friend-requests" aria-label="好友申请">
    <KbSkeleton v-if="store.requestsStatus === 'loading' || store.requestsStatus === 'idle'" variant="list" :lines="3" class="kb-rq-pad" />

    <KbEmpty v-else-if="store.requestsStatus === 'error'" icon="failed" title="没能加载好友申请" :description="store.requestsError" data-testid="requests-error">
      <template #action><KbButton variant="primary" @click="store.loadRequests()">重新加载</KbButton></template>
    </KbEmpty>

    <template v-else>
      <!-- 处理失败的原因放在最上面、不属于哪一栏:最后一条申请处理失败(比如已在别处处理过)后两栏都空了,原因也要留着 -->
      <p v-if="actionError" class="kb-rq-error" role="alert" data-testid="request-error">{{ actionError }}</p>

      <KbEmpty
        v-if="!store.incoming.length && !store.outgoing.length"
        icon="inbox"
        title="没有待处理的好友申请"
        description="别人向你发来的申请,和你发出去还在等待的申请,都会出现在这里。"
        data-testid="requests-empty"
      >
        <template #action><KbButton variant="primary" @click="$emit('add')">添加好友</KbButton></template>
      </KbEmpty>

      <template v-else>
        <section class="kb-rq-section" aria-labelledby="rq-in">
          <h2 id="rq-in" class="kb-rq-h">收到的申请<span class="m"> · {{ store.incoming.length }}</span></h2>
          <p v-if="!store.incoming.length" class="m kb-rq-none" data-testid="requests-none-in">现在没有人在等你处理。</p>
          <ul v-else class="kb-rq-list" role="list">
            <li v-for="request in store.incoming" :key="request.id" class="kb-rq-item" data-testid="request-in">
              <UserAvatar :user-id="request.from.id" :name="nameOf(request.from)" :file="request.from.avatar" :size="40" />
              <div class="kb-rq-body">
                <div class="kb-rq-name"><b>{{ nameOf(request.from) }}</b><span class="m">@{{ request.from.username }}</span></div>
                <p v-if="request.message" class="kb-rq-msg">“{{ request.message }}”</p>
                <span class="m kb-rq-meta">{{ formatWhen(request.created_at) }} · {{ expiresText(request.expires_at) }}</span>
              </div>
              <div class="kb-rq-actions">
                <KbButton variant="primary" size="sm" :disabled="busyId === request.id" :aria-label="`通过${nameOf(request.from)}的好友申请`" data-testid="request-accept" @click="act(request, 'accept')">通过</KbButton>
                <KbButton size="sm" :disabled="busyId === request.id" :aria-label="`拒绝${nameOf(request.from)}的好友申请`" data-testid="request-reject" @click="reject(request)">拒绝</KbButton>
                <KbButton size="sm" :disabled="busyId === request.id" :aria-label="`忽略${nameOf(request.from)}的好友申请`" data-testid="request-ignore" @click="act(request, 'ignore')">忽略</KbButton>
                <KbButton size="sm" :disabled="busyId === request.id" :aria-label="`拉黑${nameOf(request.from)}`" data-testid="request-block" @click="block(request)">拉黑</KbButton>
              </div>
            </li>
          </ul>
          <p v-if="store.incoming.length" class="m kb-rq-hint">拒绝会通知对方,24 小时内对方不能再向你申请;忽略不会通知对方;拉黑后对方再也不能向你申请(也不会收到通知)。申请 7 天没人处理会自动过期。</p>
        </section>

        <section class="kb-rq-section" aria-labelledby="rq-out">
          <h2 id="rq-out" class="kb-rq-h">我发出的申请<span class="m"> · {{ store.outgoing.length }}</span></h2>
          <p v-if="!store.outgoing.length" class="m kb-rq-none" data-testid="requests-none-out">你没有在等待对方处理的申请。</p>
          <ul v-else class="kb-rq-list" role="list">
            <li v-for="request in store.outgoing" :key="request.id" class="kb-rq-item" data-testid="request-out">
              <UserAvatar :user-id="request.to.id" :name="nameOf(request.to)" :file="request.to.avatar" :size="40" />
              <div class="kb-rq-body">
                <div class="kb-rq-name"><b>{{ nameOf(request.to) }}</b><span class="m">@{{ request.to.username }}</span></div>
                <p v-if="request.message" class="kb-rq-msg">“{{ request.message }}”</p>
                <span class="m kb-rq-meta">等待对方处理 · {{ formatWhen(request.created_at) }}发出 · {{ expiresText(request.expires_at) }}</span>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.kb-rq { min-width: 0; overflow: hidden; }
.kb-rq-pad { padding: var(--card-pad-ui); }
.kb-rq-section + .kb-rq-section { border-top: var(--hl) solid var(--b); }
.kb-rq-section { padding: var(--sp-3) 0; min-width: 0; }
.kb-rq-h { margin: 0; padding: var(--sp-2) var(--card-pad-ui); font-size: var(--text-14); font-weight: var(--fw-title); }
.kb-rq-h .m { font-weight: var(--fw-regular); }
.kb-rq-none { margin: 0; padding: 0 var(--card-pad-ui) var(--sp-2); }
.kb-rq-error { margin: 0; padding: var(--sp-3) var(--card-pad-ui) 0; color: var(--status-danger-text); }
.kb-rq-hint { margin: 0; padding: var(--sp-2) var(--card-pad-ui) 0; font-size: var(--text-12); }
.kb-rq-list { list-style: none; margin: 0; padding: 0; }
.kb-rq-item { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3) var(--card-pad-ui); min-width: 0; flex-wrap: wrap; }
.kb-rq-item + .kb-rq-item { border-top: var(--hl) solid var(--b); }
.kb-rq-body { flex: 1 1 14em; display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.kb-rq-name { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; flex-wrap: wrap; }
.kb-rq-name b { font-weight: var(--fw-medium); overflow-wrap: anywhere; }
.kb-rq-msg { margin: 0; overflow-wrap: anywhere; }
.kb-rq-meta { font-size: var(--text-12); }
.kb-rq-actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
</style>
