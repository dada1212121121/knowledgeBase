<script setup lang="ts">
// 「OCR 与转写」分区:图片文字识别、音视频转写各一张卡 —— 开关和参数(字段表)+ 本机有哪些引擎(下载 / 设为默认 / 卸载)。
//   - 以前开关根本没有(注释说“组件页单独编辑”其实没有),引擎列表在「组件」里,下载进度又单独一张卡,
//     其中的「下载模型 / 运行时」按钮和引擎行上的「下载」是同一件事;现在合在一起,进度卡只展示进度;
//   - 下载进度 OCR 与转写共用(后端只有一个安装任务槽),下载中自动刷新;
//   - 推荐只对 OCR 能一键采用(后端只支持切换 OCR 的默认引擎),转写的推荐只给说明。
import { computed, onMounted } from 'vue'
import { KbBadge, KbButton, KbCard } from '@kb-ui/index'
import AdminLoadState from '@/components/admin/AdminLoadState.vue'
import FieldCards from './FieldCards.vue'
import ProviderList from './ProviderList.vue'
import { useProviders } from '@/composables/useProviders'
import type { Draft } from '@/utils/settingsFields'
import { adoptable, installFailureText, installLabel, installTone, recsOfKinds } from '@/utils/settingsComponents'

defineProps<{ aiOn: boolean; draft: Draft; errors: Record<string, string> }>()
const emit = defineEmits<{ update: [path: string, value: string | boolean] }>()

const providers = useProviders()
onMounted(() => {
  void providers.reload()
  void providers.loadInstall()
})

const ready = computed(() => providers.phase.value === 'ready')
const ofKind = (kind: string) => providers.providers.value.filter((item) => item.kind === kind)
const recsOcr = computed(() => recsOfKinds(providers.recommendations.value, ['ocr']))
const recsTranscribe = computed(() => recsOfKinds(providers.recommendations.value, ['transcribe']))
const toAdopt = computed(() => adoptable(providers.recommendations.value))
const install = computed(() => providers.ocr.value?.install ?? null)
/** 有过下载(正在下载 / 成功 / 失败)或者进度读不到,才显示进度卡。 */
const showProgress = computed(() => (!!install.value && install.value.state !== 'idle') || !!providers.installError.value)
</script>

<template>
  <AdminLoadState v-if="!ready" :phase="providers.phase.value === 'ready' ? 'loading' : providers.phase.value" :message="providers.message.value" skeleton="lines" @retry="providers.reload()" />
  <p v-if="ready && providers.actionError.value" class="kb-st-inline-error" role="alert" data-testid="provider-error">{{ providers.actionError.value }}</p>

  <FieldCards section="ocr" v-bind="{ aiOn, draft, errors }" @update="(path, value) => emit('update', path, value)">
    <template #in-ocr>
      <template v-if="ready">
        <div v-if="recsOcr.length" class="kb-stack" data-testid="recommendations-ocr">
          <div v-for="item in recsOcr" :key="item.provider" class="kb-st-rec">
            <KbBadge :tone="item.already_current ? 'success' : 'warning'">{{ item.already_current ? '已采用' : '建议' }}</KbBadge>
            <span class="kb-mono">{{ item.provider }}</span>
            <span class="kb-hint">{{ item.reason }}</span>
          </div>
          <div v-if="toAdopt.length" class="kb-row">
            <KbButton size="sm" variant="primary" :disabled="providers.busy.value === 'adopt'" data-testid="adopt" @click="providers.adopt(toAdopt)">采用推荐的识别引擎</KbButton>
          </div>
        </div>
        <p v-if="providers.recommendationsFailed.value" class="kb-hint" data-testid="recommendations-failed">推荐暂时读不到,不影响下面的操作。</p>
        <ProviderList :providers="ofKind('ocr')" :busy="providers.busy.value" @install="providers.installProvider" @set-default="providers.setDefault" @uninstall="providers.uninstall" />
      </template>
    </template>

    <template #in-transcribe>
      <template v-if="ready">
        <div v-for="item in recsTranscribe" :key="item.provider" class="kb-st-rec" data-testid="recommendations-transcribe">
          <KbBadge :tone="item.already_current ? 'success' : 'warning'">{{ item.already_current ? '已采用' : '建议' }}</KbBadge>
          <span class="kb-mono">{{ item.provider }}</span>
          <span class="kb-hint">{{ item.reason }}</span>
        </div>
        <ProviderList :providers="ofKind('transcribe')" :busy="providers.busy.value" @install="providers.installProvider" />
        <p class="kb-hint">转写的默认引擎写在 config.toml 的 extract.transcribe_command 里,这里不提供一键切换。</p>
      </template>
    </template>

    <template #after-transcribe>
      <KbCard v-if="showProgress" title="下载进度" class="kb-st-card" data-testid="install-card">
        <div v-if="providers.installError.value" class="kb-st-inline-error" role="alert" data-testid="install-error">
          <span>{{ providers.installError.value }}</span>
          <KbButton size="sm" @click="providers.loadInstall()">重试</KbButton>
        </div>
        <div v-else-if="install" class="kb-stack">
          <div class="kb-row">
            <KbBadge :tone="installTone(install.state)" data-testid="install-state">{{ installLabel(install.state) }}</KbBadge>
            <span class="kb-hint">已输出 {{ install.lines }} 行{{ install.state === 'running' ? ',每 2 秒自动刷新' : '' }}</span>
            <span class="kb-spacer"></span>
            <KbButton size="sm" @click="providers.loadInstall()">刷新</KbButton>
          </div>
          <p v-if="install.command" class="kb-mono kb-hint kb-st-wrap-left">{{ install.command }}</p>
          <p v-if="install.state === 'failed'" class="kb-st-inline-error" role="alert" data-testid="install-failure">{{ installFailureText(install) }}</p>
          <pre v-if="install.tail?.length" class="kb-mono kb-hint kb-st-tail">{{ install.tail.slice(-6).join('\n') }}</pre>
        </div>
      </KbCard>
    </template>
  </FieldCards>
</template>

<style>
.kb-st-tail{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
</style>
