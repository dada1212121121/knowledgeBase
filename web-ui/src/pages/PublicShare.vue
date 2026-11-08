<script setup lang="ts">
// 公开分享页 /s/:token（设计规范）:给没登录的游客、也给登录用户用的独立轻量页面,不使用统一外壳
// (没有侧栏、搜索、AI),品牌只在顶部一小行。手机优先:微信 / QQ 里打开的人最多。
// 流程:取链接状态 → 失效 / 需要登录 / 没权限 → 状态页;要密码 → 密码页(输对后重取状态);可看 → 正文。
// 不引用任何外部资源(CSP default-src 'self');令牌只在地址里,请求都带 CSRF 头(见 api/share.ts)。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useVisualViewport } from '@/composables/useVisualViewport'
import { KbBadge, KbConfirmHost, KbSkeleton, KbToastStack } from '@kb-ui/index'
import GuestNickname from '@/components/share/GuestNickname.vue'
import PublicContent from '@/components/share/PublicContent.vue'
import PublicPassword from '@/components/share/PublicPassword.vue'
import PublicStatus from '@/components/share/PublicStatus.vue'
import PublicWatermark from '@/components/share/PublicWatermark.vue'
import InAppDownloadNote from '@/components/InAppDownloadNote.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { ownerAvatarUrl, publicInfo, type PublicActive } from '@/api/share'
import { pageTitle, statusFromError, type StatusView } from '@/utils/publicShare'
import { roleLabel } from '@/utils/share'

const route = useRoute()
// 公开页没有外壳,软键盘占用(--kbd-inset)要自己量:iOS 微信里布局视口不随键盘缩,底部弹层 / 对话框靠它让出键盘
useVisualViewport()
const token = computed(() => String(route.params.token ?? ''))

type Phase = 'loading' | 'locked' | 'active' | 'status'
const phase = ref<Phase>('loading')
const info = ref<PublicActive | null>(null)
const siteName = ref('知识库')
const view = ref<StatusView | null>(null)
/** 游客改名后本地立刻生效,不必整页重取(重取会再算一次「打开」) */
const nickname = ref('')
const docTitle = ref('')
const dirty = ref(false)

async function load() {
  phase.value = 'loading'
  try {
    const data = await publicInfo(token.value)
    siteName.value = data.site?.name || '知识库'
    if (data.state === 'locked') {
      phase.value = 'locked'
      return
    }
    info.value = data
    nickname.value = data.visitor.kind === 'guest' ? (data.visitor.nickname ?? '访客') : ''
    phase.value = 'active'
  } catch (err) {
    view.value = statusFromError(err)
    phase.value = 'status'
  }
}
onMounted(() => void load())
watch(token, () => void load())

// ---- 页面外壳:不让搜索引擎收录(服务端也带 X-Robots-Tag),标题跟着内容走
let robots: HTMLMetaElement | null = null
const previousTitle = typeof document !== 'undefined' ? document.title : ''
onMounted(() => {
  robots = document.createElement('meta')
  robots.name = 'robots'
  robots.content = 'noindex, nofollow'
  document.head.appendChild(robots)
})
watch([info, docTitle, phase], () => {
  document.title = phase.value === 'active' ? pageTitle(info.value && { title: info.value.title, site: info.value.site }, docTitle.value) : siteName.value
})
onBeforeUnmount(() => {
  robots?.remove()
  document.title = previousTitle
})

// 有没保存的编辑时关页 / 刷新要拦一下
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

const isGuest = computed(() => info.value?.visitor.kind === 'guest')
const visitorName = computed(() => info.value?.visitor.display_name || info.value?.visitor.username || '')
const loginHref = computed(() => `/login?next=${encodeURIComponent(`/s/${token.value}`)}`)
const canWrite = computed(() => !!info.value && (info.value.can.comment || info.value.can.edit))
</script>

