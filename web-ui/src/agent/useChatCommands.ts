// 聊天框 `@` 命令的状态机:加载白名单、过滤、键盘选择、执行。
// 悬浮窗和 /agent 页共用;执行细节在 `commands.ts`。
import { computed, ref } from 'vue'
import {
  applyCommandToDraft,
  commandQueryOf,
  filterCommands,
  parseChatCommand,
  runChatCommand,
  type ChatCommand,
  type CommandContext,
} from '@/agent/commands'

export function useChatCommands(
  getContext: () => CommandContext,
  getExtra: () => ChatCommand[] = () => [],
) {
  const commands = ref<ChatCommand[]>([])
  const menuOpen = ref(false)
  const query = ref('')
  const active = ref(0)

  const all = computed(() => [...commands.value, ...getExtra()])
  const filtered = computed(() => filterCommands(all.value, query.value))

  async function load() {
    try {
      const result = await getContext().call<{ commands?: ChatCommand[] }>('chat_commands', {})
      commands.value = result.commands ?? []
    } catch {
      commands.value = []
    }
  }

  /** 输入变化:末尾有 `@xxx` 就弹菜单。 */
  function onInput(text: string) {
    const value = commandQueryOf(text)
    query.value = value ?? ''
    menuOpen.value = value !== null
    active.value = 0
  }

  function close() {
    menuOpen.value = false
  }

  function move(delta: number) {
    if (!menuOpen.value || filtered.value.length === 0) return
    active.value = (active.value + delta + filtered.value.length) % filtered.value.length
  }

  /** 选中第 index 条:带参数的填进输入框,不带参数的直接执行。返回新的草稿。 */
  async function choose(index: number, text: string): Promise<string> {
    const command = filtered.value[index]
    if (!command) return text
    menuOpen.value = false
    if (command.args.length > 0) return applyCommandToDraft(text, command)
    // 先把「用户发了什么」留在对话里,再执行
    getContext().push({ role: 'user', text: `/${command.id}` })
    await runChatCommand(command, '', getContext())
    return text.replace(/(^|\s)\/([\p{L}\p{N}_-]*)$/u, '$1').trimEnd()
  }

  /** 整条输入是一条命令就执行,返回 true(不要再发给代理)。 */
  async function tryRun(text: string): Promise<boolean> {
    const parsed = parseChatCommand(text, all.value)
    if (!parsed) return false
    menuOpen.value = false
    // 先把「用户发了什么」留在对话里,再执行
    getContext().push({ role: 'user', text })
    await runChatCommand(parsed.command, parsed.args, getContext())
    return true
  }

  return {
    commands,
    menuOpen,
    query,
    active,
    filtered,
    load,
    onInput,
    close,
    move,
    choose,
    tryRun,
  }
}
