<script setup lang="ts">
// AI 助手的右侧抽屉(统一外壳 .2):
//   - 由顶栏的 AI 按钮(以及 ⌘J / 手机「我的」页)打开,不再有悬浮球——悬浮球在手机上压住标签栏、
//     在桌面上挡住表格和编辑器的右下角;
//   - 桌面是顶栏下方的右侧抽屉,手机是全屏;AI 总开关关掉或账号没有 ai.assistant 时由外壳不渲染它;
//   - 借鉴 Codeg (https://github.com/keh4l/codeg) 风格,提供宽敞内容流、代码与 Markdown 优化渲染、执行轨迹时间线与一体化输入框。
import { computed, defineAsyncComponent, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  KbBadge,
  KbButton,
  KbCard,
  KbEmpty,
  KbIcon,
  KbSelect,
  useConfirm,
  useMedia,
  useToast,
  isComposing,
} from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { usePanelsStore } from '@/stores/panels'
import { useActiveDocStore } from '@/stores/activeDoc'
import { usageMine } from '@/api/usage'
import { isMyQueueEvent, queueText, workspaceView } from '@/utils/assistant'
import { PATHS } from '@/router/paths'
import { requestUpload } from '@/api/upload'
import { failureOf } from '@/utils/loadState'
import { useFeature } from '@/composables/useFeature'
// 回答正文与笔记页同一条渲染管线（markdown-it + DOMPurify，原始 HTML 一律不开）；现在不再用 md-editor-v3
const MarkdownRead = defineAsyncComponent(() => import('@/components/MarkdownRead.vue'))
import AgentRefChips from '@/components/AgentRefChips.vue'
import AgentSessions from '@/components/AgentSessions.vue'
import ChatCommandMenu from '@/components/ChatCommandMenu.vue'
import InsightDialog from '@/components/InsightDialog.vue'
import MentionPanel from '@/components/MentionPanel.vue'
import { menuKeyOf } from '@/utils/imeGuard'
import { useChatCommands } from '@/agent/useChatCommands'
import { useMentions } from '@/agent/useMentions'
import {
  buildMentionPrompt,
  parseMentionTokens,
  refsOfMentions,
  stripMentionTokens,
} from '@/agent/mentions'
import { subscribeLive } from '@/composables/useLiveEvents'
import {
  restoreEntries,
  type AgentRef,
  type AgentSessionSummary,
} from '@/utils/agent'

interface PlanCard {
  id: string
  capability: string
  args: Record<string, unknown>
  args_hash: string
  plan: unknown
}
interface ChatEntry {
  role: 'user' | 'assistant' | 'system'
  text: string
  cards?: PlanCard[]
  trace?: string[]
  refs?: AgentRef[]
  failed?: boolean
  /** 上下文摘要(较早对话已压缩)。 */
  summary?: boolean
}

// 同一个组件两种用法(.7):外壳里的右侧抽屉(drawer,任何页面都能 ⌘J 呼出),和 /assistant 独立页面(page,铺满内容区、
// 宽屏时左边常驻会话列表)。以前页面是另一份 700 行的实现,两边功能和修复对不上,现在只有这一份。
const props = withDefaults(defineProps<{ mode?: 'drawer' | 'page' }>(), { mode: 'drawer' })
const isPage = computed(() => props.mode === 'page')

const route = useRoute()
const router = useRouter()
const toast = useToast()

// 开合状态在 panels store 里:顶栏按钮、⌘J、手机「我的」页都能打开它
const panels = usePanelsStore()
const isOpen = computed({
  get: () => panels.assistantOpen,
  set: (value: boolean) => panels.toggleAssistant(value),
})
// 抽屉在 /assistant 页面上不出现:页面本身就是助手,同时开两个同一会话的对话框只会互相打架
const visible = computed(() => (isPage.value ? true : isOpen.value && route.path !== PATHS.assistant))
const sessionId = ref('')
const draft = ref('')
const entries = ref<ChatEntry[]>([])
const busy = ref(false)
const unsandboxed = ref(false)
const error = ref('')
const canReview = useFeature('ai.extract')
/** 错误条上的「重试」:出错时记下"再做一次"要调的函数;点了先清掉错误再调 */
const retryAction = ref<(() => void) | null>(null)
/** 读取可用代理 / 历史会话列表失败了:不能把"读不到"说成"没有"(以前两种情况界面一样) */
const agentsFailed = ref(false)
const sessionsFailed = ref(false)
const confirming = ref('')
const streaming = ref('')
const copiedIndex = ref<number | null>(null)

