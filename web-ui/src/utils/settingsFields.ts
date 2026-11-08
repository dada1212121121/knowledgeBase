// 系统设置页的字段表(纯数据 + 纯函数,便于单测)。
//
// 页面完全由这张表驱动:每个配置项一行,带中文标签、一句帮助文字(作用 + 改了的后果)、
// 取值范围、默认值和生效方式;配置键名放在帮助文字里,不当标签(术语表「配置项与技术名词」)。
// 范例见 utils/systemParams.ts(系统参数页)。
//
// 默认值、取值范围、生效方式的权威来源是 `crates/kb-core/src/config/mod.rs`:
// `settingsFields.spec.ts` 会读那个文件逐项核对,表里写错(或后端改了没跟上)单测就变红。
//
// 保存时只提交**改过的键**(`{ backup: { keep_count: 0 } }`),不是整段:后端是合并语义,
// 没写的键不动。整段提交会把页面开着期间别处写入的值(例如「按反馈调整权重」写进
// `search.collection_weights`)用旧值盖回去。

import { failureOf } from './loadState'
import type { SectionId } from './settingsNav'

export type FieldKind = 'bool' | 'int' | 'number' | 'text' | 'choice' | 'time' | 'list'

/** 配置改动的生效方式(与 config.rs 的 `ChangeScope` 一一对应)。 */
export type ChangeScope = 'hot' | 'restart' | 'migration'

export interface ChoiceOption {
  value: string
  label: string
}

export interface SettingField {
  /** 点号路径,即 config.toml 里的键,如 `backup.interval_hours`。 */
  path: string
  /** 中文标签。 */
  label: string
  /** 一句帮助文字:这项管什么、改了有什么后果。取值范围与默认值由 `rangeText` 另行拼上。 */
  hint: string
  kind: FieldKind
  /** 数字框后面的单位。 */
  unit?: string
  min?: number
  max?: number
  /** 默认值(与 config.rs 的 `Default` 一致,单测核对)。 */
  def?: number | boolean | string | string[]
  /** 单选的选项;不写时由页面按运行情况提供(例如服务商列表)。 */
  options?: ChoiceOption[]
  placeholder?: string
  /** 开关打开时显示的风险提示。 */
  riskOn?: string
  /** 填成某个值时显示的风险提示(例如 `0` = 不限)。 */
  riskValue?: { value: string; text: string }
  /** 只展示,不能在这里改(嵌入段:任何改动后端都只给迁移计划,不会落盘)。 */
  readonly?: boolean
  /** 这些字段变了也要重新校验本项(例如监听地址是否需要「允许远程访问」)。 */
  watch?: string[]
  /** 额外校验:返回报错文案,通过返回 null。 */
  validate?: (value: string, draft: Draft) => string | null
}

export interface FieldGroup {
  id: string
  section: SectionId
  title: string
  /** 卡片上方的一段说明。 */
  note?: string
  /** 调用大模型的分组:AI 总开关关闭后不出现。 */
  ai?: boolean
  fields: SettingField[]
}

/** 表单里的草稿值:开关是布尔,其余都是字符串(直接绑输入框)。 */
export type Draft = Record<string, string | boolean>
type Json = Record<string, unknown>

// ---------------------------------------------------------------- 生效方式

/**
 * 立即生效的键前缀与整键。**必须与 config.rs 的 `classify_change` 逐项一致**
 * (单测会把那个函数里的字面量读出来比对)。
 */
export const HOT_PREFIXES = ['search.', 'ai.', 'accounts.', 'quota.', 'share.', 'site.', 'mail.', 'rerank.', 'schedule.', 'backup.', 'office.', 'editor.', 'web_extract.'] as const
export const HOT_KEYS = [
  'log.level',
  'index.exclude',
  'index.parallel_slices',
  'index.parallel_files',
  'evolution.session_roots',
  'llm.daily_token_budget',
  'llm.max_calls_per_hour',
  'llm.provider',
  'llm.base_url',
  'llm.extract_model',
  'llm.review_model',
  'llm.agent_model',
] as const

/**
 * `embed.*` 里只在启动时读一次、不改变向量内容的键:提示重启即可。
 * **必须与 config.rs 的 `classify_change` 一致**:以前整个 `embed.*` 都判成迁移,
 * 后端就会因为改了一个卸载时间而让整份配置都不生效。
 */
export const EMBED_RESTART_KEYS = ['embed.idle_unload_minutes', 'embed.threads', 'embed.preload'] as const

