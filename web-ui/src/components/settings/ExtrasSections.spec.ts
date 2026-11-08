// 「按反馈调整权重」「Skills」「MCP 接入」三块:四种状态、预演 / 应用 / 回滚、重新扫描、令牌入口搬到个人设置。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, type Component } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
vi.mock('vue-router', () => ({
  RouterLink: defineComponent({
    props: { to: { type: String, default: '' } },
    setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  }),
}))
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string }[], failure: '' }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string; message?: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      try {
        await options.action?.()
        return true
      } catch (err) {
        // 和真实确认框一样:action 抛错就在框里显示失败,返回 false
        confirmState.failure = err instanceof Error ? err.message : String(err)
        return false
      }
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import McpSection from './McpSection.vue'
import SkillsSection from './SkillsSection.vue'
import TuningCard from './TuningCard.vue'

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  // 官方插件列表在 Skills 分区挂载时总会读一次;默认给空列表,单独用例再覆盖。
  replies = { list_official_plugins: [], ...overrides }
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
const byId = (id: string) => $<HTMLButtonElement>(`[data-testid=${id}]`)!

let wrapper: VueWrapper | null = null
async function open(component: Component, props: Record<string, unknown> = {}) {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  wrapper = mount(component, { attachTo: document.body, props })
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  confirmState.answer = true
  confirmState.calls = []
  confirmState.failure = ''
  toasts.splice(0)
  setActivePinia(createPinia())
  backend()
})

// ---------------------------------------------------------------- 按反馈调整权重

const SUGGESTIONS = [
  { collection: 'proj_sampleapp', current: 1, suggested: 1.2, delta: 0.2, samples: 42, useful_rate: 0.881, reason: '有用率 88% 比全局高 17 个百分点,权重上调 0.20' },
  { collection: 'proj_sampleproj', current: 1, suggested: 0.95, delta: -0.05, samples: 18, useful_rate: 0.667, reason: '有用率接近全局均值,权重小幅下调 0.05' },
]
const PLAN = {
  feedback: 128,
  matched: 121,
  overall_rate: 0.71,
  groups: [{ collection: 'proj_sampleapp', kind: 'doc', prefix: 'docs', total: 42, useful: 37, rate: 0.881 }],
  suggestions: SUGGESTIONS,
  skipped: ['proj_demo 只有 3 条反馈,样本不足(需要 ≥ 5)'],
}

