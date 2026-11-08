<script setup lang="ts">
// 两步验证的绑定二维码:在浏览器里本地生成,密钥不经过任何第三方。
// 生成器(utils/qr.ts)用动态 import 按需加载,不进主包;加载或生成失败时给出退路(手动输入密钥),不让绑定卡死。
import { computed, ref, watchEffect } from 'vue'
import KbSkeleton from '@kb-ui/components/KbSkeleton.vue'

const props = defineProps<{ uri: string }>()

const state = ref<'loading' | 'ready' | 'failed'>('loading')
const path = ref({ viewBox: '', d: '' })

watchEffect((onCleanup) => {
  const uri = props.uri
  let stale = false
  onCleanup(() => (stale = true))
  state.value = 'loading'
  void import('@/utils/qr')
    .then(({ encodeQr, qrPath }) => {
      if (stale) return
      const code = encodeQr(uri)
      if (!code) {
        state.value = 'failed'
        return
      }
      path.value = qrPath(code)
      state.value = 'ready'
    })
    .catch(() => {
      if (!stale) state.value = 'failed'
    })
})

const label = computed(() => '两步验证二维码。用手机上的验证器 App 扫描它;扫不了就手动输入下面的密钥。')
</script>

<template>
  <div class="kb-qr" data-testid="totp-qr">
    <KbSkeleton v-if="state === 'loading'" :lines="1" height="100%" class="kb-qr-skel" />
    <svg v-else-if="state === 'ready'" class="kb-qr-svg" :viewBox="path.viewBox" role="img" :aria-label="label" shape-rendering="crispEdges">
      <path :d="path.d" fill="currentColor" />
    </svg>
    <p v-else class="kb-qr-failed" role="alert">二维码没能生成。请改用下面的密钥,在验证器 App 里选「手动输入」添加。</p>
  </div>
</template>

<style>
/* 二维码必须是「深色码 + 浅色底」才能被扫出来,不能跟着主题反色,所以这里固定用黑白两色(不走主题 token) */
.kb-qr {
  --qr-fg: #000;
  --qr-bg: #fff;
  box-sizing: border-box;
  width: min(100%, 232px);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border-radius: var(--r2);
  background: var(--qr-bg);
  color: var(--qr-fg);
  overflow: hidden;
}
.kb-qr-svg {
  display: block;
  width: 100%;
  height: 100%;
}
.kb-qr-skel {
  width: 100%;
  height: 100%;
}
.kb-qr-failed {
  margin: 0;
  padding: var(--sp-3);
  color: var(--qr-fg);
  font-size: calc(13px * var(--fs));
  line-height: var(--lh-body);
  text-align: center;
}
</style>
