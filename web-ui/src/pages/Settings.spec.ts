// 系统设置页:四种状态(加载 / 报错重试 / 无权限 / 就绪)、分区导航(含 AI 关闭时分区隐藏、旧链接)、
// 字段表驱动的卡片(中文标签 + 帮助文字 + 配置键 + 需要重启标记)、改值 → 保存 / 校验报错 / 保存失败重试。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, reactive } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const route = reactive<{ path: string; query: Record<string, string> }>({ path: '/admin/settings', query: {} })
const replace = vi.fn(async (to: unknown) => {
  if (typeof to === 'object' && to && 'query' in to) route.query = { ...(to as { query: Record<string, string> }).query }
})
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace }),
  onBeforeRouteLeave: vi.fn(),
  RouterLink: defineComponent({
    props: { to: { type: String, default: '' } },
    setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  }),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: vi.fn() }))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import Settings from './Settings.vue'

const CONFIG = {
  server: { listen: '127.0.0.1:7878', allow_remote: false },
  embed: { backend: 'fastembed', model: 'bge-m3-int8', max_tokens: 512, batch_size: 8, preload: true },
  search: { k: 8, global_weight: 0.8, rrf_k: 60, window_context_lines: 8, collection_weights: { proj_a: 1.2 } },
  index: { watch: true, debounce_ms: 2000, max_file_bytes: 204800 },
  meta: { read_pool: 4 },
  schedule: { nightly_at: '03:00', optimize_interval_minutes: 60 },
  backup: { enabled: true, interval_hours: 24, keep_count: 7, keep_days: 0, include_sources: false, mirror_dirs: [] as string[] },
  llm: { provider: 'deepseek', base_url: 'https://api.deepseek.com', extract_model: 'deepseek-flash', review_model: 'deepseek-v4-pro', agent_model: 'deepseek-v4-pro', daily_token_budget: 2000000, max_calls_per_hour: 60 },
  evolution: { extract_enabled_default: false, dedup_similarity: 0.92 },
  extract: { ocr_enabled: false, ocr_model_size: 'small', ocr_language: 'chi_sim+eng', transcribe_enabled: false, max_media_seconds: 1800 },
  mcp: { transports: ['stdio'] },
}
const BACKUP_STATUS = {
  home: '/home/kb/.kb',
  dir: '/home/kb/.kb/backups',
  last_backup_at: null,
  policy: { enabled: true, interval_hours: 24, keep_count: 7, keep_days: 0, include_sources: false, mirror_dirs: [] },
  next_backup_at: null,
  last_auto: null,
  progress: null,
  alert: null,
  failures: [],
  mirrors: [],
  last_check: null,
  usage: { meta_db_bytes: 1, lance_bytes: 1, sources_bytes: 1, uploads_bytes: 0, skills_bytes: 1, eval_bytes: 1, config_bytes: 1, backups_bytes: 0 },
  entries: [],
  notes: [],
}

/** 假后端的「配置文件」:update_config 真的把补丁合并进去,get_config 每次返回一份新拷贝(和真后端一样,重新读到的是新对象)。 */
let saved: Record<string, Record<string, unknown>> = structuredClone(CONFIG)
function mergePatch(patch: Record<string, Record<string, unknown>>) {
  for (const [section, keys] of Object.entries(patch)) saved[section] = { ...saved[section], ...keys }
}

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  saved = structuredClone(CONFIG)
  replies = {
    get_config: () => structuredClone(saved),
    update_config: (args: { patch: Record<string, Record<string, unknown>> }) => {
      mergePatch(args.patch)
      return { applied: true, restart_required: false, changed: Object.keys(args.patch), migration_plan: null, notes: [] }
    },
    backup_status: BACKUP_STATUS,
    list_skills: { dir: '/home/kb/.kb/skills', allow_exec: false, skills: [], warnings: [] },
    acp_agents: { permission: 'read', agents: [], tool_groups: [], sandbox: true },
    llm_providers: { providers: [], current: 'deepseek', secret_present: true },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string, args?: unknown) => {
    const reply = replies[name]
    if (typeof reply === 'function') return (reply as (a: unknown) => unknown)(args)
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const text = () => document.body.textContent ?? ''
const row = (path: string) => $(`[data-field="${path}"]`)!
const input = (path: string) => row(path).querySelector<HTMLInputElement>('input, textarea')!
async function type(path: string, value: string) {
  const el = input(path)
  el.value = value
  el.dispatchEvent(new Event('input'))
  await nextTick()
}
const navLabels = () => $$('.kb-settings-nav .ni').map((el) => el.textContent!.trim())

interface SessionOptions {
  ai?: boolean
  features?: string[]
  loaded?: boolean
}
function signIn({ ai = true, features = ['sys.settings', 'sys.ops', 'ai.acp'], loaded = true }: SessionOptions = {}) {
  const session = useSessionStore()
  session.features = new Set(features)
  session.aiEnabled = ai
  session.loaded = loaded
}

let wrapper: VueWrapper | null = null
async function open(tab?: string, session: SessionOptions = {}) {
  // 同一个用例里再次打开(换分区 / 换会话):先卸掉上一次的页面,免得查到旧页面的节点
  wrapper?.unmount()
  document.body.innerHTML = ''
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  signIn(session)
  route.query = tab ? { tab } : {}
  wrapper = mount(Settings, { attachTo: document.body })
  await flushPromises()
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  replace.mockClear()
  toasts.splice(0)
  setActivePinia(createPinia())
  backend()
})

