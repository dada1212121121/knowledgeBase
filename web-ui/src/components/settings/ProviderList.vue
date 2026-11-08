<script setup lang="ts">
// 一类组件的列表(OCR / 转写 / 嵌入 / 重排):状态徽标 + 名字 + 说明 + 这个组件上能做的操作。
// 能做什么由 providerActions 决定(后端只支持 OCR 一键设默认、OCR / 转写下载),不画点了只会报错的按钮。
// 窄屏(手机 / 窄侧栏)时说明和按钮换到下面,说明可以折行。
import { KbBadge, KbButton, KbEmpty } from '@kb-ui/index'
import { providerState } from '@/utils/provider'
import { providerActions, type Provider } from '@/utils/settingsComponents'

defineProps<{ providers: Provider[]; busy: string }>()
const emit = defineEmits<{ install: [provider: Provider]; setDefault: [provider: Provider]; uninstall: [provider: Provider] }>()
</script>

<template>
  <KbEmpty v-if="!providers.length" size="sm" icon="database" title="服务没有报告这一类组件" description="如果刚装过,点上面的「重新检测」再看一次。" />
  <ul v-else class="kb-st-prov-list" role="list" data-testid="provider-list">
    <li v-for="provider in providers" :key="provider.id" class="kb-st-prov" :class="{ 'is-broken': providerState(provider).broken }" data-testid="provider-row" :data-provider="provider.id">
      <div class="kb-st-prov-head">
        <KbBadge :tone="providerState(provider).tone" class="kb-st-prov-state" :title="providerState(provider).hint">{{ providerState(provider).label }}</KbBadge>
        <span class="kb-mono kb-st-prov-id" :title="provider.name">{{ provider.id }}</span>
      </div>
      <p class="kb-hint kb-st-prov-detail">{{ provider.detail ?? provider.model ?? '' }}</p>
      <div class="kb-st-prov-actions">
        <KbButton
          v-if="providerActions(provider).install"
          size="sm"
          :variant="providerState(provider).broken ? 'primary' : 'default'"
          :disabled="busy === provider.id"
          :aria-label="`下载 ${provider.id}`"
          data-testid="provider-install"
          @click="emit('install', provider)"
        >下载</KbButton>
        <KbButton
          v-if="providerActions(provider).setDefault"
          size="sm"
          :disabled="busy === provider.id || provider.current || !provider.ready"
          :title="provider.current ? '已经是默认' : provider.ready ? '' : '先下载并就绪后才能设为默认'"
          :aria-label="`把 ${provider.id} 设为默认`"
          data-testid="provider-default"
          @click="emit('setDefault', provider)"
        >设为默认</KbButton>
        <KbButton
          v-if="providerActions(provider).uninstall"
          size="sm"
          variant="danger"
          :disabled="busy === provider.id"
          :aria-label="`卸载 ${provider.id}`"
          data-testid="provider-uninstall"
          @click="emit('uninstall', provider)"
        >卸载</KbButton>
      </div>
    </li>
  </ul>
</template>

<style>
.kb-st-prov-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;container-type:inline-size}
.kb-st-prov{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr) auto;align-items:center;gap:var(--gap-xs,4px) var(--gap-md,12px);padding:10px 0;border-top:var(--hl) solid var(--b);min-width:0}
.kb-st-prov:first-child{border-top:0}
.kb-st-prov-head{display:flex;align-items:center;gap:var(--gap-sm,8px);min-width:0}
.kb-st-prov-state{flex:0 0 auto;white-space:nowrap}
.kb-st-prov-id{min-width:0;overflow-wrap:anywhere}
.kb-st-prov-detail{margin:0;min-width:0;overflow-wrap:anywhere;line-height:1.55}
.kb-st-prov-actions{display:flex;gap:var(--gap-xs,4px);flex-wrap:wrap;justify-content:flex-end}
@container (max-width: 560px){
  .kb-st-prov{grid-template-columns:minmax(0,1fr)}
  .kb-st-prov-actions{justify-content:flex-start}
}
</style>
