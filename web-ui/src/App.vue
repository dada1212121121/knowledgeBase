<script setup lang="ts">
// 根组件:登录页独立渲染;其余页面都放进常驻外壳,页面之间用进场过渡切换。
//
// 必须等首次导航解析完(router.isReady)再决定渲染什么:
// 解析前 route.meta 是空的,会被当成「需要外壳的页面」先把外壳挂出来,外壳一挂载就请求数据,
// 未登录时得到 401 → 跳登录页 → 整页刷新 → 再来一遍,形成无限刷新。
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ShellFrame from '@/layouts/ShellFrame.vue'
import { visibleInterval } from '@/utils/visibleInterval'

const route = useRoute()
const router = useRouter()
const ready = ref(false)
void router.isReady().then(() => (ready.value = true))

/** 部署了新前端(version.json 变了)时提示刷新,避免旧页面一直用旧逻辑。 */
const stale = ref(false)
let loadedHash = ''
let stopVersionCheck: (() => void) | undefined
async function checkVersion() {
  try {
    const response = await fetch('/version.json', { cache: 'no-store' })
    if (!response.ok) return
    const data = (await response.json()) as { hash?: string }
    const hash = data.hash ?? ''
    if (!hash) return
    if (!loadedHash) loadedHash = hash
    else if (hash !== loadedHash) stale.value = true
  } catch {
    // 没有 version.json(开发环境)就算了
  }
}
// 懒加载的前端文件拿不到（vite 会在 window 上发 vite:preloadError）：页面是旧版本，旧文件已经被新版本替换，
// 不等下一次轮询（最多 60 秒）就亮出刷新条
// 不调 preventDefault：让错误照常抛给调用方，流程图等处据此显示「页面是旧版本」（见 utils/chunkError.ts）
function onPreloadError() {
  stale.value = true
}
onMounted(() => {
  window.addEventListener('vite:preloadError', onPreloadError)
  // 标签页在后台时不查版本,回到前台再补一次
  stopVersionCheck = visibleInterval(() => void checkVersion(), 60_000, { immediate: true })
})
onUnmounted(() => {
  window.removeEventListener('vite:preloadError', onPreloadError)
  stopVersionCheck?.()
})
function reload() {
  window.location.reload()
}
</script>

<template>
  <div v-if="stale" class="kb-stale-banner">
    <span>前端已更新(部署了新版本),刷新后用新功能</span>
    <button type="button" @click="reload">刷新</button>
  </div>
  <template v-if="ready">
    <router-view v-if="route.meta.public" />
    <ShellFrame v-else>
      <router-view v-slot="{ Component, route: current }">
        <Transition name="kb-page" mode="out-in">
          <component :is="Component" :key="current.path" />
        </Transition>
      </router-view>
    </ShellFrame>
  </template>
</template>

<style scoped>
/* 版本更新提示横幅:统一使用语义圆角、阴影与间距 token,手机端避开安全区顶部 */
.kb-stale-banner {
  position: fixed;
  top: calc(var(--sp-3) + var(--safe-top));
  left: 50%;
  z-index: var(--z-toast, 100);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  max-width: calc(100vw - var(--sp-6));
  padding: var(--sp-2) var(--sp-4);
  transform: translateX(-50%);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r-pill);
  background: var(--surface-3);
  box-shadow: var(--sh3);
  font-size: var(--text-12);
}
.kb-stale-banner button {
  flex: none;
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font-weight: var(--fw-title);
  cursor: pointer;
}
</style>