/** 后端:内置模型,或某个 ACP 代理(`acp:<id>`)。 */
const BrandLogo = defineComponent({
  name: 'BrandLogo',
  props: {
    brand: { type: String, required: true },
  },
  setup(props) {
    return () => {
      if (props.brand === 'deepseek') {
        return h('svg', { viewBox: '0 0 24 24', class: 'kb-brand-svg', fill: 'currentColor' }, [
          h('path', { d: 'M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078.253.253 0 0 1-.114-.358c.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z' })
        ])
      }
      if (props.brand === 'claude') {
        return h('svg', { viewBox: '0 0 24 24', class: 'kb-brand-svg', fill: 'currentColor' }, [
          h('path', { d: 'M12 2a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1zm6.364 2.636a1 1 0 0 1 0 1.414l-1.414 1.414a1 1 0 1 1-1.414-1.414l1.414-1.414a1 1 0 0 1 1.414 0zM22 12a1 1 0 0 1-1 1h-2a1 1 0 1 1 0-2h2a1 1 0 0 1 1 1zm-3.636 6.364a1 1 0 0 1-1.414 0l-1.414-1.414a1 1 0 0 1 1.414-1.414l1.414 1.414a1 1 0 0 1 0 1.414zM12 22a1 1 0 0 1-1-1v-2a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1zm-6.364-3.636a1 1 0 0 1 0-1.414l1.414-1.414a1 1 0 0 1 1.414 1.414l-1.414 1.414a1 1 0 0 1-1.414 0zM2 12a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1zm2.636-6.364a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 0 1-1.414 1.414L4.636 7.05a1 1 0 0 1 0-1.414zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z' })
        ])
      }
      if (props.brand === 'openai') {
        return h('svg', { viewBox: '0 0 24 24', class: 'kb-brand-svg', fill: 'currentColor' }, [
          h('path', { d: 'M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l2.02-1.164 4.78 2.763v2.327l-4.78-2.763a.804.804 0 0 0-.79-.005l-1.23.71v-1.872zm2.024-3.328l2.774-1.602 2.774 1.602v3.204l-2.774 1.602-2.774-1.602z' })
        ])
      }
      if (props.brand === 'gemini') {
        return h('svg', { viewBox: '0 0 24 24', class: 'kb-brand-svg', fill: 'currentColor' }, [
          h('path', { d: 'M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12z' })
        ])
      }
      if (props.brand === 'qwen') {
        return h('svg', { viewBox: '0 0 24 24', class: 'kb-brand-svg', fill: 'currentColor' }, [
          h('path', { d: 'M12 2L3 7v10l9 5 9-5V7l-9-5zm0 3.1l6 3.3v6.8l-6 3.3-6-3.3V8.4l6-3.3zM8.5 10.2L12 8.2l3.5 2v4.4L12 16.6l-3.5-2v-4.4z' })
        ])
      }
      return h('svg', { viewBox: '0 0 24 24', class: 'kb-brand-svg', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, [
        h('path', { d: 'm12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z' })
      ])
    }
  }
})

interface ModelBrandMeta {
  brand: 'deepseek' | 'claude' | 'openai' | 'gemini' | 'qwen' | 'generic'
  displayName: string
  color: string
}

function getModelMeta(rawName: string, id?: string): ModelBrandMeta {
  const combined = `${id || ''} ${rawName}`.toLowerCase()
  if (combined.includes('deepseek')) {
    return {
      brand: 'deepseek',
      displayName: rawName.replace(/^ACP\s*·?\s*/i, '').trim() || 'DeepSeek',
      color: '#4D6BFE',
    }
  }
  if (combined.includes('claude') || combined.includes('anthropic')) {
    return {
      brand: 'claude',
      displayName: rawName.replace(/^ACP\s*·?\s*/i, '').trim() || 'Claude',
      color: '#D97706',
    }
  }
  if (combined.includes('gpt') || combined.includes('openai') || combined.includes('codex') || combined.includes('chatgpt')) {
    return {
      brand: 'openai',
      displayName: rawName.replace(/^ACP\s*·?\s*/i, '').trim() || 'GPT',
      color: '#10A37F',
    }
  }
  if (combined.includes('gemini') || combined.includes('google')) {
    return {
      brand: 'gemini',
      displayName: rawName.replace(/^ACP\s*·?\s*/i, '').trim() || 'Gemini',
      color: '#4E88F5',
    }
  }
  if (combined.includes('qwen') || combined.includes('tongyi')) {
    return {
      brand: 'qwen',
      displayName: rawName.replace(/^ACP\s*·?\s*/i, '').trim() || 'Qwen',
      color: '#615CED',
    }
  }
  return {
    brand: 'generic',
    displayName: rawName.replace(/^ACP\s*·?\s*/i, '').trim() || (id ? id : '默认模型'),
    color: 'var(--accent)',
  }
}

/** 后端:内置模型,或某个 ACP 代理(`acp:<id>`)。 */
const backend = ref(localStorage.getItem('kb.agent.backend') || 'builtin')
interface AcpAgentOption { id: string; name: string; available: boolean }
const acpAgents = ref<AcpAgentOption[]>([])
const backendOptions = computed(() =>
  acpAgents.value
    .filter((agent) => agent.available)
    .map((agent) => ({ value: `acp:${agent.id}`, label: `ACP · ${agent.name}` })),
)
const currentBackendName = computed(() => {
  const current = acpAgents.value.find((agent) => `acp:${agent.id}` === backend.value)
  return current ? current.name : backend.value.replace(/^acp:/, '') || 'ACP'
})

async function loadAcpAgents() {
  try {
    const result = await callCapability<{ agents: AcpAgentOption[]; default?: string; workspace_mb?: number; workspace_enforced?: boolean }>('acp_agents')
    agentsFailed.value = false
    acpAgents.value = result.agents ?? []
    workspaceLimitMb.value = typeof result.workspace_mb === 'number' ? result.workspace_mb : null
    // 服务端只对受限账号拦;老守护进程没有这个字段时按「不拦」处理,免得界面比服务端更严
    workspaceEnforced.value = result.workspace_enforced === true
    const available = acpAgents.value.filter((agent) => agent.available).map((agent) => `acp:${agent.id}`)
    if (!available.includes(backend.value)) {
      const fallback = result.default ? `acp:${result.default}` : ''
      backend.value = available.includes(fallback) ? fallback : available[0] ?? ''
    }
  } catch {
    agentsFailed.value = true
    acpAgents.value = []
  }
}
function setBackend(value: string | number) {
  backend.value = String(value)
  localStorage.setItem('kb.agent.backend', backend.value)
}

/** 「新建经验」表单。 */
const insightOpen = ref(false)
const {
  menuOpen: commandMenuOpen,
  filtered: commandItems,
  active: commandActive,
  onInput: onCommandInput,
  close: closeCommandMenu,
  move: moveCommand,
  choose: chooseCommand,
  tryRun: tryRunCommand,
  load: loadCommands,
} = useChatCommands(
  () => ({
    project: currentProject.value,
    call: callCapability,
    push: (entry) => entries.value.push(entry as ChatEntry),
    navigate: (path) => router.push(path),
    upload: () => fileInput.value?.click(),
    switchAgent,
    openInsight: () => {
      insightOpen.value = true
    },
    ask: askAgent,
  }),
  () =>
    acpAgents.value
      .filter((agent) => agent.available)
      .map((agent) => ({
        id: agent.id,
        label: `ACP · ${agent.name}`,
        description: '切换到该代理',
        kind: 'agent' as const,
        args: [],
      })),
)

const {
  open: mentionOpen,
  kind: mentionKind,
  items: mentionItems,
  active: mentionActive,
  loading: mentionLoading,
  kinds: mentionKinds,
  onInput: onMentionInput,
  setKind: setMentionKind,
  move: moveMention,
  choose: chooseMention,
  close: closeMention,
} = useMentions(() => ({ call: callCapability, agents: acpAgents.value }))

/** 切换后端并留一条系统提示。 */
function switchAgent(id: string) {
  setBackend(`acp:${id}`)
  const agent = acpAgents.value.find((item) => item.id === id)
  entries.value.push({ role: 'system', text: `已切换到代理 ${agent?.name ?? id}` })
}

/** 选中引用:代理就切后端,其余把引用链接插进输入框。 */
async function onMentionSelect(index: number) {
  const result = chooseMention(index, draft.value)
  if (result.ref?.kind === 'agent') {
    switchAgent(result.ref.id)
    return
  }
  draft.value = result.text
  await nextTick()
  inputRef.value?.focus()
}

/** 选中菜单项:带参数的填进输入框,不带参数的直接执行。 */
async function onCommandSelect(index: number) {
  draft.value = await chooseCommand(index, draft.value)
  await nextTick()
  inputRef.value?.focus()
}

watch(draft, (value) => {
  onMentionInput(value)
  onCommandInput(value)
  if (mentionOpen.value) closeCommandMenu()
  if (commandMenuOpen.value) closeMention()
})
// 挂件在登录前就挂载了,首次加载会失败;每次打开时补一次
watch(isOpen, (value) => {
  if (value) void loadCommands()
})

const currentModelMeta = computed(() => {
  const current = acpAgents.value.find((agent) => `acp:${agent.id}` === backend.value)
  if (current) {
    return getModelMeta(current.name, current.id)
  }
  if (backend.value && backend.value !== 'builtin') {
    const rawId = backend.value.replace(/^acp:/, '')
    return getModelMeta(rawId, rawId)
  }
  return getModelMeta('DeepSeek', 'deepseek')
})

const availableModels = computed(() => {
  const list = acpAgents.value
    .filter((agent) => agent.available)
    .map((agent) => ({
      value: `acp:${agent.id}`,
      meta: getModelMeta(agent.name, agent.id),
    }))
  if (list.length === 0) {
    return [{
      value: backend.value || 'acp:deepseek',
      meta: currentModelMeta.value,
    }]
  }
  return list
})

const isModelMenuOpen = ref(false)
const modelPickerRef = ref<HTMLElement | null>(null)

function selectModel(val: string) {
  setBackend(val)
  isModelMenuOpen.value = false
}

function onDocumentClick(e: MouseEvent) {
  if (isModelMenuOpen.value && modelPickerRef.value && !modelPickerRef.value.contains(e.target as Node)) {
    isModelMenuOpen.value = false
  }
}

/** 历史会话面板 */
const showHistory = ref(false)
const sessions = ref<AgentSessionSummary[]>([])
const sessionsLoading = ref(false)
const traceOpen = ref<Record<number, boolean>>({})
const inputRef = ref<HTMLTextAreaElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)

// 订阅大模型流式增量事件
const acpTurn = ref(false)
const acpTrace = ref<string[]>([])
/** 代理请求执行工具,等界面答复。 */
const pendingPermission = ref<{ request_id: string; tool: string } | null>(null)

// ---- 排队与工作目录(.7) ----
/** 全站代理名额满了时后端每秒推一次 acp.queued:前面还有几个人。开始出内容或这一轮结束就清掉 */
const queueAhead = ref<number | null>(null)
const queueHint = computed(() => queueText(queueAhead.value))
/** 代理工作目录:已用(usage_mine)和上限(acp_agents.workspace_mb)。满了后端会拒绝新的一轮,所以前面先拦住并说清楚 */
const workspaceUsed = ref<number | null>(null)
const workspaceLimitMb = ref<number | null>(null)
const workspaceEnforced = ref(false)
const workspace = computed(() => workspaceView(workspaceUsed.value, workspaceLimitMb.value, workspaceEnforced.value))
async function loadWorkspace() {
  try {
    workspaceUsed.value = (await usageMine()).storage.workspace_bytes
  } catch {
    workspaceUsed.value = null // 取不到就不显示,不挡对话
  }
}

subscribeLive((event) => {
  if (event.type === 'acp.queued') {
    const data = event.data as { session_id?: string; ahead?: number }
    if (acpTurn.value && isMyQueueEvent(data.session_id, sessionId.value)) queueAhead.value = typeof data.ahead === 'number' ? data.ahead : null
    return
  }
  if (event.type === 'acp.update') queueAhead.value = null
  if (event.type === 'acp.update') {
    const data = event.data as {
      session_id?: string
      kind?: string
      text?: string
      title?: string
      request_id?: string
      tool?: string
    }
    if (!acpTurn.value) return
    if (data.session_id && sessionId.value && data.session_id !== sessionId.value) return
    if (data.kind === 'text') {
      streaming.value += data.text ?? ''
      scrollToBottom()
    } else if (data.kind === 'tool' && data.title) {
      acpTrace.value.push(data.title)
    } else if (data.kind === 'permission_request') {
      pendingPermission.value = {
        request_id: String(data.request_id ?? ''),
        tool: String(data.tool ?? '工具调用'),
      }
    }
  }
})

const hasSession = computed(() => sessionId.value !== '')

function storageKey() {
  return 'kb.agent.session'
}

