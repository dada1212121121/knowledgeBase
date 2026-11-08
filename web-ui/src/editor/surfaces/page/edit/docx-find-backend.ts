/**
 * 查找控制器的真引擎后端：把 `FindBackend` 接到 Worker 里的引擎。
 *
 * 命中、高亮、替换都由引擎算：中文、跨页、表格里的文字、被修订打断的文字都和"文档里看到的"一致；
 * 这里只做三件事——发读请求、提交选中 / 替换命令、等回执。
 */
import { findDocxText, readDocxHighlights, type DocxEditEngine } from '../../../engines/docx'
import { settleAdmission, settleSelection } from '../commands/settle'
import { highlightRange, selectionForMatch } from './docx-find'
import { FIND_LIMIT } from './docx-find'
import type { FindBackend } from './docx-find-controller'

export function createFindBackend(engine: DocxEditEngine, suggesting: () => { name: string } | undefined): FindBackend {
  const { binding } = engine
  return {
    async find(query) {
      // 先把还没落到引擎的输入冲掉：用户刚敲完字就查，命中里要包含那些字
      await engine.flush()
      return findDocxText(engine.client, query, FIND_LIMIT)
    },
    async select(match) {
      const { result, shown } = await settleSelection(binding.commands.submit({ kind: 'select', payload: { selection: selectionForMatch(match) } } as never, { source: 'selection', fence: true }))
      return { ok: result.ok, shown }
    },
    async replace(request) {
      const result = await settleAdmission(binding.commands.submit({ kind: 'replaceMatches', payload: request } as never, { fence: true }))
      return result.ok ? { ok: true } : { ok: false, reason: result.reason }
    },
    async highlights(matches) {
      const geometry = binding.viewStore.getSnapshot().geometry
      if (!geometry?.documentVersion) return null
      return readDocxHighlights(engine.client, matches.map(highlightRange), geometry.documentVersion, geometry.frameEpoch, geometry.layoutRevision)
    },
    suggesting,
  }
}
