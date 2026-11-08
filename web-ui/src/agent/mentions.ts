// 聊天框 `@` 引用(codeg 的做法):
//   - `@` 选的是「引用」:代理 / 条目 / 会话 / 项目 / 集合;
//   - 选中后插入 `@[标题](kb://kind/id)` 这样的**可读链接**,链接本身就是锚点;
//   - 发送时把这些链接解析出来,在提示词里附一段「参考资料」,让代理用工具去读;
//   - 快捷命令走 `/`(见 commands.ts),和 codeg 的 `/`、`$` 分工一致。
import type { AgentRef } from '@/utils/agent'

export type MentionKind = 'agent' | 'item' | 'session' | 'project' | 'collection'

export interface MentionRef {
  kind: MentionKind
  id: string
  label: string
  detail?: string
  uri: string
}

export interface MentionSearchContext {
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
  agents: Array<{ id: string; name: string; available: boolean }>
}

/** 引用面板的分组顺序(和 codeg 的 agent 优先一致)。 */
export const MENTION_KINDS: Array<{ kind: MentionKind; label: string; hint: string }> = [
  { kind: 'agent', label: '代理', hint: '切换 / 指定代理' },
  { kind: 'item', label: '条目', hint: '知识库里的文档 / 代码 / 经验' },
  { kind: 'session', label: '会话', hint: '历史对话' },
  { kind: 'project', label: '项目', hint: '项目根目录' },
  { kind: 'collection', label: '集合', hint: '集合与行数' },
]

// `@` 前面可以是开头、空白,或中日韩文字(和 codeg 的 mention-match 一致,
// 这样「帮我看看@部署文档」也能触发;邮箱那种 `me@x.com` 不会)。
const MENTION_PREFIX = /(^|[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])$/u

/** 输入末尾正在输入的 `@query`(没有就返回 null)。 */
export function mentionQueryOf(text: string): { query: string; start: number } | null {
  const match = text.match(/(^|[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])@([^\s@]*)$/u)
  if (!match) return null
  const prefix = match[1] ?? ''
  if (prefix && !MENTION_PREFIX.test(prefix)) return null
  const start = text.length - (match[2]?.length ?? 0) - 1
  return { query: match[2] ?? '', start }
}

/** 引用 → 可读链接(`@[标题](kb://kind/id)`)。 */
export function mentionToken(ref: MentionRef): string {
  return `@[${ref.label}](${ref.uri})`
}

const TOKEN = /@\[([^\]]*)\]\((kb:\/\/[a-z]+\/[^)\s]+)\)/g

/** 从文本里解析引用链接。 */
export function parseMentionTokens(text: string): MentionRef[] {
  const refs: MentionRef[] = []
  for (const match of text.matchAll(TOKEN)) {
    const uri = match[2]
    const kind = uri.slice('kb://'.length).split('/')[0] as MentionKind
    if (!MENTION_KINDS.some((entry) => entry.kind === kind)) continue
    const id = decodeURIComponent(uri.slice(`kb://${kind}/`.length))
    refs.push({ kind, id, label: match[1] || id, uri })
  }
  return refs
}

/** 把引用链接换成纯标题(给用户气泡显示)。 */
export function stripMentionTokens(text: string): string {
  return text.replace(TOKEN, (_all, label: string) => `@${label}`)
}

/** 把引用写进提示词:代理拿到「标题 + 链接」,自己用工具去读。 */
export function buildMentionPrompt(text: string, refs: MentionRef[]): string {
  if (refs.length === 0) return stripMentionTokens(text)
  const toolOf: Record<MentionKind, string> = {
    agent: '（切换代理由客户端处理）',
    item: '用 get_item 读它',
    session: '用 agent_history 读它',
    project: '用 search_knowledge / list_projects 看它',
    collection: '用 list_collections 看它',
  }
  const lines = refs.map((ref) => `- [${ref.kind}] ${ref.label} (${ref.uri}) — ${toolOf[ref.kind]}`)
  return `用户引用了这些资料:\n${lines.join('\n')}\n\n${stripMentionTokens(text)}`
}

/** 按类型搜索引用候选项。 */
export async function searchMentions(
  kind: MentionKind,
  query: string,
  ctx: MentionSearchContext,
): Promise<MentionRef[]> {
  const needle = query.trim().toLowerCase()
  const hit = (value: string) => !needle || value.toLowerCase().includes(needle)
  if (kind === 'agent') {
    return ctx.agents
      .filter((agent) => agent.available)
      .filter((agent) => hit(agent.name) || hit(agent.id))
      .map((agent) => ({
        kind: 'agent',
        id: agent.id,
        label: agent.name,
        detail: '切换到这个代理',
        uri: `kb://agent/${agent.id}`,
      }))
  }
  if (kind === 'item') {
    if (!needle) return []
    const result = await ctx.call<{
      hits?: Array<{ id: string; collection: string; source: string; title?: string | null }>
    }>('search_knowledge', { query, k: 6 })
    return (result.hits ?? []).map((item) => ({
      kind: 'item',
      id: item.id,
      label: item.title || item.source || item.id,
      detail: `${item.collection} · ${item.source}`,
      uri: `kb://item/${encodeURIComponent(item.id)}`,
    }))
  }
  if (kind === 'session') {
    const result = await ctx.call<{
      sessions?: Array<{ session_id: string; title?: string | null; project?: string | null }>
    }>('agent_sessions', { limit: 20 })
    return (result.sessions ?? [])
      .filter((session) => hit(session.title ?? '') || hit(session.session_id))
      .map((session) => ({
        kind: 'session',
        id: session.session_id,
        label: session.title?.trim() || `会话 ${session.session_id.slice(0, 8)}`,
        detail: session.project || undefined,
        uri: `kb://session/${encodeURIComponent(session.session_id)}`,
      }))
  }
  if (kind === 'project') {
    const result = await ctx.call<{
      projects?: Array<{ name?: string; slug?: string; root_path?: string }>
    }>('list_projects', {})
    return (result.projects ?? [])
      .filter((project) => hit(project.name ?? '') || hit(project.slug ?? ''))
      .map((project) => ({
        kind: 'project',
        id: project.slug ?? project.name ?? '',
        label: project.name || project.slug || '项目',
        detail: project.root_path,
        uri: `kb://project/${encodeURIComponent(project.slug ?? project.name ?? '')}`,
      }))
  }
  const result = await ctx.call<{ collections?: Array<{ name?: string; rows?: number }> }>(
    'list_collections',
    {},
  )
  return (result.collections ?? [])
    .filter((collection) => hit(collection.name ?? ''))
    .map((collection) => ({
      kind: 'collection',
      id: collection.name ?? '',
      label: collection.name ?? '',
      detail: `${collection.rows ?? 0} 行`,
      uri: `kb://collection/${encodeURIComponent(collection.name ?? '')}`,
    }))
}

/** 引用 → 引用胶囊(只给能跳转的条目 / 集合 / 项目)。 */
export function refsOfMentions(refs: MentionRef[]): AgentRef[] {
  const out: AgentRef[] = []
  for (const ref of refs) {
    if (ref.kind === 'item') {
      out.push({ kind: 'item', id: ref.id, label: ref.label, collection: '', source: ref.detail })
    } else if (ref.kind === 'collection') {
      out.push({ kind: 'collection', id: ref.id, label: ref.label })
    } else if (ref.kind === 'project') {
      out.push({ kind: 'project', id: ref.id, label: ref.label })
    }
  }
  return out
}
