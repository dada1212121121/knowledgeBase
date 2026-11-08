// 聊天框里的 `@` 快捷命令:
//   - 白名单来自后端 `chat_commands`(只列非 Admin 能力),前端不自己拼能力名;
//   - 解析 / 过滤 / 执行都在这里,悬浮窗和 /agent 页共用,避免两处逻辑漂移。
import type { AgentRef } from '@/utils/agent'

export interface ChatCommand {
  id: string
  label: string
  description: string
  kind: 'capability' | 'upload' | 'navigate' | 'form' | 'agent'
  capability?: string | null
  args: string[]
  path?: string | null
  /** 交给代理的提示词(`{args}` / `{project}` 占位)。 */
  prompt?: string
}

export interface ChatEntryLike {
  role: 'user' | 'assistant' | 'system'
  text: string
  refs?: AgentRef[]
  trace?: string[]
  failed?: boolean
  summary?: boolean
}

export interface CommandContext {
  /** 当前项目(可空)。 */
  project: string
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>
  push: (entry: ChatEntryLike) => void
  navigate: (path: string) => void
  upload: () => void
  switchAgent: (id: string) => void
  openInsight: () => void
  /** 把一条提示词发给 ACP 代理(由组件实现,复用正常对话的发送逻辑)。 */
  ask: (prompt: string, displayText?: string) => Promise<void>
}

/** 输入框末尾正在输入的 `/query`(没有就返回 null);`@` 留给引用。 */
export function commandQueryOf(text: string): string | null {
  const match = text.match(/(^|\s)\/([\p{L}\p{N}_-]*)$/u)
  return match ? match[2] : null
}

/** 过滤命令:id / 名称 / 说明任一命中。 */
export function filterCommands(commands: ChatCommand[], query: string): ChatCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands
  return commands.filter(
    (command) =>
      command.id.toLowerCase().includes(needle) ||
      command.label.toLowerCase().includes(needle) ||
      command.description.toLowerCase().includes(needle),
  )
}

/** 整条输入是不是一条命令(`/id 参数`)。 */
export function parseChatCommand(
  text: string,
  commands: ChatCommand[],
): { command: ChatCommand; args: string } | null {
  const match = text.trim().match(/^\/([\w-]+)\s*([\s\S]*)$/)
  if (!match) return null
  const command = commands.find((item) => item.id === match[1])
  return command ? { command, args: match[2].trim() } : null
}

/** 把输入框里的 `/query` 替换成 `/id `(选中带参数的命令后继续输入)。 */
export function applyCommandToDraft(text: string, command: ChatCommand): string {
  return text.replace(/(^|\s)\/([\p{L}\p{N}_-]*)$/u, `$1/${command.id} `)
}

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  return [head, sep, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

/** 执行一条命令。返回 true 表示已处理(不要再去问代理)。 */
export async function runChatCommand(
  command: ChatCommand,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  switch (command.kind) {
    case 'upload':
      ctx.upload()
      return true
    case 'navigate':
      if (command.path) ctx.navigate(command.path)
      return true
    case 'form':
      ctx.openInsight()
      return true
    case 'agent':
      ctx.switchAgent(command.id)
      return true
    case 'capability':
      break
  }
  if (!command.capability) return true
  if (command.args.length > 0 && !args) {
    ctx.push({
      role: 'system',
      text: `用法:/${command.id} ${command.args.map((arg) => `<${arg}>`).join(' ')}`,
      failed: true,
    })
    return true
  }
  try {
    const prompt = (command.prompt ?? '')
      .replace('{args}', args)
      .replace('{project}', ctx.project ? `(项目 ${ctx.project})` : '')
    if (prompt) {
      await ctx.ask(prompt, `/${command.id}${args ? ` ${args}` : ''}`)
      return true
    }
    // 没有提示词的能力命令:直接调能力,把结果给用户
    const result = await ctx.call<unknown>(command.capability, args ? { query: args } : {})
    ctx.push({
      role: 'assistant',
      text: `\`${command.capability}\` 返回:\n\n\`\`\`json\n${JSON.stringify(result, null, 2).slice(0, 4000)}\n\`\`\``,
    })
    return true
  } catch (err) {
    ctx.push({
      role: 'system',
      text: `/${command.id} 失败:${err instanceof Error ? err.message : '未知错误'}`,
      failed: true,
    })
    return true
  }
}
