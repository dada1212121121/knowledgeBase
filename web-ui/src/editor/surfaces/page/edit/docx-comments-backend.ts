/**
 * 评论控制器的真引擎后端。
 *
 * 引擎的评论命令都是"先读目标（带文档版本）→ 带 `expectVersion` 提交"：评论目标被别人（协同）删了或改了位置，
 * 版本对不上引擎会拒绝，不会把评论加到错位的文字上。这里按引擎的这个节奏发，不自作聪明地缓存版本。
 */
import { readCommentRange, readDocxReview, readReviewTarget, type DocxEditEngine } from '../../../engines/docx'
import { settleAdmission, settleSelection } from '../commands/settle'
import type { CommentBackend, CommentSnapshot } from './docx-comment-controller'

export function createCommentBackend(engine: DocxEditEngine, revealSelection: () => void): CommentBackend {
  const { binding } = engine
  /** 评论的字符串 id → 界面用的数字 id（`reviewTarget` 要）；每次读都重建 */
  let uiIds = new Map<string, number>()

  const submit = (kind: string, payload: unknown) => settleAdmission(binding.commands.submit({ kind, payload } as never, { fence: true }))

  /** 目标评论当前的会话 id / 范围 / 版本；评论已经不在了返回 null */
  async function targetOf(id: string) {
    const uiId = uiIds.get(id)
    if (uiId === undefined) return null
    return readReviewTarget(engine.client, { kind: 'comment', uiId })
  }

  return {
    async read(): Promise<CommentSnapshot> {
      // 先把没落到引擎的输入冲掉：刚加的评论 / 刚敲的字都要在这次快照里
      await engine.flush()
      const review = await readDocxReview(engine.client)
      uiIds = new Map(review.comments.flatMap((comment) => (comment.uiId === undefined ? [] : [[comment.id, comment.uiId] as const])))
      // 位置序号：按（页序号, 页内 y）排；还没有矩形的（页没建）不给，排到最后
      const placed = [...review.commentAnchors.entries()].sort(([, left], [, right]) => left.pageIndex - right.pageIndex || left.y - right.y)
      const positions = new Map(placed.map(([id], index) => [id, index]))
      return { comments: review.comments, positions }
    },

    async add(text, author) {
      await engine.flush()
      const selection = binding.viewStore.getSnapshot().workerSelection
      if (!selection) return { ok: false, reason: '先选中要评论的文字' }
      const target = await readCommentRange(engine.client, selection)
      if (!target) return { ok: false, reason: '先选中要评论的文字（光标不能是空的，也不能在页眉页脚里）' }
      return submit('addComment', { ranges: [target.range], author, date: new Date().toISOString(), body: text, expectVersion: target.version })
    },

    async reply(parentId, text, author) {
      const target = await targetOf(parentId)
      if (!target) return { ok: false, reason: '要回复的评论已经不在了' }
      // 回复锚在父评论的范围上，并带 parentId（Word 里回复是挂在父评论下的）
      return submit('addComment', { ranges: target.ranges, author, date: new Date().toISOString(), body: text, parentId: target.id, expectVersion: target.version })
    },

    async setDone(id, done) {
      const target = await targetOf(id)
      if (!target) return { ok: false, reason: '这条评论已经不在了' }
      return submit('updateComment', { id: target.id, patch: { done }, expectVersion: target.version })
    },

    async remove(id) {
      const target = await targetOf(id)
      if (!target) return { ok: false, reason: '这条评论已经不在了' }
      return submit('removeComment', { id: target.id, expectVersion: target.version })
    },

    async reveal(id) {
      const target = await targetOf(id)
      if (!target) return false
      // 选中评论锚着的文字，再按引擎帧里的选区几何滚过去（评论所在页可能还没建，取不到它的矩形）
      const [range] = target.ranges as Array<{ story: string; start: { paraId: string; offset: number }; end: { paraId: string; offset: number } }>
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
