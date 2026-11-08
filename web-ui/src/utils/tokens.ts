// 访问令牌的纯逻辑:名字校验、类型说明、错误话术。页面见 components/TokenCard.vue。
import { AccountError } from '@/api/client'

export const SCOPE_LABEL: Record<string, string> = { mcp: 'MCP', api: 'API' }

/** 令牌类型的一句话说明(创建对话框里选类型时看)。 */
export const SCOPE_HELP: Record<'mcp' | 'api', string> = {
  mcp: '给 Kiro、Claude Code、Codex 等 MCP 客户端连接知识库用。',
  api: '给你自己的脚本调用网页接口用。',
}

/** 创建前的名字校验;合格返回 `null`。重名只有后端知道(409),这里不猜。 */
export function checkTokenName(raw: string): string | null {
  if (raw.trim() === '') return '请给令牌起个名字,方便以后知道它给谁用'
  return null
}

/** 共享内容开关对这个类型有没有意义:只有 MCP 令牌会去搜索别人分享给我的内容。 */
export const sharedApplies = (scope: string) => scope === 'mcp'

/** 创建 / 撤销 / 读取失败时给用户看的话(发生了什么 + 怎么办)。 */
export function explainTokenError(err: unknown, name = ''): string {
  if (!(err instanceof AccountError)) return '连不上服务器。检查网络后再试一次。'
  if (err.status === 409) return `已经有一个叫「${name.trim()}」的令牌了。换个名字,或者先撤销旧的那个。`
  if (err.status === 403) return '你的账号没有开通这个功能,请联系管理员。'
  if (err.status === 404) return '这个令牌已经不存在了(可能在别处撤销过),刷新列表可以看到最新情况。'
  const detail = err.message.trim().replace(/[。.!!]+$/, '')
  return detail ? `${detail}。请稍后再试。` : '操作没有成功,请稍后再试。'
}
