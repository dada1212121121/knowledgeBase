<script setup lang="ts">
// 「模型」分区(只在 AI 总开关开着时才挂载):内置模型、费用保护、自动提炼(字段表驱动)+ 密钥与连接测试。
//   - 服务商从后端的目录里选;换服务商时,接口地址如果还是旧服务商的默认地址就跟着换(用户改过的不动);
//   - 密钥只写不读:页面只知道「有没有」;清除要二次确认(以前输入框留空点保存就会静默清掉);
//   - 连接测试用的是已保存的设置,有未保存的改动时在旁边说明;结果就近显示,失败的原因常驻;
//   - 服务商目录读取有自己的加载 / 报错 / 无权限状态,不影响上面字段的编辑。
import { computed, onMounted, ref } from 'vue'
import { KbBadge, KbButton, KbCard, KbInput, KbSkeleton, useConfirm, useToast } from '@kb-ui/index'
import FieldCards from './FieldCards.vue'
import { callCapability } from '@/api/client'
import { useLoadState } from '@/composables/useLoadState'
import type { Draft } from '@/utils/settingsFields'
import { baseUrlAfterSwitch, keyHint, providerOptions, testFailureText, testSuccessText, type LlmCatalog } from '@/utils/settingsModel'

const props = defineProps<{
  draft: Draft
  errors: Record<string, string>
  /** 模型相关的字段有没有改了没保存(连接测试用的是已保存的设置)。 */
  unsaved: boolean
}>()
const emit = defineEmits<{ update: [path: string, value: string | boolean] }>()

const toast = useToast()
const confirm = useConfirm()
const catalogState = useLoadState<LlmCatalog>(() => callCapability<LlmCatalog>('llm_providers'), '读取服务商信息')
const catalog = computed(() => catalogState.data.value)
onMounted(() => void catalogState.reload())

const choices = computed(() => ({ 'llm.provider': providerOptions(catalog.value) }))
const provider = computed(() => String(props.draft['llm.provider'] ?? ''))
const hint = computed(() => keyHint(catalog.value, provider.value))

/** 换服务商:接口地址还是旧服务商的默认地址就一起换掉。 */
function onUpdate(path: string, value: string | boolean) {
  if (path === 'llm.provider' && typeof value === 'string') {
    const next = baseUrlAfterSwitch(catalog.value, provider.value, value, String(props.draft['llm.base_url'] ?? ''))
    emit('update', path, value)
    if (next) emit('update', 'llm.base_url', next)
    return
  }
  emit('update', path, value)
}

// ---- 密钥
const keyText = ref('')
const savingKey = ref(false)
const keyFailure = ref('')

async function saveKey() {
  const key = keyText.value.trim()
  if (!key) return
  savingKey.value = true
  keyFailure.value = ''
  try {
    await callCapability('set_llm_key', { api_key: key, confirm: true })
    keyText.value = ''
    await catalogState.reload({ quiet: true })
    toast.push('密钥已保存。')
  } catch (err) {
    keyFailure.value = `保存密钥失败:${err instanceof Error && /[\u4e00-\u9fff]/.test(err.message) ? err.message.replace(/[。.]$/, '') : '服务没有正常回应'}。请稍后重试。`
  } finally {
    savingKey.value = false
  }
}

async function clearKey() {
  const ok = await confirm.ask({
    title: '清除已保存的密钥?',
    message: '清除后,自动提炼、审核、深度检索会因为没有密钥而无法调用模型,直到重新保存。已经整理好的笔记不受影响。',
    confirmText: '清除密钥',
    tone: 'danger',
    doneText: '已清除',
    action: () => callCapability('set_llm_key', { api_key: '', confirm: true }),
  })
  if (ok) {
    keyFailure.value = ''
    await catalogState.reload({ quiet: true })
  }
}

// ---- 连接测试
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const result = await callCapability<{ reply?: string }>('test_llm', { confirm: true })
    testResult.value = { ok: true, text: testSuccessText(result.reply) }
    toast.push(testResult.value.text)
  } catch (err) {
    testResult.value = { ok: false, text: testFailureText(err) }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <FieldCards section="model" :ai-on="true" :draft="draft" :errors="errors" :choices="choices" @update="onUpdate">
    <template #after-llm>
      <KbCard title="密钥与连接测试" class="kb-st-card" data-group="llm-key" data-testid="llm-key-card">
        <KbSkeleton v-if="catalogState.phase.value === 'loading'" :lines="2" />

        <div v-else-if="catalogState.phase.value === 'error'" class="kb-st-inline-error" role="alert" data-testid="llm-catalog-error">
          <span>{{ catalogState.message.value }}</span>
          <KbButton size="sm" @click="catalogState.reload()">重试</KbButton>
        </div>

        <p v-else-if="catalogState.phase.value === 'forbidden'" class="kb-hint" data-testid="llm-catalog-forbidden">{{ catalogState.message.value }}</p>

        <div v-else class="kb-stack">
          <div class="kb-row">
            <KbBadge :tone="catalog?.secret_present ? 'success' : 'warning'" data-testid="llm-key-state">{{ catalog?.secret_present ? '已保存密钥' : '还没有保存密钥' }}</KbBadge>
            <span v-if="hint" class="kb-hint kb-st-key-hint">{{ hint }}</span>
          </div>
          <div class="kb-st-key-form">
            <KbInput v-model="keyText" type="password" placeholder="粘贴新的密钥" aria-label="新的密钥" autocomplete="new-password" data-testid="llm-key-input" />
            <KbButton variant="primary" size="sm" :disabled="!keyText.trim() || savingKey" data-testid="llm-key-save" @click="saveKey">{{ savingKey ? '保存中…' : '保存密钥' }}</KbButton>
            <KbButton v-if="catalog?.secret_present" variant="danger" size="sm" data-testid="llm-key-clear" @click="clearKey">清除密钥</KbButton>
          </div>
          <p v-if="keyFailure" class="kb-st-inline-error" role="alert" data-testid="llm-key-failure">{{ keyFailure }}</p>
          <div class="kb-st-key-form">
            <KbButton size="sm" :disabled="testing" data-testid="llm-test" @click="testConnection">{{ testing ? '测试中…' : '测试连接' }}</KbButton>
            <span class="kb-hint kb-st-key-hint">用已保存的设置给模型发一句话,确认连得上。</span>
          </div>
          <p v-if="unsaved" class="kb-st-risk" data-testid="llm-test-unsaved">上面有改动还没保存,测试用的是已保存的设置。</p>
          <p v-if="testResult" :class="testResult.ok ? 'kb-st-ok' : 'kb-st-inline-error'" :role="testResult.ok ? 'status' : 'alert'" data-testid="llm-test-result">{{ testResult.text }}</p>
          <p class="kb-hint">密钥只写进 secrets.toml,页面不回显。</p>
        </div>
      </KbCard>
    </template>
  </FieldCards>
</template>
