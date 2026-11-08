// AI 助手(同一个组件的两种用法):抽屉 / 独立页面、会话接续、排队提示、代理工作目录占用与满了拦住。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
const route = reactive<{ path: string; query: Record<string, string> }>({ path: '/home', query: {} })
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push, replace: vi.fn() }) }))
// 抓住组件订阅的 WebSocket 回调,测试里手动推事件
let pushLive: (event: { type: string; data: Record<string, unknown> }) => void = () => undefined
vi.mock('@/composables/useLiveEvents', () => ({
  subscribeLive: (listener: typeof pushLive) => {
    pushLive = listener
    return () => undefined
  },
  useLiveEvents: () => () => undefined,
}))
// 回答用的 Markdown 渲染器很重(异步加载),这里换成只输出原文的替身;用 render 函数,模板字符串在异步组件里渲染不出来
vi.mock('@/components/MarkdownRead.vue', async () => {
  const { defineComponent, h } = await import('vue')
  // __esModule:异步组件只有看到它才会取 .default,否则把整个模块对象当组件渲染
  return { __esModule: true, default: defineComponent({ props: { source: { type: String, default: '' } }, setup: (props) => () => h('div', { class: 'md' }, props.source) }) }
})

import { usePanelsStore } from '@/stores/panels'
import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import AssistantDrawer from './AssistantDrawer.vue'
import { useActiveDocStore } from '@/stores/activeDoc'

const MB = 1024 * 1024
let replies: Record<string, unknown> = {}
let chatResolve: ((value: unknown) => void) | null = null
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    // 默认当受限账号写(服务端会对它拦工作目录超限);不受限的主知识库账号见下面专门的用例
    acp_agents: { agents: [{ id: 'deepseek', name: 'DeepSeek', available: true }], default: 'deepseek', workspace_mb: 512, workspace_enforced: true },
    agent_sessions: { sessions: [{ session_id: 's_old', title: '上次的对话', updated_at: 1, pinned: false }] },
    agent_history: { messages: [{ role: 'user', content_json: JSON.stringify({ text: '以前问过的' }) }] },
    usage_mine: { storage: { sources_bytes: 0, uploads_bytes: 0, vectors_bytes: 0, meta_bytes: 0, workspace_bytes: 100 * MB, total_bytes: 100 * MB, limit_bytes: 0 }, ai: { day: 'd', tokens_today: 0, limit: 0 } },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string) => {
    if (name === 'acp_chat') return new Promise((resolve) => (chatResolve = resolve))
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)

let wrapper: VueWrapper | null = null
async function open(mode: 'drawer' | 'page', options: { path?: string } = {}) {
  route.path = options.path ?? (mode === 'page' ? '/assistant' : '/home')
  if (mode === 'drawer') usePanelsStore().toggleAssistant(true)
  wrapper = mount(AssistantDrawer, { props: { mode }, attachTo: document.body })
  await flushPromises()
  await flushPromises()
}
async function say(text: string) {
  const area = wrapper!.find('textarea')
  await area.setValue(text)
  await wrapper!.find('[aria-label=发送]').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  localStorage.clear()
  callCapability.mockReset()
  push.mockClear()
  chatResolve = null
  window.matchMedia = ((query: string) => ({ matches: query === '(min-width: 840px)', media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  setActivePinia(createPinia())
  backend()
})

describe('两种用法', () => {
  it('抽屉:是对话框,有「全屏打开」和「收起」', async () => {
    await open('drawer')
    const root = $('[data-testid=assistant-drawer]')!
    expect(root.getAttribute('role')).toBe('dialog')
    expect($('[data-testid=assistant-expand]')).not.toBeNull()
    expect($('[aria-label=收起]')).not.toBeNull()
  })

  it('页面:不是对话框,没有收起 / 全屏按钮,宽屏左边常驻会话列表(不用点按钮)', async () => {
    await open('page')
    const root = $('[data-testid=assistant-page]')!
    expect(root.getAttribute('role')).toBeNull()
    expect(root.classList.contains('is-page')).toBe(true)
    expect($('[data-testid=assistant-expand]')).toBeNull()
    expect($('[aria-label=收起]')).toBeNull()
    expect($('.kb-agent-sessions')).not.toBeNull()
    expect($('[aria-label=历史会话]')).toBeNull()
    expect(calls('agent_sessions')).toHaveLength(1)
  })

  it('页面在窄屏:会话列表折起来,点按钮才展开', async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    await open('page')
    expect($('.kb-agent-sessions')).toBeNull()
    await wrapper!.find('[aria-label=历史会话]').trigger('click')
    expect($('.kb-agent-sessions')).not.toBeNull()
  })

  it('抽屉在 /assistant 页面上不出现(页面本身就是助手,不开两个同一会话的对话框)', async () => {
    await open('drawer', { path: '/assistant' })
    expect($('[data-testid=assistant-drawer]')).toBeNull()
  })

  it('「全屏打开」:收起抽屉并去 /assistant;正在回答时不能切', async () => {
    await open('drawer')
    await say('你好')
    expect(($('[data-testid=assistant-expand]') as HTMLButtonElement).disabled).toBe(true)
    chatResolve!({ session_id: 's1', text: '好', trace: [], stop_reason: 'end' })
    await flushPromises()
    await wrapper!.find('[data-testid=assistant-expand]').trigger('click')
    expect(push).toHaveBeenCalledWith('/assistant')
    expect(usePanelsStore().assistantOpen).toBe(false)
  })

  it('⌘J / Esc 只归抽屉:页面模式不响应(否则一次按键两边各处理一遍)', async () => {
    await open('page')
    const panels = usePanelsStore()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }))
    expect(panels.assistantOpen).toBe(false)
  })
})

