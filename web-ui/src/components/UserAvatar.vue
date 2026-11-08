<script setup lang="ts">
// 用户头像:有头像画图片,没有(或图片加载失败)画显示名的首字母,底色由用户 id 决定、各处一致。
// 图片是装饰性的:旁边一般已经有用户名文字,所以默认 alt 为空;单独出现时(例如只有头像的按钮)用 label 给读屏软件名字。
import { computed, ref, watch } from 'vue'
import { avatarUrl, hueOf, initialOf, isGuestId } from '@/utils/avatar'

const props = withDefaults(
  defineProps<{
    userId: string
    name?: string | null
    /** 库里的头像文件名;没有就画首字母。只知道 id 的地方(多人编辑名单)先用 api/avatars 批量查出来再传 */
    file?: string | null
    /** 游客:没有账号也就没有头像,画固定的游客头像。游客标识 `guest:…` 会被自动识别 */
    guest?: boolean
    size?: number
    label?: string
    /** 直接指定图片地址(优先于 `file`)。游客看分享页时没有登录,`/users/{id}/avatar` 对他们是 401,
     *  分享人的头像要走按链接校验的地址,所以由调用方给。 */
    src?: string | null
    /** 首字母由 CSS 画出来、不进 DOM 文本:头像旁边已经写着名字的按钮用,否则 axe 会把「管」也算成按钮的可见文字,和无障碍名称对不上 */
    cssInitial?: boolean
  }>(),
  { name: '', file: null, src: null, guest: false, size: 32, label: '', cssInitial: false },
)

const isGuest = computed(() => props.guest || isGuestId(props.userId))
const url = computed(() => (isGuest.value ? null : (props.src ?? avatarUrl(props.userId, props.file))))
// 图片加载失败(头像刚被删、网络抖动)就退回首字母;头像换了再重新尝试
const failed = ref(false)
watch(url, () => (failed.value = false))
const showImage = computed(() => !!url.value && !failed.value)
const style = computed(() => ({
  '--avatar-size': `${props.size}px`,
  '--avatar-hue': String(hueOf(props.userId || props.name || '')),
}))
</script>

<template>
  <span class="kb-avatar" :class="{ 'is-guest': isGuest }" :style="style" :role="label ? 'img' : undefined" :aria-label="label || undefined" :aria-hidden="label ? undefined : true">
    <svg v-if="isGuest" class="kb-avatar-guest" viewBox="0 0 24 24" fill="currentColor" data-testid="avatar-guest">
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7z" />
    </svg>
    <img v-else-if="showImage" :src="url!" alt="" loading="lazy" decoding="async" draggable="false" @error="failed = true" />
    <span v-else class="kb-avatar-initial" :data-initial="cssInitial ? initialOf(name) : undefined">{{ cssInitial ? '' : initialOf(name) }}</span>
  </span>
</template>

<style>
/* 底色明度压到 30~32%:白色首字母在所有色相上对比度都 ≥4.5(原来亮度 38% / 46%,黄绿色相上只有 3.5 / 2.2) */
.kb-avatar{display:inline-grid;place-items:center;flex:none;overflow:hidden;width:var(--avatar-size);height:var(--avatar-size);border-radius:var(--r-pill);background:hsl(var(--avatar-hue) 45% 32%);color:#fff;font-weight:600;user-select:none;vertical-align:middle}
:root[data-tone=light] .kb-avatar,[data-tone=light] .kb-avatar{background:hsl(var(--avatar-hue) 55% 30%)}
.kb-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.kb-avatar-initial{font-size:calc(var(--avatar-size) * .42)}
.kb-avatar-initial[data-initial]::before{content:attr(data-initial)}
/* 游客头像:所有游客同一个灰色人像,用主题里的中性色,深浅色下都看得清;描一圈细边,免得浅色页面上和白底融在一起 */
.kb-avatar.is-guest{background:var(--surface-sunken);color:var(--text-secondary);box-shadow:inset 0 0 0 var(--hl,1px) var(--border-strong)}
.kb-avatar-guest{width:70%;height:70%;display:block;margin-top:12%}
</style>
