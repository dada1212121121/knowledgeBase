/**
 * Word 编辑命令执行器
 *
 * 把外壳派来的 `docx.*` 命令落到引擎：先过可用性判断，再按 `planDocxCommand` 的结果走格式 / 提交通道，
 * 等引擎回执后返回人能读懂的结果。不认识引擎类型的 Surface 只持有这个执行器。
 *
 * 几个必须保持的约定：
 * - 撤销 / 重做走引擎自己的历史（Yrs 事务），不是前端栈：远端协同的修改不入本地栈，由引擎保证；
 * - 改字体族要先把新字体登记进 Worker 的字体环境（否则排版宽度按替代字体算，分页会和 Word 不一致），
 *   登记成功才提交格式意图；登记失败不提交；
 * - 引擎拒绝（refused）要带着原因返回，不吞：只读被收回、版本过期、选区在不支持的故事里，都是用户该看到的事。
 */
import type { CommandResult } from '../../../types'
import { buildImageWrapPatch, readSelectedObjectAttrs, selectedPictureOf, type DocxEditEngine } from '../../../engines/docx'
import { settleAdmission as settle } from './settle'
import { docxCommandGate, docxFormatState, type DocxFormatState } from './state'
import { isDocxCommandType, planDocxCommand, type DocxCommandArgsMap, type DocxCommandType } from './intents'

export interface DocxCommandRunner {
  /** 当前格式状态（工具栏高亮 / 当前值） */
  formatState(): DocxFormatState
  /** 这条命令现在能不能执行（不执行）；null = 可以 */
  gate(type: DocxCommandType): string | null
  /** 执行一条 `docx.*` 命令；不是本表的命令返回 `{ ok:false, reason:'not_docx_command' }` */
  run(type: string, args?: unknown): Promise<CommandResult>
}

export function createDocxCommandRunner(engine: DocxEditEngine): DocxCommandRunner {
  const { binding } = engine

  /** 引擎当前选中的图片（几何里有、且选区正好覆盖它）；没有返回 null */
  const selectedPicture = () => {
    const geometry = binding.viewStore.getSnapshot().geometry
    return geometry ? selectedPictureOf(geometry) : null
  }
  const formatState = () => docxFormatState(binding.viewStore.getSnapshot().editState as never, selectedPicture() !== null)
  const pendingInput = () => binding.admission.getSnapshot().pendingInputs > 0

  /** 改选中图片的环绕：读当前版式 → 算补丁 → 带着图片版本号提交（版本过期引擎会拒绝，不会改错图） */
  async function wrapPicture(target: DocxCommandArgsMap['docx.image.wrap']['target']): Promise<CommandResult> {
    const picture = selectedPicture()
    const selection = binding.viewStore.getSnapshot().workerSelection
    if (!picture || !selection) return { ok: false, reason: '请先选中一张图片' }
    let attrs: Record<string, unknown> | null
    try {
      await engine.flush()
      attrs = await readSelectedObjectAttrs(engine.client, selection)
    } catch (error) {
      return { ok: false, reason: `读不到图片的当前版式：${error instanceof Error ? error.message : String(error)}` }
    }
    if (!attrs) return { ok: false, reason: '选中的不是图片' }
    const patch = buildImageWrapPatch(attrs, target)
    return settle(
      binding.commands.submit({ kind: 'setObjectProperties', payload: { handle: picture.handle, patch, expectVersion: picture.version } } as never, { fence: true }),
    )
  }

  return {
    formatState,
    gate(type) {
      return docxCommandGate(type, formatState(), pendingInput())
    },
    async run(type, args) {
      if (!isDocxCommandType(type)) return { ok: false, reason: 'not_docx_command' }
      const blocked = docxCommandGate(type, formatState(), pendingInput())
      if (blocked) return { ok: false, reason: blocked }
      if (type === 'docx.image.wrap') return wrapPicture((args as DocxCommandArgsMap['docx.image.wrap']).target)
      const planned = planDocxCommand(type, args as DocxCommandArgsMap[typeof type])
      if (!planned) return { ok: false, reason: '这个操作的参数不合法' }

      // 改字体族：先登记字体环境
      if (type === 'docx.fontFamily') {
        const family = String((args as DocxCommandArgsMap['docx.fontFamily']).family).trim()
        let environment
        try {
          environment = await engine.prepareFontFamily(family)
        } catch (error) {
          return { ok: false, reason: `字体「${family}」没能准备好：${error instanceof Error ? error.message : String(error)}` }
        }
        try {
          const registered = await settle(binding.commands.submit({ kind: 'setFontEnvironment', payload: environment } as never, { fence: true }))
          if (!registered.ok) return registered
          engine.fontEnvironmentApplied(environment)
        } finally {
          // 字体字节只在这份环境里存在一次，登记后立刻释放（大字体几百 KB，别留在主线程）
          environment.faces.length = 0
        }
      }

      const held =
        planned.channel === 'format'
          ? binding.commands.format(planned.intent, { fence: true })
          : binding.commands.submit(planned.intent, { source: type === 'docx.table.select' ? 'selection' : undefined, fence: true })
      return settle(held)
    },
  }
}