/** 计划卡片里的参数:长值截断,对象转成一行 JSON。 */
function formatArg(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function scrollToBottom() {
  void nextTick(() => {
    if (scrollRef.value) {
      scrollRef.value.scrollTop = scrollRef.value.scrollHeight
    }
  })
}

function toggleOpen() {
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    void nextTick(() => {
      inputRef.value?.focus()
      scrollToBottom()
    })
  }
}

// 当前页面感知:识别是在查看哪个集合或文档
const activeDoc = useActiveDocStore()
/** 标题里的方括号会截断 `@[标题](kb://…)` 引用,换成全角 */
const mentionLabel = (title: string) => (title.trim() || '无标题').replace(/\[/g, '［').replace(/\]/g, '］')
const currentContext = computed(() => {
  const p = route.path
  if (p === PATHS.kb) {
    const col = route.query.collection as string | undefined
    const item = route.query.item as string | undefined
    // 文档页登记过当前文档:显示标题(不显示 ins_xxxx 这种编号);笔记附上可读引用,助手会按引用去读它
    const doc = activeDoc.doc
    if (item && doc) {
      const label = mentionLabel(doc.title)
      const prefix = doc.noteId ? `针对 @[${label}](kb://item/${encodeURIComponent(doc.noteId)}) ：` : `针对当前打开的文档《${label}》：`
      return { label: `当前文档：${label}`, prefix }
    }
    if (item) return { label: '当前文档', prefix: `针对当前打开的文档（编号 ${item}）：` }
    if (col) return { label: `集合 ${col}`, prefix: `在当前集合 ${col} 中：` }
    return { label: '知识库', prefix: '关于知识库浏览：' }
  }
  if (p === PATHS.search) return { label: '搜索', prefix: '如何更好地检索知识库：' }
  if (p === PATHS.review) return { label: '审核收件箱', prefix: '关于待审知识的整理与校验：' }
  if (p === PATHS.import || p.startsWith(`${PATHS.import}/`)) return { label: '导入', prefix: '关于数据源与导入解析：' }
  if (p === PATHS.tasks || p === PATHS.audit) return { label: '任务与审计', prefix: '关于系统后台任务与批次审计：' }
  return null
})

/** 当前浏览的集合(上传时作为默认目标)。 */
const currentCollection = computed(() => {
  const collection = route.query.collection
  return typeof collection === 'string' ? collection : ''
})

/** 当前浏览的项目(浏览器页带 `?collection=proj_xxx` 时):会话会归到这个项目下。 */
const currentProject = computed(() => {
  const collection = route.query.collection
  if (typeof collection === 'string' && collection.startsWith('proj_')) {
    return collection.slice('proj_'.length)
  }
  return ''
})

/** 把一条消息发给 ACP 代理(不推用户气泡;@ 命令和普通消息都走这里)。 */
async function askAgent(text: string, displayText?: string) {
  busy.value = true
  error.value = ''
  retryAction.value = null
  scrollToBottom()

  if (!backend.value.startsWith('acp:')) {
    if (agentsFailed.value) {
      // 代理列表没读到(不是"没有代理"):说清楚并给重试,重试读通后清掉提示,用户再发一次即可
      error.value = '没能读取可用的代理。请检查网络后重试。'
      retryAction.value = () => void retryAgents()
    } else {
      error.value = '还没有可用的 ACP 代理:去「设置 → ACP 接入」安装或启用一个'
    }
    busy.value = false
    return
  }
  if (workspace.value?.blocked) {
    error.value = workspace.value.text
    busy.value = false
    return
  }
  queueAhead.value = null
  try {
    const agent = backend.value.slice(4)
    acpTrace.value = []
    acpTurn.value = true
    const reply = await callCapability<{
      session_id: string
      text: string
      trace: string[]
      stop_reason: string
      sandboxed?: boolean
    }>('acp_chat', {
      agent,
      session_id: sessionId.value || undefined,
      text,
      display_text: displayText,
      project: currentProject.value || undefined,
    })
    sessionId.value = reply.session_id
    unsandboxed.value = reply.sandboxed === false
    localStorage.setItem(storageKey(), reply.session_id)
    acpTurn.value = false
    streaming.value = ''
    const finalText = reply.text?.trim() ? reply.text : streaming.value
    streaming.value = ''
    entries.value.push({
      role: 'assistant',
      text: finalText,
      trace: reply.trace?.length ? reply.trace : acpTrace.value,
    })
    void loadSessions()
  } catch (err) {
    const message = err instanceof Error ? err.message : '对话失败'
    // 出错也别把已经生成的过程丢掉
    const partial = streaming.value.trim()
    if (partial) {
      entries.value.push({ role: 'assistant', text: partial, trace: acpTrace.value })
    }
    streaming.value = ''
    // 代理没登录:给管理员能照着做的话;其余失败走统一的"发生了什么 + 怎么办",不露英文异常
    error.value = /auth/i.test(message) ? '这个代理还没有登录。请管理员在服务器上登录它,或在代理设置里配置访问密钥,然后再试一次。' : failureOf(err, '这一轮对话').message
    retryAction.value = () => void askAgent(text, displayText)
    acpTurn.value = false
    acpTrace.value = []
  } finally {
    busy.value = false
    queueAhead.value = null
    void loadWorkspace()
    scrollToBottom()
  }
}

async function stopTurn() {
  if (!sessionId.value) return
  try {
    await callCapability('acp_cancel', { session_id: sessionId.value })
  } catch (err) {
    error.value = failureOf(err, '停止').message
  }
}

async function send() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  // 引用:把链接解析出来,提示词里附「参考资料」
  const refs = parseMentionTokens(text)
  if (refs.length > 0) {
    draft.value = ''
    entries.value.push({ role: 'user', text: stripMentionTokens(text), refs: refsOfMentions(refs) })
    await askAgent(buildMentionPrompt(text, refs), stripMentionTokens(text))
    return
  }
  // 整条是 /命令 就直接执行(命令内部会让代理来做),不发给代理原文
  if (await tryRunCommand(text)) {
    draft.value = ''
    return
  }
  draft.value = ''
  entries.value.push({ role: 'user', text })
  await askAgent(text)
}

/** 答复代理的权限请求。 */
async function respondPermission(allow: boolean) {
  const pending = pendingPermission.value
  if (!pending) return
  pendingPermission.value = null
  try {
    await callCapability('acp_permission', {
      session_id: sessionId.value || undefined,
      request_id: pending.request_id,
      allow,
    })
    toast.push(allow ? '已允许这次工具调用' : '已拒绝这次工具调用')
  } catch (err) {
    toast.push(failureOf(err, '答复').message, 'danger')
  }
}

async function confirmCard(card: PlanCard) {
  confirming.value = card.id
  error.value = ''
  try {
    const result = await callCapability<{ batch_id: string | null }>('agent_confirm', {
      session_id: sessionId.value,
      card_id: card.id,
      args_hash: card.args_hash,
    })
    entries.value.push({
      role: 'system',
      text: result.batch_id
        ? `已执行 ${card.capability}，生成批次 ${result.batch_id}（可在审计页撤销）`
        : `已执行 ${card.capability}`,
      refs: result.batch_id
        ? [{ kind: 'batch', id: result.batch_id, label: '查看批次' } as AgentRef]
        : [],
    })
    toast.push('已执行')
  } catch (err) {
    error.value = failureOf(err, '执行').message
  } finally {
    confirming.value = ''
    scrollToBottom()
  }
}

/** 拉取最近的会话(打开面板 / 发完消息后刷新)。 */
async function loadSessions() {
  sessionsLoading.value = true
  try {
    const result = await callCapability<{ sessions: AgentSessionSummary[] }>('agent_sessions', {})
    sessionsFailed.value = false
    sessions.value = result.sessions ?? []
  } catch {
    sessionsFailed.value = true
    sessions.value = []
  } finally {
    sessionsLoading.value = false
  }
}

/** 切到某个历史会话:读它的记录并渲染。 */
async function switchSession(id: string) {
  showHistory.value = false
  if (id === sessionId.value) return
  sessionId.value = id
  localStorage.setItem(storageKey(), id)
  await loadHistory(id)
}

/** 读某个会话的记录并渲染;失败时说清楚,并给"重试"(重试就是再读一次) */
async function loadHistory(id: string) {
  entries.value = []
  streaming.value = ''
  error.value = ''
  retryAction.value = null
  try {
    const listed = await callCapability<{
      messages: { role: string; content_json: string }[]
      summary?: string
    }>('agent_history', { session_id: id })
    entries.value = restoreEntries(listed.messages).map((entry) => ({
      ...entry,
      cards: entry.cards as PlanCard[] | undefined,
    }))
    if (listed.summary?.trim()) {
      entries.value.unshift({ role: 'system', text: listed.summary, summary: true })
    }
  } catch (err) {
    error.value = failureOf(err, '读取这个会话').message
    retryAction.value = () => void loadHistory(id)
  }
  scrollToBottom()
}

