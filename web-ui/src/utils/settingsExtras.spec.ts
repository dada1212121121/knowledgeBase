import { describe, expect, it } from 'vitest'
import {
  emptyPluginDraft,
  mcpSnippet,
  pluginPayload,
  skillDetail,
  skillKindText,
  skillsIntro,
  transportRows,
  validatePlugin,
  type PluginDraft,
  type SkillInfo,
} from './settingsExtras'

const skill = (extra: Partial<SkillInfo>): SkillInfo => ({ id: 's', name: 's', manifest: '/x', kind: 'loader-rule', enabled: true, rules: [], prompt_stages: [], template_required: [], ...extra })

describe('skillDetail', () => {
  it('加载规则:列出规则', () => {
    expect(skillDetail(skill({ rules: ['**/*.proto → text · proto', '**/*.md → md'] }))).toBe('**/*.proto → text · proto · **/*.md → md')
  })

  it('提示词:覆盖的阶段用中文', () => {
    expect(skillDetail(skill({ kind: 'prompt', prompt_stages: ['extract', 'review'] }))).toBe('覆盖阶段:提炼、审核')
    expect(skillDetail(skill({ kind: 'prompt', prompt_stages: ['custom'] }))).toBe('覆盖阶段:custom')
    expect(skillDetail(skill({ kind: 'prompt', prompt_stages: ['web_extract'] }))).toBe('覆盖阶段:网页规范化')
  })

  it('笔记模板:必填字段', () => {
    expect(skillDetail(skill({ kind: 'insight-template', template_required: ['title', 'body'] }))).toBe('必填:title、body')
  })

  it('脚本类只登记不执行;其它没有细节写「—」', () => {
    expect(skillDetail(skill({ kind: 'exec' }))).toBe('只登记,不执行')
    expect(skillDetail(skill({}))).toBe('—')
  })

  it('插件:版本 + 钩子,没有钩子说明只做声明式索引', () => {
    expect(skillDetail(skill({ kind: 'plugin', version: '0.1.0', hooks: ['chunk', 'source'] }))).toBe('v0.1.0 · 钩子:切块、抓取来源')
    expect(skillDetail(skill({ kind: 'plugin' }))).toBe('只做声明式索引')
  })
})

describe('skillKindText', () => {
  it('术语表的说法:笔记模板,不是“条目模板”;插件单独一类', () => {
    expect(skillKindText('insight-template')).toBe('笔记模板')
    expect(skillKindText('loader-rule')).toBe('加载规则')
    expect(skillKindText('plugin')).toBe('插件')
    expect(skillKindText('mystery')).toBe('mystery')
  })
})

