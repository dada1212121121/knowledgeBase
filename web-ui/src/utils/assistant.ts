// AI 助手的纯逻辑:排队提示、今日额度的提示。和界面分开,方便单测。
import { WARN_PERCENT, formatBytes } from '@/utils/usage'

/**
 * 排队提示(后端在全站编码代理名额已满时每秒推一次 `acp.queued { session_id, ahead }`)。
 * ahead 是前面还有几个在等;0 或缺省说明轮到了,不显示。
 */
export function queueText(ahead: number | null | undefined): string {
  if (ahead == null || !(ahead > 0)) return ''
  return ahead === 1 ? '排队中:前面还有 1 个人,轮到你会自动开始' : `排队中:前面还有 ${ahead} 个人,轮到你会自动开始`
}

/** 这条排队事件是不是当前会话的(没有会话号的事件只在还没拿到会话号时认,即本轮第一条消息)。 */
export function isMyQueueEvent(eventSession: string | null | undefined, mySession: string): boolean {
  if (!eventSession) return !mySession
  return !mySession || eventSession === mySession
}

export interface WorkspaceView {
  /** 显示在输入框下面的一句话 */
  text: string
  level: 'ok' | 'warn' | 'over' | 'unlimited'
  /** 满了:后端会拒绝开始新的一轮(acp_chat 返回「超过上限,请先清理」),发送按钮要置灰并说明原因 */
  blocked: boolean
}

/**
 * 代理工作目录的占用(usage_mine.storage.workspace_bytes)与上限(acp_agents.workspace_mb,0 = 不限)。
 * 助手走的是外部编码代理,不用内置模型的每日额度,所以这里显示的是它真正会撞上的限制:工作目录大小。
 * 取不到任何一项就不显示(不编数字)。
 *
 * enforced:服务端会不会真的拦(acp_agents.workspace_enforced)。只有受限账号(spaces/<id>/ 下的用户)才拦,主知识库账号不拦;
 * 不会拦的账号只显示已用多少,不写「上限」也不置灰发送,免得界面比服务端更严。老守护进程没有这个字段时按「不确定」处理,同样不拦。
 * 边界与服务端一致:超过上限(used > limit)才算满;恰好等于上限只提示快满了。
 */
export function workspaceView(
  usedBytes: number | null | undefined,
  limitMb: number | null | undefined,
  enforced: boolean | null | undefined = true,
): WorkspaceView | null {
  if (usedBytes == null || limitMb == null) return null
  const limit = limitMb * 1024 * 1024
  const used = formatBytes(usedBytes)
  if (enforced !== true || !(limit > 0)) return { text: `代理工作目录已用 ${used}`, level: 'unlimited', blocked: false }
  const base = `代理工作目录已用 ${used} / 上限 ${formatBytes(limit)}`
  if (usedBytes > limit) return { text: `${base}。满了,先在「个人设置 → 我的用量」里看看占用,清理后才能继续`, level: 'over', blocked: true }
  if (usedBytes * 100 >= limit * WARN_PERCENT) return { text: `${base}。快满了`, level: 'warn', blocked: false }
  return { text: base, level: 'ok', blocked: false }
}