/** 一个键改了以后怎么生效:`embed.*` 要先迁移(上面几项例外),白名单里的立即生效,其余都要重启。 */
export function changeScope(path: string): ChangeScope {
  if ((EMBED_RESTART_KEYS as readonly string[]).includes(path)) return 'restart'
  if (path === 'embed' || path.startsWith('embed.')) return 'migration'
  if (HOT_PREFIXES.some((prefix) => path.startsWith(prefix)) || (HOT_KEYS as readonly string[]).includes(path)) return 'hot'
  return 'restart'
}

export const needsRestart = (path: string) => changeScope(path) === 'restart'

// ---------------------------------------------------------------- 校验用的小函数

const URL_PATTERN = /^https?:\/\/[^\s/]+/i
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** 解析 `server.listen`("IP:端口"):不是合法写法返回 null。与后端 `SocketAddr` 的解析口径一致(不收主机名)。 */
export function parseListen(value: string): { loopback: boolean } | null {
  const text = value.trim()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(text)
  if (v4) {
    const octets = v4.slice(1, 5).map(Number)
    if (octets.some((part) => part > 255) || Number(v4[5]) > 65535) return null
    return { loopback: octets[0] === 127 }
  }
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(text)
  if (v6 && v6[1]!.includes(':') && Number(v6[2]) <= 65535) {
    return { loopback: v6[1] === '::1' }
  }
  return null
}

