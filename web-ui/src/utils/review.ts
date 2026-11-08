// 审核收件箱的纯逻辑:状态 / 类型文案、AI 建议、批量操作的结果汇总、正文是否要折叠。
// 和界面分开,方便单测;页面只负责取数和画出来。

export type DraftState = 'pending' | 'approved' | 'revised' | 'rejected' | 'duplicate'

export const KIND_TEXT: Record<string, string> = { decision: '决策', pitfall: '坑', howto: '做法', convention: '约定' }
export const kindText = (kind: string): string => KIND_TEXT[kind] ?? kind

export const STATE_TEXT: Record<string, string> = { pending: '待审', approved: '已通过', revised: '修订通过', rejected: '已驳回', duplicate: '重复' }
export const stateText = (state: string): string => STATE_TEXT[state] ?? state

export function stateTone(state: string): 'warning' | 'success' | 'danger' | 'neutral' {
  if (state === 'pending') return 'warning'
  if (state === 'approved' || state === 'revised') return 'success'
  if (state === 'rejected') return 'danger'
  return 'neutral'
}

/** AI 评分:没有审核结论(没配模型 / 额度用完)就直说,不写 0 分。 */
export const scoreText = (score: number | null): string => (score === null ? '没有 AI 审核结论' : `AI ${Math.round(score * 100)} 分`)
/** 70 分以上算有把握,其余提醒人多看一眼。 */
export const scoreTone = (score: number | null): 'success' | 'warning' => (score !== null && score >= 0.7 ? 'success' : 'warning')

/** AI 的建议(ai_then_human 模式下这就是「AI 建议通过 / 建议修订 / 建议驳回」)。 */
export function decisionText(decision: string | null): string {
  if (decision === 'approve') return 'AI 建议通过'
  if (decision === 'revise') return 'AI 建议修订'
  if (decision === 'reject') return 'AI 建议驳回'
  return ''
}

/** 能审的状态:待审和重复(重复的也允许人工放行)。其它状态只读。 */
export const isActionable = (state: string): boolean => state === 'pending' || state === 'duplicate'

/** 正文超过这个长度(或行数)就折叠成几行,点「展开」看全文。 */
const FOLD_CHARS = 180
const FOLD_LINES = 4
export const isLongBody = (body: string): boolean => body.length > FOLD_CHARS || body.split('\n').length > FOLD_LINES

/** 批量操作的结果汇总:全部成功 / 部分成功 / 全部失败,各说各的话,失败的条数不能被「成功」盖住。 */
export function batchSummary(verb: string, done: number, failed: number, firstError = ''): { text: string; tone: 'success' | 'warning' | 'danger' } {
  if (failed === 0) return { text: `已${verb} ${done} 条`, tone: 'success' }
  const reason = firstError ? `(第一个失败原因:${firstError})` : ''
  if (done === 0) return { text: `${failed} 条都没能${verb}${reason}`, tone: 'danger' }
  return { text: `已${verb} ${done} 条,另有 ${failed} 条没成功${reason}`, tone: 'warning' }
}

/** 还有多少条没显示出来(后端分页);没有更多返回 0。 */
export const remaining = (total: number, shown: number): number => Math.max(0, total - shown)
