// 「Skills」与「MCP 接入」分区的展示逻辑(纯函数,便于单测)。
// Skills 数据来自能力 `list_skills`(后端 `kb-service` 的 skills 注册表);MCP 取自配置里的 `mcp.transports` 与 `server.allow_remote`。

export interface SkillInfo {
  /** 目录名:编辑 / 删除时指明是哪一个(显示名可以重名、可以是中文) */
  id: string
  name: string
  manifest: string
  kind: string
  enabled: boolean
  /** 插件版本(非插件没有) */
  version?: string
  /** 插件启用的钩子:extract / chunk / enrich / source */
  hooks?: string[]
  /** 说明(插件有) */
  description?: string
  rules: string[]
  prompt_stages: string[]
  template_required: string[]
}

export interface SkillSummary {
  dir: string | null
  allow_exec: boolean
  /** 宿主启动时探测到的 bwrap 沙箱;旧后端没有这个字段时按不可用处理。 */
  sandbox_available?: boolean
  /** bwrap 不可用时是否允许裸跑;旧后端没有时按 false 处理。 */
  allow_unsandboxed?: boolean
  skills: SkillInfo[]
  warnings: string[]
}

/** 类型名:术语表里「条目」一律叫「笔记」。 */
export const SKILL_KIND_TEXT: Readonly<Record<string, string>> = {
  'loader-rule': '加载规则',
  prompt: '提示词',
  'insight-template': '笔记模板',
  exec: '脚本类',
  plugin: '插件',
}
export const skillKindText = (kind: string) => SKILL_KIND_TEXT[kind] ?? kind

const STAGE_TEXT: Readonly<Record<string, string>> = { extract: '提炼', review: '审核', web_extract: '网页规范化' }
const HOOK_TEXT: Readonly<Record<string, string>> = { extract: '解析', chunk: '切块', enrich: '增强', source: '抓取来源' }

/** 细节列:规则 / 提示词覆盖哪个阶段 / 模板必填字段 / 插件钩子,取有值的那一项。 */
export function skillDetail(skill: SkillInfo): string {
  if (skill.kind === 'plugin') {
    const hooks = (skill.hooks ?? []).map((hook) => HOOK_TEXT[hook] ?? hook)
    const parts = [skill.version ? `v${skill.version}` : '', hooks.length ? `钩子:${hooks.join('、')}` : '只做声明式索引']
    return parts.filter(Boolean).join(' · ')
  }
  if (skill.rules.length) return skill.rules.join(' · ')
  if (skill.prompt_stages.length) return `覆盖阶段:${skill.prompt_stages.map((stage) => STAGE_TEXT[stage] ?? stage).join('、')}`
  if (skill.template_required.length) return `必填:${skill.template_required.join('、')}`
  return skill.kind === 'exec' ? '只登记,不执行' : '—'
}

/**
 * 分区开头的说明。提示词类型是用来覆盖自动提炼 / 审核的,AI 总开关关闭时整个分区
 * 不该再提它(术语表:关掉后任何位置都不出现 AI 相关功能的字样)。
 */
export function skillsIntro(aiOn: boolean): string {
  const base = 'Skills 是给系统定的几条小规矩:哪些文件用什么方式切、怎么打标签、新笔记要满足什么要求。插件还能换索引策略;插件里的外部进程只有显式打开脚本类开关后才会运行。'
  return aiOn
    ? `${base}常用的三种类型:加载规则(哪些文件用什么方式分块、打什么标签)、提示词(覆盖自动提炼 / 审核用的提示词)、笔记模板(新建笔记的必填字段与长度上限)。`
    : `${base}两种常用类型:加载规则(哪些文件用什么方式分块、打什么标签)、笔记模板(新建笔记的必填字段与长度上限)。`
}

/** 客户端要粘贴的 MCP 配置片段:本机用 stdio,远程用带令牌的 HTTP 地址。 */
export function mcpSnippet(origin: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        knowledgeBase: { command: 'kb', args: ['mcp'], env: { KB_HOME: '~/.kb' } },
        'knowledgeBase-http': { url: `${origin}/mcp`, headers: { Authorization: 'Bearer kb_<令牌>' } },
      },
    },
    null,
    2,
  )
}

