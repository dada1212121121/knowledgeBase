<script setup lang="ts">
// 新建访问令牌:名字 + 类型 + 是否包含「共享给我的内容」,创建后**一次性**显示令牌明文并提供复制。
// 令牌明文只在这个组件的内存里,关掉就没了(服务端也只存哈希);不写任何存储、不进地址栏。
import { computed, ref } from 'vue'
import { KbButton, KbCopyButton, KbDialog, KbSwitch } from '@kb-ui/index'
import { tokenCreate, type CreatedToken, type TokenScope } from '@/api/tokens'
import { checkTokenName, explainTokenError, SCOPE_HELP, SCOPE_LABEL, sharedApplies } from '@/utils/tokens'

const emit = defineEmits<{ close: []; created: [] }>()

const name = ref('')
const scope = ref<TokenScope>('mcp')
const includeShared = ref(false)
const busy = ref(false)
const error = ref('')
const created = ref<CreatedToken | null>(null)
const copied = ref(false)
const closeHint = ref('')
// 创建时的选择,完成页上回显(创建响应里没有 include_shared)
const summary = ref({ name: '', scope: 'mcp' as TokenScope, shared: false })

const nameProblem = computed(() => (name.value === '' ? null : checkTokenName(name.value)))
const canSubmit = computed(() => !busy.value && checkTokenName(name.value) === null)
const sharedOn = computed(() => sharedApplies(scope.value))

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await tokenCreate(name.value, scope.value, includeShared.value)
    summary.value = { name: result.name, scope: result.scope, shared: result.scope === 'mcp' && includeShared.value }
    created.value = result
    emit('created')
  } catch (err) {
    error.value = explainTokenError(err, name.value)
  } finally {
    busy.value = false
  }
}

function requestClose() {
  if (busy.value) return
  // 令牌只显示这一次:没复制过就关,先提醒一次,再点才真关
  if (created.value && !copied.value && !closeHint.value) {
    closeHint.value = '还没复制令牌吗?关闭之后就看不到了。确认已保存的话,再点一次「完成」。'
    return
  }
  emit('close')
}
</script>

<template>
  <KbDialog :title="created ? '令牌已创建' : '新建访问令牌'" :subtitle="created ? '令牌只显示这一次' : '给 MCP 客户端或脚本用的长期凭证'" :close-on-scrim="false" @close="requestClose">
    <form v-if="!created" class="kb-tk" method="post" novalidate data-testid="token-form" @submit.prevent="submit">
      <label class="kb-tk-field">
        <span>名称</span>
        <input v-model="name" class="kb-input" type="text" maxlength="100" autocomplete="off" spellcheck="false" placeholder="例如:kiro-笔记本" aria-describedby="tk-name-help" data-testid="token-name" />
        <small id="tk-name-help" :class="nameProblem ? 'kb-tk-bad' : 'm'">{{ nameProblem ?? '同一个账号下不能重名。写清楚给谁用,以后撤销时好认。' }}</small>
      </label>

      <fieldset class="kb-tk-field kb-tk-scope">
        <legend>类型</legend>
        <label v-for="item in (['mcp', 'api'] as const)" :key="item" class="kb-tk-radio" :class="{ 'is-on': scope === item }">
          <input v-model="scope" type="radio" name="token-scope" :value="item" :data-testid="`token-scope-${item}`" />
          <span><b>{{ SCOPE_LABEL[item] }}</b><small class="m">{{ SCOPE_HELP[item] }}</small></span>
        </label>
      </fieldset>

      <div class="kb-tk-shared" :class="{ 'is-off': !sharedOn }">
        <!-- API 令牌用不到这个选项:显示成关闭,免得人以为开了(请求里也不会带 true,见 api/tokens.ts) -->
        <KbSwitch :model-value="sharedOn && includeShared" :disabled="!sharedOn" aria-label="包含共享给我的内容" aria-describedby="tk-shared-help" data-testid="token-shared" @update:model-value="(value: boolean) => (includeShared = value)" />
        <div>
          <b>包含共享给我的内容</b>
          <small id="tk-shared-help" class="m">
            <template v-if="sharedOn">开启后,用这个令牌连接的 MCP 客户端(如 Kiro、Claude Code)也能搜到别人分享给你的内容,这些内容会进入客户端的对话上下文。默认关闭,只搜你自己的知识库。</template>
            <template v-else>只有 MCP 令牌会搜索内容,API 令牌用不到这个选项。</template>
          </small>
        </div>
      </div>

      <p v-if="error" class="kb-tk-bad" role="alert">{{ error }}</p>
      <div class="kb-tk-actions">
        <KbButton :disabled="busy" @click="requestClose">取消</KbButton>
        <button type="submit" hidden tabindex="-1"></button>
        <KbButton variant="primary" :disabled="!canSubmit" data-testid="token-submit" @click="submit">{{ busy ? '创建中…' : '创建令牌' }}</KbButton>
      </div>
    </form>

    <div v-else class="kb-tk" data-testid="token-done">
      <p class="kb-tk-warn" role="note"><b>请现在复制并保存。</b>关闭这个窗口之后就再也看不到它了;丢了只能撤销后重新创建。</p>
      <code class="kb-tk-secret" data-testid="token-secret">{{ created.token }}</code>
      <div class="kb-tk-actions kb-tk-copyrow">
        <KbCopyButton :text="() => created!.token" label="复制令牌" variant="primary" size="md" @copied="(ok: boolean) => ok && (copied = true)" />
      </div>
      <dl class="kb-tk-sum">
        <div><dt>名称</dt><dd>{{ summary.name }}</dd></div>
        <div><dt>类型</dt><dd>{{ SCOPE_LABEL[summary.scope] }}</dd></div>
        <div v-if="summary.scope === 'mcp'"><dt>共享给我的内容</dt><dd>{{ summary.shared ? '包含' : '不包含' }}</dd></div>
      </dl>
      <p v-if="closeHint" class="kb-tk-bad" role="alert">{{ closeHint }}</p>
      <div class="kb-tk-actions"><KbButton variant="primary" data-testid="token-close" @click="requestClose">完成</KbButton></div>
    </div>
  </KbDialog>