describe('会话接续', () => {
  it('打开时接上本机记着的会话,读它的历史', async () => {
    localStorage.setItem('kb.agent.session', 's_old')
    await open('page')
    expect(calls('agent_history')[0]![1]).toEqual({ session_id: 's_old' })
    expect(document.body.textContent).toContain('以前问过的')
  })

  it('抽屉再次打开时,如果别处(独立页面)换了会话,接上新的那个', async () => {
    localStorage.setItem('kb.agent.session', 's_old')
    await open('drawer')
    const panels = usePanelsStore()
    panels.toggleAssistant(false)
    await flushPromises()
    localStorage.setItem('kb.agent.session', 's_new')
    panels.toggleAssistant(true)
    await flushPromises()
    expect(calls('agent_history').map((call) => (call[1] as { session_id: string }).session_id)).toEqual(['s_old', 's_new'])
  })
})

describe('排队', () => {
  it('名额满了:显示前面还有几个人;开始出内容就消失', async () => {
    await open('page')
    await say('帮我看看')
    pushLive({ type: 'acp.queued', data: { session_id: 's1', ahead: 2 } })
    await flushPromises()
    expect($('[data-testid=assistant-queue]')!.textContent).toBe('排队中:前面还有 2 个人,轮到你会自动开始')
    pushLive({ type: 'acp.update', data: { session_id: 's1', kind: 'text', text: '开始了' } })
    await flushPromises()
    expect($('[data-testid=assistant-queue]')).toBeNull()
  })

  it('这一轮结束后排队提示也清掉;别的会话的排队事件不显示', async () => {
    await open('page')
    await say('一')
    chatResolve!({ session_id: 's1', text: '好', trace: [], stop_reason: 'end' })
    await flushPromises()
    await say('二')
    pushLive({ type: 'acp.queued', data: { session_id: 'someone_else', ahead: 5 } })
    await flushPromises()
    expect($('[data-testid=assistant-queue]')).toBeNull()
    pushLive({ type: 'acp.queued', data: { session_id: 's1', ahead: 1 } })
    await flushPromises()
    expect($('[data-testid=assistant-queue]')).not.toBeNull()
    chatResolve!({ session_id: 's1', text: '好', trace: [], stop_reason: 'end' })
    await flushPromises()
    expect($('[data-testid=assistant-queue]')).toBeNull()
  })

  it('没在等回答时收到的排队事件不理', async () => {
    await open('page')
    pushLive({ type: 'acp.queued', data: { ahead: 3 } })
    await flushPromises()
    expect($('[data-testid=assistant-queue]')).toBeNull()
  })
})