/** 错误条上的「重试」 */
function retryLast() {
  const action = retryAction.value
  error.value = ''
  retryAction.value = null
  action?.()
}

/** 重新读取可用的代理;读通了就把"没能读取"的提示撤掉,读不通就再提示一次 */
async function retryAgents() {
  await loadAcpAgents()
  if (agentsFailed.value) {
    error.value = '没能读取可用的代理。请检查网络后重试。'
    retryAction.value = () => void retryAgents()
  }
}

/** 重命名会话(空标题 = 恢复成首条用户消息)。 */
async function renameSession(id: string, title: string) {
  try {
    await callCapability('agent_rename_session', { session_id: id, title })
    await loadSessions()
  } catch (err) {
    toast.push(failureOf(err, '重命名').message, 'danger')
  }
}

/** 置顶 / 取消置顶。 */
async function pinSession(id: string, pinned: boolean) {
  try {
    await callCapability('agent_pin_session', { session_id: id, pinned })
    await loadSessions()
  } catch (err) {
    toast.push(failureOf(err, '置顶').message, 'danger')
  }
}

/** 删除一个会话(当前会话被删就顺势开新会话)。 */
async function removeSession(id: string) {
  const target = sessions.value.find((item) => item.session_id === id)
  const ok = await useConfirm().ask({
    title: '删除这个会话?',
    message: `「${target?.title ?? id}」的对话记录会被删除,不能恢复。`,
    confirmText: '删除',
    tone: 'danger',
    doneText: '会话已删除',
    action: () => callCapability('agent_delete_session', { session_id: id }),
  })
  if (!ok) return
  if (id === sessionId.value) newSession()
  await loadSessions()
}

/** 复制消息正文。 */
async function copyMessage(text: string, idx: number) {
  try {
    await navigator.clipboard.writeText(text)
    copiedIndex.value = idx
    toast.push('已复制到剪贴板')
    setTimeout(() => {
      if (copiedIndex.value === idx) copiedIndex.value = null
    }, 2000)
  } catch {
    toast.push('复制失败', 'danger')
  }
}

/** 把一条回答插进正在编辑的文档(光标处;没点过正文时插在开头)。文档页没在编辑时按钮本来就不显示 */
async function insertIntoDoc(text: string) {
  const insert = activeDoc.insert
  if (!insert) return
  try {
    const ok = await insert(text)
    toast.push(ok ? '已插入到文档,可以用撤销取消' : '没能插入:文档现在不能编辑', ok ? undefined : 'danger')
  } catch {
    toast.push('没能插入:文档现在不能编辑', 'danger')
  }
}

/** 聊天里的附件:复用全局上传管线(分片 / 去重 / 入库),上传后给一条系统提示。 */
const fileInput = ref<HTMLInputElement | null>(null)
function pickFiles() {
  fileInput.value?.click()
}
function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (!files.length) return
  requestUpload(files, { collection: currentCollection.value || undefined })
  entries.value.push({
    role: 'system',
    text: `已提交 ${files.length} 个文件,解析进度见「导入记录」`,
    refs: [{ kind: 'ingest', id: PATHS.importQueue, label: '导入记录' }],
  })
  input.value = ''
  scrollToBottom()
}

/** 抽屉 → 独立页面:会话号已经存在本机,页面打开时会接着这个会话 */
function expand() {
  isOpen.value = false
  void router.push(PATHS.assistant)
}
// 页面模式下,宽屏(≥840)左边常驻会话列表;窄屏和抽屉里一样点按钮才展开
const wide = useMedia('(min-width: 840px)')

function newSession() {
  sessionId.value = ''
  entries.value = []
  streaming.value = ''
  error.value = ''
  retryAction.value = null
  showHistory.value = false
  localStorage.removeItem(storageKey())
  toast.push('已开启新会话')
}

function sendPreset(prompt: string) {
  draft.value = prompt
  void send()
}

function handleInputKeydown(event: KeyboardEvent) {
  // 输入法占着的键(选词的↑↓、上屏的回车、取消组字的 Esc)menuKeyOf 返回 null:菜单不响应,也不 preventDefault
  const action = menuKeyOf(event)
  if (mentionOpen.value && action) {
    event.preventDefault()
    if (action === 'next') moveMention(1)
    else if (action === 'prev') moveMention(-1)
    else if (action === 'confirm') void onMentionSelect(mentionActive.value)
    else closeMention()
    return
  }
  if (commandMenuOpen.value && action) {
    event.preventDefault()
    if (action === 'next') moveCommand(1)
    else if (action === 'prev') moveCommand(-1)
    else if (action === 'confirm') void onCommandSelect(commandActive.value)
    else closeCommandMenu()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !isComposing(event)) {
    event.preventDefault()
    void send()
  }
}

function handleGlobalKeydown(event: KeyboardEvent) {
  // ⌘J / Esc 只归抽屉:页面模式的那一份不响应,否则一次按键两边各处理一遍
  if (isPage.value) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
    event.preventDefault()
    toggleOpen()
  } else if (event.key === 'Escape' && isOpen.value && !isComposing(event)) {
    // 组字中的 Esc 是取消输入法的预编辑文字,不是关抽屉
    isOpen.value = false
  }
}

/**
 * 接上本机记着的会话(读它的历史)。抽屉和独立页面是两个实例,会话号存在本机:
 * 在一边聊过,另一边打开时要接上最新的那个会话,而不是停在旧的内容上。正在回答时不切。
 */
async function restoreSaved() {
  const saved = localStorage.getItem(storageKey())
  if (busy.value || !!streaming.value) return
  if (!saved) {
    if (sessionId.value) {
      sessionId.value = ''
      entries.value = []
    }
    return
  }
  if (saved === sessionId.value && entries.value.length) return
  sessionId.value = saved
  // 读失败时以前是悄悄留下一个空对话(界面看着像新对话,实际还挂在旧会话上);现在说清楚并给重试
  await loadHistory(saved)
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('click', onDocumentClick)
  void loadAcpAgents()
  if (isPage.value) {
    void loadSessions()
    void loadCommands()
    void loadWorkspace()
  }
  await restoreSaved()
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('click', onDocumentClick)
})

// 顶栏上的 AI 按钮靠它显示「正在回答」的脉动小圆点
watch(
  () => busy.value || !!streaming.value,
  (value) => (panels.assistantBusy = value),
  { immediate: true },
)
onUnmounted(() => (panels.assistantBusy = false))

watch(isOpen, (val) => {
  if (val && !isPage.value) {
    void loadWorkspace()
    void restoreSaved().then(scrollToBottom)
    void loadSessions()
    void loadAcpAgents()
  }
})
</script>