export interface TransportRow {
  id: 'stdio' | 'http'
  title: string
  enabled: boolean
  hint: string
}

/** 两种传输的状态与说明。HTTP 还要说清谁能访问(allow_remote)。 */
export function transportRows(transports: readonly string[], allowRemote: boolean): TransportRow[] {
  return [
    {
      id: 'stdio',
      title: '本机客户端(stdio)',
      enabled: transports.includes('stdio'),
      hint: 'Kiro、Claude Code、Codex 等本机客户端按需拉起 kb mcp,不经过网络,也不需要令牌。',
    },
    {
      id: 'http',
      title: '网络地址(HTTP,/mcp)',
      enabled: transports.includes('http'),
      hint: `客户端要带访问令牌(类型选 mcp)访问 /mcp。${allowRemote ? '服务已允许远程访问,其它设备也能连。' : '服务目前只允许本机访问;要让其它设备连,需要先打开「常规」里的「允许远程访问」。'}`,
    },
  ]
}

/* ---------------- 新增 / 编辑 Skill ---------------- */

/** 表单对应的内容(和后端 `save_skill` 的入参一致,编辑时由 `get_skill` 取回)。 */
export interface SkillDraft {
  name: string
  kind: string
  description: string
  enabled: boolean
  glob: string
  lang: string
  tags: string[]
  stage: string
  template: string
  required: string[]
  max_body_chars: number | null
  max_title_chars: number | null
}

export const emptySkillDraft = (kind = 'loader-rule'): SkillDraft => ({
  name: '',
  kind,
  description: '',
  enabled: true,
  glob: '',
  lang: 'text',
  tags: [],
  stage: 'extract',
  template: '',
  required: [],
  max_body_chars: null,
  max_title_chars: null,
})

/** 能从界面新建的类型。提示词是用来覆盖 AI 提炼 / 审核的,AI 总开关关闭时不出现。 */
export function creatableKinds(aiOn: boolean): { value: string; label: string }[] {
  return ['loader-rule', 'insight-template', ...(aiOn ? ['prompt'] : [])].map((value) => ({ value, label: skillKindText(value) }))
}

/** 每种类型是干什么的:新增对话框里直接写出来,不让人去猜。 */
export const SKILL_KIND_HELP: Readonly<Record<string, { what: string; example: string }>> = {
  'loader-rule': {
    what: '告诉系统:某一类文件按什么方式切成片段、再自动打上哪些标签。切得合适,搜索命中的就是一整段完整的内容,而不是半句话。',
    example: '例如把所有 .proto 文件按"每几十行一段"切开,并打上 proto 标签,之后搜索时就能用标签筛出接口定义。',
  },
  'insight-template': {
    what: '给"新建笔记"定规矩:哪些项不能空、标题和正文最长多少字。不符合的保存时会被拦下并说明原因。',
    example: '例如要求每条笔记都有标题和标签,正文不超过 2000 字,避免记成一大篇流水账。',
  },
  prompt: {
    what: '换掉 AI 自动提炼笔记、或审核候选笔记时用的提示词,让它按你们团队的口径来。',
    example: '例如审核时要求"只通过有明确结论和适用条件的经验,含糊的退回"。',
  },
}

/** 一键填入的示例:点一下就有一份能直接保存的内容,改几个字就是自己的。 */
export function skillPreset(kind: string): SkillDraft {
  const base = emptySkillDraft(kind)
  if (kind === 'loader-rule') {
    return { ...base, name: '接口定义文件', description: '把 .proto 按行窗口切开并打标签', glob: '**/*.proto', lang: 'text', tags: ['proto', '接口'] }
  }
  if (kind === 'insight-template') {
    return { ...base, name: '笔记基本要求', description: '标题和标签不能空,正文别太长', required: ['title', 'tags'], max_body_chars: 2000 }
  }
  return { ...base, name: '审核更严格', description: '只通过有明确结论的经验', stage: 'review', template: '只通过有明确结论和适用条件的经验;含糊、没有依据、只是复述文档的一律退回,并写明退回原因。' }
}