/** 把「逗号或换行分隔」的目录文本拆成数组。 */
export function splitList(text: string): string[] {
  return text
    .split(/[,，\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function validateListen(value: string, draft: Draft): string | null {
  const parsed = parseListen(value)
  if (!parsed) return '要写成「IP:端口」,例如 127.0.0.1:7878(不能写主机名)'
  if (!parsed.loopback && draft['server.allow_remote'] !== true) {
    return '这不是本机地址,需要同时打开下面的「允许远程访问」,否则服务启动不了'
  }
  return null
}

function validateMirrorDirs(value: string): string | null {
  const dirs = splitList(value)
  if (dirs.length > 4) return `最多 4 个目录,现在写了 ${dirs.length} 个`
  const bad = dirs.find((dir) => dir.split('/').some((part) => part === '..'))
  if (bad) return `不能用「..」,请写绝对路径:${bad}`
  return null
}

function validateUrl(value: string): string | null {
  return URL_PATTERN.test(value.trim()) ? null : '要以 http:// 或 https:// 开头'
}

// ---------------------------------------------------------------- 字段表

export const FIELD_GROUPS: FieldGroup[] = [
  // ---- 常规
  {
    id: 'server',
    section: 'general',
    title: '服务地址',
    fields: [
      {
        path: 'server.listen',
        label: '监听地址',
        kind: 'text',
        def: '127.0.0.1:7878',
        placeholder: '127.0.0.1:7878',
        hint: '浏览器和接口访问这个服务用的「IP:端口」。改成非本机地址时必须同时打开「允许远程访问」,改完要重启,并用新地址访问。',
        watch: ['server.allow_remote'],
        validate: validateListen,
      },
      {
        path: 'server.allow_remote',
        label: '允许远程访问',
        kind: 'bool',
        def: false,
        hint: '打开后,局域网或公网上的其它设备也能连到这个服务;关闭时只有本机能访问。',
        riskOn: '风险较高:服务会对外暴露。请先确认已设置强密码,并在前面加上 HTTPS 反向代理。',
      },
      {
        path: 'server.warm_on_start',
        label: '启动时等模型就绪',
        kind: 'bool',
        def: true,
        hint: '打开时,守护进程要等嵌入模型加载完才对外服务(模型起不来会直接启动失败,问题暴露得早);关闭后先让服务可用,模型在后台加载,加载完成前的检索和导入会报「正在加载」。服务与 embed sidecar 一起重启、嫌弃重启窗口长时再关。',
      },
    ],
  },

  // ---- 存储与索引
  {
    id: 'index',
    section: 'storage',
    title: '文件监听与索引',
    fields: [
      {
        path: 'index.watch',
        label: '监视文件变化',
        kind: 'bool',
        def: true,
        hint: '打开后,项目目录里的文件一有改动就自动重新索引;关闭后只在手动同步或夜间校验时才更新。',
      },
      {
        path: 'index.debounce_ms',
        label: '改动合并等待时间',
        kind: 'int',
        unit: '毫秒',
        min: 0,
        def: 2000,
        hint: '文件连续改动时,等安静这么久再一起索引,避免保存一次就索引一次。调小更及时但更耗 CPU。',
      },
      {
        path: 'index.max_file_bytes',
        label: '单个文件大小上限',
        kind: 'int',
        unit: '字节',
        min: 1,
        def: 204800,
        hint: '超过这个大小的文件不会被索引,免得大文件拖慢整个知识库。204,800 字节约 200 KB。',
      },
    ],
  },
  {
    id: 'meta',
    section: 'storage',
    title: '数据库',
    fields: [
      {
        path: 'meta.read_pool',
        label: '数据库读连接数',
        kind: 'int',
        unit: '个',
        min: 1,
        max: 8,
        def: 4,
        hint: '同时读取元数据库的连接数。调大能让多人同时浏览更顺畅,但更占内存。',
      },
    ],
  },
  {
    id: 'convert',
    section: 'storage',
    title: '旧格式文档转换',
    note: '.doc、.xls、.rtf、.odt、.ods 这类旧格式的办公文档,默认只是原样保存、搜不到里面的字。打开转换后,入库时会用服务器上装好的 LibreOffice 转出一份临时文件来抽取文字,让它们能被搜到;原文件一个字节都不动。需要先在服务器上运行 kb convert install 安装,并重启服务。',
    fields: [
      {
        path: 'convert.enabled',
        label: '入库时转换旧格式文档',
        kind: 'bool',
        def: false,
        hint: '打开后,新导入的旧格式办公文档会先转换再抽取文字。没装 LibreOffice 时这一项不生效,文件照旧原样保存。',
      },
      {
        path: 'convert.timeout_secs',
        label: '单个文件转换时限',
        kind: 'int',
        unit: '秒',
        min: 1,
        max: 3600,
        def: 120,
        hint: '一个文件转换超过这个时间就放弃并结束转换进程,这个文件按转换失败处理。',
      },
      {
        path: 'convert.max_concurrent',
        label: '同时转换的文件数',
        kind: 'int',
        unit: '个',
        min: 1,
        max: 8,
        def: 1,
        hint: '全站最多同时转换几个文件。每个转换进程峰值约占 320 MB 内存,机器内存紧张时保持 1。',
      },
    ],
  },
  {
    id: 'office',
    section: 'storage',
    title: '文档在线编辑',
    note: '在知识库里直接编辑 Word、Excel、PowerPoint 文件:保存后新内容替换原文件。替换前的内容作为旧版本备份,可以在版本历史里恢复。',
    fields: [
      {
        path: 'office.keep_versions',
        label: '保留的旧版本份数',
        kind: 'int',
        unit: '份',
        min: 0,
        max: 50,
        def: 3,
        hint: '每个文件除了当前这一版,再留几份旧版本备份,超出的从最旧的开始删。填 0 表示不留,保存后旧内容就没了。每份备份占一个文件那么大的磁盘。',
      },
      {
        path: 'office.collab',
        label: 'Word / Excel / PowerPoint 多人同时编辑',
        kind: 'bool',
        def: true,
        hint: '打开时几个人可以同时改一份办公文档,互相实时看到修改和光标,停手后自动保存。要服务器上装了协同服务(office-worker);关掉或没装时退回一个人编辑、别人只读。',
      },
    ],
  },
  {
    id: 'office_ai',
    section: 'storage',
    ai: true,
    title: 'AI 修改文档',
    note: 'AI 工具经 MCP 读写在线文档(笔记、Markdown、代码与文本、CSV、Word / Excel / PowerPoint)时的规则。',
    fields: [
      {
        path: 'office.agent_direct_edit',
        label: 'AI 直接修改文档',
        kind: 'bool',
        def: false,
        hint: '关着时 AI 只能提修改建议,要有人在文档页上接受才生效;打开后 AI 直接改,正在多人编辑时修改实时出现在大家的编辑器里。两种情况的改动都进版本历史,可以恢复。',
      },
    ],
  },
  {
    id: 'schedule',
    section: 'storage',
    title: '调度与维护',
    note: '这两项管后台定时做的事:每天一次全量校验,每隔一段时间整理一次索引存储。',
    fields: [
      {
        path: 'schedule.nightly_at',
        label: '夜间全量校验时间',
        kind: 'time',
        def: '03:00',
        placeholder: '03:00',
        hint: '每天这个时间(服务器本地时间)对所有已登记的目录做一次全量指纹校验,补上漏掉的改动。请选在没人用的时段。',
      },
      {
        path: 'schedule.optimize_interval_minutes',
        label: '索引整理间隔',
        kind: 'int',
        unit: '分钟',
        min: 1,
        def: 60,
        hint: '每隔多久整理一次索引存储(合并碎片、清理过期数据),让搜索保持流畅。间隔太短会占用磁盘读写。',
      },
    ],
  },

  // ---- 搜索与排序
  {
    id: 'search',
    section: 'search',
    title: '搜索参数',
    fields: [
      {
        path: 'search.k',
        label: '默认返回条数',
        kind: 'int',
        unit: '条',
        min: 1,
        max: 100,
        def: 8,
        hint: '搜索时一次最多给几条结果。调大结果更全,但读起来更长。',
      },
      {
        path: 'search.global_weight',
        label: '公共集合的权重',
        kind: 'number',
        min: 0,
        def: 0.8,
        hint: '把项目集合和公共集合(_global)的结果合并排序时,公共集合的权重。1 表示同等重要,调低会让公共内容排得更靠后。',
      },
      {
        path: 'search.rrf_k',
        label: '合并排序的平滑系数',
        kind: 'int',
        min: 1,
        def: 60,
        hint: '多路结果合并排序时用的常数:越大,名次靠前和靠后的差距越小。一般保持默认。',
      },
      {
        path: 'search.window_context_lines',
        label: '代码结果的上下文行数',
        kind: 'int',
        unit: '行',
        min: 0,
        def: 8,
        hint: '代码类结果会在命中的位置前后各补这么多行,方便直接读懂;调大上下文更完整,但结果更长。',
      },
      {
        path: 'search.query_cache_entries',
        label: '查询缓存条数',
        kind: 'int',
        unit: '条',
        min: 0,
        max: 10000,
        def: 512,
        hint: '同一个知识库里重复的查询直接复用上次算出的向量,不用再跑一遍模型。填 0 表示关掉缓存。',
      },
      {
        path: 'search.query_cache_ttl_secs',
        label: '查询缓存有效期',
        kind: 'int',
        unit: '秒',
        min: 0,
        max: 86400,
        def: 900,
        hint: '缓存最多留多久。填 0 表示一直留着;换了嵌入模型或重调了索引参数,旧向量会按这个时长自然失效。',
      },
    ],
  },

  // ---- 模型(AI)
  {
    id: 'llm',
    section: 'model',
    ai: true,
    title: '内置模型',
    note: '自动提炼、审核、深度检索和主题归纳用这里的模型;聊天走「编码代理」。提炼和审核会把项目里的文本发到下面的接口地址,请只填你信任的服务。',
    fields: [
      {
        path: 'llm.provider',
        label: '服务商',
        kind: 'choice',
        def: 'deepseek',
        hint: '用哪家的大模型服务。换服务商后记得同步改接口地址和模型名,并重新保存密钥。',
      },
      {
        path: 'llm.base_url',
        label: '接口地址',
        kind: 'text',
        def: 'https://api.deepseek.com',
        placeholder: 'https://api.deepseek.com',
        hint: '服务商提供的 OpenAI 兼容接口地址。',
        validate: validateUrl,
      },
      {
        path: 'llm.extract_model',
        label: '提炼用模型',
        kind: 'text',
        def: 'deepseek-flash',
        hint: '从提交和会话里整理候选笔记时用的模型,调用最频繁,适合选便宜快速的。',
      },
      {
        path: 'llm.review_model',
        label: '审核用模型',
        kind: 'text',
        def: 'deepseek-v4-pro',
        hint: '判断候选笔记值不值得保留时用的模型,建议和提炼用不同的模型。',
      },
      {
        path: 'llm.agent_model',
        label: '归纳与深度检索用模型',
        kind: 'text',
        def: 'deepseek-v4-pro',
        hint: '归纳主题、深度检索时改写查询用的模型。',
      },
    ],
  },
  {
    id: 'cost',
    section: 'model',
    ai: true,
    title: '费用保护',
    note: '模型按用量收费。这两项是兜底的闸门:到上限就停止调用,避免出问题时账单失控。',
    fields: [
      {
        path: 'llm.daily_token_budget',
        label: '每个模型每天的用量上限',
        kind: 'int',
        min: 0,
        def: 2000000,
        hint: '按模型分别累计当天的用量(输入加输出,口径与服务商计费一致),达到上限后该模型当天不再被调用,次日恢复。0 表示不限。',
        riskValue: { value: '0', text: '已不限制用量:模型被频繁调用时会产生持续的费用。' },
      },
      {
        path: 'llm.max_calls_per_hour',
        label: '每小时最多调用次数',
        kind: 'int',
        unit: '次',
        min: 0,
        def: 60,
        hint: '提炼、审核、深度检索、助手共用这一份,只统计成功发出的调用;超过后新的调用会被拒绝,直到这一小时过去。0 表示不限,并发时可能略超。',
        riskValue: { value: '0', text: '已不限制次数:模型被频繁调用时会产生持续的费用。' },
      },
    ],
  },
  {
    id: 'web_extract',
    section: 'model',
    ai: true,
    title: '网页 AI 规范化',
    note: '网页来源抓到的页面再交给「提炼用模型」整理成结构固定的内容(原文照常入库)。每个网页来源有自己的开关和提取要求;内容没变的页面不会重复调用。',
    fields: [
      {
        path: 'web_extract.enabled_by_default',
        label: '新建网页来源默认开启',
        kind: 'bool',
        def: true,
        hint: '添加网页来源时「AI 规范化」开关的初始状态。已有来源不受影响。',
        riskOn: '外发与费用:新网页来源抓到的页面会发给上面的模型服务,按页计费。',
      },
      {
        path: 'web_extract.max_input_chars',
        label: '单次送给模型的正文上限',
        kind: 'int',
        unit: '字',
        min: 2000,
        max: 200000,
        def: 24000,
        hint: '更长的页面按段落切成几段,每段调用一次模型。太小切得碎、调用次数多;太大可能超过模型能接收的长度。',
      },
      {
        path: 'web_extract.max_parts',
        label: '超长页面最多切几段',
        kind: 'int',
        unit: '段',
        min: 1,
        max: 20,
        def: 4,
        hint: '超出部分不送模型(原文仍完整入库),整理结果里会注明只整理了前几段。',
      },
      {
        path: 'web_extract.max_pages_per_sync',
        label: '每次同步最多整理几页',
        kind: 'int',
        unit: '页',
        min: 1,
        max: 200,
        def: 50,
        hint: '一个大站一次同步不会花光当天额度;剩下的页在下次同步时接着整理。',
      },
    ],
  },
  {
    id: 'evolution',
    section: 'model',
    ai: true,
    title: '自动提炼',
    fields: [
      {
        path: 'evolution.extract_enabled_default',
        label: '新项目默认开启自动提炼',
        kind: 'bool',
        def: false,
        hint: '新登记的项目默认是否自动整理候选笔记(进审核收件箱)。已有项目不受影响;每个项目另有「允许发给云端模型」的开关,两个都开才会外发内容。',
        riskOn: '外发风险:新项目的提交和会话内容会发给上面的模型服务。',
      },
      {
        path: 'evolution.dedup_similarity',
        label: '重复判定的相似度',
        kind: 'number',
        min: 0,
        max: 1,
        def: 0.92,
        hint: '新整理出的笔记与已有笔记的相似度达到这个值,就当作重复丢弃。调高更宽松(留下更多相近的笔记),调低更严格。',
      },
    ],
  },

  // ---- 组件:嵌入(只读)
  {
    id: 'embed',
    section: 'components',
    title: '嵌入',
    note: '嵌入把文字转成可以比较相似度的向量,搜索靠它找到意思相近的内容。这一组只读:任何嵌入相关的改动,服务端都只给出迁移计划、不会直接写入。换模型要先迁移已有集合(停服 → kb migrate → 启动),其它参数改 config.toml 后重启。',
    fields: [
      {
        path: 'embed.backend',
        label: '嵌入引擎',
        kind: 'text',
        readonly: true,
        def: 'fastembed',
        hint: 'fastembed 在本机运行;http 调用外部的向量服务。',
      },
      {
        path: 'embed.model',
        label: '嵌入模型',
        kind: 'text',
        readonly: true,
        def: 'bge-m3-int8',
        hint: '换模型会改变向量,已有集合必须先迁移。',
      },
      {
        path: 'embed.max_tokens',
        label: '单块文本上限',
        kind: 'int',
        readonly: true,
        def: 512,
        hint: '每一块文本送去嵌入前的长度上限,超出的部分会被截掉。',
      },
      {
        path: 'embed.batch_size',
        label: '每批处理块数',
        kind: 'int',
        readonly: true,
        min: 1,
        max: 64,
        def: 8,
        hint: '一次送去嵌入的文本块数。调大更快但更占内存。',
      },
      {
        path: 'embed.preload',
        label: '启动时加载模型',
        kind: 'bool',
        readonly: true,
        def: true,
        hint: '打开后服务启动时就把模型载入内存,第一次搜索不用等;内存紧张时可以关闭。',
      },
    ],
  },

  // ---- OCR 与转写
  {
    id: 'ocr',
    section: 'ocr',
    title: '图片文字识别(OCR)',
    fields: [
      {
        path: 'extract.ocr_enabled',
        label: '识别图片和扫描件里的文字',
        kind: 'bool',
        def: false,
        hint: '打开后,导入的图片和扫描件会先识别成文字再索引,搜索才搜得到里面的字。关闭,或识别引擎还没装好时,只留一个占位说明,不影响导入。',
      },
      {
        path: 'extract.ocr_model_size',
        label: '识别模型大小',
        kind: 'choice',
        def: 'small',
        options: [
          { value: 'small', label: '小(更快)' },
          { value: 'medium', label: '中(更准,更慢更占内存)' },
        ],
        hint: '只对默认的 RapidOCR 引擎有效。',
      },
      {
        path: 'extract.ocr_language',
        label: '备用引擎的识别语言',
        kind: 'text',
        def: 'chi_sim+eng',
        placeholder: 'chi_sim+eng',
        hint: '只在默认引擎用不了、改用 tesseract 时生效,写法如 chi_sim+eng(简体中文加英文)。',
      },
      {
        path: 'extract.ocr.slots',
        label: '同时识别几份文件',
        unit: '份',
        kind: 'int',
        min: 0,
        max: 16,
        def: 0,
        riskValue: { value: '0', text: '按核数自动:核数除以 4,最少 1 份、最多 4 份。' },
        hint: '识别很吃 CPU,调大能多份并行、但会把机器压满。填 0 按核数自动。',
      },
      {
        path: 'extract.ocr.budget_secs',
        label: '单份最多识别多久',
        unit: '秒',
        kind: 'int',
        min: 30,
        max: 3600,
        def: 300,
        hint: '到时间就停下,没识别完的页只留提示。配合下面的页数上限一起,防止一份大扫描件占住整个导入队列。',
      },
      {
        path: 'extract.ocr.max_pages',
        label: '单份最多识别几页',
        unit: '页',
        kind: 'int',
        min: 1,
        max: 500,
        def: 40,
        hint: '扫描件动辄几百页,单页约 0.3~1 秒。超出的页继续标记「待识别」,不会丢。',
      },
    ],
  },
  {
    id: 'transcribe',
    section: 'ocr',
    title: '音视频转写',
    fields: [
      {
        path: 'extract.transcribe_enabled',
        label: '转写音频和视频',
        kind: 'bool',
        def: false,
        hint: '打开后,导入的音频和视频会转成文字再索引。转写很占 CPU 和时间;引擎没装好时只留占位说明。',
      },
      {
        path: 'extract.max_media_seconds',
        label: '单个音视频最长处理时长',
        kind: 'int',
        unit: '秒',
        min: 10,
        max: 86400,
        def: 1800,
        hint: '超过这个时长的音视频只转写前面这一段,防止一个长视频占满机器。',
      },
    ],
  },

  // ---- 备份
  {
    id: 'backup',
    section: 'backup',
    title: '定时备份与保留',
    note: '守护进程按间隔自己打包,备份成功后按保留策略清理旧备份;归档只增不减会把磁盘吃满。手动备份也适用同一份保留策略。',
    fields: [
      {
        path: 'backup.enabled',
        label: '定时备份',
        kind: 'bool',
        def: true,
        hint: '打开后,服务每隔一段时间自动打包一份备份;关闭后只能手动「立即备份」。',
      },
      {
        path: 'backup.interval_hours',
        label: '备份间隔',
        kind: 'int',
        unit: '小时',
        min: 1,
        max: 720,
        def: 24,
        hint: '两次自动备份之间隔多久。',
      },
      {
        path: 'backup.keep_count',
        label: '最多保留份数',
        kind: 'int',
        unit: '份',
        min: 0,
        max: 365,
        def: 7,
        hint: '超过的旧备份在下一次自动备份成功之后被删掉,最新一份永远保留。0 表示不按份数清理。',
      },
      {
        path: 'backup.keep_days',
        label: '最长保留天数',
        kind: 'int',
        unit: '天',
        min: 0,
        max: 3650,
        def: 0,
        hint: '超过这么多天的旧备份会被删掉,最新一份永远保留。0 表示不按天数清理。',
      },
      {
        path: 'backup.include_sources',
        label: '定时备份包含原件',
        kind: 'bool',
        def: false,
        hint: '原件(sources)体积通常很大,而且一般另有副本,所以默认不带。打开后每份备份会明显变大。',
      },
    ],
  },
  {
    id: 'mirror',
    section: 'backup',
    title: '异地副本',
    fields: [
      {
        path: 'backup.mirror_dirs',
        label: '异地备份目录',
        kind: 'list',
        max: 4,
        def: [],
        placeholder: '/mnt/usb/kb-backups\n/data/backup/kb',
        hint: '每份备份再复制一份到这些目录(移动硬盘、NAS、另一块数据盘),本机的盘坏了还能恢复。一行写一个目录(逗号分隔也行);写绝对路径,或相对数据目录的路径。',
        validate: validateMirrorDirs,
      },
    ],
  },
]

/** 全部字段(扁平)。 */
export const ALL_FIELDS: SettingField[] = FIELD_GROUPS.flatMap((group) => group.fields)

/** 某个分区里看得到的分组:AI 总开关关闭时,AI 分组不出现。 */
export function groupsOf(section: SectionId, aiOn: boolean): FieldGroup[] {
  return FIELD_GROUPS.filter((group) => group.section === section && (aiOn || !group.ai))
}

export function fieldOf(path: string): SettingField | undefined {
  return ALL_FIELDS.find((field) => field.path === path)
}

// ---------------------------------------------------------------- 文案

/** 千位用逗号(术语表「数字、时间与单位」)。 */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 数字后面的单位(数字和中文之间留一个半角空格)。 */
const unitSuffix = (field: SettingField) => (field.unit ? ` ${field.unit}` : '')

/** 默认值的人话。 */
export function defaultText(field: SettingField): string {
  const def = field.def
  if (def === undefined) return ''
  if (field.kind === 'bool') return def === true ? '开启' : '关闭'
  if (field.kind === 'list') return Array.isArray(def) && def.length ? def.join('、') : '不复制'
  if (field.kind === 'choice') return field.options?.find((option) => option.value === def)?.label ?? String(def)
  if (typeof def === 'number') return `${groupDigits(def)}${unitSuffix(field)}`
  return String(def)
}

/** 取值范围与默认值的一句话,拼在帮助文字后面(界面上写的范围和默认值都从字段表来,不手写)。 */
export function rangeText(field: SettingField): string {
  const parts: string[] = []
  const unit = unitSuffix(field)
  if (field.kind === 'int' || field.kind === 'number') {
    if (field.min !== undefined && field.max !== undefined) parts.push(`取值 ${groupDigits(field.min)}–${groupDigits(field.max)}${unit}`)
    else if (field.min !== undefined && field.min > 0) parts.push(`不小于 ${groupDigits(field.min)}${unit}`)
    else if (field.max !== undefined) parts.push(`不大于 ${groupDigits(field.max)}${unit}`)
  } else if (field.kind === 'time') {
    parts.push('格式 HH:MM(24 小时制)')
  } else if (field.kind === 'list' && field.max !== undefined) {
    parts.push(`最多 ${field.max} 个`)
  }
  const def = defaultText(field)
  if (def) parts.push(`默认 ${def}`)
  return parts.join(',')
}

/** 当前草稿值需要提醒的风险(开关打开 / 填成特定值)。 */
export function riskOf(field: SettingField, raw: string | boolean | undefined): string {
  if (field.riskOn && raw === true) return field.riskOn
  if (field.riskValue && typeof raw === 'string' && raw.trim() === field.riskValue.value) return field.riskValue.text
  return ''
}

// ---------------------------------------------------------------- 草稿 ↔ 配置

export function readPath(config: Json, path: string): unknown {
  let current: unknown = config
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Json)[part]
  }
  return current
}

/**
 * 把点号路径写进补丁(`{ extract: { ocr: { slots: 4 } } }`)。
 *
 * 支持任意深度:两层是绝大多数配置段,三层是子表(`extract.ocr.*`)。中间层不是对象时重建,
 * 免得把手改的怪值(`extract = 1`)当成可写容器。
 */
function writePath(patch: Json, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor = patch
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {}
    cursor = cursor[part] as Json
  }
  cursor[parts.at(-1)!] = value
}