<template>
  <!-- 右侧抽屉(桌面在顶栏下方,手机全屏) -->
  <aside
    v-if="visible"
    class="kb-agent-widget"
    :class="{ 'is-page': isPage }"
    :role="isPage ? undefined : 'dialog'"
    aria-label="AI 助手"
    :data-testid="isPage ? 'assistant-page' : 'assistant-drawer'"
  >
    <!-- 头部栏 -->
    <div class="kb-agent-head">
      <div class="kb-agent-title-row">
        <span class="kb-agent-avatar" :style="{ color: currentModelMeta.color }">
          <BrandLogo :brand="currentModelMeta.brand" />
        </span>
        <div class="kb-agent-meta">
          <div class="kb-agent-heading">
            <b class="kb-agent-name">AI 助手</b>
            <span class="kb-agent-model-tag">{{ currentModelMeta.displayName }}</span>
          </div>
          <div class="kb-agent-status" :class="{ 'is-active': busy || !!streaming }">
            <span class="kb-status-indicator"></span>
            <span>{{ busy ? '思考规划中…' : streaming ? '生成回复中…' : '就绪' }}</span>
          </div>
        </div>
      </div>

      <!-- 顶栏快捷操作 -->
      <div class="kb-agent-actions">
        <button
          v-if="currentContext"
          type="button"
          class="btn sm kb-ghost kb-context-pill"
          :title="`针对${currentContext.label}提问`"
          @click="draft = currentContext.prefix + draft; inputRef?.focus()"
        >
          <KbIcon name="doc" :size="12" />
          <span class="kb-context-text">{{ currentContext.label }}</span>
        </button>
        <button
          type="button"
          class="btn sm kb-ghost"
          v-if="!(isPage && wide)"
          :title="showHistory ? '收起历史会话' : '历史会话'"
          aria-label="历史会话"
          :class="{ 'is-current': showHistory }"
          @click="showHistory = !showHistory"
        >
          <KbIcon name="clock" :size="13" />
        </button>
        <button
          type="button"
          class="btn sm kb-ghost"
          title="开启新会话"
          aria-label="新会话"
          @click="newSession"
        >
          <KbIcon name="plus" :size="13" />
        </button>
        <!-- 抽屉里:展开成独立页面(更宽、左边常驻会话列表);正在回答时不能切,不然这一轮的流式内容会留在抽屉里 -->
        <button
          v-if="!isPage"
          type="button"
          class="btn sm kb-ghost"
          title="在独立页面打开"
          aria-label="全屏打开"
          data-testid="assistant-expand"
          :disabled="busy || !!streaming"
          @click="expand"
        >
          <KbIcon name="forward" :size="13" />
        </button>
        <button
          v-if="!isPage"
          type="button"
          class="btn sm kb-ghost"
          title="收起 (Esc)"
          aria-label="收起"
          @click="isOpen = false"
        >
          <KbIcon name="close" :size="13" />
        </button>
      </div>
    </div>

    <!-- 历史会话 -->
    <AgentSessions
      v-if="showHistory || (isPage && wide)"
      :sessions="sessions"
      :current="sessionId"
      :loading="sessionsLoading"
      :failed="sessionsFailed"
      @retry="loadSessions"
      @select="switchSession"
      @remove="removeSession"
      @create="newSession"
      @rename="renameSession"
      @pin="pinSession"
    />

    <!-- 对话消息列表 -->
    <div ref="scrollRef" class="kb-agent-body">
      <!-- 错误提示 -->
      <div v-if="error" class="kb-agent-error" role="alert" data-testid="assistant-error">
        <KbIcon name="failed" :size="14" />
        <span class="kb-agent-error-text">{{ error }}</span>
        <button v-if="retryAction" type="button" class="btn sm" data-testid="assistant-retry" @click="retryLast">重试</button>
      </div>
      <div v-if="unsandboxed" class="kb-agent-error">未隔离</div>

      <!-- 空白引导态 (Codeg 风格工作台欢迎卡) -->
      <div v-if="!entries.length && !streaming" class="kb-agent-welcome">
        <div class="kb-agent-welcome-icon">
          <KbIcon name="robot" :size="28" />
        </div>
        <div class="kb-agent-welcome-title">AI 助手</div>
        <div class="kb-agent-welcome-desc">用自然语言检索知识库、梳理代码、整理笔记。</div>

        <div class="kb-agent-prompts">
          <button
            type="button"
            class="kb-agent-prompt-card"
            @click="sendPreset('帮我梳理当前项目的架构目录与核心模块职责')"
          >
            <div class="kb-prompt-header">
              <KbIcon name="branch" :size="13" class="kb-prompt-ico" />
              <span class="kb-prompt-txt">梳理当前代码架构与模块职责</span>
            </div>
            <span class="kb-prompt-sub">分析核心目录、模块关系与调用链</span>
          </button>
          <button
            type="button"
            class="kb-agent-prompt-card"
            @click="sendPreset('帮我总结一下最近知识库里新增或更新的内容')"
          >
            <div class="kb-prompt-header">
              <KbIcon name="sparkles" :size="13" class="kb-prompt-ico" />
              <span class="kb-prompt-txt">总结最近新增与更新的笔记</span>
            </div>
            <span class="kb-prompt-sub">检索并聚合近期版本演进与关键文档</span>
          </button>
          <!-- 没有「自动提炼与审核」功能的账号看不到审核收件箱,这张卡片也不给 -->
          <button
            v-if="canReview"
            type="button"
            class="kb-agent-prompt-card"
            data-testid="prompt-review"
            @click="sendPreset('检查审核收件箱里有哪些待处理的条目')"
          >
            <div class="kb-prompt-header">
              <KbIcon name="inbox" :size="13" class="kb-prompt-ico" />
              <span class="kb-prompt-txt">看看审核收件箱里有什么</span>
            </div>
            <span class="kb-prompt-sub">列出等你确认的候选笔记</span>
          </button>
          <button
            v-if="currentContext"
            type="button"
            class="kb-agent-prompt-card is-highlight"
            @click="sendPreset(`${currentContext.prefix}请帮我梳理这里的核心要点`)"
          >
            <div class="kb-prompt-header">
              <KbIcon name="doc" :size="13" class="kb-prompt-ico" />
              <span class="kb-prompt-txt">分析当前页面：{{ currentContext.label }}</span>
            </div>
            <span class="kb-prompt-sub">将当前浏览上下文纳入分析对话</span>
          </button>
        </div>
      </div>

      <!-- 消息气泡流 -->
      <div
        v-for="(entry, index) in entries"
        :key="index"
        class="kb-agent-msg-wrap"
        :class="[`is-${entry.role}`, { 'is-failed': entry.failed }]"
      >
        <!-- 用户消息 -->
        <div v-if="entry.role === 'user'" class="kb-agent-bubble">
          <div class="kb-user-text">{{ entry.text }}</div>
        </div>

        <!-- 助手消息 (Codeg 风格优雅全宽卡片) -->
        <div v-else-if="entry.role === 'assistant'" class="kb-agent-bubble">
          <div class="kb-agent-bubble-head">
            <div class="kb-bubble-meta">
              <span class="kb-agent-avatar sm" :style="{ color: currentModelMeta.color }">
                <BrandLogo :brand="currentModelMeta.brand" />
              </span>
              <span class="kb-bubble-role">AI 助手</span>
            </div>
            <div class="kb-bubble-actions">
              <button
                type="button"
                class="kb-bubble-btn"
                :title="copiedIndex === index ? '已复制' : '复制回复'"
                @click="copyMessage(entry.text, index)"
              >
                <KbIcon :name="copiedIndex === index ? 'check' : 'copy'" :size="12" />
                <span>{{ copiedIndex === index ? '已复制' : '复制' }}</span>
              </button>
              <!-- 正在编辑一篇文档时：把这条回答插到正文光标处（一步撤销），不用复制粘贴 -->
              <button
                v-if="activeDoc.insert && entry.text.trim()"
                type="button"
                class="kb-bubble-btn"
                title="插到正在编辑的文档的光标处"
                data-testid="assistant-insert-doc"
                @click="insertIntoDoc(entry.text)"
              >
                <KbIcon name="plus" :size="12" />
                <span>插入到文档</span>
              </button>
            </div>
          </div>

          <!-- 工具调用时间线 -->
          <div v-if="entry.trace?.length" class="kb-agent-trace-box">
            <button
              type="button"
              class="kb-agent-trace-header"
              :title="traceOpen[index] ? '折叠工具调用记录' : '展开工具调用记录'"
              @click="traceOpen[index] = !traceOpen[index]"
            >
              <span class="kb-trace-left">
                <span class="kb-trace-icon">
                  <KbIcon name="terminal" :size="12" />
                </span>
                <span class="kb-trace-title">已调用 {{ entry.trace.length }} 次工具</span>
                <span class="kb-trace-badge">已完成</span>
              </span>
              <span class="kb-trace-chevron" :class="{ 'is-open': traceOpen[index] }">
                <KbIcon name="chevron" :size="11" />
              </span>
            </button>
            <div v-if="traceOpen[index]" class="kb-agent-trace-flow">
              <div v-for="(t, i) in entry.trace" :key="i" class="kb-agent-trace-step">
                <span class="kb-step-dot"></span>
                <span class="kb-step-cmd mono">{{ t }}</span>
              </div>
            </div>
          </div>

          <!-- 上下文摘要 -->
          <details v-if="entry.summary" class="kb-agent-summary">
            <summary>上下文摘要 (较早对话已压缩)</summary>
            <p class="kb-agent-text">{{ entry.text }}</p>
          </details>

          <!-- Markdown 正文渲染 -->
          <div v-else-if="entry.text" class="kb-agent-text kb-agent-md">
            <MarkdownRead :source="entry.text" />
          </div>

          <!-- 工具结果里的引用 -->
          <AgentRefChips v-if="entry.refs?.length" :refs="entry.refs" />

          <!-- 计划卡片 (带写入/副作用的操作) -->
          <div v-if="entry.cards?.length" class="kb-agent-cards">
            <div v-for="card in entry.cards" :key="card.id" class="kb-agent-card">
              <div class="kb-agent-card-head">
                <span class="tag y">计划卡片</span>
                <span class="mono kb-agent-card-cap">{{ card.capability }}</span>
              </div>
              <div class="kb-agent-card-args">
                <div v-for="(value, key) in card.args" :key="key" class="kb-agent-card-arg">
                  <span class="m">{{ key }}</span>
                  <span class="mono">{{ formatArg(value) }}</span>
                </div>
              </div>
              <details class="kb-agent-card-plan-wrap">
                <summary class="kb-hint">查看执行计划详情</summary>
                <pre class="kb-mono kb-agent-card-plan">{{ JSON.stringify(card.plan, null, 2) }}</pre>
              </details>
              <div class="kb-agent-card-foot">
                <span class="kb-agent-card-note">确认后开启可回滚的独立审计批次</span>
                <KbButton
                  size="sm"
                  variant="primary"
                  :disabled="confirming === card.id"
                  @click="confirmCard(card)"
                >
                  {{ confirming === card.id ? '执行中…' : '确认执行' }}
                </KbButton>
              </div>
            </div>
          </div>
        </div>

        <!-- 系统消息 -->
        <div v-else class="kb-agent-bubble is-system-msg">
          <span class="kb-agent-system-text">{{ entry.text }}</span>
          <AgentRefChips v-if="entry.refs?.length" :refs="entry.refs" />
        </div>
      </div>

      <!-- 实时流式增量打字机 -->
      <div v-if="streaming" class="kb-agent-msg-wrap is-assistant">
        <div class="kb-agent-bubble is-streaming-bubble">
          <div class="kb-agent-bubble-head">
            <div class="kb-bubble-meta">
              <span class="kb-agent-avatar sm">
                <KbIcon name="robot" :size="13" />
              </span>
              <span class="kb-bubble-role">AI 助手</span>
              <span class="kb-streaming-pill">输出中</span>
            </div>
          </div>
          <div class="kb-agent-text kb-agent-md">
            <MarkdownRead :source="streaming" />
            <span class="kb-agent-caret">▊</span>
          </div>
        </div>
      </div>

      <!-- 思考中骨架占位 -->
      <div v-else-if="busy" class="kb-agent-msg-wrap is-assistant">
        <div class="kb-agent-bubble is-loading">
          <div class="kb-agent-loading-dots">
            <span></span><span></span><span></span>
          </div>
          <span class="kb-agent-loading-text">正在调用外部代理并规划步骤…</span>
        </div>
      </div>
    </div>

    <!-- 底部操作与输入栏 (Codeg 风格集成容器) -->
    <div class="kb-agent-foot">
      <!-- 权限确认卡片 -->
      <div v-if="pendingPermission" class="kb-agent-permission">
        <div class="kb-agent-permission-content">
          <KbIcon name="running" :size="14" class="kb-perm-icon" />
          <div class="kb-agent-permission-text">
            代理请求执行工具：<b class="mono">{{ pendingPermission.tool }}</b>
          </div>
        </div>
        <div class="kb-agent-permission-actions">
          <button type="button" class="btn sm pri" @click="respondPermission(true)">允许</button>
          <button type="button" class="btn sm kb-danger-text" @click="respondPermission(false)">拒绝</button>
        </div>
      </div>

      <!-- 排队 / 工作目录:代理真正会撞上的两个限制,发之前和等着的时候都说清楚 -->
      <p v-if="queueHint" class="kb-agent-hint is-queue" role="status" data-testid="assistant-queue">{{ queueHint }}</p>
      <p v-if="workspace" class="kb-agent-hint" :class="`is-${workspace.level}`" :role="workspace.blocked ? 'alert' : undefined" data-testid="assistant-workspace">{{ workspace.text }}</p>

      <!-- 一体化工作台输入框 -->
      <div class="kb-composer">
        <MentionPanel
          v-if="mentionOpen"
          :kinds="mentionKinds"
          :kind="mentionKind"
          :items="mentionItems"
          :active="mentionActive"
          :loading="mentionLoading"
          @tab="setMentionKind"
          @select="onMentionSelect"
        />
        <ChatCommandMenu
          v-if="commandMenuOpen"
          :items="commandItems"
          :active="commandActive"
          @select="onCommandSelect"
        />
        <InsightDialog
          :open="insightOpen"
          :project="currentProject"
          @close="insightOpen = false"
          @saved="insightOpen = false"
        />
        <textarea
          ref="inputRef"
          v-model="draft"
          rows="2"
          class="kb-composer-textarea"
          placeholder="问点什么…(@ 引用 / 命令,Enter 发送)"
          @keydown="handleInputKeydown"
        ></textarea>

        <div class="kb-composer-toolbar">
          <!-- 左侧快捷功能 -->
          <div class="kb-composer-left">
            <input ref="fileInput" type="file" multiple class="kb-agent-file" @change="onFilesPicked" />
            <button
              type="button"
              class="kb-composer-upload-btn"
              title="上传附件/文档到知识库"
              aria-label="上传文件"
              @click="pickFiles"
            >
              <KbIcon name="upload" :size="14" />
            </button>
            <div ref="modelPickerRef" class="kb-model-picker">
              <button
                type="button"
                class="kb-model-trigger"
                :class="{ 'is-open': isModelMenuOpen }"
                :aria-expanded="isModelMenuOpen"
                title="切换模型 / 代理"
                @click.stop="isModelMenuOpen = !isModelMenuOpen"
              >
                <span class="kb-model-brand-icon" :style="{ color: currentModelMeta.color }">
                  <BrandLogo :brand="currentModelMeta.brand" />
                </span>
                <span class="kb-model-name">{{ currentModelMeta.displayName }}</span>
                <KbIcon name="chevron" :size="10" class="kb-model-chevron" :class="{ 'is-open': isModelMenuOpen }" />
              </button>

              <!-- 浮出下拉菜单 -->
              <div v-if="isModelMenuOpen" class="kb-model-popover" @click.stop>
                <div class="kb-model-popover-header">切换模型 / 代理</div>
                <div class="kb-model-list">
                  <button
                    v-for="item in availableModels"
                    :key="item.value"
                    type="button"
                    class="kb-model-item"
                    :class="{ 'is-selected': backend === item.value }"
                    @click="selectModel(item.value)"
                  >
                    <span class="kb-model-brand-icon" :style="{ color: item.meta.color }">
                      <BrandLogo :brand="item.meta.brand" />
                    </span>
                    <span class="kb-model-item-text">{{ item.meta.displayName }}</span>
                    <KbIcon v-if="backend === item.value" name="check" :size="12" class="kb-model-item-check" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="kb-composer-right">
            <span v-if="!isPage" class="kb-composer-shortcut">⌘J 切换</span>
            <button v-if="busy && sessionId" type="button" class="btn sm" @click="stopTurn">停止</button>
            <button
              type="button"
              class="btn sm pri kb-composer-send-btn"
              :disabled="busy || !draft.trim() || !!workspace?.blocked"
              aria-label="发送"
              @click="send"
            >
              <KbIcon name="send" :size="12" />
              <span>{{ busy ? '处理中' : '发送' }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 右侧抽屉:桌面贴在顶栏下方(顶栏上的 AI 按钮始终可点,用来收起),手机全屏盖住标签栏 */
.kb-agent-widget {
  position: fixed;
  right: 0;
  top: var(--topbar-h);
  bottom: 0;
  width: min(520px, 100vw);
  background: var(--surface-1);
  border-left: var(--hl) solid var(--border-default);
  box-shadow: -8px 0 32px rgba(var(--shade), 0.35);
  display: flex;
  flex-direction: column;
  z-index: 25;
  overflow: hidden;
  backdrop-filter: blur(20px);
}

/* 头部栏 */
.kb-agent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: var(--hl) solid var(--b);
  background: var(--surface-2);
  flex: none;
  gap: 8px;
}
.kb-agent-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.kb-agent-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--r2);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  border: var(--hl) solid color-mix(in srgb, var(--accent) 30%, transparent);
  color: var(--ac);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.kb-agent-avatar.sm {
  width: 20px;
  height: 20px;
  border-radius: var(--r1);
}
.kb-agent-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.kb-agent-heading {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-agent-name {
  font-size: calc(13px * var(--fs));
  font-weight: 600;
  color: var(--t);
}
.kb-agent-model-tag {
  font-size: calc(11px * var(--fs));
  color: var(--t2);
  padding: 1px 5px;
  border-radius: var(--r1);
  background: var(--surface-3);
  border: var(--hl) solid var(--b);
}
.kb-agent-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: calc(11px * var(--fs));
  color: var(--m);
}
.kb-status-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--g);
}
.kb-agent-status.is-active .kb-status-indicator {
  background: var(--ac);
  animation: kb-pulse 1.2s infinite ease-in-out;
}
.kb-agent-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.kb-context-pill {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(11px * var(--fs));
  gap: 4px;
}
.kb-context-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 消息流主体 */
.kb-agent-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--surface-1);
}