describe('代理工作目录', () => {
  it('显示已用 / 上限(上限来自 acp_agents.workspace_mb)', async () => {
    await open('page')
    expect($('[data-testid=assistant-workspace]')!.textContent).toBe('代理工作目录已用 100 MB / 上限 512 MB')
  })

  it('满了:说明原因,发送按钮置灰,也不会发出 acp_chat', async () => {
    backend({ usage_mine: { storage: { workspace_bytes: 600 * MB }, ai: {} } })
    await open('page')
    const hint = $('[data-testid=assistant-workspace]')!
    expect(hint.textContent).toContain('满了')
    expect(hint.getAttribute('role')).toBe('alert')
    await wrapper!.find('textarea').setValue('还想问')
    expect(($('[aria-label=发送]') as HTMLButtonElement).disabled).toBe(true)
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(calls('acp_chat')).toHaveLength(0)
  })

  it('服务端不对这个账号拦(主知识库账号,workspace_enforced: false):超了也不置灰、不写上限,照常发', async () => {
    backend({
      acp_agents: { agents: [{ id: 'deepseek', name: 'DeepSeek', available: true }], default: 'deepseek', workspace_mb: 512, workspace_enforced: false },
      usage_mine: { storage: { workspace_bytes: 600 * MB }, ai: {} },
    })
    await open('page')
    const hint = $('[data-testid=assistant-workspace]')!
    expect(hint.textContent).toBe('代理工作目录已用 600 MB')
    expect(hint.getAttribute('role')).toBeNull()
    await say('你好')
    expect(calls('acp_chat')).toHaveLength(1)
  })

  it('老守护进程没有 workspace_enforced 字段:不确定就不拦', async () => {
    backend({
      acp_agents: { agents: [{ id: 'deepseek', name: 'DeepSeek', available: true }], default: 'deepseek', workspace_mb: 512 },
      usage_mine: { storage: { workspace_bytes: 600 * MB }, ai: {} },
    })
    await open('page')
    await say('你好')
    expect(calls('acp_chat')).toHaveLength(1)
  })

  it('后端没给上限(老版本) / 取不到占用:不显示,不挡对话', async () => {
    backend({ acp_agents: { agents: [{ id: 'deepseek', name: 'DeepSeek', available: true }], default: 'deepseek' } })
    await open('page')
    expect($('[data-testid=assistant-workspace]')).toBeNull()
    await say('你好')
    expect(calls('acp_chat')).toHaveLength(1)
  })

  it('每一轮结束后重新量一次占用(代理可能刚写了文件)', async () => {
    await open('page')
    const before = calls('usage_mine').length
    await say('写个文件')
    chatResolve!({ session_id: 's1', text: '写好了', trace: [], stop_reason: 'end' })
    await flushPromises()
    expect(calls('usage_mine').length).toBe(before + 1)
  })
})

describe('输入法组字', () => {
  const press = (target: Element, key: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
    target.dispatchEvent(event)
    return event
  }

  it('@ 面板打开时,组字中的 Esc / 回车 / ↑↓ 归输入法:面板不关、不选中、不发送、不拦截按键,抽屉也不收起', async () => {
    await open('drawer')
    const area = wrapper!.find('textarea')
    await area.setValue('@')
    await flushPromises()
    expect($('.kb-mention-panel')).not.toBeNull()
    for (const key of ['Escape', 'Enter', 'ArrowDown', 'ArrowUp']) {
      // 标准写法 isComposing,以及 Safari 上屏回车那种 isComposing 已是 false、keyCode 仍是 229 的
      expect(press(area.element, key, { isComposing: true }).defaultPrevented).toBe(false)
      expect(press(area.element, key, { keyCode: 229 }).defaultPrevented).toBe(false)
      await flushPromises()
      // Vue 的 DOM 更新是异步的,每个键之后都等一下再看,才不会把「还没更新」当成「没关」
      expect($('.kb-mention-panel'), `组字中的 ${key} 把 @ 面板关掉了`).not.toBeNull()
    }
    expect($('[role=dialog]'), '组字中的 Esc 把整个抽屉收起来了').not.toBeNull()
    expect(document.body.textContent).not.toContain('已切换到代理')
    expect(calls('acp_chat')).toHaveLength(0)
  })

  it('组字结束后:回车选中当前项,Esc 关闭面板', async () => {
    await open('page')
    const area = wrapper!.find('textarea')
    await area.setValue('@')
    await flushPromises()
    expect(press(area.element, 'Enter').defaultPrevented).toBe(true)
    await flushPromises()
    expect(document.body.textContent).toContain('已切换到代理')
    await area.setValue('')
    await area.setValue('@')
    await flushPromises()
    expect($('.kb-mention-panel')).not.toBeNull()
    expect(press(area.element, 'Escape').defaultPrevented).toBe(true)
    await flushPromises()
    expect($('.kb-mention-panel')).toBeNull()
  })

  it('没有任何面板时,组字中的回车不发送;组字结束后的回车才发送', async () => {
    await open('drawer')
    const area = wrapper!.find('textarea')
    await area.setValue('你好')
    press(area.element, 'Enter', { isComposing: true })
    await flushPromises()
    expect(calls('acp_chat')).toHaveLength(0)
    press(area.element, 'Enter')
    await flushPromises()
    expect(calls('acp_chat')).toHaveLength(1)
  })
})

