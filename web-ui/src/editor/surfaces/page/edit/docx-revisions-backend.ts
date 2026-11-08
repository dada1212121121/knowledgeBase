/**
 * 修订控制器的真引擎后端：读修订列表、按修订 id 接受 / 拒绝、选中并滚到它。
 *
 * 接受 / 拒绝按修订 id 提交；修订被别人（协同）处理了就不存在了，先 `reviewTarget` 确认，
 * 避免把一个已经没有的 id 交给引擎。
 */
import { readDocxReview, readReviewTarget, type DocxEditEngine } from '../../../engines/docx'
import { settleAdmission, settleSelection } from '../commands/settle'
import type { RevisionBackend } from './docx-revisions'

export function createRevisionBackend(engine: DocxEditEngine, revealSelection: () => void): RevisionBackend {
  const { binding } = engine
  return {
    async read() {
      await engine.flush()
      return (await readDocxReview(engine.client)).revisions
    },

    async decide(revisionId, accept) {
      // 先确认这条修订还在：不在了（被别人处理了）给明确的原因，而不是让引擎报一个笼统的拒绝
      const target = await readReviewTarget(engine.client, { kind: 'revision', revisionId })
      if (!target) return { ok: false, reason: '这条修订已经不存在（可能被别人处理了）' }
      // 接受 / 拒绝的载荷不带 expectVersion：版本由准入层按当前文档补（上游契约，类型上就是 Omit<…, 'expectVersion'>）
      return settleAdmission(binding.commands.submit({ kind: accept ? 'acceptRevision' : 'rejectRevision', payload: { revisionId: target.id } } as never, { fence: true }))
    },

    async reveal(revisionId) {
      const target = await readReviewTarget(engine.client, { kind: 'revision', revisionId })
      const [range] = (target?.ranges ?? []) as Array<{ story: string; start: { paraId: string; offset: number }; end: { paraId: string; offset: number } }>
      if (!range) return false
      const { result, shown } = await settleSelection(
        binding.commands.submit(
          { kind: 'select', payload: { selection: { anchor: { story: range.story, ...range.start }, focus: { story: range.story, ...range.end } } } } as never,
          { source: 'selection', fence: true },
        ),
      )
      // 选区几何随新一帧才到，回执一到就读会读到上一个选区的位置，所以等帧装好再滚
      if (result.ok) {
        await shown
        revealSelection()
      }
      return result.ok
    },
  }
}
