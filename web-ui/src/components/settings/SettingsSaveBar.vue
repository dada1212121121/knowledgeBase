<script setup lang="ts">
// 系统设置页的保存条:有改动才出现,贴在内容区底部(粘在滚动容器的底边,不盖住最后一张卡)。
//   - 有校验错误:说清哪里不对,「保存」置灰(不会把明知被拒绝的补丁发出去);
//   - 上一次保存失败:原因常驻在这里(错误提示不自动消失),按钮变成「重试」;
//   - 手机上文字在上、按钮在下并排,按钮可点区域 ≥44px 由全局触屏规则保证。
import { KbButton, KbIcon } from '@kb-ui/index'

defineProps<{
  /** 有多少项改动没保存。 */
  count: number
  /** 当前草稿里第一条校验错误(没有就空)。 */
  error: string
  /** 上一次保存失败的原因(没有就空)。 */
  failure: string
  saving: boolean
}>()
const emit = defineEmits<{ save: []; revert: [] }>()
</script>

<template>
  <div v-if="count > 0 || failure" class="kb-save-bar kb-st-save" role="region" aria-label="保存设置" data-testid="settings-save-bar">
    <div class="kb-st-save-text">
      <span v-if="failure" class="kb-st-save-bad" role="alert" data-testid="settings-save-failure"><KbIcon name="failed" :size="14" />{{ failure }}</span>
      <span v-else-if="error" class="kb-st-save-bad" role="alert" data-testid="settings-save-invalid"><KbIcon name="failed" :size="14" />{{ error }}</span>
      <span v-else data-testid="settings-save-count">有 {{ count }} 项修改未保存</span>
    </div>
    <div class="kb-st-save-actions">
      <KbButton :disabled="saving" data-testid="settings-revert" @click="emit('revert')">还原</KbButton>
      <KbButton variant="primary" :disabled="saving || (!failure && !!error)" data-testid="settings-save" @click="emit('save')">
        {{ saving ? '保存中…' : failure ? '重试' : '保存' }}
      </KbButton>
    </div>
  </div>
</template>

<style>
.kb-st-save{display:flex;align-items:center;justify-content:space-between;gap:var(--gap-sm,8px) var(--gap-md,12px);flex-wrap:wrap;flex:0 0 auto;z-index:5}
.kb-st-save-text{flex:1 1 220px;min-width:0;font-size:calc(13px*var(--fs));overflow-wrap:anywhere}
.kb-st-save-bad{display:flex;align-items:flex-start;gap:4px;color:var(--status-danger-text)}
.kb-st-save-actions{display:flex;gap:var(--gap-sm,8px);flex:0 0 auto}
@media (max-width:599px){
  .kb-st-save-actions{flex:1 1 100%}
  .kb-st-save-actions .kb-btn{flex:1}
}
</style>