<template>
  <div class="kb-pub" data-testid="public-page">
    <header class="kb-pub-top">
      <span class="kb-pub-brand" data-testid="public-brand">{{ siteName }}</span>
      <span class="kb-pub-spacer"></span>
      <template v-if="phase === 'active' && info">
        <KbBadge :tone="info.can.edit ? 'success' : 'neutral'" data-testid="public-role">{{ roleLabel(info.role) }}</KbBadge>
        <UserAvatar v-if="isGuest" guest user-id="" :name="nickname" :size="22" />
        <GuestNickname v-if="isGuest" :token="token" :nickname="nickname" @renamed="(value: string) => (nickname = value)" />
        <span v-else class="kb-pub-user" data-testid="public-user">
          <UserAvatar :user-id="info.visitor.id ?? ''" :name="visitorName" :file="info.visitor.avatar" :size="22" />
          <span>{{ visitorName }}</span>
        </span>
        <a v-if="isGuest" class="kb-pub-login" :href="loginHref" data-testid="public-login-link">登录</a>
      </template>
    </header>

    <main class="kb-pub-main">
      <KbSkeleton v-if="phase === 'loading'" variant="card" :lines="6" />
      <PublicStatus v-else-if="phase === 'status' && view" :view="view" :token="token" @retry="load" />
      <PublicPassword v-else-if="phase === 'locked'" :token="token" @unlocked="load" />

      <template v-else-if="phase === 'active' && info">
        <p class="kb-pub-owner" data-testid="public-owner">
          <UserAvatar v-if="info.owner" :user-id="info.owner.id" :name="info.owner.display_name" :src="ownerAvatarUrl(token, info.owner.avatar)" :size="20" />
          <span>{{ info.owner ? `${info.owner.display_name} 分享给你` : '有人分享给你' }}</span>
        </p>
        <!-- 微信 / QQ 里下载会被拦:页面顶上说一次(带「复制链接」),文档里的下载按钮旁就不再重复(in-app-note=false) -->
        <InAppDownloadNote v-if="info.can.download" data-testid="public-inapp" />
        <p v-if="isGuest && canWrite" class="kb-pub-note" data-testid="public-guest-note">你的评论和修改会记在「{{ nickname }}」名下,所有者能看到并回退。</p>
        <p v-if="isGuest && !info.can.edit" class="kb-pub-note" data-testid="public-login-hint">
          想参与编辑?<a :href="loginHref">登录</a>后,如果所有者给了你编辑权限就能修改。
        </p>
        <PublicContent :info="info" :token="token" @title="(value: string) => (docTitle = value)" @dirty="(value: boolean) => (dirty = value)" />
        <PublicWatermark v-if="info.watermark" :text="info.watermark" />
      </template>
    </main>

    <!-- 独立页面没有外壳:提示条和确认框要自己挂 -->
    <KbToastStack />
    <KbConfirmHost />
  </div>
</template>

<style>
.kb-pub { height: 100vh; height: 100dvh; overflow-y: auto; overscroll-behavior-y: none; display: flex; flex-direction: column; background: var(--bg-canvas); color: var(--text-primary); /* 四边都让出安全区:横屏的刘海机(iPhone 微信横屏)两侧也有 */ padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left); box-sizing: border-box; }
/* 自己做滚动容器:全局样式给 body 设了 overflow:hidden 和 100vh(外壳页面各自管滚动),没有外壳的整页不这样就滚不动 */
/* 软键盘升起时(iOS 微信里布局视口不缩),页面末尾多出键盘那么高的空间:最下面的内容也能滚到键盘上方。没有键盘时高度为 0 */
.kb-pub::after { content: ''; flex: none; height: var(--kbd-inset, 0px); }
.kb-pub-top { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; padding: var(--sp-2) var(--sp-4); border-bottom: var(--hl) solid var(--border-subtle); min-height: 44px; box-sizing: border-box; }
.kb-pub-brand { font-size: var(--text-13); font-weight: var(--fw-medium); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }
.kb-pub-spacer { flex: 1; }
.kb-pub-user { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--text-13); min-width: 0; }
.kb-pub-login { font-size: var(--text-13); color: var(--accent-text, var(--accent)); text-decoration: underline; padding: var(--sp-1); }
.kb-pub-main { flex: 1; width: 100%; max-width: 1180px; margin: 0 auto; padding: var(--sp-5) var(--sp-4) var(--sp-6); box-sizing: border-box; display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-pub-owner { margin: 0; display: flex; align-items: center; gap: var(--sp-2); color: var(--text-secondary); font-size: var(--text-13); }
.kb-pub-note { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: rgb(var(--ink), 0.04); color: var(--text-secondary); font-size: var(--text-12); line-height: var(--lh-body); }
.kb-pub-note a { color: var(--accent-text, var(--accent)); }
/* 提示里的「登录」是一行字中间的两个字链接,触屏上很难点中:不改版面,用伪元素把可点区域撑到 44px 以上 */
@media (pointer: coarse) {
  .kb-pub-note a { position: relative; }
  .kb-pub-note a::before { content: ''; position: absolute; inset: -16px -10px; }
}
@media (max-width: 599px) {
  .kb-pub-top { padding-inline: var(--sp-3); }
  .kb-pub-main { padding: var(--sp-4) var(--sp-3) var(--sp-5); }
}
@media (pointer: coarse) { .kb-pub-login { min-height: 44px; min-width: 44px; display: inline-flex; align-items: center; justify-content: center; } }
</style>
