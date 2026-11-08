<script setup lang="ts">
// 个人设置里的「通知偏好」:每一类通知要不要同时发邮件(后端 notification_prefs,默认值见 kb-core/src/social.rs)。
//
// 站内通知(铃铛)一直会有,不能关;这里只管邮件。邮件按类合并,同一个人最多每 10 分钟一封(后端固定,没有「摘要频率」可选)。
// 开关一拨就保存:先按新值显示,服务端确认后以返回的整张表为准;失败退回原值并写明原因。
// 站点没配好发信时选择照样保存(配好以后生效),但要提醒用户现在发不出去,免得以为开了就收得到。
import { computed, onMounted, ref } from 'vue'
import { KbBadge, KbButton, KbCard, KbEmpty, KbSkeleton, KbSwitch } from '@kb-ui/index'
import { notificationPrefs, type NotificationPrefs } from '@/api/social'
import { useSessionStore } from '@/stores/session'
import { CATEGORIES, KIND_ORDER, kindInfo, type NotificationCategory } from '@/utils/notifications'
import { socialErrorText } from '@/utils/social'

const session = useSessionStore()
const prefs = ref<NotificationPrefs | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const saveError = ref('')
/** 正在保存的那一类;保存期间所有开关暂时不可点(一次只有一个请求在途,返回的整张表不会互相覆盖)。 */
const saving = ref('')

async function load() {
  status.value = 'loading'
  try {
    prefs.value = await notificationPrefs()
    status.value = 'ready'
  } catch (err) {
    loadError.value = socialErrorText(err, '没能加载通知偏好。请检查网络后重试。')
    status.value = 'error'
  }
}
onMounted(load)

async function toggle(kind: string, value: boolean) {
  const before = prefs.value
  if (!before || saving.value) return
  saving.value = kind
  saveError.value = ''
  prefs.value = { ...before, email: { ...before.email, [kind]: value } }
  try {
    prefs.value = await notificationPrefs({ [kind]: value })
  } catch (err) {
    prefs.value = before
    saveError.value = socialErrorText(err, '没能保存。请稍后重试。')
  } finally {
    saving.value = ''
  }
}

// 按分类分组(好友 / 分享 / 评论 / 系统),组内沿用后端给的顺序
const groups = computed(() => {
  const kinds = prefs.value?.kinds?.length ? prefs.value.kinds : KIND_ORDER
  return CATEGORIES.filter((item): item is { value: NotificationCategory; label: string } => item.value !== 'all')
    .map((category) => ({ ...category, kinds: kinds.filter((kind) => kindInfo(kind).category === category.value) }))
    .filter((group) => group.kinds.length)
})
const emailUnverified = computed(() => !!session.user && (!session.user.email || session.user.email_verified === false))
</script>

<template>
  <KbCard class="kb-me-card kb-me-wide" aria-labelledby="me-notify" data-testid="notify-prefs">
    <header class="kb-me-head"><b id="me-notify">通知偏好</b></header>

    <KbSkeleton v-if="status === 'loading'" variant="card" :lines="3" class="kb-np-pad" />

    <KbEmpty v-else-if="status === 'error' || !prefs" icon="failed" title="没能加载通知偏好" :description="loadError" data-testid="np-error">
      <template #action><KbButton variant="primary" @click="load">重新加载</KbButton></template>
    </KbEmpty>

    <template v-else>
      <div class="kb-np-lead">
        <p class="m">所有通知都会出现在顶栏的铃铛里。这里选择哪些通知还要同时发到你的邮箱;同类通知会合并,同一个人最多每 10 分钟收到一封。</p>
        <p v-if="!prefs.mail_available" class="kb-np-warn" data-testid="np-mail-off">
          <KbBadge tone="warning">邮件暂不可用</KbBadge>
          站点还没有配置发信邮箱,现在选了也发不出去。你的选择会保存,配置好以后生效。
        </p>
        <p v-if="emailUnverified" class="kb-np-warn" data-testid="np-email-note">
          <KbBadge tone="warning">邮箱未验证</KbBadge>
          你的账号还没有验证邮箱,验证之前不会收到邮件。
        </p>
      </div>

      <section v-for="group in groups" :key="group.value" class="kb-np-group" :aria-labelledby="`np-g-${group.value}`">
        <h3 :id="`np-g-${group.value}`" class="kb-np-h">{{ group.label }}</h3>
        <div v-for="kind in group.kinds" :key="kind" class="kb-np-row">
          <div class="kb-np-text" :data-testid="`np-${kind}-text`" @click="toggle(kind, !prefs.email[kind])">
            <b :id="`np-l-${kind}`">{{ kindInfo(kind).label }}</b>
            <span class="m">{{ kindInfo(kind).hint }}</span>
          </div>
          <KbSwitch :model-value="!!prefs.email[kind]" :disabled="!!saving" :aria-labelledby="`np-l-${kind}`" :data-testid="`np-${kind}`" @update:model-value="toggle(kind, $event)" />
        </div>
      </section>

      <p v-if="saveError" class="kb-np-error" role="alert" data-testid="np-save-error">{{ saveError }}</p>
    </template>
  </KbCard>
</template>

<style scoped>
.kb-np-pad { padding: var(--card-pad-ui); }
.kb-np-lead { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--card-pad-ui); }
.kb-np-lead p { margin: 0; }
.kb-np-warn { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
.kb-np-group { border-top: var(--hl) solid var(--b); }
.kb-np-h { margin: 0; padding: var(--sp-3) var(--card-pad-ui) var(--sp-1); font-size: var(--text-12); font-weight: var(--fw-medium); color: var(--text-tertiary); }
.kb-np-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: 0 var(--card-pad-ui); min-width: 0; }
/* 开关本身只有 28×16:点左边的文字也能切换,整行都是可点区域 */
.kb-np-text { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: var(--sp-1); min-width: 0; min-height: var(--list-row-h); padding: var(--sp-2) 0; cursor: pointer; }
.kb-np-text b { font-weight: var(--fw-medium); }
.kb-np-text .m { font-size: var(--text-13); }
.kb-np-error { margin: 0; padding: var(--sp-3) var(--card-pad-ui); color: var(--status-danger-text); border-top: var(--hl) solid var(--b); }
</style>
