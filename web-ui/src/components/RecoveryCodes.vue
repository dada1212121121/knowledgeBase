<script setup lang="ts">
// 恢复码展示(开启两步验证 / 重新生成之后):**只显示这一次**。
// 提供复制全部、下载为文本文件;用户勾选「我已保存」后才允许关闭(父组件根据 v-model:saved 控制)。
// 恢复码只存在于 props 里,不写任何存储;下载用一次性的 blob 地址,点完立刻释放。
import { computed, onBeforeUnmount } from 'vue'
import { KbButton, KbCopyButton } from '@kb-ui/index'
import { recoveryFileName, recoveryFileText } from '@/utils/totp'
import { dayKey } from '@/utils/time'

const props = defineProps<{ codes: string[]; account: string; site: string; saved: boolean; hint?: string }>()
const emit = defineEmits<{ 'update:saved': [value: boolean] }>()

const allText = computed(() => props.codes.join('\n'))

let url = ''
function download() {
  const text = recoveryFileText(props.codes, { site: props.site, account: props.account, day: dayKey() })
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  if (url) URL.revokeObjectURL(url)
  url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = recoveryFileName(props.account)
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 给浏览器一点时间开始下载,再释放
  window.setTimeout(() => {
    if (url) URL.revokeObjectURL(url)
    url = ''
  }, 4000)
}
onBeforeUnmount(() => {
  if (url) URL.revokeObjectURL(url)
})
</script>

<template>
  <div class="kb-rc" data-testid="recovery-codes">
    <p class="kb-rc-warn" role="note"><b>恢复码只显示这一次。</b>手机丢了或验证器用不了时,用其中任意一个代替验证码登录;每个只能用一次。请现在保存好。</p>
    <ol class="kb-rc-list" aria-label="恢复码">
      <li v-for="code in codes" :key="code"><code>{{ code }}</code></li>
    </ol>
    <div class="kb-rc-actions">
      <KbCopyButton :text="() => allText" label="复制全部" size="md" />
      <KbButton data-testid="rc-download" @click="download">下载为文本文件</KbButton>
    </div>
    <label class="kb-rc-ack" :class="{ 'is-needed': !!hint }">
      <input type="checkbox" data-testid="rc-saved" :checked="saved" @change="emit('update:saved', ($event.target as HTMLInputElement).checked)" />
      <span>我已把恢复码保存在安全的地方</span>
    </label>
    <p v-if="hint" class="kb-rc-hint" role="alert">{{ hint }}</p>
  </div>
</template>

<style>
.kb-rc {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.kb-rc-warn {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r2);
  background: color-mix(in oklab, var(--status-warning) 14%, transparent);
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
  line-height: var(--lh-body);
}
.kb-rc-warn b {
  color: var(--status-warning-text);
}
.kb-rc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--sp-2);
}
.kb-rc-list li {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r2);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
  min-width: 0;
}
.kb-rc-list code {
  display: block;
  font-family: var(--mono);
  font-size: calc(14px * var(--fs));
  letter-spacing: 0.04em;
  color: var(--text-primary);
  user-select: all;
  overflow-wrap: anywhere;
}
.kb-rc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.kb-rc-ack {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 44px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: calc(14px * var(--fs));
}
.kb-rc-ack input {
  width: 20px;
  height: 20px;
  flex: none;
  accent-color: var(--accent);
}
.kb-rc-ack.is-needed span {
  color: var(--status-danger-text);
}
.kb-rc-hint {
  margin: 0;
  color: var(--status-danger-text);
  font-size: calc(13px * var(--fs));
}
@media (max-width: 599px) {
  .kb-rc-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