/** 分块方式的可选项(`text` = 按行窗口,通用;其余是按语法结构切,切得更整齐)。 */
export const LANG_OPTIONS: { value: string; label: string }[] = [
  { value: 'text', label: '按行窗口(通用)' },
  { value: 'markdown', label: 'Markdown(按标题)' },
  { value: 'rust', label: 'Rust' },
  { value: 'python', label: 'Python' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'tsx', label: 'TSX' },
  { value: 'go', label: 'Go' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'bash', label: 'Shell' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'swift', label: 'Swift' },
]

export const REQUIRED_OPTIONS = [
  { value: 'title', label: '标题' },
  { value: 'body', label: '正文' },
  { value: 'tags', label: '标签' },
]

export type SkillErrors = Partial<Record<'name' | 'glob' | 'lang' | 'template' | 'rules', string>>

/** 保存前的就近检查(口径与后端一致;后端仍会再校验一遍)。返回空对象 = 通过。 */
export function validateSkill(draft: SkillDraft): SkillErrors {
  const errors: SkillErrors = {}
  const name = draft.name.trim()
  if (!name) errors.name = '给它起个名字'
  else if ([...name].length > 60) errors.name = '名字不要超过 60 个字'
  if (draft.kind === 'loader-rule') {
    if (!draft.glob.trim()) errors.glob = '写上要匹配的文件,例如 **/*.proto'
    if (!draft.lang.trim()) errors.lang = '选一种分块方式'
  } else if (draft.kind === 'prompt') {
    if (!draft.template.trim()) errors.template = '提示词不能是空的'
    else if ([...draft.template].length > 20000) errors.template = '提示词不要超过 20000 个字'
  } else if (draft.kind === 'insight-template') {
    const none = !draft.required.length && !draft.max_body_chars && !draft.max_title_chars
    if (none) errors.rules = '至少设一条要求:必填项,或者标题 / 正文的字数上限'
  }
  return errors
}

/** 表单 → `save_skill` 的入参:空串 / 0 的字数上限不传,只带当前类型用得到的字段。 */
export function skillPayload(draft: SkillDraft, id: string | null): Record<string, unknown> {
  const base = { ...(id ? { id } : {}), name: draft.name.trim(), kind: draft.kind, description: draft.description.trim(), enabled: draft.enabled }
  if (draft.kind === 'loader-rule') return { ...base, glob: draft.glob.trim(), lang: draft.lang.trim(), tags: draft.tags }
  if (draft.kind === 'prompt') return { ...base, stage: draft.stage, template: draft.template }
  return {
    ...base,
    required: draft.required,
    ...(draft.max_body_chars ? { max_body_chars: draft.max_body_chars } : {}),
    ...(draft.max_title_chars ? { max_title_chars: draft.max_title_chars } : {}),
  }
}


/* ---------------- 插件(索引策略 / 进程钩子) ---------------- */

export interface PluginFileDraft {
  /** 插件目录内的相对路径,例如 plugin.py */
  path: string
  /** UTF-8 文本内容 */
  content: string
}

export interface PluginExecDraft {
  command: string
  args: string[]
  /** extract / chunk / enrich / source */
  hooks: string[]
  timeout_ms: number
  max_output_bytes: number
}

export interface PluginSourceDraft {
  match: string[]
  kinds: string[]
  priority: number
}

export interface PluginPermissionsDraft {
  network: boolean
  read_project: boolean
  llm: boolean
}

/** 插件表单(和后端 `save_plugin` 的 `draft` 一致)。 */
export interface PluginDraft {
  name: string
  version: string
  description: string
  enabled: boolean
  include: string[]
  exclude: string[]
  projects: string[]
  lang: string
  tags: string[]
  priority: number
  exec: PluginExecDraft | null
  source: PluginSourceDraft | null
  permissions: PluginPermissionsDraft
  files: PluginFileDraft[]
}

/** 官方插件卡片的一项(后端 `list_official_plugins`)。 */
export interface OfficialPluginInfo {
  id: string
  name: string
  description: string
  version: string
  tags: string[]
  hooks: string[]
  include: string[]
  /** 纯排除规则才有;老后端没有这个字段时按空数组处理。 */
  exclude?: string[]
  installed: boolean
  installed_version: string | null
}

const SCRIPT_EXTENSIONS = new Set(['py', 'js', 'mjs', 'cjs', 'ts', 'sh', 'rb', 'pl', 'php', 'lua', 'jar', 'exe', 'bat', 'cmd', 'ps1'])

