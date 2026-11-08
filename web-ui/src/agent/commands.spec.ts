import { describe, expect, it, vi } from 'vitest'
import {
  applyCommandToDraft,
  commandQueryOf,
  filterCommands,
  parseChatCommand,
  runChatCommand,
  type ChatCommand,
  type CommandContext,
} from './commands'

const commands: ChatCommand[] = [
  {
    id: 'search',
    label: '搜索知识库',
    description: '按关键词检索',
    kind: 'capability',
    capability: 'search_knowledge',
    args: ['query'],
    prompt: '用 knowledgeBase 的 search_knowledge 工具检索「{args}」{project}',
  },
  {
    id: 'projects',
    label: '列出项目',
    description: '看看有哪些项目',
    kind: 'capability',
    capability: 'list_projects',
    args: [],
    prompt: '用 knowledgeBase 的 list_projects 工具列出项目',
  },
  {
    id: 'upload',
    label: '上传文件',
    description: '选文件',
    kind: 'upload',
    args: [],
  },
  {
    id: 'settings',
    label: '打开设置',
    description: '跳到设置页',
    kind: 'navigate',
    path: '/settings',
    args: [],
  },
  {
    id: 'claude',
    label: 'ACP · Claude',
    description: '切换到该代理',
    kind: 'agent',
    args: [],
  },
]

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    project: '',
    call: vi.fn().mockResolvedValue({}),
    push: vi.fn(),
    navigate: vi.fn(),
    upload: vi.fn(),
    switchAgent: vi.fn(),
    openInsight: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('聊天 @ 命令', () => {
  it('只在输入末尾有 @ 时弹菜单', () => {
    expect(commandQueryOf('/sea')).toBe('sea')
    expect(commandQueryOf('你好 /')).toBe('')
    expect(commandQueryOf('你好 /sea 世界')).toBeNull()
    expect(commandQueryOf('没有 at')).toBeNull()
  })

  it('解析整条命令,未知命令不处理', () => {
    expect(parseChatCommand('/search 一键安装', commands)).toEqual({
      command: commands[0],
      args: '一键安装',
    })
    expect(parseChatCommand('  /projects  ', commands)?.command.id).toBe('projects')
    expect(parseChatCommand('/nope x', commands)).toBeNull()
    expect(parseChatCommand('普通消息', commands)).toBeNull()
  })

  it('按 id / 名称 / 说明过滤', () => {
    expect(filterCommands(commands, 'sea').map((item) => item.id)).toEqual(['search'])
    expect(filterCommands(commands, '代理').map((item) => item.id)).toEqual(['claude'])
    expect(filterCommands(commands, '').length).toBe(commands.length)
  })

  it('选中带参数的命令后把 /query 换成 /id', () => {
    expect(applyCommandToDraft('/sea', commands[0])).toBe('/search ')
    expect(applyCommandToDraft('前缀 /pro', commands[1])).toBe('前缀 /projects ')
  })

  it('上传 / 跳转 / 切代理直接执行', async () => {
    const ctx = context()
    await runChatCommand(commands[2], '', ctx)
    expect(ctx.upload).toHaveBeenCalled()
    await runChatCommand(commands[3], '', ctx)
    expect(ctx.navigate).toHaveBeenCalledWith('/settings')
    await runChatCommand(commands[4], '', ctx)
    expect(ctx.switchAgent).toHaveBeenCalledWith('claude')
  })

  it('能力命令交给代理(带工具提示词),不是前端直调', async () => {
    const ctx = context({ project: 'proj_demo' })
    const handled = await runChatCommand(commands[0], '部署', ctx)
    expect(handled).toBe(true)
    expect(ctx.call).not.toHaveBeenCalled()
    const prompt = (ctx.ask as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(prompt).toContain('search_knowledge')
    expect(prompt).toContain('部署')
    expect(prompt).toContain('proj_demo')
  })

  it('搜索没参数时给用法提示', async () => {
    const ctx = context()
    await runChatCommand(commands[0], '', ctx)
    expect(ctx.ask).not.toHaveBeenCalled()
    const entry = (ctx.push as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(entry.failed).toBe(true)
    expect(entry.text).toContain('/search')
  })

  it('代理报错时落一条失败提示', async () => {
    const ctx = context({ ask: vi.fn().mockRejectedValue(new Error('boom')) })
    await runChatCommand(commands[1], '', ctx)
    const entry = (ctx.push as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(entry.failed).toBe(true)
    expect(entry.text).toContain('boom')
  })
})
