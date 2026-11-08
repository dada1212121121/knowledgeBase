// 设置页各分区里「点了某个按钮但失败了」的提示文案(纯函数,便于单测):出了什么事 + 怎么办。
// 服务端给的中文原因带上(它通常已经说清了原因);英文异常、状态码一律换成人话,不直接露给用户。

const HAS_CJK = /[\u4e00-\u9fff]/

/** 操作失败的两句话。服务端给的中文原因带上,英文异常换成人话。 */
export function actionFailure(doing: string, err: unknown, advice = '请稍后重试'): string {
  const raw = err instanceof Error ? err.message.trim() : ''
  const status = typeof err === 'object' && err !== null ? (err as { status?: unknown }).status : undefined
  if (status === 403) return `${doing}失败:你的账号没有这个权限。请联系管理员。`
  const gap = /[A-Za-z0-9]$/.test(doing) ? ' ' : ''
  if (HAS_CJK.test(raw)) return `${doing}${gap}失败:${raw.replace(/[。.]$/, '')}。${advice}。`
  return `${doing}${gap}失败:服务没有正常回应。${advice}。`
}