</template>

<style>
.kb-tk {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 0;
}
.kb-tk-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: calc(13px * var(--fs));
  color: var(--text-secondary);
}
.kb-tk-field .kb-input {
  width: 100%;
}
.kb-tk-field legend {
  padding: 0;
  margin-bottom: var(--sp-1);
}
.kb-tk-bad {
  margin: 0;
  color: var(--status-danger-text);
  font-size: calc(13px * var(--fs));
  line-height: var(--lh-body);
}
.kb-tk-scope {
  gap: var(--sp-2);
}
.kb-tk-radio {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3);
  min-height: 44px;
  border-radius: var(--r2);
  border: 1px solid var(--border-default);
  cursor: pointer;
  color: var(--text-primary);
}
.kb-tk-radio.is-on {
  border-color: var(--accent);
  background: color-mix(in oklab, var(--accent) 10%, transparent);
}
.kb-tk-radio input {
  margin-top: 3px;
  flex: none;
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}
.kb-tk-radio span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kb-tk-radio small,
.kb-tk-shared small {
  font-size: calc(12px * var(--fs));
  line-height: var(--lh-body);
}
.kb-tk-shared {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--r2);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
}
.kb-tk-shared > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.kb-tk-shared.is-off b {
  color: var(--text-tertiary);
}
.kb-tk-warn {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r2);
  background: color-mix(in oklab, var(--status-warning) 14%, transparent);
  font-size: calc(13px * var(--fs));
  line-height: var(--lh-body);
}
.kb-tk-warn b {
  color: var(--status-warning-text);
}
.kb-tk-secret {
  display: block;
  padding: var(--sp-3);
  border-radius: var(--r2);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
  font-family: var(--mono);
  font-size: calc(13px * var(--fs));
  color: var(--text-primary);
  user-select: all;
  overflow-wrap: anywhere;
  word-break: break-all;
}
.kb-tk-sum {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: calc(13px * var(--fs));
}
.kb-tk-sum > div {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-3);
}
.kb-tk-sum dt {
  color: var(--text-secondary);
}
.kb-tk-sum dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}
.kb-tk-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.kb-tk-copyrow {
  justify-content: flex-start;
}
@media (max-width: 599px) {
  .kb-tk-actions:not(.kb-tk-copyrow) > * {
    flex: 1;
    justify-content: center;
  }
}
</style>
