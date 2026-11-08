// 搜索页的纯逻辑:范围选项、结果来源(我的 / 谁共享的)、点结果去哪、高级选项的记忆。
// 和界面分开,方便单测;页面只负责取数和画出来。
import type { SearchHit } from '@/api/client'
import type { PublicProfile } from '@/api/share'
import { PATHS } from '@/router/paths'
import { personName, roleLabel } from '@/utils/share'

type Kind = SearchHit['kind']

/** 结果类型的中文名(术语表:insight 在界面上叫「笔记」)。 */
const KIND_LABEL: Record<Kind, string> = { insight: '笔记', code: '代码', doc: '文档', external: '网页', summary: '摘要' }
export const kindLabel = (kind: string): string => KIND_LABEL[kind as Kind] ?? '内容'

// ---------------------------------------------------------------- 范围

/** 下拉里选的范围。`mine` 是我自己的知识库(沿用原来的 scope / project 参数);`shared` 走 search_shared。 */
export type ScopeChoice =
  | { kind: 'mine'; scope: 'auto' | 'all' | 'global'; project: string }
  | { kind: 'shared'; include: 'shared' | 'all' }

export const SHARED_ONLY = 'shared:only'
export const SHARED_ALL = 'shared:all'

/** 选项值 → 范围。认不出的值按「当前项目」处理,不抛错(值来自下拉,但路由或存储里的旧值也可能混进来)。 */
export function parseScope(value: string): ScopeChoice {
  if (value === SHARED_ONLY) return { kind: 'shared', include: 'shared' }
  if (value === SHARED_ALL) return { kind: 'shared', include: 'all' }
  const [head = '', ...rest] = value.split(':')
  if (head === 'all' || head === 'global') return { kind: 'mine', scope: head, project: rest.join(':') }
  // 只有 auto 后面跟的才是项目名;前缀都认不出的整条当垃圾,退回「当前项目」
  return { kind: 'mine', scope: 'auto', project: head === 'auto' ? rest.join(':') : '' }
}

/** 默认范围:当前项目。它不写进地址(地址里没有 scope 就是它)。 */
export const DEFAULT_SCOPE = 'auto:'

/**
 * 地址里带来的范围值要核对:不在当前能选的选项里(项目被删了、共享被收回、手改了地址、旧链接)就退回默认,
 * 不能让下拉里显示一个选不到的值,更不能拿它去搜。
 */
export function pickScope(raw: string, options: readonly ScopeOption[]): string {
  return options.some((option) => option.value === raw) ? raw : DEFAULT_SCOPE
}

export interface ScopeOption {
  value: string
  label: string
}

/**
 * 范围下拉的选项。只有真有人分享内容给我(sharedCount > 0)才出现两个「共享」选项:
 * 没有共享时多出两个永远搜不到东西的选项只会让人困惑。
 */
export function scopeOptions(projects: string[], sharedCount: number): ScopeOption[] {
  const options: ScopeOption[] = [
    { value: 'auto:', label: '当前项目' },
    ...projects.map((name) => ({ value: `auto:${name}`, label: name })),
    { value: 'all:', label: '全部集合' },
    { value: 'global:', label: '_global' },
  ]
  if (sharedCount > 0) options.push({ value: SHARED_ALL, label: '我的 + 共享给我的' }, { value: SHARED_ONLY, label: '只搜共享给我的' })
  return options
}

// ---------------------------------------------------------------- 结果

/** 共享检索(search_shared)返回的命中:在普通命中上多了来源知识库、分享人和我在那里的角色。 */
export type AnyHit = SearchHit & { space_id?: string; owner?: PublicProfile | null; role?: string }

/** 命中的来源:我自己的,还是谁分享给我的(带我的角色)。 */
export function hitSource(hit: AnyHit): { mine: boolean; label: string; role: string } {
  // 没有 space_id 是普通检索(只会是我自己的);共享检索里我自己的命中 role 是 owner
  if (!hit.space_id || hit.role === 'owner') return { mine: true, label: '我的', role: '' }
  return { mine: false, label: hit.owner ? `来自 ${personName(hit.owner)}` : '别人分享的', role: roleLabel(hit.role) }
}

/**
 * 点一条结果去哪。
 * 我自己的:知识库页按集合 + 路径 + 命中块定位(Browser 认 collection / path / highlight / anchor)。
 * 别人分享的:知识库页的「共享给我」,用 space + 位置找覆盖它的授权(笔记带 item,文件带 path)。
 * 注意是路径地址:路由表里没有命名路由,用 name 会抛 No match。
 */
