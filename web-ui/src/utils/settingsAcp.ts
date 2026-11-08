// 「编码代理」(ACP)分区的展示与校验逻辑(纯函数,便于单测)。
// 数据来自能力 `acp_agents`,规则取自后端 `kb-service/src/acp_registry.rs` 的 validate / validate_command。

export interface AcpAgentRow {
  id: string
  name: string
  command: string
  args: string[]
  /** 环境变量;密钥类的值后端只给 `••••`(表示有值),从不回显明文。 */
  env: Record<string, string>
  /** npm 包名(带版本也行);没有表示要按官方说明手动装。 */
  npm: string
  docs: string
  /** 内置代理才有:地址 / 密钥 / 模型各对应哪个环境变量。 */
  env_hint: { base: string; key: string; model: string } | null
  builtin: boolean
  available: boolean
}

export interface AcpSettings {
  permission: string
  default?: string
  sandbox?: boolean
  tool_groups?: string[]
  agents: AcpAgentRow[]
}

export type AcpPermission = 'none' | 'read' | 'all'

export const PERMISSIONS: readonly { value: AcpPermission; label: string }[] = [
  { value: 'none', label: '全部要确认(默认)' },
  { value: 'read', label: '读和搜索自动放行' },
  { value: 'all', label: '全部自动放行(不推荐)' },
]

/** 改工具权限前的确认文案:说清放开以后代理能做什么。 */
export function permissionConfirm(value: string): { title: string; message: string; danger: boolean; confirmText: string } {
  if (value === 'all') {
    return {
      title: '全部自动放行?',
      message: '代理要执行的任何工具(包括写文件、运行命令)都会被自动放行,不再问你。只在完全信任这个代理时使用。',
      danger: true,
      confirmText: '全部放行',
    }
  }
  if (value === 'read') {
    return { title: '读和搜索自动放行?', message: '代理读文件、搜索知识库不再问你;写操作仍然要你确认。', danger: false, confirmText: '改成自动放行读和搜索' }
  }
  return { title: '全部要确认?', message: '代理每次要执行工具都会先问你,最稳妥。', danger: false, confirmText: '改成全部要确认' }
}

/** 开 / 关沙箱前的确认文案。 */
export function sandboxConfirm(on: boolean): { title: string; message: string; danger: boolean; confirmText: string } {
  return on
    ? { title: '开启沙箱?', message: '之后新拉起的代理会在沙箱(bwrap)里运行。已经在跑的会话要重开才生效。', danger: false, confirmText: '开启' }
    : {
        title: '关闭沙箱?',
        message: '关闭后,代理与守护进程同权,能读到本机上的任何文件。只在沙箱确实起不来时使用。',
        danger: true,
        confirmText: '关闭沙箱',
      }
}

/** 一个代理的状态徽标:已安装 / 未安装;被选为默认却没装好的要标红(那会让聊天直接失败)。 */
export function agentState(agent: Pick<AcpAgentRow, 'id' | 'available'>, defaultId: string): { label: string; tone: 'success' | 'danger' | 'neutral' } {
  if (agent.available) return { label: '已安装', tone: 'success' }
  return agent.id === defaultId ? { label: '未安装 · 已选为默认', tone: 'danger' } : { label: '未安装', tone: 'neutral' }
}

/** npm 规格 → 包名(去掉 `@版本`),与后端 `npm_package_name` 一致;作用域包 `@scope/pkg@1` → `@scope/pkg`。 */
export function npmPackage(spec: string): string {
  const index = spec.lastIndexOf('@')
  return index > 0 ? spec.slice(0, index) : spec
}

/** 卸载确认的文案。安装用的是 `npm -g --prefix <数据目录>/acp-tools`,卸载同样只动那个目录,不是系统全局。 */
export function uninstallMessage(spec: string): string {
  return `会把 ${npmPackage(spec)} 从知识库自己的 acp-tools 目录里移除,不影响系统里装的其它程序,也不影响知识库数据。`
}

const SHELLS = ['sh', 'bash', 'dash', 'zsh', 'fish', 'csh', 'ksh', 'env', 'busybox']

export interface CustomAgentForm {
  id: string
  name: string
  command: string
  args: string
}

/** 添加自定义代理的表单校验(与后端 validate / validate_command 同一口径,提交前就说清,不等服务端拒绝)。 */
export function validateAgentForm(form: CustomAgentForm, existingIds: readonly string[] = []): Partial<Record<'id' | 'command', string>> {
  const errors: Partial<Record<'id' | 'command', string>> = {}
  const id = form.id.trim()
  if (!id) errors.id = '请填一个标识'
  else if (!/^[A-Za-z0-9._-]+$/.test(id)) errors.id = '只能用字母、数字、-、_、.'
  else if (existingIds.includes(id)) errors.id = `「${id}」已经有了。要改它的设置,请在列表里点「配置」`
  const command = form.command.trim()
  if (!command) errors.command = '请填启动命令'
  else if (SHELLS.includes(command.split('/').pop() ?? command)) errors.command = '不能直接用 sh / bash / env 这类解释器,请填具体的程序'
  else if (command.includes('/') && !command.startsWith('/')) errors.command = '请写绝对路径(以 / 开头),或 PATH 上的命令名'
  return errors
}

/** 参数文本 → 数组(空白分隔)。 */
export const splitArgs = (text: string): string[] => text.split(/\s+/).map((item) => item.trim()).filter(Boolean)

/** 变量名里带 KEY / TOKEN / SECRET / PASSWORD 的按密钥处理(输入框遮住)。 */
export const isSecretEnv = (key: string) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)

export interface EnvEntry {
  key: string
  value: string
}

/** 打开配置时的变量行:已有的 + 内置代理约定的地址 / 密钥 / 模型变量(没值的先留空行)。 */
export function envEntries(row: Pick<AcpAgentRow, 'env' | 'env_hint'>): EnvEntry[] {
  const entries = Object.entries(row.env ?? {}).map(([key, value]) => ({ key, value }))
  const hint = row.env_hint
  if (hint) {
    for (const key of [hint.base, hint.key, hint.model]) {
      if (key && !entries.some((entry) => entry.key === key)) entries.push({ key, value: '' })
    }
  }
  return entries
}

/** 变量行 → 提交的对象:没有名字的行丢掉,同名取后面的。值为 `••••` 表示保持原值(后端据此保留旧密钥),清空表示删除。 */
export function envPayload(entries: readonly EnvEntry[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of entries) {
    const key = entry.key.trim()
    if (key) env[key] = entry.value
  }
  return env
}

/** 操作失败的两句话(实现在 actionFailure.ts,设置页各分区共用)。 */
export { actionFailure as acpFailure } from './actionFailure'