/** 配置里的值 → 表单草稿值。 */
export function toDraft(config: Json, fields: readonly SettingField[] = ALL_FIELDS): Draft {
  const draft: Draft = {}
  for (const field of fields) {
    const value = readPath(config, field.path)
    if (field.kind === 'bool') draft[field.path] = value === true
    // 列表一行一项(多行文本框里最好读);解析时逗号、换行都认
    else if (field.kind === 'list') draft[field.path] = Array.isArray(value) ? value.join('\n') : ''
    else draft[field.path] = value === undefined || value === null ? '' : String(value)
  }
  return draft
}

/** 草稿里的一项 → 配置里的真实类型;不合法返回带标签的报错文案。 */
export function parseField(field: SettingField, raw: string | boolean | undefined, draft: Draft = {}): { value: unknown } | { error: string } {
  if (field.kind === 'bool') return { value: raw === true }
  const text = String(raw ?? '').trim()
  const name = `「${field.label}」`
  if (field.kind === 'int' || field.kind === 'number') {
    const integer = field.kind === 'int'
    const pattern = integer ? /^\d+$/ : /^(\d+\.?\d*|\.\d+)$/
    if (!pattern.test(text) || !Number.isFinite(Number(text)) || (integer && !Number.isSafeInteger(Number(text)))) {
      // 中文和数字之间留一个半角空格(术语表「标点与排版」)
      const bounds = field.min !== undefined && field.max !== undefined ? ` ${field.min}–${field.max} 之间的` : ''
      return { error: `${name}要填${bounds}${integer ? '整数' : '数字'}` }
    }
    const value = Number(text)
    if (field.min !== undefined && value < field.min) return { error: `${name}不能小于 ${field.min}` }
    if (field.max !== undefined && value > field.max) return { error: `${name}不能大于 ${field.max}` }
    return { value }
  }
  if (field.kind === 'time') {
    return HHMM_PATTERN.test(text) ? { value: text } : { error: `${name}要写成 HH:MM,例如 03:00` }
  }
  if (field.kind === 'choice') {
    if (!text) return { error: `${name}请选一项` }
    if (field.options && !field.options.some((option) => option.value === text)) return { error: `${name}请从列表里选一项` }
    return { value: text }
  }
  if (field.kind === 'list') {
    const message = field.validate?.(text, draft)
    if (message) return { error: `${name}${message}` }
    return { value: splitList(text) }
  }
  if (text === '') return { error: `${name}不能为空` }
  const message = field.validate?.(text, draft)
  if (message) return { error: `${name}${message}` }
  return { value: text }
}