describe('系统设置 · 四种状态', () => {
  it('加载中:骨架屏,不是「加载中…」文字,也还没有表单', async () => {
    replies.get_config = () => new Promise(() => undefined)
    signIn()
    wrapper = mount(Settings, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect($('[data-testid=setting-rows]')).toBeNull()
    expect($('[data-testid=settings-save-bar]')).toBeNull()
  })

  it('读取失败:说清出了什么事 + 重试,点重试后恢复', async () => {
    let failures = 1
    backend({
      get_config: () => {
        if (failures-- > 0) throw new CapabilityError('配置文件格式不对', 'internal', 500)
        return structuredClone(CONFIG)
      },
    })
    await open()
    const failed = $('[data-testid=admin-error]')!
    expect(failed.textContent).toContain('读取系统设置失败')
    expect(failed.textContent).toContain('配置文件格式不对')
    expect($('[data-testid=setting-rows]')).toBeNull()
    failed.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('[data-field="server.listen"]')).not.toBeNull()
  })

  it('没有开通(403):整页只说「没有开通」,不画导航也不给重试', async () => {
    backend({ get_config: new CapabilityError('forbidden', 'forbidden', 403) })
    await open()
    expect($('[data-testid=admin-forbidden]')!.textContent).toContain('你的账号没有开通这个功能')
    expect($('.kb-settings-nav')).toBeNull()
    expect($('[data-testid=admin-forbidden] button')).toBeNull()
  })

  it('会话还没加载完:不画任何分区(免得闪一下 AI 分区),加载完才出现', async () => {
    signIn({ loaded: false })
    wrapper = mount(Settings, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    useSessionStore().loaded = true
    await flushPromises()
    expect($('[data-testid=settings-body]')).not.toBeNull()
  })
})

describe('系统设置 · 分区与字段', () => {
  it('常规:中文标签 + 帮助文字,配置键名放在帮助文字里而不是当标签', async () => {
    await open()
    const listen = row('server.listen')
    expect(listen.querySelector('.kb-st-label')!.textContent).toContain('监听地址')
    expect(listen.querySelector('.kb-st-label')!.textContent).not.toContain('server.listen')
    expect(listen.querySelector('.kb-st-hint')!.textContent).toContain('server.listen')
    expect(listen.querySelector('.kb-st-hint')!.textContent).toContain('默认 127.0.0.1:7878')
    expect(input('server.listen').value).toBe('127.0.0.1:7878')
  })

  it('取值范围与默认值写在帮助文字里(来自字段表,和 config.rs 对账过)', async () => {
    await open('backup')
    expect(row('backup.interval_hours').querySelector('.kb-st-hint')!.textContent).toContain('取值 1–720 小时,默认 24 小时')
    expect(row('backup.keep_count').querySelector('.kb-st-hint')!.textContent).toContain('取值 0–365 份,默认 7 份')
  })

  it('需要重启的项带标记;立即生效的项没有', async () => {
    await open()
    expect(row('server.listen').querySelector('[data-testid=setting-restart]')!.textContent).toBe('需要重启')
    await open('search')
    expect(row('search.k').querySelector('[data-testid=setting-restart]')).toBeNull()
    await open('storage')
    expect(row('index.max_file_bytes').querySelector('[data-testid=setting-restart]')).not.toBeNull()
    expect(row('schedule.nightly_at').querySelector('[data-testid=setting-restart]')).toBeNull()
  })

  it('存储与索引里有「调度与维护」(它不再躲在备份页底部)', async () => {
    await open('storage')
    expect($$('[data-group]').map((el) => el.getAttribute('data-group'))).toEqual(['index', 'meta', 'convert', 'office', 'office_ai', 'schedule'])
    await open('backup')
    expect($('[data-field="schedule.nightly_at"]')).toBeNull()
  })

  it('嵌入段只读:显示当前值,没有输入框,也不带「需要重启」', async () => {
    await open('components')
    const model = row('embed.model')
    expect(model.querySelector('[data-testid=setting-value]')!.textContent).toBe('bge-m3-int8')
    expect(model.querySelector('input')).toBeNull()
    expect(model.querySelector('[data-testid=setting-restart]')).toBeNull()
    expect(text()).toContain('要先迁移已有集合')
  })

  it('每个分区里都没有裸露的键名当标签,也没有 token / top-k 这类英文词', async () => {
    for (const tab of ['general', 'storage', 'search', 'components', 'ocr', 'backup']) {
      await open(tab)
      for (const label of $$('.kb-st-label')) expect(label.textContent, `${tab}`).not.toMatch(/[a-z]+[._][a-z]+|top-?k|token/i)
    }
  })

  it('旧页签:tuning 落到「搜索与排序」,about 落到「常规」,并纠正地址', async () => {
    await open('tuning')
    expect($('[data-field="search.k"]')).not.toBeNull()
    expect(text()).toContain('按反馈调整权重')
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'search' } })
    await open('about')
    expect($('[data-testid=about-card]')).not.toBeNull()
  })

  it('搬走的页签:访问令牌去个人设置,外观去外观页', async () => {
    await open('tokens')
    expect(replace).toHaveBeenCalledWith('/me')
    replace.mockClear()
    await open('appearance')
    expect(replace).toHaveBeenCalledWith('/me/appearance')
  })

  it('导航里不再有「外观」「访问令牌」「关于」「检索调权」这些重复的入口', async () => {
    await open()
    expect(navLabels()).toEqual(['常规', '存储与索引', '搜索与排序', '模型', '组件', 'OCR 与转写', 'Skills', 'MCP 接入', '编码代理', '备份'])
  })

  it('数据目录取不到(没有 sys.ops)就不显示这一行,不编数字', async () => {
    backend({ system_status: new CapabilityError('forbidden', 'forbidden', 403) })
    await open()
    expect($('[data-testid=about-card]')!.textContent).not.toContain('数据目录')
    backend({ system_status: { overview: { service: { home: '/home/kb/.kb' } }, network: {} } })
    await open()
    expect($('[data-testid=about-card]')!.textContent).toContain('/home/kb/.kb')
  })
})