describe('插件表单校验', () => {
  const draft = (extra: Partial<PluginDraft>): PluginDraft => ({ ...emptyPluginDraft(), ...extra })

  it('名称必填;文件级钩子必须有 include;抓取来源必须有 match 和 source 钩子', () => {
    expect(validatePlugin(draft({})).name).toContain('名字')
    const exec = { command: 'python3', args: ['plugin.py'], hooks: ['chunk'], timeout_ms: 20000, max_output_bytes: 16 * 1024 * 1024 }
    expect(validatePlugin(draft({ name: 'x', exec })).exec).toContain('include')
    expect(validatePlugin(draft({ name: 'x', include: ['**/*.vue'], exec, files: [{ path: 'plugin.py', content: '' }] })).exec).toBeUndefined()
    expect(validatePlugin(draft({ name: 'x', include: ['**/*.vue'], exec })).exec).toContain('plugin.py')
    expect(validatePlugin(draft({ name: 'x', include: ['**/*.vue'], exec, source: { match: [], kinds: ['web'], priority: 0 } })).source).toContain('匹配地址')
    expect(validatePlugin(draft({ name: 'x', include: ['**/*.vue'], exec, source: { match: ['https://a/**'], kinds: ['web'], priority: 0 } })).source).toContain('抓取来源')
  })

  it('未开放的项目目录 / 模型权限不能声明为 true', () => {
    const exec = { command: 'python3', args: ['plugin.py'], hooks: ['chunk'], timeout_ms: 20000, max_output_bytes: 16 * 1024 * 1024 }
    const base = { name: 'x', include: ['**/*.vue'], exec, files: [{ path: 'plugin.py', content: '' }] }
    expect(validatePlugin(draft({ ...base, permissions: { network: false, read_project: true, llm: false } })).permissions).toContain('项目目录')
    expect(validatePlugin(draft({ ...base, permissions: { network: false, read_project: false, llm: true } })).permissions).toContain('模型')
    expect(validatePlugin(draft({ ...base, permissions: { network: true, read_project: false, llm: false } })).permissions).toBeUndefined()
  })

  it('纯排除不能带语言 / 标签;版本、优先级、超时和来源优先级会检查', () => {
    expect(validatePlugin(draft({ name: 'x', version: 'v'.repeat(33) })).version).toContain('32')
    expect(validatePlugin(draft({ name: 'x', exclude: ['**/dist/**'], lang: 'vue' })).patterns).toContain('纯排除')
    expect(validatePlugin(draft({ name: 'x', include: ['**/*.vue'], priority: 2000 })).patterns).toContain('-1000')
    const exec = { command: 'python3', args: ['plugin.py'], hooks: ['chunk'], timeout_ms: 10, max_output_bytes: 16 * 1024 * 1024 }
    expect(validatePlugin(draft({ name: 'x', include: ['**/*.vue'], exec })).exec).toContain('超时')
    const sourceExec = { ...exec, hooks: ['source'] }
    const source = { match: ['https://docs.example.com/**'], kinds: ['web'], priority: 2000 }
    expect(validatePlugin(draft({ name: 'x', exec: sourceExec, source })).source).toContain('-1000')
  })

  it('脚本路径不能逃出插件目录、不能覆盖 manifest、不能重复', () => {
    const base = { name: 'x', include: ['**/*.vue'] }
    expect(validatePlugin(draft({ ...base, files: [{ path: '../evil.py', content: '' }] })).files).toContain('不合法')
    expect(validatePlugin(draft({ ...base, files: [{ path: '/abs.py', content: '' }] })).files).toContain('不合法')
    expect(validatePlugin(draft({ ...base, files: [{ path: 'manifest.toml', content: '' }] })).files).toContain('不合法')
    expect(validatePlugin(draft({ ...base, files: [{ path: 'a/./b.py', content: '' }] })).files).toContain('不合法')
    expect(validatePlugin(draft({ ...base, files: [{ path: 'a.py', content: '' }, { path: 'a.py', content: '' }] })).files).toContain('重复')
  })

  it('提交前去掉空行 / 首尾空格;新建不带 id,编辑带目录名', () => {
    const form = draft({
      name: '  vue-sfc  ',
      include: [' **/*.vue ', ''],
      tags: ['vue'],
      files: [{ path: ' plugin.py ', content: 'print(1)' }],
    })
    expect(pluginPayload(form, null)).toMatchObject({ draft: { name: 'vue-sfc', include: ['**/*.vue'], files: [{ path: 'plugin.py', content: 'print(1)' }] } })
    expect(pluginPayload(form, null)).not.toHaveProperty('id')
    expect(pluginPayload(form, 'vue-sfc')).toMatchObject({ id: 'vue-sfc' })
  })
})

describe('skillsIntro', () => {
  it('AI 开着:三种类型,含提示词', () => {
    expect(skillsIntro(true)).toContain('三种类型')
    expect(skillsIntro(true)).toContain('提示词')
  })

  it('AI 关闭:不提提示词 / 提炼 / 审核,任何位置没有「AI」', () => {
    const text = skillsIntro(false)
    expect(text).not.toMatch(/提示词|提炼|审核|AI/)
    expect(text).toContain('加载规则')
  })
})

describe('MCP', () => {
  it('配置片段:本机 stdio + 带令牌的 HTTP 地址', () => {
    const parsed = JSON.parse(mcpSnippet('https://kb.example.com'))
    expect(parsed.mcpServers.knowledgeBase).toEqual({ command: 'kb', args: ['mcp'], env: { KB_HOME: '~/.kb' } })
    expect(parsed.mcpServers['knowledgeBase-http']).toEqual({ url: 'https://kb.example.com/mcp', headers: { Authorization: 'Bearer kb_<令牌>' } })
  })

  it('传输状态:按配置里启用了哪些', () => {
    expect(transportRows(['stdio'], false).map((row) => [row.id, row.enabled])).toEqual([['stdio', true], ['http', false]])
    expect(transportRows(['stdio', 'http'], true).map((row) => row.enabled)).toEqual([true, true])
    expect(transportRows([], false).map((row) => row.enabled)).toEqual([false, false])
  })

  it('HTTP 的说明点明谁能访问:不允许远程时指路到「允许远程访问」', () => {
    expect(transportRows(['http'], false)[1]!.hint).toContain('允许远程访问')
    expect(transportRows(['http'], true)[1]!.hint).toContain('其它设备也能连')
  })

  it('说明里没有 token / scope 这类英文词', () => {
    for (const row of transportRows(['stdio', 'http'], false)) expect(row.hint).not.toMatch(/\b(token|scope|api)\b/i)
  })
})
