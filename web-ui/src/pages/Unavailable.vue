<script setup lang="ts">
// 服务不可用页(公开路由,不走外壳,也不依赖 /auth/status——它失败了才会来这里):
// 维护中(503)/ 服务出了问题 / 连不上 / 设备没网。会自动重试(先快后慢),恢复后回到刚才要去的页面。
// 以前登录检查一遇到网络错误就把人扔到登录页,登录页也连不上,用户只看到一个不会好的登录框。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KbButton } from '@kb-ui/index'
import StatusPage from '@/components/StatusPage.vue'
import { authStatus } from '@/api/client'
import { UNAVAILABLE_COPY, UNAVAILABLE_KINDS, classifyUnavailable, retryDelayMs, safeNext, type UnavailableKind } from '@/utils/status'

const route = useRoute()
const router = useRouter()

const fromQuery = typeof route.query.kind === 'string' ? route.query.kind : ''
// 设备没网时一开始就按「离线」显示(放到挂载后再改会先闪一帧错误的文案)
const kind = ref<UnavailableKind>(!navigator.onLine ? 'offline' : UNAVAILABLE_KINDS.includes(fromQuery as UnavailableKind) ? (fromQuery as UnavailableKind) : 'network')
const copy = computed(() => UNAVAILABLE_COPY[kind.value])
const next = computed(() => safeNext(typeof route.query.next === 'string' ? route.query.next : null))

const checking = ref(false)
const attempts = ref(0)
let timer: ReturnType<typeof setTimeout> | undefined

function clearTimer() {
  if (timer) clearTimeout(timer)
  timer = undefined
}

function schedule() {
  clearTimer()
  if (!copy.value.autoRetry) return
  timer = setTimeout(() => void check(), retryDelayMs(attempts.value))
}

/** 重新问一次服务:通了就回到原来的页面(守卫会按登录状态再决定去登录页还是目标页),没通就更新原因并排下一次。 */
async function check() {
  if (checking.value) return
  clearTimer()
  checking.value = true
  try {
    await authStatus()
    await router.replace(next.value)
  } catch (err) {
    attempts.value += 1
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null
    kind.value = classifyUnavailable(status, navigator.onLine)
    schedule()
  } finally {
    checking.value = false
  }
}

// 网络回来了马上试,不用等下一次定时;断网了就改成「设备离线」并停止自动重试
const onOnline = () => void check()
const onOffline = () => {
  kind.value = 'offline'
  clearTimer()
}

onMounted(() => {
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  schedule()
})
onBeforeUnmount(() => {
  clearTimer()
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
})
</script>

<template>
  <main class="kb-unavail" data-testid="unavailable" :data-kind="kind">
    <div class="kb-unavail-brand"><span class="kb-unavail-mark">kb</span>知识库</div>
    <StatusPage :icon="copy.icon" :title="copy.title" :description="copy.text">
      <KbButton variant="primary" :disabled="checking" data-testid="unavail-retry" @click="check">{{ checking ? '正在重试…' : '重试' }}</KbButton>
      <template v-if="attempts > 0" #detail>
        <span data-testid="unavail-attempts">已重试 {{ attempts }} 次<template v-if="copy.autoRetry && !checking">,稍后会自动再试</template></span>
      </template>
    </StatusPage>
  </main>
</template>

<style scoped>
.kb-unavail { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-4); background: var(--bg-canvas); color: var(--text-primary); }
.kb-unavail-brand { display: flex; align-items: center; gap: var(--sp-2); font-weight: var(--fw-title); color: var(--text-secondary); }
/* 与登录页的品牌小标同款(那份样式在登录页的代码块里,这个页面不一定加载了它) */
.kb-unavail-mark { display: grid; place-items: center; width: 2em; height: 2em; border-radius: var(--r2); background: var(--accent); color: var(--on-accent); font-size: var(--text-13); font-weight: var(--fw-title); }
</style>
