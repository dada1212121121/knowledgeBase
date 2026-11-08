<script setup lang="ts">
// 隐私设置:谁能搜到我、谁可以把文档分享给我(后端 set_privacy,默认值见 kb-core/src/social.rs)。
// 开关一拨就保存:先按新值显示,服务端确认后为准;失败退回原值并在下面写原因(错误不自动消失)。
import { computed, ref } from 'vue'
import { KbButton, KbEmpty, KbSegmented, KbSkeleton, KbSwitch, useToast } from '@kb-ui/index'
import type { Privacy, ShareFrom } from '@/api/social'
import { useFriendsStore } from '@/stores/friends'
import { useSessionStore } from '@/stores/session'
import { socialErrorText } from '@/utils/social'

const store = useFriendsStore()
const session = useSessionStore()
const toast = useToast()
const saving = ref(false)
const error = ref('')

// 开关本身只有 28×16:触屏上不好点。所以点开关左边的文字也能切换(整行都是可点区域),开关仍然是键盘 / 读屏用的那个控件
// 用邮箱搜人要求对方的邮箱已验证(后端只在已验证邮箱里查);没验证时开关再开也没用,提醒一句
const emailUnverified = computed(() => session.user?.email_verified === false || (!!session.user && !session.user.email))

async function save(patch: Partial<Privacy>) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    await store.savePrivacy(patch)
    toast.push('已保存')
  } catch (err) {
    error.value = socialErrorText(err, '没能保存隐私设置。请稍后重试。')
  } finally {
    saving.value = false
  }
}

const SHARE_OPTIONS = [
  { value: 'everyone', label: '所有人' },
  { value: 'friends', label: '仅好友' },
]
</script>

<template>
  <section class="card kb-pv" data-testid="privacy-panel" aria-label="隐私设置">
    <KbSkeleton v-if="store.privacyStatus === 'loading' || store.privacyStatus === 'idle'" variant="card" :lines="3" class="kb-pv-pad" />

    <KbEmpty v-else-if="store.privacyStatus === 'error' || !store.privacy" icon="failed" title="没能加载隐私设置" :description="store.privacyError" data-testid="privacy-error">
      <template #action><KbButton variant="primary" @click="store.loadPrivacy()">重新加载</KbButton></template>
    </KbEmpty>

    <template v-else>
      <p class="m kb-pv-lead">这些设置决定别人怎么找到你、能不能把文档分享给你。已经是好友的人不受搜索设置影响。</p>

      <div class="kb-pv-row">
        <div class="kb-pv-text is-tap" data-testid="pv-username-text" @click="save({ searchable_by_username: !store.privacy.searchable_by_username })">
          <b id="pv-username">允许别人用用户名搜到我</b>
          <span class="m">打开后,别人输入你完整的用户名就能找到你并发好友申请。默认打开。</span>
        </div>
        <KbSwitch :model-value="store.privacy.searchable_by_username" :disabled="saving" aria-labelledby="pv-username" data-testid="pv-username" @update:model-value="save({ searchable_by_username: $event })" />
      </div>

      <div class="kb-pv-row">
        <div class="kb-pv-text is-tap" data-testid="pv-email-text" @click="save({ searchable_by_email: !store.privacy.searchable_by_email })">
          <b id="pv-email">允许别人用邮箱搜到我</b>
          <span class="m">打开后,别人输入你完整的邮箱就能找到你。邮箱比用户名更私密,默认关闭。</span>
          <span v-if="emailUnverified" class="m kb-pv-warn" data-testid="pv-email-note">你的邮箱还没有验证,验证之前别人用邮箱也搜不到你。</span>
        </div>
        <KbSwitch :model-value="store.privacy.searchable_by_email" :disabled="saving" aria-labelledby="pv-email" data-testid="pv-email" @update:model-value="save({ searchable_by_email: $event })" />
      </div>

      <div class="kb-pv-row is-stack">
        <div class="kb-pv-text">
          <b id="pv-share">谁可以把文档分享给我</b>
          <span class="m">选「仅好友」后,不是好友的人无法把文档分享给你。</span>
        </div>
        <KbSegmented :model-value="store.privacy.share_from" :options="SHARE_OPTIONS" aria-labelledby="pv-share" data-testid="pv-share" @update:model-value="save({ share_from: $event as ShareFrom })" />
      </div>

      <p v-if="error" class="kb-pv-error" role="alert" data-testid="privacy-save-error">{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.kb-pv { min-width: 0; overflow: hidden; }
.kb-pv-pad { padding: var(--card-pad-ui); }
.kb-pv-lead { margin: 0; padding: var(--sp-3) var(--card-pad-ui); }
.kb-pv-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-4) var(--card-pad-ui); border-top: var(--hl) solid var(--b); min-width: 0; }
.kb-pv-row.is-stack { flex-wrap: wrap; }
.kb-pv-text { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; flex: 1 1 16em; }
.kb-pv-text b { font-weight: var(--fw-medium); }
.kb-pv-text.is-tap { cursor: pointer; min-height: var(--field-h); justify-content: center; }
.kb-pv-text .m { font-size: var(--text-13); }
.kb-pv-warn { color: var(--status-warning-text); }
.kb-pv-error { margin: 0; padding: var(--sp-3) var(--card-pad-ui); color: var(--status-danger-text); border-top: var(--hl) solid var(--b); }
</style>