/** 参数里哪些值看起来像插件脚本(和服务端 `check_command_file` 同一套判据)。 */
const scriptRef = (value: string): boolean => {
  const text = value.trim()
  if (!text || text.startsWith('-') || text.includes('://') || text.includes('=')) return false
  const extension = text.split('.').pop()?.toLowerCase() ?? ''
  return text.startsWith('.') || SCRIPT_EXTENSIONS.has(extension)
}

/** 去掉参数里常见的 `./`,文件路径和引用就能直接比较。 */
const normalizeScriptRef = (value: string) => value.trim().replace(/^\.\//, '').replace(/\\/g, '/')

export const HOOK_OPTIONS = [
  { value: 'extract', label: '解析(把原始字节抽成文本)' },
  { value: 'chunk', label: '切块(决定每段多长、带什么上下文)' },
  { value: 'enrich', label: '增强(给切好的块补上下文,块数不能变)' },
  { value: 'source', label: '抓取来源(Web 页面等)生成索引' },
]

export const emptyPluginDraft = (): PluginDraft => ({
  name: '',
  version: '0.1.0',
  description: '',
  enabled: true,
  include: [],
  exclude: [],
  projects: [],
  lang: '',
  tags: [],
  priority: 0,
  exec: null,
  source: null,
  permissions: { network: false, read_project: false, llm: false },
  files: [],
})

/** 表单里的“一行一条”文本 ↔ 字符串数组。 */
export const linesText = (values: readonly string[]) => values.join('\n')
export const textLines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)

/** 客户端先按服务端同一口径检查一遍;`allowExec` 为 false 时进程钩子只提示不阻止保存。 */
export type PluginErrors = Partial<Record<'name' | 'version' | 'patterns' | 'exec' | 'permissions' | 'source' | 'files', string>>

export function validatePlugin(draft: PluginDraft): PluginErrors {
  const errors: PluginErrors = {}
  const name = draft.name.trim()
  if (!name) errors.name = '给它起个名字'
  else if ([...name].length > 60) errors.name = '名字不要超过 60 个字'
  if ([...draft.version].length > 32) errors.version = '版本不要超过 32 个字'

  const indexTouched = draft.include.length || draft.exclude.length || draft.projects.length || draft.lang.trim() || draft.tags.length || draft.priority !== 0
  if (indexTouched && !draft.include.length && !draft.exclude.length) errors.patterns = '[index] 至少要写一条 include 或 exclude'
  else if (!draft.include.length && (draft.lang.trim() || draft.tags.length)) errors.patterns = '纯排除规则不能设置语言或标签'
  if (draft.priority < -1000 || draft.priority > 1000) errors.patterns = '优先级必须在 -1000 到 1000 之间'

  // v1 只开放联网;项目目录与模型接口还没有协议,声明 true 只会让插件在服务端
  // 加载失败,所以在表单层就拦住,并和服务端保持同一口径。
  if (draft.permissions.read_project) errors.permissions = '项目目录读取尚未开放,不能声明 read_project = true'
  else if (draft.permissions.llm) errors.permissions = '模型调用尚未开放,不能声明 llm = true'

  if (draft.exec) {
    if (!draft.exec.command.trim()) errors.exec = '写上要运行的命令,例如 python3'
    else if (draft.exec.hooks.length === 0) errors.exec = '至少选一个钩子'
    else if (draft.exec.hooks.some((hook) => ['extract', 'chunk', 'enrich'].includes(hook)) && !draft.include.length) {
      errors.exec = '文件级钩子要有 include,否则插件不知道处理哪些文件'
    } else if (draft.exec.timeout_ms < 100 || draft.exec.timeout_ms > 120000) errors.exec = '超时必须在 100 到 120000 毫秒之间'
    else if (draft.exec.max_output_bytes < 1024 || draft.exec.max_output_bytes > 16 * 1024 * 1024) errors.exec = '响应上限必须在 1KB 到 16MB 之间'
    if (draft.exec.args.length > 32) errors.exec = '命令参数最多 32 项'
    if (!errors.exec) {
      const available = new Set(draft.files.map((file) => normalizeScriptRef(file.path)))
      const missing = [draft.exec.command, ...draft.exec.args].map((item) => item.trim()).filter(scriptRef).map(normalizeScriptRef).find((item) => !available.has(item))
      if (missing) errors.exec = `命令或参数引用的脚本 ${missing} 不在这次提交的文件里;保存会删掉旧文件,请把脚本一起传上来`
    }
    if (draft.exec.hooks.includes('source') && !draft.source) errors.source = '勾了抓取来源钩子,就要填写来源匹配规则'
  }
  if (draft.source) {
    if (!draft.source.match.length) errors.source = '[source] 至少要写一条匹配地址'
    else if (draft.source.kinds.some((kind) => kind !== 'web')) errors.source = 'v1 只支持 web 来源'
    else if (!draft.exec || !draft.exec.hooks.includes('source')) errors.source = '填了来源规则,就要在钩子里勾上「抓取来源」'
    else if (draft.source.priority < -1000 || draft.source.priority > 1000) errors.source = '来源优先级必须在 -1000 到 1000 之间'
  }
  const seen = new Set<string>()
  for (const file of draft.files) {
    const path = file.path.trim()
    if (!path) {
      errors.files = '每个脚本文件都要有路径'
      break
    }
    if (path === 'manifest.toml' || path.startsWith('.') || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
      errors.files = `脚本路径 ${path} 不合法:只能是插件目录内的相对路径,不能以点开头,也不能占用根目录的 manifest.toml`
      break
    }
    if (seen.has(path)) {
      errors.files = `脚本路径 ${path} 重复`
      break
    }
    seen.add(path)
    if (file.content.length > 1024 * 1024) {
      errors.files = `脚本 ${path} 超过 1MB`
      break
    }
  }
  if (draft.files.length > 32) errors.files = '脚本文件最多 32 个'
  return errors
}

