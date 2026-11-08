<script setup lang="ts">
// 搜索的「高级选项」:重排、查看排序依据(术语表:不要在界面上写 rerank / explain / top-k)。每页几条在结果下面的翻页条里调。
// 桌面上内联展开,手机上放进底部弹层;两处用同一份内容,所以单独成组件。
import { KbSwitch } from '@kb-ui/index'
import type { SearchPrefs } from '@/utils/search'

const props = defineProps<{
  modelValue: SearchPrefs
  /** 融合参数 k(config.search.rrf_k);读不到或没有调优权限就不显示 */
  rrfK?: number | null
}>()
const emit = defineEmits<{ 'update:modelValue': [value: SearchPrefs] }>()

const set = <K extends keyof SearchPrefs>(key: K, value: SearchPrefs[K]) => emit('update:modelValue', { ...props.modelValue, [key]: value })
</script>

<template>
  <div class="kb-sadv" data-testid="search-advanced">
    <div class="kb-sadv-item">
      <KbSwitch :model-value="modelValue.rerank" label="重排" data-testid="adv-rerank" @update:model-value="set('rerank', $event)" />
      <p class="m kb-sadv-hint">对初步结果再排一次序,更准,但会慢一点。需要服务器装了重排模型才有效果。</p>
    </div>
    <div class="kb-sadv-item">
      <KbSwitch :model-value="modelValue.explain" label="查看排序依据" data-testid="adv-explain" @update:model-value="set('explain', $event)" />
      <p class="m kb-sadv-hint">显示每条结果为什么排在这儿,并给出详细的得分。</p>
    </div>
    <p v-if="rrfK != null" class="m kb-sadv-hint" data-testid="adv-rrf">混合检索的融合参数 k = {{ rrfK }}(到「系统设置」里改)。</p>
  </div>
</template>

<style scoped>
.kb-sadv { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-sadv-item { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.kb-sadv-hint { margin: 0; font-size: var(--text-12); }
</style>