export function hitRoute(hit: AnyHit): { path: string; query: Record<string, string> } {
  const source = hitSource(hit)
  if (source.mine) {
    return {
      path: PATHS.kb,
      query: {
        collection: hit.collection,
        path: hit.source,
        highlight: hit.id,
        ...(hit.anchor ? { anchor: JSON.stringify(hit.anchor) } : {}),
      },
    }
  }
  return {
    path: PATHS.kb,
    query: {
      scope: 'shared',
      space: hit.space_id!,
      collection: hit.collection,
      ...(hit.kind === 'insight' ? { item: hit.id } : { path: hit.source }),
    },
  }
}

// ---------------------------------------------------------------- 高级选项

export interface SearchPrefs {
  /** 重排:对初步结果再排一次序,更准但稍慢 */
  rerank: boolean
  /** 查看排序依据:每条结果显示各阶段名次,并出现右侧的说明面板 */
  explain: boolean
  /** 每页显示几条(翻页在页面里做,不影响向服务器取多少) */
  pageSize: number
}

/** 每页条数可选值 */
export const PAGE_SIZES = [10, 20, 50] as const
/** 向服务器一次取多少条:取满上限,翻页只是在这批结果里切片,不用每翻一页重搜一遍(取 100 条和取 10 条几乎一样快) */
export const MAX_HITS = 100
/** 在别人共享给我的内容里搜,服务器最多给 50 条 */
export const MAX_SHARED_HITS = 50
/** 默认只给结果,不摆排序依据:那是调检索的人才看的东西。 */
export const DEFAULT_PREFS: SearchPrefs = { rerank: true, explain: false, pageSize: 10 }
export const PREFS_KEY = 'kb.search.prefs'

/** 从存储里读回高级选项;坏数据、缺字段、不在可选范围内的值逐项退回默认,不整体丢弃也不抛错。 */
export function readPrefs(raw: string | null): SearchPrefs {
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {
    // 存储里是坏数据:全部用默认
  }
  const allowed = (value: unknown): value is (typeof PAGE_SIZES)[number] => PAGE_SIZES.includes(value as (typeof PAGE_SIZES)[number])
  // 以前这一项叫"返回条数"(存在 k 里):值在新的可选范围里就沿用,免得用户的设置凭空变了
  const pageSize = allowed(data.pageSize) ? data.pageSize : allowed(data.k) ? data.k : DEFAULT_PREFS.pageSize
  return {
    rerank: typeof data.rerank === 'boolean' ? data.rerank : DEFAULT_PREFS.rerank,
    explain: typeof data.explain === 'boolean' ? data.explain : DEFAULT_PREFS.explain,
    pageSize,
  }
}

/** 高级选项里有几项改过(和默认值不同):折叠起来时用角标提醒「这里有改动」。每页条数在结果下面的翻页条里调,不算。 */
export function changedCount(prefs: SearchPrefs): number {
  return (['rerank', 'explain'] as const).filter((key) => prefs[key] !== DEFAULT_PREFS[key]).length
}

/**
 * 请求里的 rerank:用户关掉了才明说 false;开着(默认)就不传,让服务器自己判断——有重排模型就用,
 * 没装(现在的默认部署)就老老实实按融合分数排,不当成"出了问题"。明说 true 会让服务器把"没有重排模型"
 * 报成降级,那样每次搜索页面顶上都挂一条"已降级",其实什么都没坏。
 */
export function rerankParam(prefs: SearchPrefs): { rerank: false } | Record<string, never> {
  return prefs.rerank ? {} : { rerank: false }
}

/**
 * 服务器返回的"降级原因"写成人话:发生了什么、这次的结果怎么来的。
 * 返回 null = 不用提醒(不影响结果的情况)。
 */
export function degradedText(code: string | null | undefined): { text: string; tone: 'info' | 'warn' } | null {
  switch (code) {
    case null:
    case undefined:
    case '':
      return null
    case 'rerank_unavailable':
      return { text: '重排没有生效(这台服务器没有启用重排模型),结果按关键词 + 语义的综合分数排序,不影响查到的内容。', tone: 'info' }
    case 'rerank_timeout':
      return { text: '重排花的时间太长,这次直接用了综合分数的排序。', tone: 'info' }
    case 'embedder_loading':
      return { text: '语义模型还在启动(空闲一段时间后会自动释放内存,第一次搜索要几秒钟重新加载),这次只按关键词匹配;过几秒再搜一次就是完整的结果。', tone: 'warn' }
    case 'embedder_unavailable':
      return { text: '语义模型暂时不可用,这次只按关键词匹配,查不到意思相近但字面不同的内容。', tone: 'warn' }
    case 'vector_pending':
      return { text: '部分内容正在补建向量索引,这次按关键词相关性排序;补完后结果会更完整。', tone: 'info' }
    default:
      return { text: `这次搜索有部分功能没有生效(${code})。`, tone: 'warn' }
  }
}
