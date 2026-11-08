/** 命令失败反馈的筛选规则单测：只显示写给人看的中文原因，不弹机器代码。 */
import { describe, expect, it } from 'vitest'
import { commandFeedback, isReadonlySafeToolbarCommand } from './commandFeedback'

describe('commandFeedback', () => {
  it('成功：空串（用来清掉上一条失败提示）', () => {
    expect(commandFeedback({ ok: true })).toBe('')
    expect(commandFeedback({ ok: true, data: { pages: 20 } })).toBe('')
  })

  it('失败且原因是中文：原样显示', () => {
    expect(commandFeedback({ ok: false, reason: '浏览器拦截了打印窗口，请允许本站弹出窗口后再试' })).toBe('浏览器拦截了打印窗口，请允许本站弹出窗口后再试')
    expect(commandFeedback({ ok: false, reason: '请先选中一张图片' })).toBe('请先选中一张图片')
  })

  it('失败但原因是机器代码：不显示——把 nothing_to_undo 弹给用户比不提示更糟', () => {
    for (const reason of ['nothing_to_undo', 'nothing_to_redo', 'surface_not_mounted', 'unsupported_command:docx.foo', 'anchor_lost', 'no_match', 'empty_text', 'invalid_args']) {
      expect(commandFeedback({ ok: false, reason }), reason).toBe('')
    }
  })

  it('失败但没有原因：不显示', () => {
    expect(commandFeedback({ ok: false })).toBe('')
    expect(commandFeedback({ ok: false, reason: '   ' })).toBe('')
  })

  it('中英混合的原因（带英文错误详情）：显示，前缀是给人看的中文', () => {
    expect(commandFeedback({ ok: false, reason: '导出失败：Failed to fetch' })).toBe('导出失败：Failed to fetch')
  })

  it('首尾空白被去掉', () => {
    expect(commandFeedback({ ok: false, reason: '  文档当前是只读的 ' })).toBe('文档当前是只读的')
  })
})

describe('isReadonlySafeToolbarCommand', () => {
  const toolbar = [
    {
      actions: [
        { command: 'docx.bold', write: true },
        { command: 'file.print' },
        { command: 'export.docx' },
        { command: 'view.toggleReview' },
        // 同一个命令既被写动作用、又被非写动作用：保守当写命令
        { command: 'docx.mixed', write: true },
        { command: 'docx.mixed' },
      ],
    },
    { actions: [{ command: 'docx.insertImage', write: true }] },
  ]

  it('非写动作的命令：只读安全（打印 / 导出 / 审阅开关）', () => {
    for (const command of ['file.print', 'export.docx', 'view.toggleReview']) expect(isReadonlySafeToolbarCommand(toolbar, command), command).toBe(true)
  })

  it('写动作的命令：不安全', () => {
    expect(isReadonlySafeToolbarCommand(toolbar, 'docx.bold')).toBe(false)
    expect(isReadonlySafeToolbarCommand(toolbar, 'docx.insertImage')).toBe(false)
  })

  it('同一命令混用写 / 非写动作：保守当写命令，不论顺序', () => {
    expect(isReadonlySafeToolbarCommand(toolbar, 'docx.mixed')).toBe(false)
    const reversed = [{ actions: [{ command: 'docx.mixed' }, { command: 'docx.mixed', write: true }] }]
    expect(isReadonlySafeToolbarCommand(reversed, 'docx.mixed')).toBe(false)
  })

  it('工具栏里没有的命令：不安全（不能因为"没声明为写"就放行一个未知命令）', () => {
    expect(isReadonlySafeToolbarCommand(toolbar, 'docx.unknown')).toBe(false)
    expect(isReadonlySafeToolbarCommand([], 'file.print')).toBe(false)
  })
})