describe('读取失败与出错重试', () => {
  const errorText = () => $('[data-testid=assistant-error]')?.textContent?.replace(/\s+/g, ' ') ?? ''
  const retry = () => $<HTMLButtonElement>('[data-testid=assistant-retry]')!
  /** 在默认假后端上让 acp_chat 失败 */
  function chatFails(error: Error) {
    const base = callCapability.getMockImplementation()!
    callCapability.mockImplementation(async (name: string, ...rest: unknown[]) => {
      if (name === 'acp_chat') throw error
      return base(name, ...rest)
    })
  }

  it('这一轮对话失败:说"发生了什么 + 怎么办",不露英文异常;重试再问一次,不会多出一条用户消息', async () => {
    await open('drawer')
    chatFails(new CapabilityError('internal: boom', 'internal', 500))
    await say('帮我整理一下')
    expect(errorText()).toContain('这一轮对话失败')
    expect(errorText()).toContain('请')
    expect(errorText()).not.toContain('boom')
    expect($('[data-testid=assistant-error]')!.getAttribute('role')).toBe('alert')
    expect(calls('acp_chat')).toHaveLength(1)
    retry().click()
    await flushPromises()
    expect(calls('acp_chat')).toHaveLength(2)
    expect(document.body.textContent!.split('帮我整理一下').length - 1).toBe(1)
  })

  it('代理没登录:给管理员能照着做的话,不露英文原文', async () => {
    await open('drawer')
    chatFails(new CapabilityError('auth required: please login', 'internal', 500))
    await say('你好')
    expect(errorText()).toContain('还没有登录')
    expect(errorText()).not.toContain('auth required')
  })

  it('读取可用代理失败(不是没有代理):提示"没能读取"并给重试,重试读通后提示消失', async () => {
    backend({ acp_agents: new CapabilityError('boom', 'internal', 500) })
    await open('drawer')
    await say('你好')
    expect(errorText()).toContain('没能读取可用的代理')
    expect(errorText()).not.toContain('还没有可用的 ACP 代理')
    expect(calls('acp_chat')).toHaveLength(0)
    backend()
    retry().click()
    await flushPromises()
    expect($('[data-testid=assistant-error]')).toBeNull()
    expect(calls('acp_agents').length).toBe(2)
  })

  it('读取可用代理重试仍失败:再次提示,不当成成功', async () => {
    backend({ acp_agents: new CapabilityError('boom', 'internal', 500) })
    await open('drawer')
    await say('你好')
    retry().click()
    await flushPromises()
    expect(errorText()).toContain('没能读取可用的代理')
  })

  it('真的没有可用代理:仍写"还没有可用的代理",不给重试', async () => {
    backend({ acp_agents: { agents: [], workspace_mb: 512 } })
    await open('drawer')
    await say('你好')
    expect(errorText()).toContain('还没有可用的 ACP 代理')
    expect($('[data-testid=assistant-retry]')).toBeNull()
  })

  it('打开时读不到上次的会话记录:说清楚并给重试,重试读通后恢复内容(以前悄悄留一个空对话)', async () => {
    localStorage.setItem('kb.agent.session', 's_old')
    backend({ agent_history: new CapabilityError('boom', 'internal', 500) })
    await open('drawer')
    expect(errorText()).toContain('读取这个会话失败')
    expect(errorText()).not.toContain('boom')
    backend()
    retry().click()
    await flushPromises()
    expect($('[data-testid=assistant-error]')).toBeNull()
    expect(document.body.textContent).toContain('以前问过的')
  })

  it('点历史会话读取失败:同样有重试', async () => {
    await open('page')
    backend({ agent_history: new CapabilityError('boom', 'internal', 500) })
    await wrapper!.find('.kb-agent-session').trigger('click')
    await flushPromises()
    expect(errorText()).toContain('读取这个会话失败')
    backend()
    retry().click()
    await flushPromises()
    expect($('[data-testid=assistant-error]')).toBeNull()
  })

  it('历史会话列表读取失败:写"没能读取历史会话"并给重试,不是"还没有历史会话";重试后恢复', async () => {
    backend({ agent_sessions: new CapabilityError('boom', 'internal', 500) })
    await open('page')
    expect($('[data-testid=sessions-error]')!.textContent).toContain('没能读取历史会话')
    expect(document.body.textContent).not.toContain('还没有历史会话')
    backend()
    $<HTMLButtonElement>('[data-testid=sessions-retry]')!.click()
    await flushPromises()
    expect($('[data-testid=sessions-error]')).toBeNull()
    expect(document.body.textContent).toContain('上次的对话')
  })

  it('历史会话列表读取中是骨架屏,不是一行"读取中…"', async () => {
    const base = callCapability.getMockImplementation()!
    callCapability.mockImplementation((name: string, ...rest: unknown[]) => (name === 'agent_sessions' ? new Promise(() => undefined) : base(name, ...rest)))
    await open('page')
    expect($('[data-testid=sessions-loading]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('读取中')
  })
})

describe('欢迎卡', () => {
  it('文案用术语表里的说法:叫「AI 助手」(不叫"管家"),不露 ACP / 工具链 / 条目', async () => {
    await open('drawer')
    const welcome = $('.kb-agent-welcome')!.textContent!.replace(/\s+/g, ' ')
    expect(welcome).toContain('AI 助手')
    for (const word of ['管家', 'ACP', '工具链', '条目']) expect(welcome, word).not.toContain(word)
    expect(welcome).toContain('总结最近新增与更新的笔记')
  })

  it('有「自动提炼与审核」功能:有"看看审核收件箱里有什么"这张卡,点了发出预设问题', async () => {
    const session = useSessionStore()
    session.features = new Set(['ai.assistant', 'ai.extract'])
    session.loaded = true
    await open('drawer')
    const card = $<HTMLButtonElement>('[data-testid=prompt-review]')!
    expect(card.textContent).toContain('看看审核收件箱里有什么')
    card.click()
    await flushPromises()
    expect(calls('acp_chat')[0]![1]).toMatchObject({ text: expect.stringContaining('审核收件箱') })
  })

  it('没有该功能点(角色没勾自动提炼与审核):不给这张卡,别的卡照常', async () => {
    const session = useSessionStore()
    session.features = new Set(['ai.assistant', 'docs.notes'])
    session.loaded = true
    await open('drawer')
    expect($('[data-testid=prompt-review]')).toBeNull()
    expect($('.kb-agent-welcome')!.textContent).toContain('总结最近新增与更新的笔记')
  })
})

describe('当前文档（UI-3）', () => {
  it('知识库页打开着一篇笔记：显示标题而不是编号，提问时附上可读引用', async () => {
    route.query = { collection: 'kb', item: 'ins_8f21' }
    useActiveDocStore().register({ noteId: 'ins_8f21', title: '部署[清单]' }, null)
    await open('drawer', { path: '/kb' })
    const pill = $('.kb-context-pill')!
    expect(pill.textContent).toContain('当前文档：部署［清单］')
    expect(pill.textContent).not.toContain('ins_8f21')
    pill.click()
    await flushPromises()
    expect(wrapper!.find('textarea').element.value).toBe('针对 @[部署［清单］](kb://item/ins_8f21) ：')
    route.query = {}
  })

  it('正在编辑文档时，回答上有「插入到文档」，点了把回答原文插进去；不在编辑时没有这个按钮', async () => {
    const insert = vi.fn(async () => true)
    const store = useActiveDocStore()
    const unregister = store.register({ noteId: 'ins_1', title: '笔记' }, insert)
    await open('drawer')
    await say('帮我写一段')
    chatResolve!({ session_id: 's1', text: '## 小结\n\n- 第一点', trace: [], stop_reason: 'end' })
    await flushPromises()
    const button = $('[data-testid=assistant-insert-doc]')!
    expect(button).not.toBeNull()
    button.click()
    await flushPromises()
    expect(insert).toHaveBeenCalledWith('## 小结\n\n- 第一点')
    unregister()
    await flushPromises()
    expect($('[data-testid=assistant-insert-doc]')).toBeNull()
  })
})