export interface PatchResult {
  /** 合并补丁:只含改过的键。 */
  patch: Json
  /** 改过的字段路径。 */
  changed: string[]
  /** 不合法的字段 → 报错文案(只含改过的,或被改动牵连的字段)。 */
  errors: Record<string, string>
}

/**
 * 草稿相对已保存配置的改动。
 *
 * 只校验**碰过**的字段:配置文件里本来就有的怪值(手改的、旧版本留下的)不会一打开页面就满屏标红。
 * 被改动牵连的字段(`watch`)也会校验——只关掉「允许远程访问」而没碰监听地址,同样会被后端拒绝。
 */
export function buildSettingsPatch(config: Json, draft: Draft, fields: readonly SettingField[] = ALL_FIELDS): PatchResult {
  const baseline = toDraft(config, fields)
  const touched = new Set(fields.filter((field) => !field.readonly && draft[field.path] !== baseline[field.path]).map((field) => field.path))
  const patch: Json = {}
  const changed: string[] = []
  const errors: Record<string, string> = {}
  for (const field of fields) {
    if (field.readonly) continue
    const isTouched = touched.has(field.path)
    const implicated = !isTouched && !!field.watch?.some((path) => touched.has(path))
    if (!isTouched && !implicated) continue
    const parsed = parseField(field, draft[field.path], draft)
    if ('error' in parsed) {
      errors[field.path] = parsed.error
      continue
    }
    if (!isTouched) continue
    // 写法不同但值一样(“ 7 ”和 7、“a, b”和两行 a / b)不算改动,免得保存条为一个没变的值冒出来
    if (JSON.stringify(parsed.value) === JSON.stringify(readPath(config, field.path))) continue
    writePath(patch, field.path, parsed.value)
    changed.push(field.path)
  }
  return { patch, changed, errors }
}