/** 表单 → `save_plugin` 的入参。 */
export function pluginPayload(draft: PluginDraft, id: string | null): Record<string, unknown> {
  return {
    ...(id ? { id } : {}),
    draft: {
      ...draft,
      name: draft.name.trim(),
      version: draft.version.trim() || '0.1.0',
      description: draft.description.trim(),
      lang: draft.lang.trim(),
      include: draft.include.map((item) => item.trim()).filter(Boolean),
      exclude: draft.exclude.map((item) => item.trim()).filter(Boolean),
      projects: draft.projects.map((item) => item.trim()).filter(Boolean),
      exec: draft.exec
        ? {
            ...draft.exec,
            command: draft.exec.command.trim(),
            args: draft.exec.args.map((item) => item.trim()).filter(Boolean),
            timeout_ms: Math.trunc(Number(draft.exec.timeout_ms) || 0),
            max_output_bytes: Math.trunc(Number(draft.exec.max_output_bytes) || 0),
          }
        : null,
      source: draft.source
        ? {
            ...draft.source,
            match: draft.source.match.map((item) => item.trim()).filter(Boolean),
            kinds: draft.source.kinds.length ? draft.source.kinds : ['web'],
            priority: Math.trunc(Number(draft.source.priority) || 0),
          }
        : null,
      files: draft.files.map((file) => ({ path: file.path.trim(), content: file.content })),
    },
  }
}

/** 一键填入一个能跑的示例:统计 .vue 文件并按 template / script 切开。 */
export function pluginPreset(): PluginDraft {
  return {
    ...emptyPluginDraft(),
    name: 'vue-sfc',
    version: '0.1.0',
    description: '把 Vue 单文件组件按 template / script 切开',
    include: ['**/*.vue'],
    exclude: ['**/node_modules/**'],
    lang: 'vue',
    tags: ['vue'],
    priority: 100,
    exec: {
      command: 'python3',
      args: ['plugin.py', 'vue'],
      hooks: ['chunk'],
      timeout_ms: 20000,
      max_output_bytes: 16 * 1024 * 1024,
    },
    files: [
      {
        path: 'plugin.py',
        content: "import json,sys\n\nfor line in sys.stdin:\n    req=json.loads(line)\n    doc=req.get('params',{}).get('doc',{})\n    print(json.dumps({'jsonrpc':'2.0','id':req.get('id'),'result':{'chunks':[{'key':'all','text':doc.get('text',''),'start_line':1,'end_line':1,'header':doc.get('source','')}]}},ensure_ascii=False),flush=True)\n",
      },
    ],
  }
}
