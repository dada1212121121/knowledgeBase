<script setup lang="ts">
// 使用指南页顶部的「AI 接入指南」:每个用户一份,里面带本人的 admin key、创建访问令牌 / 接 MCP / 自动更新知识库的全部接口说明、
// 给 AI 的提示词和一段自测脚本。下载后整份发给 AI,它就能自己接入并测通。
// 这里还能看到 / 复制 / 轮换 admin key。AI 总开关关闭时标题不带 AI 字样(术语表),功能不变。
import { computed, onMounted, ref } from 'vue'
import { KbButton, KbCard, KbSkeleton, useConfirm, useToast } from '@kb-ui/index'
import { adminKeyGet, adminKeyRotate, aiGuideText, aiGuideUrl, type AdminKeyInfo } from '@/api/adminKey'
import { useSessionStore } from '@/stores/session'
import { timeAgo } from '@/utils/agent'
import { failureOf, friendly } from '@/utils/loadState'

const session = useSessionStore()
const toast = useToast()
const confirm = useConfirm()

const info = ref<AdminKeyInfo | null>(null)
const loading = ref(true)
const failure = ref('')
const shown = ref(false)
const copyingGuide = ref(false)

const title = computed(() => (session.aiEnabled ? 'AI 接入指南' : '接口接入指南'))
const audience = computed(() => (session.aiEnabled ? '发给 AI' : '发给要接入的程序或同事'))

async function load() {
  loading.value = true
  failure.value = ''
  try {
    info.value = await adminKeyGet()
  } catch (err) {
    failure.value = failureOf(err, '读取 admin key').message
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** 默认只露出前缀和最后 4 位,点「显示」才看全部。 */
const masked = computed(() => {
  const key = info.value?.admin_key ?? ''
  return key.length > 12 ? `${key.slice(0, 6)}${'•'.repeat(16)}${key.slice(-4)}` : key
})

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.push(done)
  } catch {
    // 微信 / QQ 内置浏览器常不给剪贴板权限:让用户自己选中复制
    toast.push('浏览器不允许自动复制,请手动选中复制', 'warning')
  }
}

async function copyKey() {
  if (info.value) await copyText(info.value.admin_key, 'admin key 已复制')
}

async function copyGuide() {
  copyingGuide.value = true
  try {
    await copyText(await friendly(aiGuideText(), '读取接入指南'), '接入指南全文已复制,直接粘贴给 AI 即可')
  } catch (err) {
    toast.push(err instanceof Error ? err.message : '读取接入指南失败', 'danger')
  } finally {
    copyingGuide.value = false
  }
}

async function rotate() {
  const ok = await confirm.ask({
    title: '轮换 admin key?',
    message:
      '轮换后旧 key 立刻失效:已经下载的接入指南、配好 key 的脚本和 AI 都会得到 401,需要换成新 key(重新下载指南即可)。已经创建的访问令牌不受影响。',
    confirmText: '轮换',
    tone: 'danger',
    doneText: 'admin key 已轮换',
    action: async () => {
      info.value = await friendly(adminKeyRotate(), '轮换 admin key')
      shown.value = true
    },
  })
  if (ok) await copyKey()
}
</script>

<template>
  <KbCard class="kb-aig" aria-labelledby="ai-guide-title" data-testid="ai-guide">
    <header class="kb-aig-head">
      <b id="ai-guide-title">{{ title }}</b>
    </header>
    <p class="m kb-aig-intro">
      下载这份文档{{ audience }},里面有你的 admin key、创建访问令牌和接入知识库的步骤、自动更新知识库的方法、全部接口说明和一段自测脚本。
      照着做就能接入并测试成功,测试用的数据会自动清理。
    </p>
    <div class="kb-aig-actions">
      <a class="btn pri" :href="aiGuideUrl(true)" download="knowledgebase-ai-guide.md" data-testid="ai-guide-download">下载接入指南</a>
      <KbButton :disabled="copyingGuide" data-testid="ai-guide-copy" @click="copyGuide">{{ copyingGuide ? '读取中…' : '复制全文' }}</KbButton>
    </div>

    <div class="kb-aig-key" data-testid="admin-key-row">
      <span class="kb-aig-label">admin key</span>
      <KbSkeleton v-if="loading" variant="lines" :lines="1" />
      <template v-else-if="failure">
        <span class="kb-aig-bad" role="alert" data-testid="admin-key-failure">{{ failure }}</span>
        <KbButton size="sm" @click="load">重试</KbButton>
      </template>
      <template v-else-if="info">
        <code class="mono kb-aig-code" data-testid="admin-key-value">{{ shown ? info.admin_key : masked }}</code>
        <span class="kb-aig-ops">
          <KbButton size="sm" :aria-pressed="shown" data-testid="admin-key-toggle" @click="shown = !shown">{{ shown ? '隐藏' : '显示' }}</KbButton>
          <KbButton size="sm" data-testid="admin-key-copy" @click="copyKey">复制</KbButton>
          <KbButton size="sm" variant="danger" data-testid="admin-key-rotate" @click="rotate">轮换</KbButton>
        </span>
      </template>
    </div>
    <p v-if="info" class="m kb-small kb-aig-note">
      用这把 key 能以你的身份调用你权限内的全部接口(包括创建访问令牌)。{{ info.rotated_at ? `上次轮换:${timeAgo(info.rotated_at)}。` : '从未轮换过。' }}
    </p>
  </KbCard>
</template>

<style>
.kb-aig { display: flex; flex-direction: column; gap: var(--sp-3); }
.kb-aig-head { display: flex; align-items: center; gap: var(--sp-3); }
.kb-aig-intro { margin: 0; line-height: 1.6; }
.kb-aig-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.kb-aig-key {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2) var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-sunken);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  min-width: 0;
}
.kb-aig-label { color: var(--text-secondary); font-size: calc(12px * var(--fs)); flex: none; }
.kb-aig-code { flex: 1 1 14em; min-width: 0; overflow-wrap: anywhere; }
.kb-aig-ops { display: flex; flex-wrap: wrap; gap: var(--sp-2); flex: none; }
.kb-aig-bad { color: var(--status-danger-text); flex: 1 1 14em; min-width: 0; }
.kb-aig-note { margin: 0; }
</style>
