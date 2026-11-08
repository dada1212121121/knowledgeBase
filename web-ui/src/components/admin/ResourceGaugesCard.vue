<script setup lang="ts">
// 本机资源(系统概览,卡 F):处理器、内存、磁盘三个环形仪表,点进系统状态看曲线。
// 数值来自概览页本来就在取的系统状态(不再多发请求);读不到的那一个写「—」不画。
import { RouterLink } from 'vue-router'
import { KbGauge } from '@kb-ui/index'
import { PATHS } from '@/router/paths'

defineProps<{
  cpu?: number | null
  memory?: number | null
  disk?: number | null
  cores?: number | null
  /** 磁盘剩余(GB),写在仪表下面 */
  diskFreeGb?: number | null
}>()
</script>

<template>
  <section class="card kb-rg" aria-labelledby="ov-resources" data-testid="ov-resources">
    <div class="ch">
      <span id="ov-resources">本机资源</span>
      <div class="r"><RouterLink class="kb-rg-link" :to="{ path: PATHS.system, query: { tab: 'resources' } }">看曲线</RouterLink></div>
    </div>
    <div class="kb-rg-body">
      <KbGauge v-if="typeof cpu === 'number'" :value="cpu" label="处理器使用率" :caption="cores ? `${cores} 核` : ''" :size="108" />
      <KbGauge v-if="typeof memory === 'number'" :value="memory" label="内存使用率" caption="内存" :size="108" />
      <KbGauge v-if="typeof disk === 'number'" :value="disk" label="磁盘使用率" :caption="typeof diskFreeGb === 'number' ? `剩 ${diskFreeGb} GB` : '磁盘'" :size="108" />
      <p v-if="typeof cpu !== 'number' && typeof memory !== 'number' && typeof disk !== 'number'" class="m">没能读到本机资源。</p>
    </div>
  </section>
</template>

<style scoped>
.kb-rg { display: flex; flex-direction: column; min-width: 0; }
.kb-rg-body { flex: 1 1 auto; display: flex; flex-wrap: wrap; justify-content: space-around; align-items: center; gap: var(--sp-3); padding: var(--card-pad-ui); min-height: 160px; }
.kb-rg-link { font-size: var(--text-12); }
</style>