describe('系统设置 · AI 总开关', () => {
  it('开着:模型和编码代理分区都在', async () => {
    await open()
    expect(navLabels()).toContain('模型')
    expect(navLabels()).toContain('编码代理')
  })

  it('关闭:模型和编码代理整个分区不在导航里', async () => {
    await open(undefined, { ai: false })
    expect(navLabels()).toEqual(['常规', '存储与索引', '搜索与排序', '组件', 'OCR 与转写', 'Skills', 'MCP 接入', '备份'])
  })

  it('关闭:直接打开模型 / 编码代理的链接回到常规,不暴露这些分区', async () => {
    await open('model', { ai: false })
    expect($('[data-field="llm.provider"]')).toBeNull()
    expect($('[data-field="server.listen"]')).not.toBeNull()
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'general' } })
    await open('acp', { ai: false })
    expect($('[data-field="server.listen"]')).not.toBeNull()
  })

  it('关闭:不去读模型和编码代理的数据(读了也是 403)', async () => {
    await open(undefined, { ai: false })
    expect(calls('llm_providers')).toHaveLength(0)
    expect(calls('acp_agents')).toHaveLength(0)
  })

  it('关闭:剩下的每个分区里任何位置都没有「AI」字样', async () => {
    for (const tab of ['general', 'storage', 'search', 'components', 'ocr', 'skills', 'mcp', 'backup']) {
      await open(tab, { ai: false })
      expect(text(), `${tab} 分区`).not.toMatch(/AI/)
    }
  })

  it('开着:模型分区的字段、费用保护、自动提炼都在,服务商 / 地址 / 模型名能保存(以前永远不落盘)', async () => {
    await open('model')
    for (const path of ['llm.provider', 'llm.base_url', 'llm.extract_model', 'llm.review_model', 'llm.agent_model', 'llm.daily_token_budget', 'llm.max_calls_per_hour', 'evolution.extract_enabled_default']) {
      expect($(`[data-field="${path}"]`), path).not.toBeNull()
    }
    await type('llm.extract_model', 'deepseek-chat')
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    expect(calls('update_config')[0]![1]).toEqual({ patch: { llm: { extract_model: 'deepseek-chat' } }, confirm: true })
  })

  it('改了模型字段还没保存:密钥卡里提醒「测试连接用的是已保存的设置」;改的不是模型字段就不提醒', async () => {
    await open('model')
    expect($('[data-testid=llm-test-unsaved]')).toBeNull()
    await type('evolution.dedup_similarity', '0.9')
    expect($('[data-testid=llm-test-unsaved]')).toBeNull()
    await type('llm.base_url', 'https://api.example.com')
    expect($('[data-testid=llm-test-unsaved]')).not.toBeNull()
  })

  it('费用上限填 0(不限):行内写明风险', async () => {
    await open('model')
    expect($('[data-field="llm.max_calls_per_hour"] [data-testid=setting-risk]')).toBeNull()
    await type('llm.max_calls_per_hour', '0')
    expect($('[data-field="llm.max_calls_per_hour"] [data-testid=setting-risk]')!.textContent).toContain('费用')
  })
})