describe('按反馈调整权重', () => {
  it('还没预演过:给说明和下一步「预演」,不是一张空表', async () => {
    await open(TuningCard)
    expect($('[data-testid=tune-card]')!.textContent).toContain('还没有预演过')
    expect($('[data-testid=tune-card]')!.textContent).toContain('预演不会改任何设置')
    expect(byId('tune-preview').textContent!.trim()).toBe('预演')
    expect($('[data-testid=tune-apply]')).toBeNull()
  })

  it('预演:发 dry_run,显示概况和建议;应用按钮可用', async () => {
    backend({ tune_retrieval: PLAN })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    expect(calls('tune_retrieval')[0]![1]).toEqual({ dry_run: true, confirm: true })
    expect(byId('tune-summary').textContent).toBe('反馈 128 条 · 能对上记录 121 条 · 全局有用率 71%')
    const rows = $$('[data-testid=rt-row]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('proj_sampleapp')
    expect(rows[0]!.textContent).toContain('88%(样本 42 条)')
    expect(rows[0]!.textContent).toContain('1.00 → 1.20')
    expect(rows[0]!.textContent).toContain('+0.20')
    expect(rows[1]!.textContent).toContain('-0.05')
    expect(byId('tune-apply').disabled).toBe(false)
  })

  it('界面上的英文词换成中文:「集合」不是 Collection,预演不写 dry run,得分不直接甩 MRR', async () => {
    backend({ tune_retrieval: PLAN })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    const text = $('[data-testid=tune-card]')!.textContent!
    expect(text).toContain('集合')
    expect(text).not.toMatch(/Collection|dry run|feedback 表/)
  })

  it('没有需要调整的:写明原因,应用置灰', async () => {
    backend({ tune_retrieval: { ...PLAN, suggestions: [] } })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    expect($('[data-testid=tune-card]')!.textContent).toContain('没有需要调整的集合(样本不足,或幅度太小)')
    expect(byId('tune-apply').disabled).toBe(true)
  })

  it('细节折起:分组统计和被跳过的原因', async () => {
    backend({ tune_retrieval: PLAN })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    const details = byId('tune-details')
    expect(details.hasAttribute('open')).toBe(false)
    expect(details.textContent).toContain('proj_demo 只有 3 条反馈')
    expect(details.textContent).toContain('37/42 有用(88%)')
  })

  it('预演失败:原因常驻 + 仍然能重新预演', async () => {
    backend({ tune_retrieval: new CapabilityError('反馈表读不了', 'internal', 500) })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    expect(byId('tune-error').textContent).toBe('预演失败:反馈表读不了。请稍后重试。')
    expect(byId('tune-preview').textContent!.trim()).toBe('重新预演')
  })

  it('应用:先确认(写明写到哪、会回滚),成功后给「已应用」和前后得分,应用按钮置灰', async () => {
    let applied = false
    backend({
      tune_retrieval: (args: { dry_run: boolean }) => {
        if (args.dry_run) return PLAN
        applied = true
        return { ...PLAN, applied: true, eval: { before: { mrr: 0.9 }, after: { mrr: 0.92 } } }
      },
    })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    byId('tune-apply').click()
    await flushPromises()
    expect(confirmState.calls[0]!.title).toBe('应用 2 条权重建议?')
    expect(confirmState.calls[0]!.message).toContain('search.collection_weights')
    expect(applied).toBe(true)
    expect(calls('tune_retrieval')[1]![1]).toEqual({ dry_run: false, confirm: true })
    expect(byId('tune-outcome').textContent).toContain('已应用')
    expect(byId('tune-outcome').textContent).toContain('评测得分 0.900 → 0.920')
    expect(byId('tune-apply').disabled).toBe(true)
  })

  it('应用后得分下降被回滚:确认框里显示失败(向上抛),结果卡写明“已回滚”和原因', async () => {
    backend({
      tune_retrieval: (args: { dry_run: boolean }) => (args.dry_run ? PLAN : { ...PLAN, applied: false, rolled_back: true, eval: { before: { mrr: 0.93 }, after: { mrr: 0.9 } } }),
    })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    byId('tune-apply').click()
    await flushPromises()
    expect(confirmState.failure).toBe('应用后评测得分下降,已自动回滚,权重没有改变')
    expect(byId('tune-outcome').textContent).toContain('已回滚')
    expect(byId('tune-outcome').textContent).toContain('0.930 → 0.900')
  })

  it('取消确认:不应用', async () => {
    confirmState.answer = false
    backend({ tune_retrieval: PLAN })
    await open(TuningCard)
    byId('tune-preview').click()
    await flushPromises()
    byId('tune-apply').click()
    await flushPromises()
    expect(calls('tune_retrieval')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- Skills

const SKILLS = {
  dir: '/home/kb/.kb/skills',
  allow_exec: false,
  warnings: ['skills/broken/manifest.toml:3 缺少 type 字段,已跳过'],
  skills: [
    { id: 'proto', name: 'proto', manifest: '/x', kind: 'loader-rule', enabled: true, rules: ['**/*.proto → text'], prompt_stages: [], template_required: [] },
    { id: 'review-prompt', name: 'review-prompt', manifest: '/y', kind: 'prompt', enabled: false, rules: [], prompt_stages: ['review'], template_required: [] },
  ],
}

const OFFICIAL = [
  {
    id: 'official-vue',
    name: 'official-vue',
    description: '把 Vue 单文件组件按 template / script 切开',
    version: '0.1.0',
    tags: ['vue'],
    hooks: ['chunk'],
    include: ['**/*.vue'],
    installed: false,
    installed_version: null,
  },
  {
    id: 'official-sql',
    name: 'official-sql',
    description: '按语句切 SQL,保留表名到上下文',
    version: '0.1.0',
    tags: ['sql'],
    hooks: ['chunk'],
    include: ['**/*.sql'],
    installed: true,
    installed_version: '0.1.0',
  },
]

const PLUGIN_SKILLS = {
  ...SKILLS,
  skills: [
    { id: 'vue-sfc', name: 'vue-sfc', manifest: '/z', kind: 'plugin', enabled: true, version: '0.2.0', hooks: ['chunk'], rules: ['**/*.vue → vue'], prompt_stages: [], template_required: [] },
  ],
}

const PLUGIN_DRAFT = {
  name: 'vue-sfc',
  version: '0.2.0',
  description: '把 Vue 单文件组件按 template / script 切开',
  enabled: true,
  include: ['**/*.vue'],
  exclude: ['**/node_modules/**'],
  projects: [],
  lang: 'vue',
  tags: ['vue'],
  priority: 100,
  exec: { command: 'python3', args: ['plugin.py', 'vue'], hooks: ['chunk'], timeout_ms: 20000, max_output_bytes: 16 * 1024 * 1024 },
  source: null,
  permissions: { network: false, read_project: false, llm: false },
  files: [{ path: 'plugin.py', content: 'print(1)' }],
}

describe('Skills', () => {
  it('列出已登记的 skill:类型用术语表的说法,状态和细节分开', async () => {
    backend({ list_skills: SKILLS })
    await open(SkillsSection, { aiOn: true })
    const rows = $$('[data-testid=skills-list] [data-testid=rt-row]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('加载规则')
    expect(rows[0]!.textContent).toContain('已启用')
    expect(rows[1]!.textContent).toContain('提示词')
    expect(rows[1]!.textContent).toContain('已停用')
    expect(rows[1]!.textContent).toContain('覆盖阶段:审核')
    expect(byId('skills-exec').textContent).toBe('不允许(默认)')
    expect($('[data-testid=skills-warnings]')!.textContent).toContain('缺少 type 字段')
  })

  it('进程钩子打开时显示真实的沙箱状态,而不是只说「允许执行」', async () => {
    backend({ list_skills: { ...SKILLS, allow_exec: true, sandbox_available: true } })
    await open(SkillsSection, { aiOn: true })
    expect(byId('skills-exec').textContent).toBe('沙箱运行')
  })

  it('bwrap 不可用且没有显式放行时显示「没有沙箱」', async () => {
    backend({ list_skills: { ...SKILLS, allow_exec: true, sandbox_available: false, allow_unsandboxed: false } })
    await open(SkillsSection, { aiOn: true })
    expect(byId('skills-exec').textContent).toBe('没有沙箱')
    expect($('[data-testid=skills-exec]')!.parentElement?.textContent).toContain('进程钩子已禁用')
  })

  it('插件行:显示版本和钩子,能打开插件编辑器(而不是普通 Skill 表单)', async () => {
    backend({ list_skills: PLUGIN_SKILLS, get_plugin: { id: 'vue-sfc', draft: PLUGIN_DRAFT } })
    await open(SkillsSection, { aiOn: true })
    const row = $('[data-testid=skills-list] [data-testid=rt-row]')!
    expect(row.textContent).toContain('插件')
    expect(row.textContent).toContain('0.2.0')
    expect(row.textContent).toContain('钩子:切块')
    byId('skill-edit-vue-sfc').click()
    await flushPromises()
    expect(calls('get_plugin')[0]![1]).toEqual({ id: 'vue-sfc' })
    expect($('[data-testid=plugin-dialog]')).not.toBeNull()
    expect($<HTMLInputElement>('[data-testid=plugin-command] input, input[data-testid=plugin-command]')!.value).toBe('python3')
  })

  it('插件也走只翻 enabled 的接口,不用先读整份清单再写回', async () => {
    backend({ list_skills: PLUGIN_SKILLS, set_skill_enabled: { id: 'vue-sfc' } })
    await open(SkillsSection, { aiOn: true })
    byId('skill-toggle-vue-sfc').click()
    await flushPromises()
    expect(calls('set_skill_enabled')[0]![1]).toEqual({ id: 'vue-sfc', enabled: false, confirm: true })
    expect(calls('get_plugin')).toHaveLength(0)
    expect(calls('save_plugin')).toHaveLength(0)
  })

  it('空:说明 skill 是干什么的 + 下一步「新增 Skill」', async () => {
    backend({ list_skills: { ...SKILLS, skills: [], warnings: [] } })
    await open(SkillsSection, { aiOn: true })
    expect($('[data-testid=skills-list]')!.textContent).toContain('还没有 skill')
    expect($('[data-testid=skills-list]')!.textContent).toContain('示例可以一键填入')
    expect($('[data-testid=skills-list] button')!.textContent).toBe('新增 Skill')
    expect($('[data-testid=skills-warnings]')).toBeNull()
  })

  it('重新扫描:发请求、重读、提示个数;失败的原因常驻', async () => {
    backend({ list_skills: SKILLS, reload_skills: { dir: '/x' } })
    await open(SkillsSection, { aiOn: true })
    byId('skills-rescan').click()
    await flushPromises()
    expect(calls('reload_skills')[0]![1]).toEqual({ confirm: true })
    expect(calls('list_skills')).toHaveLength(2)
    expect(toasts[0]!.message).toBe('已重新扫描 Skills(2 个)。')
    backend({ list_skills: SKILLS, reload_skills: new CapabilityError('manifest 解析失败', 'internal', 500) })
    byId('skills-rescan').click()
    await flushPromises()
    expect(byId('skills-error').textContent).toBe('重新扫描失败:manifest 解析失败。请稍后重试。')
  })

  it('加载中 / 读取失败可重试 / 没开通', async () => {
    backend({ list_skills: () => new Promise(() => undefined) })
    await open(SkillsSection, { aiOn: true })
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    wrapper!.unmount()
    document.body.innerHTML = ''
    let fail = true
    backend({
      list_skills: () => {
        if (fail) throw new CapabilityError('清单目录读不了', 'internal', 500)
        return SKILLS
      },
    })
    await open(SkillsSection, { aiOn: true })
    expect($('[data-testid=admin-error]')!.textContent).toContain('读取 Skills 清单失败:清单目录读不了')
    fail = false
    $('[data-testid=admin-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=skills-card]')).not.toBeNull()
    wrapper!.unmount()
    document.body.innerHTML = ''
    backend({ list_skills: new CapabilityError('forbidden', 'forbidden', 403) })
    await open(SkillsSection, { aiOn: true })
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
  })

  it('AI 总开关关闭:整个分区没有「AI」字样,也不提提示词', async () => {
    backend({ list_skills: { ...SKILLS, skills: [SKILLS.skills[0]] } })
    await open(SkillsSection, { aiOn: false })
    const text = document.body.textContent!
    expect(text).not.toMatch(/AI/)
    expect($('[data-testid=skills-card]')!.textContent).not.toContain('提示词')
  })
})

const PROTO_DRAFT = { name: 'proto', kind: 'loader-rule', description: '', enabled: true, glob: '**/*.proto', lang: 'text', tags: ['proto'], stage: '', template: '', required: [], max_body_chars: null, max_title_chars: null }

describe('Skills · 新增 / 编辑 / 停用 / 删除', () => {
  const setInput = async (testid: string, value: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(`[data-testid=${testid}]`)!
    const input = el.matches('input, textarea') ? el : el.querySelector<HTMLInputElement>('input, textarea')!
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
  }

  beforeEach(() => {
    confirmState.answer = true
    confirmState.calls.length = 0
  })

  it('页面直接写明每种类型是干什么的;AI 关闭时不出现提示词', async () => {
    backend({ list_skills: SKILLS })
    await open(SkillsSection, { aiOn: true })
    const on = $('[data-testid=skills-kinds]')!.textContent!
    expect(on).toContain('加载规则')
    expect(on).toContain('笔记模板')
    expect(on).toContain('提示词')
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open(SkillsSection, { aiOn: false })
    expect($('[data-testid=skills-kinds]')!.textContent).not.toContain('提示词')
  })

  it('新增:没填名称和匹配路径点保存,就近提示且不发请求;「填入示例」一键填好,保存带上 confirm', async () => {
    backend({ list_skills: SKILLS, save_skill: { id: 'proto-2' } })
    await open(SkillsSection, { aiOn: true })
    byId('skills-add').click()
    await flushPromises()
    expect($('[data-testid=skill-dialog]')).not.toBeNull()
    byId('skill-save').click()
    await flushPromises()
    expect($('[data-testid=skill-dialog]')!.textContent).toContain('给它起个名字')
    expect($('[data-testid=skill-dialog]')!.textContent).toContain('写上要匹配的文件')
    expect(calls('save_skill')).toHaveLength(0)

    byId('skill-example').click()
    await flushPromises()
    byId('skill-save').click()
    await flushPromises()
    const [, args] = calls('save_skill')[0]!
    expect(args).toMatchObject({ name: '接口定义文件', kind: 'loader-rule', glob: '**/*.proto', lang: 'text', tags: ['proto', '接口'], enabled: true, confirm: true })
    expect(args).not.toHaveProperty('id')
    expect(toasts.at(-1)!.message).toBe('已新增,马上生效。')
    expect($('[data-testid=skill-dialog]')).toBeNull()
    expect(calls('list_skills').length).toBeGreaterThan(1)
  })

  it('切换类型:只带当前类型的字段;笔记模板至少要设一条要求', async () => {
    backend({ list_skills: SKILLS, save_skill: { id: 'x' } })
    await open(SkillsSection, { aiOn: true })
    byId('skills-add').click()
    await flushPromises()
    const tabs = $$('[data-testid=skill-dialog] [role=radio], [data-testid=skill-dialog] [role=tab], [data-testid=skill-dialog] i')
    tabs.find((tab) => tab.textContent?.includes('笔记模板'))!.click()
    await flushPromises()
    await setInput('skill-name', '笔记要求')
    byId('skill-save').click()
    await flushPromises()
    expect($('[data-testid=skill-dialog]')!.textContent).toContain('至少设一条要求')
    expect(calls('save_skill')).toHaveLength(0)
    byId('skill-required-title').click()
    await setInput('skill-body-limit', '2000')
    byId('skill-save').click()
    await flushPromises()
    const args = calls('save_skill')[0]![1] as Record<string, unknown>
    expect(args).toMatchObject({ kind: 'insight-template', required: ['title'], max_body_chars: 2000 })
    expect(args).not.toHaveProperty('glob')
    expect(args).not.toHaveProperty('max_title_chars')
  })

  it('编辑:先取回完整内容预填,保存带上目录名;类型不能改', async () => {
    backend({ list_skills: SKILLS, get_skill: { id: 'proto', draft: PROTO_DRAFT }, save_skill: { id: 'proto' } })
    await open(SkillsSection, { aiOn: true })
    byId('skill-edit-proto').click()
    await flushPromises()
    expect(calls('get_skill')[0]![1]).toEqual({ id: 'proto' })
    expect($<HTMLInputElement>('[data-testid=skill-glob] input, input[data-testid=skill-glob]')!.value).toBe('**/*.proto')
    expect($('[data-testid=skill-dialog]')!.textContent).toContain('类型不能改')
    expect($('[data-testid=skill-example]')).toBeNull()
    await setInput('skill-glob', '**/*.thrift')
    byId('skill-save').click()
    await flushPromises()
    expect(calls('save_skill')[0]![1]).toMatchObject({ id: 'proto', glob: '**/*.thrift', confirm: true })
    expect(toasts.at(-1)!.message).toBe('已保存,马上生效。')
  })

  it('服务端拒绝时原因留在对话框里,填的内容不丢,可以直接改了再试', async () => {
    backend({ list_skills: SKILLS, get_skill: { id: 'proto', draft: PROTO_DRAFT }, save_skill: new CapabilityError('匹配路径写得不对:invalid glob', 'invalid_input', 400) })
    await open(SkillsSection, { aiOn: true })
    byId('skill-edit-proto').click()
    await flushPromises()
    await setInput('skill-glob', '[')
    byId('skill-save').click()
    await flushPromises()
    expect($('[data-testid=skill-failure]')!.textContent).toContain('匹配路径写得不对')
    expect($('[data-testid=skill-dialog]')).not.toBeNull()
    expect($<HTMLInputElement>('[data-testid=skill-glob] input, input[data-testid=skill-glob]')!.value).toBe('[')
  })

  it('停用:只翻 enabled;已停用的显示「启用」', async () => {
    backend({ list_skills: SKILLS, set_skill_enabled: { id: 'proto' } })
    await open(SkillsSection, { aiOn: true })
    expect(byId('skill-toggle-proto').textContent).toBe('停用')
    expect(byId('skill-toggle-review-prompt').textContent).toBe('启用')
    byId('skill-toggle-proto').click()
    await flushPromises()
    expect(calls('set_skill_enabled')[0]![1]).toEqual({ id: 'proto', enabled: false, confirm: true })
    expect(calls('save_skill')).toHaveLength(0)
    expect(toasts.at(-1)!.message).toBe('已停用 proto。')
  })

  it('删除:先确认(说明不能恢复);取消不发请求,确认后发 delete_skill 并重读', async () => {
    backend({ list_skills: SKILLS, delete_skill: { deleted: true } })
    await open(SkillsSection, { aiOn: true })
    confirmState.answer = false
    byId('skill-delete-proto').click()
    await flushPromises()
    expect(confirmState.calls[0]!.message).toContain('不能恢复')
    expect(calls('delete_skill')).toHaveLength(0)
    confirmState.answer = true
    byId('skill-delete-proto').click()
    await flushPromises()
    expect(calls('delete_skill')[0]![1]).toEqual({ id: 'proto', confirm: true })
    expect(toasts.at(-1)!.message).toBe('已删除 proto。')
  })

  it('操作失败:原因常驻在按钮下面,不弹走', async () => {
    backend({ list_skills: SKILLS, delete_skill: new CapabilityError('没找到', 'not_found', 404) })
    await open(SkillsSection, { aiOn: true })
    byId('skill-delete-proto').click()
    await flushPromises()
    expect(byId('skills-action-error').textContent).toContain('删除失败')
  })

  it('脚本类只登记不执行:只能删,不给编辑和停用', async () => {
    backend({ list_skills: { ...SKILLS, skills: [{ id: 'run', name: 'run', manifest: '/z', kind: 'exec', enabled: true, rules: [], prompt_stages: [], template_required: [] }] } })
    await open(SkillsSection, { aiOn: true })
    expect($('[data-testid=skill-edit-run]')).toBeNull()
    expect($('[data-testid=skill-toggle-run]')).toBeNull()
    expect($('[data-testid=skill-delete-run]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------- 新增插件 / 官方插件

describe('Skills · 插件', () => {
  const setInput = async (testid: string, value: string) => {
    const el = $<HTMLInputElement | HTMLTextAreaElement>(`[data-testid=${testid}]`)!
    const input = el.matches('input, textarea') ? el : el.querySelector<HTMLInputElement>('input, textarea')!
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
  }

  beforeEach(() => {
    confirmState.answer = true
    confirmState.calls.length = 0
  })

  it('新增插件:先校验;「填入示例」后保存结构化表单,不交 TOML', async () => {
    backend({ list_skills: SKILLS, save_plugin: { id: 'vue-sfc' } })
    await open(SkillsSection, { aiOn: true })
    byId('skills-add-plugin').click()
    await flushPromises()
    expect($('[data-testid=plugin-dialog]')).not.toBeNull()
    byId('plugin-save').click()
    await flushPromises()
    expect($('[data-testid=plugin-dialog]')!.textContent).toContain('给它起个名字')
    expect(calls('save_plugin')).toHaveLength(0)

    byId('plugin-example').click()
    await flushPromises()
    byId('plugin-save').click()
    await flushPromises()
    const [, args] = calls('save_plugin')[0]!
    expect(args).toMatchObject({
      confirm: true,
      draft: {
        name: 'vue-sfc',
        include: ['**/*.vue'],
        lang: 'vue',
        exec: { command: 'python3', args: ['plugin.py', 'vue'], hooks: ['chunk'] },
        files: [{ path: 'plugin.py' }],
      },
    })
    expect(args).not.toHaveProperty('id')
    expect(JSON.stringify(args)).not.toContain('type = "plugin"')
    expect(toasts.at(-1)!.message).toBe('插件已新增,马上生效。')
    expect($('[data-testid=plugin-dialog]')).toBeNull()
  })

  it('来源规则必须和 source 钩子成对;打开来源会顺手勾上钩子', async () => {
    backend({ list_skills: SKILLS })
    await open(SkillsSection, { aiOn: true })
    byId('skills-add-plugin').click()
    await flushPromises()
    await setInput('plugin-name', 'web-docs')
    byId('plugin-source-toggle').querySelector<HTMLElement>('.sw')!.click()
    await flushPromises()
    expect($('[data-testid=plugin-source-match]')).not.toBeNull()
    // 没开进程钩子时,填来源会在保存时报“要勾抓取来源”
    await setInput('plugin-source-match', 'https://docs.example.com/**')
    byId('plugin-save').click()
    await flushPromises()
    expect($('[data-testid=plugin-source-error]')!.textContent).toContain('抓取来源')
    expect(calls('save_plugin')).toHaveLength(0)
  })

  it('关掉进程钩子会同时清掉来源规则和权限,避免留下没有执行者的配置', async () => {
    backend({ list_skills: SKILLS })
    await open(SkillsSection, { aiOn: true })
    byId('skills-add-plugin').click()
    await flushPromises()
    byId('plugin-exec-toggle').querySelector<HTMLElement>('.sw')!.click()
    byId('plugin-source-toggle').querySelector<HTMLElement>('.sw')!.click()
    await flushPromises()
    expect($('[data-testid=plugin-source-match]')).not.toBeNull()
    expect($('[data-testid=plugin-perm-network]')).not.toBeNull()
    // v1 只开放联网;项目目录 / 模型开关不应该出现在表单里。
    expect($('[data-testid=plugin-perm-read]')).toBeNull()
    expect($('[data-testid=plugin-perm-llm]')).toBeNull()
    expect($('[data-testid=plugin-perm-network]')!.parentElement!.textContent).toContain('项目目录与模型接口')
    byId('plugin-exec-toggle').querySelector<HTMLElement>('.sw')!.click()
    await flushPromises()
    expect($('[data-testid=plugin-source-match]')).toBeNull()
    expect($('[data-testid=plugin-perm-network]')).toBeNull()
    expect(byId('plugin-source-toggle').querySelector<HTMLElement>('.sw')!.getAttribute('aria-checked')).toBe('false')
  })

  it('编辑插件:预填命令 / 参数 / 脚本;服务端拒绝时原因留在对话框里', async () => {
    backend({ list_skills: PLUGIN_SKILLS, get_plugin: { id: 'vue-sfc', draft: PLUGIN_DRAFT }, save_plugin: new CapabilityError('脚本路径不合法', 'invalid_input', 400) })
    await open(SkillsSection, { aiOn: true })
    byId('skill-edit-vue-sfc').click()
    await flushPromises()
    expect($<HTMLTextAreaElement>('[data-testid=plugin-args] textarea, textarea[data-testid=plugin-args]')!.value).toBe('plugin.py\nvue')
    expect($<HTMLTextAreaElement>('[data-testid=plugin-file-content-0] textarea, textarea[data-testid=plugin-file-content-0]')!.value).toBe('print(1)')
    byId('plugin-save').click()
    await flushPromises()
    const args = calls('save_plugin')[0]![1] as Record<string, unknown>
    expect(args).toMatchObject({ id: 'vue-sfc', draft: { name: 'vue-sfc', exec: { command: 'python3' }, files: [{ path: 'plugin.py' }] } })
    expect($('[data-testid=plugin-failure]')!.textContent).toContain('脚本路径不合法')
    expect($('[data-testid=plugin-dialog]')).not.toBeNull()
  })

  it('官方插件:未安装可安装、已安装可卸载;卸载先确认,取消不发请求', async () => {
    backend({
      list_skills: SKILLS,
      list_official_plugins: OFFICIAL,
      install_official_plugin: { id: 'official-vue' },
      uninstall_official_plugin: { id: 'official-sql', deleted: true },
    })
    await open(SkillsSection, { aiOn: true })
    expect($('[data-testid=official-row-official-vue]')!.textContent).toContain('未安装')
    expect($('[data-testid=official-row-official-vue]')!.textContent).toContain('处理:**/*.vue')
    expect($('[data-testid=official-row-official-vue]')!.textContent).toContain('钩子:切块')
    expect($('[data-testid=official-row-official-sql]')!.textContent).toContain('已安装 v0.1.0')

    byId('official-install-official-vue').click()
    await flushPromises()
    expect(calls('install_official_plugin')[0]![1]).toEqual({ id: 'official-vue', overwrite: false, confirm: true })
    expect(toasts.at(-1)!.message).toBe('official-vue 已安装。')

    confirmState.answer = false
    byId('official-uninstall-official-sql').click()
    await flushPromises()
    expect(confirmState.calls[0]!.message).toContain('马上不再生效')
    expect(calls('uninstall_official_plugin')).toHaveLength(0)
    confirmState.answer = true
    byId('official-uninstall-official-sql').click()
    await flushPromises()
    expect(calls('uninstall_official_plugin')[0]![1]).toEqual({ id: 'official-sql', overwrite: false, confirm: true })
    expect(toasts[0]!.message).toBe('已卸载 official-sql。')
  })

  it('官方插件:纯排除规则显示排除项,没有进程钩子时说明是声明式', async () => {
    backend({
      list_skills: SKILLS,
      list_official_plugins: [
        {
          id: 'official-noise',
          name: '构建产物与依赖噪音',
          description: '排除构建目录',
          version: '0.1.0',
          tags: ['index'],
          hooks: [],
          include: ['**/*'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          installed: false,
          installed_version: null,
        },
      ],
    })
    await open(SkillsSection, { aiOn: true })
    const row = byId('official-row-official-noise')
    expect(row.textContent).toContain('处理:**/*')
    expect(byId('official-exclude-official-noise').textContent).toContain('**/node_modules/**')
    expect(row.textContent).toContain('仅声明式规则(无进程)')
  })

  it('重新安装已装插件:先确认覆盖,取消不发请求', async () => {
    backend({ list_skills: SKILLS, list_official_plugins: OFFICIAL, install_official_plugin: { id: 'official-sql' } })
    await open(SkillsSection, { aiOn: true })
    confirmState.answer = false
    byId('official-install-official-sql').click()
    await flushPromises()
    expect(confirmState.calls[0]!.title).toContain('重新安装')
    expect(calls('install_official_plugin')).toHaveLength(0)
    confirmState.answer = true
    byId('official-install-official-sql').click()
    await flushPromises()
    expect(calls('install_official_plugin')[0]![1]).toEqual({ id: 'official-sql', overwrite: true, confirm: true })
  })

  it('官方插件读不到:不拖垮整个 Skills 分区,给出重试', async () => {
    backend({ list_skills: SKILLS, list_official_plugins: new CapabilityError('目录不可写', 'internal', 500) })
    await open(SkillsSection, { aiOn: true })
    expect($('[data-testid=skills-list]')).not.toBeNull()
    expect(byId('official-error').textContent).toContain('读取官方插件失败')
    expect(byId('official-retry')).not.toBeNull()
  })
})

// ---------------------------------------------------------------- MCP

function signIn(features: string[]) {
  const session = useSessionStore()
  session.features = new Set(features)
  session.loaded = true
}

describe('MCP 接入', () => {
  it('两种传输的状态与说明;令牌入口指向个人设置(不在这里重复一份令牌表)', async () => {
    signIn(['sys.settings'])
    await open(McpSection, { transports: ['stdio', 'http'], allowRemote: false })
    expect($('[data-transport=stdio]')!.textContent).toContain('已启用')
    expect($('[data-transport=http]')!.textContent).toContain('已启用')
    expect($('[data-transport=http]')!.textContent).toContain('只允许本机访问')
    expect($('[data-testid=mcp-tokens-link]')!.getAttribute('href')).toBe('/me')
    expect($('[data-testid=mcp-card]')!.textContent).toContain('mcp.transports')
    expect(document.body.textContent).not.toMatch(/2025-11-25|协商版本/)
  })

  it('没启用 http:标「未启用」', async () => {
    signIn(['sys.settings'])
    await open(McpSection, { transports: ['stdio'], allowRemote: false })
    expect($('[data-transport=http]')!.textContent).toContain('未启用')
  })

  it('客户端配置片段:能复制的 JSON,网络地址带本站地址', async () => {
    signIn(['sys.settings'])
    await open(McpSection, { transports: ['stdio'], allowRemote: false })
    const parsed = JSON.parse($('[data-testid=mcp-snippet] pre')!.textContent!)
    expect(parsed.mcpServers.knowledgeBase.args).toEqual(['mcp'])
    expect(parsed.mcpServers['knowledgeBase-http'].url).toBe(`${window.location.origin}/mcp`)
  })

  it('在线客户端数:有 sys.ops 才去读,读到才显示;没有这个功能就不调接口也不显示', async () => {
    signIn(['sys.settings'])
    backend({ system_status: { network: { mcp_sessions: 3 } } })
    await open(McpSection, { transports: ['stdio'], allowRemote: false })
    expect(calls('system_status')).toHaveLength(0)
    expect($('[data-testid=mcp-sessions]')).toBeNull()
    wrapper!.unmount()
    document.body.innerHTML = ''
    signIn(['sys.settings', 'sys.ops'])
    await open(McpSection, { transports: ['stdio'], allowRemote: false })
    expect($('[data-testid=mcp-sessions]')!.textContent).toBe('现在有 3 个客户端在线。')
  })

  it('读不到在线客户端数:不显示这一行,其余照常', async () => {
    signIn(['sys.settings', 'sys.ops'])
    backend({ system_status: new CapabilityError('boom', 'internal', 500) })
    await open(McpSection, { transports: ['stdio'], allowRemote: false })
    expect($('[data-testid=mcp-sessions]')).toBeNull()
    expect($('[data-testid=mcp-card]')).not.toBeNull()
  })
})