/** 这次改动里要重启才生效的字段(给保存后的提醒用)。 */
export function restartFields(changed: readonly string[]): SettingField[] {
  return changed.map((path) => fieldOf(path)).filter((field): field is SettingField => !!field && needsRestart(field.path))
}

// ---------------------------------------------------------------- 保存结果的文案

/**
 * 保存成功后的提示条:哪些立即生效、哪些要重启才生效,分开说清。
 * 全是热更新 → 成功色;有要重启的 → 警告色(别让人以为已经生效)。
 */
export function saveSummary(changed: readonly string[], restartLabels: readonly string[]): { text: string; tone: 'success' | 'warning' } {
  const count = changed.length
  if (!restartLabels.length) return { text: `已保存 ${count} 项,立即生效。`, tone: 'success' }
  const names = `「${restartLabels.join('、')}」`
  return restartLabels.length >= count
    ? { text: `已保存 ${count} 项。${names}要重启服务后才生效。`, tone: 'warning' }
    : { text: `已保存 ${count} 项。${names}要重启服务后才生效,其余已立即生效。`, tone: 'warning' }
}

/** 保存失败的两句话(出了什么事 + 怎么办)。服务端校验没过时把它给的原因带上。 */
export function saveFailureText(err: unknown): string {
  const failure = failureOf(err, '保存设置')
  if (failure.phase === 'forbidden') return '你的账号没有修改系统设置的权限。请联系管理员。'
  const raw = err instanceof Error ? err.message.trim() : ''
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined
  if (status === 400 && /[\u4e00-\u9fff]/.test(raw)) return `保存设置失败:${raw.replace(/[。.]$/, '')}。请检查填写的值后重试。`
  return failure.message
}