describe('系统设置 · 备份分区的可见性', () => {
  it('没有 sys.ops 的账号没有「备份」分区,链接直达也回到常规', async () => {
    await open('backup', { features: ['sys.settings', 'ai.acp'] })
    expect(navLabels()).not.toContain('备份')
    expect($('[data-field="backup.enabled"]')).toBeNull()
  })
})

describe('系统设置 · 改值与保存', () => {
  it('没改动时没有保存条', async () => {
    await open('search')
    expect($('[data-testid=settings-save-bar]')).toBeNull()
  })

  it('改一个值 → 保存条「有 1 项修改未保存」→ 保存只提交这一个键 → 提示 → 条消失', async () => {
    await open('search')
    await type('search.k', '9')
    expect($('[data-testid=settings-save-count]')!.textContent).toBe('有 1 项修改未保存')
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    // 只提交改过的键:不带整段 search,更不会把页面开着期间别处写入的 collection_weights 盖回去
    expect(calls('update_config')[0]![1]).toEqual({ patch: { search: { k: 9 } }, confirm: true })
    expect(toasts[0]!.message).toBe('已保存 1 项,立即生效。')
    expect(toasts[0]!.tone).toBe('success')
    expect(calls('get_config')).toHaveLength(2)
    expect($('[data-testid=settings-save-bar]')).toBeNull()
  })

  it('保存是跨分区的:改了两个分区里的值,一次提交', async () => {
    await open('search')
    await type('search.k', '9')
    $$('.kb-settings-nav .ni').find((el) => el.textContent!.trim() === '存储与索引')!.click()
    await flushPromises()
    await type('schedule.nightly_at', '04:30')
    expect($('[data-testid=settings-save-count]')!.textContent).toBe('有 2 项修改未保存')
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    expect(calls('update_config')[0]![1]).toEqual({ patch: { search: { k: 9 }, schedule: { nightly_at: '04:30' } }, confirm: true })
  })

  it('改了要重启的项:提示里点名「要重启服务后才生效」,用警告色', async () => {
    await open()
    await type('server.listen', '127.0.0.1:9000')
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    expect(toasts[0]!.message).toBe('已保存 1 项。「监听地址」要重启服务后才生效。')
    expect(toasts[0]!.tone).toBe('warning')
  })

  it('校验失败:就近报错(带标签和范围),保存置灰,不会发出请求', async () => {
    await open('backup')
    await type('backup.interval_hours', '0')
    expect(row('backup.interval_hours').querySelector('[data-testid=setting-error]')!.textContent).toContain('「备份间隔」不能小于 1')
    expect($('[data-testid=settings-save-invalid]')!.textContent).toContain('「备份间隔」不能小于 1')
    const save = $<HTMLButtonElement>('[data-testid=settings-save]')!
    expect(save.disabled).toBe(true)
    save.click()
    await flushPromises()
    expect(calls('update_config')).toHaveLength(0)
    // 改回合法值,报错消失、可以保存
    await type('backup.interval_hours', '12')
    expect(row('backup.interval_hours').querySelector('[data-testid=setting-error]')).toBeNull()
    expect($<HTMLButtonElement>('[data-testid=settings-save]')!.disabled).toBe(false)
  })

  it('监听地址不是本机地址又没打开「允许远程访问」:报错指向监听地址;打开开关后恢复', async () => {
    await open()
    await type('server.listen', '0.0.0.0:7878')
    expect(row('server.listen').querySelector('[data-testid=setting-error]')!.textContent).toContain('允许远程访问')
    row('server.allow_remote').querySelector<HTMLElement>('[role=switch]')!.click()
    await nextTick()
    expect(row('server.listen').querySelector('[data-testid=setting-error]')).toBeNull()
    expect(row('server.allow_remote').querySelector('[data-testid=setting-risk]')!.textContent).toContain('对外暴露')
  })

  it('保存失败:原因常驻在保存条上(不自动消失),按钮变「重试」,重试成功后清掉', async () => {
    let fail = true
    backend({
      update_config: () => {
        if (fail) throw new CapabilityError('配置补丁不合法: search.k 超出范围', 'invalid_input', 400)
        return { applied: true, restart_required: false, changed: ['search'], migration_plan: null, notes: [] }
      },
    })
    await open('search')
    await type('search.k', '9')
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    expect($('[data-testid=settings-save-failure]')!.textContent).toContain('保存设置失败:配置补丁不合法: search.k 超出范围。请检查填写的值后重试。')
    expect(toasts[0]!.tone).toBe('danger')
    const retry = $<HTMLButtonElement>('[data-testid=settings-save]')!
    expect(retry.textContent!.trim()).toBe('重试')
    // 输入框里的值还在,用户不用重填
    expect(input('search.k').value).toBe('9')
    fail = false
    retry.click()
    await flushPromises()
    expect($('[data-testid=settings-save-failure]')).toBeNull()
    expect($('[data-testid=settings-save-bar]')).toBeNull()
    expect(calls('update_config')).toHaveLength(2)
  })

  it('没有写入(服务端说补丁与当前一致 / 迁移计划):警告提示,草稿保留', async () => {
    backend({ update_config: { applied: false, restart_required: false, changed: [], migration_plan: null, notes: ['补丁与当前配置一致,没有写入'] } })
    await open('search')
    await type('search.k', '9')
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    expect(toasts[0]!.message).toBe('补丁与当前配置一致,没有写入')
    expect(toasts[0]!.tone).toBe('warning')
    expect(input('search.k').value).toBe('9')
  })

  it('还原:草稿回到已保存的值,保存条消失', async () => {
    await open('search')
    await type('search.k', '9')
    $<HTMLButtonElement>('[data-testid=settings-revert]')!.click()
    await nextTick()
    expect(input('search.k').value).toBe('8')
    expect($('[data-testid=settings-save-bar]')).toBeNull()
  })

  it('0 和 false 是合法值,也会提交', async () => {
    await open('backup')
    await type('backup.keep_count', '0')
    row('backup.enabled').querySelector<HTMLElement>('[role=switch]')!.click()
    await nextTick()
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    expect(calls('update_config')[0]![1]).toEqual({ patch: { backup: { enabled: false, keep_count: 0 } }, confirm: true })
  })

  it('异地目录:逗号分隔写成数组;含「..」报错', async () => {
    await open('backup')
    await type('backup.mirror_dirs', '/mnt/usb, /mnt/nas')
    $<HTMLButtonElement>('[data-testid=settings-save]')!.click()
    await flushPromises()
    expect(calls('update_config')[0]![1]).toEqual({ patch: { backup: { mirror_dirs: ['/mnt/usb', '/mnt/nas'] } }, confirm: true })
    await type('backup.mirror_dirs', '/mnt/../etc')
    expect(row('backup.mirror_dirs').querySelector('[data-testid=setting-error]')!.textContent).toContain('不能用「..」')
  })
})
