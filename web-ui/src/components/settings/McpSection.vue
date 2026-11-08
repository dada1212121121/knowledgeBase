<script setup lang="ts">
// 「MCP 接入」分区:让 Kiro、Claude Code、Codex 等客户端把知识库当工具用。
//   - 两种传输(本机 stdio / 网络 HTTP)的状态是只读的:传输开关写在 config.toml 的 mcp.transports,改完要重启;
//   - 访问令牌在「个人设置」里新建(每个人自己的令牌,不在系统设置里重复一份);
//   - 在线客户端数只有有 sys.ops 的账号读得到,读不到就不显示这一行(不编数字);
//   - 以前列了一串“协商版本”日期,对配置客户端没用,去掉了。
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { KbBadge, KbCard, KbCopyButton } from '@kb-ui/index'
import { PATHS } from '@/router/paths'
import { callCapability } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import { mcpSnippet, transportRows } from '@/utils/settingsExtras'

const props = defineProps<{ transports: string[]; allowRemote: boolean }>()

const session = useSessionStore()
const sessions = ref<number | null>(null)
onMounted(async () => {
  if (!session.has('sys.ops')) return
  try {
    const status = await callCapability<{ network?: { mcp_sessions?: number } }>('system_status')
    sessions.value = status.network?.mcp_sessions ?? null
  } catch {
    // 在线客户端数只是锦上添花:读不到就不显示这一行,不影响配置本身
  }
})

const rows = computed(() => transportRows(props.transports, props.allowRemote))
const snippet = computed(() => mcpSnippet(window.location.origin))
</script>

<template>
  <KbCard title="传输方式" class="kb-st-card" data-testid="mcp-card">
    <p class="kb-st-note">客户端可以按需拉起本机的 kb mcp,也可以经网络地址访问。传输开关写在 config.toml 的 <code class="kb-mono kb-st-key">mcp.transports</code>,改完要重启服务才生效。</p>
    <ul class="kb-st-list">
      <li v-for="row in rows" :key="row.id" class="kb-st-mirror-item" :data-transport="row.id">
        <div class="kb-st-mirror">
          <KbBadge :tone="row.enabled ? 'success' : 'neutral'" class="kb-st-nowrap">{{ row.enabled ? '已启用' : '未启用' }}</KbBadge>
          <b>{{ row.title }}</b>
        </div>
        <span class="kb-hint kb-st-block">{{ row.hint }}</span>
      </li>
    </ul>
    <p v-if="sessions !== null" class="kb-hint" data-testid="mcp-sessions">现在有 {{ sessions }} 个客户端在线。</p>
    <p class="kb-hint">
      访问令牌在「个人设置」里新建,类型选 mcp:
      <RouterLink :to="PATHS.me" data-testid="mcp-tokens-link">去个人设置</RouterLink>
    </p>
  </KbCard>

  <KbCard title="客户端配置片段" class="kb-st-card" data-testid="mcp-snippet">
    <template #extra><KbCopyButton :text="() => snippet" label="复制" variant="primary" /></template>
    <p class="kb-st-note">把下面的片段合并进客户端的 MCP 配置;网络地址那一项里的「kb_&lt;令牌&gt;」换成你新建的令牌。</p>
    <pre class="kb-mono kb-st-code">{{ snippet }}</pre>
  </KbCard>
</template>