.kb-agent-error-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.kb-agent-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--r2);
  background: color-mix(in srgb, var(--r) 12%, transparent);
  border: var(--hl) solid var(--r);
  color: var(--r);
  font-size: calc(12px * var(--fs));
}

/* 空白引导状态 */
.kb-agent-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 24px 16px;
  margin: auto 0;
}
.kb-agent-welcome-icon {
  width: 52px;
  height: 52px;
  border-radius: var(--r3);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: var(--hl) solid color-mix(in srgb, var(--accent) 24%, transparent);
  color: var(--ac);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}
.kb-agent-welcome-title {
  font-size: calc(15px * var(--fs));
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--t);
}
.kb-agent-welcome-desc {
  font-size: calc(13px * var(--fs));
  color: var(--m);
  max-width: 360px;
  line-height: 1.55;
  margin-bottom: 22px;
}
.kb-agent-prompts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.kb-agent-prompt-card {
  /* 与全站卡片同一个内边距来源(横 --card-pad-x / 纵 --sp-3),10/14 是这处自己长出来的值 */
  padding: var(--sp-3) var(--card-pad-x);
  border-radius: var(--r2);
  border: var(--hl) solid var(--b2);
  background: var(--surface-2);
  color: var(--t);
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.kb-agent-prompt-card:hover {
  border-color: var(--ac);
  background: var(--surface-3);
  transform: translateY(-1px);
}
.kb-prompt-header {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-prompt-ico {
  color: var(--ac);
  flex: none;
}
.kb-prompt-txt {
  font-size: calc(13px * var(--fs));
  font-weight: 500;
  color: var(--t);
}
.kb-prompt-sub {
  font-size: calc(11px * var(--fs));
  color: var(--m);
  padding-left: 19px;
}
.kb-agent-prompt-card.is-highlight {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
}

/* 消息气泡流 */
.kb-agent-msg-wrap {
  display: flex;
  width: 100%;
}
.kb-agent-msg-wrap.is-user {
  justify-content: flex-end;
}
.kb-agent-msg-wrap.is-assistant {
  justify-content: flex-start;
}
.kb-agent-msg-wrap.is-system {
  justify-content: center;
}

/* 用户气泡 */
.kb-agent-msg-wrap.is-user .kb-agent-bubble {
  max-width: 85%;
  padding: 10px 14px;
  border-radius: var(--r3) var(--r3) var(--r1) var(--r3);
  background: color-mix(in srgb, var(--accent) 18%, var(--surface-2));
  border: var(--hl) solid color-mix(in srgb, var(--accent) 30%, transparent);
  color: var(--t);
  font-size: calc(13px * var(--fs));
  line-height: 1.6;
  word-break: break-word;
  box-shadow: var(--sh1);
}
.kb-user-text {
  white-space: pre-wrap;
}

/* 助手气泡 (Codeg 风格卡片化工作区) */
.kb-agent-msg-wrap.is-assistant .kb-agent-bubble {
  width: 100%;
  max-width: 100%;
  padding: 12px 14px;
  border-radius: var(--r3);
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  color: var(--t);
  box-shadow: var(--sh1);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.kb-agent-bubble-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: var(--hl) solid var(--b);
}
.kb-bubble-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-bubble-role {
  font-size: calc(12px * var(--fs));
  font-weight: 600;
  color: var(--t);
}
.kb-bubble-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.kb-bubble-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: var(--r1);
  border: var(--hl) solid var(--b);
  background: var(--surface-3);
  color: var(--m);
  font-size: calc(11px * var(--fs));
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.kb-bubble-btn:hover {
  color: var(--t);
  border-color: var(--ac);
}

/* 系统消息 */
.kb-agent-bubble.is-system-msg {
  background: var(--surface-2);
  border: var(--hl) solid var(--b);
  border-radius: var(--r2);
  padding: 6px 12px;
  color: var(--m);
  font-size: calc(12px * var(--fs));
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 工具调用时间线 (Codeg 风格活动卡) */
.kb-agent-trace-box {
  border: var(--hl) solid var(--b);
  background: var(--surface-3);
  border-radius: var(--r2);
  overflow: hidden;
}
.kb-agent-trace-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: var(--t2);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.kb-agent-trace-header:hover {
  background: color-mix(in srgb, var(--hover) 40%, transparent);
}
.kb-trace-left {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kb-trace-icon {
  color: var(--ac);
  display: flex;
  align-items: center;
}
.kb-trace-title {
  font-weight: 500;
}
.kb-trace-badge {
  font-size: calc(10px * var(--fs));
  padding: 1px 5px;
  border-radius: var(--r1);
  background: color-mix(in srgb, var(--g) 15%, transparent);
  color: var(--g);
}
.kb-trace-chevron {
  color: var(--m);
  display: flex;
  align-items: center;
  transition: transform var(--dur-fast) var(--ease-out);
}
.kb-trace-chevron.is-open {
  transform: rotate(90deg);
}
.kb-agent-trace-flow {
  padding: 8px 10px;
  border-top: var(--hl) solid var(--b);
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: color-mix(in srgb, var(--surface-sunken, var(--surface-1)) 60%, transparent);
}
.kb-agent-trace-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(11px * var(--fs));
}
.kb-step-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--ac);
  flex: none;
}
.kb-step-cmd {
  color: var(--t2);
  word-break: break-all;
}

/* 计划卡片 */
.kb-agent-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-agent-card {
  padding: 10px 12px;
  border-radius: var(--r2);
  border: var(--hl) solid var(--b2);
  background: var(--surface-3);
}
.kb-agent-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.kb-agent-card-cap {
  font-size: calc(12px * var(--fs));
  color: var(--t2);
}
.kb-agent-card-args {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 6px 0;
}
.kb-agent-card-arg {
  display: flex;
  gap: 8px;
  font-size: calc(12px * var(--fs));
  align-items: baseline;
}
.kb-agent-card-arg .m {
  min-width: 72px;
  flex: none;
}
.kb-agent-card-arg .mono {
  word-break: break-all;
  color: var(--t);
}
.kb-agent-card-plan-wrap summary {
  cursor: pointer;
  font-size: calc(11px * var(--fs));
  color: var(--m);
}
.kb-agent-card-plan {
  margin: 4px 0 8px;
  padding: 6px 8px;
  border-radius: var(--r1);
  background: var(--surface-sunken, var(--surface-1));
  font-size: calc(11px * var(--fs));
  line-height: 1.4;
  max-height: 120px;
  overflow: auto;
  user-select: text;
}
.kb-agent-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.kb-agent-card-note {
  font-size: calc(11px * var(--fs));
  color: var(--m);
}

/* 上下文摘要折叠 */
.kb-agent-summary summary {
  cursor: pointer;
  font-size: calc(12px * var(--fs));
  color: var(--t2);
}
.kb-agent-summary p {
  margin: var(--gap-xs) 0 0;
  white-space: pre-wrap;
}

/* Markdown 深度美化 */
.kb-agent-md {
  overflow-x: auto;
}
.kb-agent-md :deep(.kb-md-read) {
  /* 聊天气泡里的正文比笔记页小一号；标题等级按 em 跟着缩 */
  --prose-size: calc(13px * var(--fs));
}
.kb-agent-md :deep(.kb-md-read-body) {
  line-height: 1.7;
}
.kb-agent-md :deep(.kb-md-read-body h1),
.kb-agent-md :deep(.kb-md-read-body h2),
.kb-agent-md :deep(.kb-md-read-body h3) {
  font-size: 1.15em;
  margin-top: 0.9em;
}
.kb-agent-md :deep(p) {
  margin: 0.5em 0 !important;
}
.kb-agent-md :deep(p:first-child) {
  margin-top: 0 !important;
}
.kb-agent-md :deep(p:last-child) {
  margin-bottom: 0 !important;
}
.kb-agent-md :deep(ul),
.kb-agent-md :deep(ol) {
  padding-left: 1.35em !important;
  margin: 0.5em 0 !important;
}
.kb-agent-md :deep(li) {
  margin: 0.25em 0 !important;
}
.kb-agent-md :deep(code) {
  font-family: var(--mono, monospace) !important;
  font-size: 0.88em !important;
  padding: 2px 5px !important;
  border-radius: var(--r1) !important;
  background: var(--surface-3) !important;
  border: var(--hl) solid var(--b) !important;
  color: var(--t) !important;
}
.kb-agent-md :deep(pre) {
  border-radius: var(--r2) !important;
  border: var(--hl) solid var(--b2) !important;
  background: var(--surface-sunken, var(--surface-1)) !important;
  margin: 0.75em 0 !important;
  padding: 10px 12px !important;
}
.kb-agent-md :deep(pre code) {
  padding: 0 !important;
  background: transparent !important;
  border: none !important;
}
.kb-agent-md :deep(blockquote) {
  margin: 0.6em 0 !important;
  padding: 4px 12px !important;
  border-left: 3px solid var(--ac) !important;
  color: var(--t2) !important;
  background: color-mix(in srgb, var(--accent) 6%, transparent) !important;
  border-radius: 0 var(--r1) var(--r1) 0 !important;
}
.kb-agent-md :deep(table) {
  width: 100% !important;
  border-collapse: collapse !important;
  margin: 0.75em 0 !important;
  font-size: calc(12px * var(--fs)) !important;
}
.kb-agent-md :deep(th),
.kb-agent-md :deep(td) {
  border: var(--hl) solid var(--b2) !important;
  padding: 6px 10px !important;
}
.kb-agent-md :deep(th) {
  background: var(--surface-3) !important;
}

/* 流式打字与光标 */
.kb-streaming-pill {
  font-size: calc(11px * var(--fs));
  padding: 1px 6px;
  border-radius: var(--r1);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--ac);
  font-weight: 500;
}
.kb-agent-caret {
  display: inline-block;
  margin-left: 3px;
  color: var(--ac);
  animation: kb-blink 0.9s infinite step-start;
}
@keyframes kb-blink {
  50% { opacity: 0; }
}

