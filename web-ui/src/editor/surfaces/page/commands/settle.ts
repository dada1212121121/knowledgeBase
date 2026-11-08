/**
 * 等一次命令准入走完并取回执，翻成 `CommandResult`（执行器用， 的查找 / 评论 / 修订也用）。
 * 引擎拒绝要带着人能读懂的原因返回，不吞：只读被收回、版本过期、选区在不支持的故事里，都是用户该看到的事。
 */
import type { CommandResult } from '../../../types'
import type { PeerlessAdmissionResult } from '../../../engines/docx/vendor/inputAdmission'

/** 把引擎的回执原因翻成人话；没见过的原因原样带上，便于排查 */
export function reasonText(reason: string | undefined): string {
  switch (reason) {
    case 'read-only':
      return '文档当前是只读的'
    case 'revision-required':
      return '请先把光标放在要处理的修订上'
    case 'unknown-revision':
      return '这条修订已经不存在了'
    case 'stale-version':
    case 'version-mismatch':
      return '文档在你操作期间被改动了，请重试'
    default:
      return reason ? `引擎没有执行这个操作（${reason}）` : '引擎没有执行这个操作'
  }
}

/** 一次准入走完后的回执，加上"引擎有没有把它的效果画进已安装的几何"这一条 */
interface Settled {
  result: CommandResult
  /** 命令被引擎接下（applied / noop）时才有：覆盖该命令的几何帧装好（或被丢弃）时落定，不会拒绝 */
  presented?: Promise<unknown>
}

async function settle(held: PeerlessAdmissionResult): Promise<Settled> {
  let admitted: PeerlessAdmissionResult | undefined = held
  // 输入法组合期间提交会被"挂起"，组合结束才放行；这里等它放行，不抢在组合前面
  if (held.status === 'held') admitted = await held.released
  if (admitted?.status === 'ignored') return { result: { ok: false, reason: admitted.reason === 'read-only' ? '文档当前是只读的' : '没有可执行的内容' } }
  if (admitted?.status !== 'submitted') return { result: { ok: false, reason: '引擎没有接收这个操作' } }
  const outcome = await admitted.ticket.ack
  const presented = admitted.ticket.presented
  if (outcome.status === 'applied') return { result: { ok: true, data: { seq: outcome.seq } }, presented }
  // noop：命令合法但没有改动文档；不是失败。选区命令（select）几乎总是这个结果——选区变了、文档没变，
  // 照样会有一帧带着新选区的几何随后到达，所以 noop 同样带 presented
  if (outcome.status === 'noop') return { result: { ok: true, data: { seq: outcome.seq, noop: true } }, presented }
  return { result: { ok: false, reason: reasonText(outcome.reason) } }
}

/** 等一次准入走完并取回执 */
export async function settleAdmission(held: PeerlessAdmissionResult): Promise<CommandResult> {
  return (await settle(held)).result
}

/**
 * 同 `settleAdmission`，另给一个 `shown`：它落定时，含这次选区的几何帧已经装进 viewStore。
 *
 * 回执（ack）只表示引擎收下并算完了命令，带新选区的几何帧是之后才到、才装进 viewStore 的；
 * 机器忙时两者能差几百毫秒到几秒（空闲时约 20~40 ms）。"选中某处，再按 viewStore 里的选区几何滚过去"
 * 必须等 `shown`，否则读到的是上一个选区的位置，页面就停在上一个命中那里
 * （查找连按"下一个"后，当前命中落在可视区之外）。
 * 命令被拒绝 / 被忽略时没有新帧，`shown` 立即落定。
 */
export async function settleSelection(held: PeerlessAdmissionResult): Promise<{ result: CommandResult; shown: Promise<void> }> {
  const { result, presented } = await settle(held)
  return { result, shown: presented ? presented.then(() => undefined, () => undefined) : Promise.resolve() }
}