/* 思考加载动画 */
.kb-agent-bubble.is-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}
.kb-agent-loading-dots {
  display: flex;
  gap: 4px;
}
.kb-agent-loading-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ac);
  animation: kb-dots 1.2s infinite ease-in-out;
}
.kb-agent-loading-dots span:nth-child(2) { animation-delay: 0.2s; }
.kb-agent-loading-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes kb-dots {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1.1); opacity: 1; }
}
.kb-agent-loading-text {
  font-size: calc(12px * var(--fs));
  color: var(--m);
}

/* 底部操作与输入区 (Codeg 风格一体化 Composer) */
.kb-agent-foot {
  padding: 10px 14px 12px;
  border-top: var(--hl) solid var(--b);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: none;
}
.kb-brand-svg {
  width: 15px;
  height: 15px;
  display: block;
  flex-shrink: 0;
}
.kb-composer-upload-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--r2);
  border: var(--hl) solid var(--b2);
  background: var(--surface-3);
  color: var(--t2);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}
.kb-composer-upload-btn:hover {
  background: var(--surface-3);
  border-color: var(--accent);
  color: var(--accent);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.kb-composer-upload-btn:active {
  transform: scale(0.96);
}

/* 模型图标 + 名字选择器 (Codeg 风格) */
.kb-model-picker {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.kb-model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 10px 0 8px;
  border-radius: var(--r2);
  border: var(--hl) solid var(--b2);
  background: var(--surface-3);
  color: var(--text-primary);
  font-size: calc(12px * var(--fs));
  font-weight: 500;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
  user-select: none;
}
.kb-model-trigger:hover {
  background: var(--surface-3);
  border-color: var(--b);
  color: var(--t);
}
.kb-model-trigger.is-open {
  border-color: var(--accent);
  box-shadow: var(--accent-ring);
  background: var(--surface-3);
}
.kb-model-brand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.kb-model-name {
  font-size: calc(12px * var(--fs));
  line-height: 1;
  color: var(--t);
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kb-model-chevron {
  color: var(--text-tertiary);
  margin-left: 2px;
  transition: transform var(--dur-fast) var(--ease-out);
}
.kb-model-chevron.is-open {
  transform: rotate(180deg);
}

/* 模型下拉浮出菜单 */
.kb-model-popover {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 175px;
  max-width: 260px;
  background: var(--surface-2);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r3);
  box-shadow: var(--sh3);
  padding: 6px;
  z-index: 50;
  backdrop-filter: blur(16px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  animation: kb-pop-in var(--dur-fast) var(--ease-out);
}
@keyframes kb-pop-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.kb-model-popover-header {
  font-size: calc(11px * var(--fs));
  color: var(--text-tertiary);
  padding: 4px 8px 6px;
  border-bottom: var(--hl) solid var(--b);
  margin-bottom: 2px;
  font-weight: 500;
}
.kb-model-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}
.kb-model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--r2);
  border: none;
  background: transparent;
  color: var(--t2);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: all var(--dur-fast) var(--ease-out);
}
.kb-model-item:hover {
  background: var(--surface-3);
  color: var(--t);
}
.kb-model-item.is-selected {
  background: var(--surface-3);
  color: var(--accent);
  font-weight: 500;
}
.kb-model-item-text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kb-model-item-check {
  margin-left: auto;
  color: var(--accent);
}

/* 权限提示条 */
.kb-agent-permission {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-sm);
  padding: 8px 10px;
  border: var(--hl) solid color-mix(in srgb, var(--status-warning) 45%, transparent);
  border-radius: var(--r2);
  background: color-mix(in srgb, var(--status-warning) 10%, transparent);
}
.kb-agent-permission-content {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.kb-perm-icon {
  color: var(--status-warning);
  flex: none;
}
.kb-agent-permission-text {
  font-size: calc(12px * var(--fs));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-agent-permission-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

/* 一体化工作台输入框 */
.kb-composer {
  position: relative;
  display: flex;
  flex-direction: column;
  border: var(--hl) solid var(--b2);
  border-radius: var(--r3);
  background: var(--surface-1);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.kb-composer:focus-within {
  border-color: var(--ac);
  box-shadow: var(--ring);
}
.kb-composer-textarea {
  width: 100%;
  min-height: 48px;
  max-height: 140px;
  padding: 10px 12px 4px;
  border: none;
  background: transparent;
  color: var(--t);
  font-family: inherit;
  font-size: calc(13px * var(--fs));
  line-height: 1.5;
  resize: none;
  outline: none;
}
.kb-composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 8px;
  gap: 8px;
}
.kb-composer-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.kb-composer-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.kb-composer-shortcut {
  font-size: calc(11px * var(--fs));
  color: var(--m);
  user-select: none;
}
.kb-composer-send-btn {
  height: 32px;
  padding: 0 12px;
  gap: 5px;
  border-radius: var(--r2);
}
/* 触屏:同一行左边的上传按钮、模型选择都是 44px 高,发送按钮也做成 44px,不再低一截 */
@media (pointer: coarse) {
  .kb-composer-send-btn {
    height: 44px;
    min-height: 44px;
  }
}
.kb-agent-file {
  display: none;
}

@media (max-width: 599px) {
  .kb-agent-widget {
    inset: 0;
    width: 100vw;
    border-left: 0;
    z-index: 41;
    padding-top: var(--safe-top);
  }
}
/* 触屏上头部的图标按钮(历史 / 新会话 / 全屏 / 收起)至少 44px 见方,不然手指点不准 */
@media (pointer: coarse) {
  .kb-agent-actions .btn { min-width: 44px; min-height: 44px; justify-content: center; }
  /* 输入框下面的「上传文件」和模型选择:桌面上 32px 够用,手指点不准,同样撑到 44px */
  .kb-composer-upload-btn { width: 44px; height: 44px; }
  .kb-model-trigger { min-height: 44px; }
}

/* 排队 / 工作目录提示 */
.kb-agent-hint { margin: 0 0 var(--sp-2); font-size: var(--text-12); color: var(--text-tertiary); overflow-wrap: anywhere; }
.kb-agent-hint.is-queue { color: var(--accent-text); }
.kb-agent-hint.is-warn { color: var(--status-warning-text); }
.kb-agent-hint.is-over { color: var(--status-danger-text); }

/* 600–839 的竖屏小平板同样用底部标签栏:抽屉直接铺满 */
@media (min-width: 600px) and (max-width: 839px) and (orientation: portrait) {
  .kb-agent-widget { inset: 0; width: 100vw; border-left: 0; z-index: 41; }
}

/* ---- 独立页面模式:铺满内容区,不是浮层;宽屏左边常驻会话列表 ----
   放在最后:要盖过上面手机「抽屉铺满全屏」的 fixed 定位(页面模式在外壳里,标签栏要留着) */
.kb-agent-widget.is-page {
  position: relative;
  inset: auto;
  top: auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  border-left: 0;
  box-shadow: none;
  backdrop-filter: none;
  z-index: auto;
  padding-top: 0;
  background: var(--bg-canvas);
}
@media (min-width: 840px) {
  .kb-agent-widget.is-page {
    display: grid;
    grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas: 'side head' 'side body' 'side foot';
  }
  .kb-agent-widget.is-page > .kb-agent-sessions { grid-area: side; border-right: var(--hl) solid var(--b); max-height: none; overflow: auto; }
  .kb-agent-widget.is-page > .kb-agent-head { grid-area: head; }
  .kb-agent-widget.is-page > .kb-agent-body { grid-area: body; min-height: 0; }
  .kb-agent-widget.is-page > .kb-agent-foot { grid-area: foot; }
  /* 宽屏上正文别拉成一整行:对话限制在易读的宽度,居中 */
  .kb-agent-widget.is-page > .kb-agent-body > *,
  .kb-agent-widget.is-page > .kb-agent-foot > * { width: 100%; max-width: 52rem; margin-left: auto; margin-right: auto; box-sizing: border-box; }
}
</style>
