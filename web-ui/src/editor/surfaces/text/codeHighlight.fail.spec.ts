/**
 * 高亮引擎的 chunk 拉不到时（离线 / 部署中途）：代码块保持纯文本，编辑器照常可用，不抛未处理的异常，也不反复重试。
 * 单独一个文件，因为这里要把引擎模块整个换成「加载即失败」，会影响同文件里的其它用例。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./codeHighlightEngine', () => {
  throw new Error('chunk load failed')
})

import { cleanupText, mountText } from './textTestKit'
import { highlightEngineState, resetHighlightEngine } from './codeHighlight'

afterEach(cleanupText)

describe('高亮引擎加载失败', () => {
  it('代码块保持纯文本，正文可继续编辑，状态记为 failed 且不再重试', async () => {
    resetHighlightEngine()
    const { el, view, surface } = await mountText('```js\nconst a = 1\n```')
    const deadline = Date.now() + 5000
    while (highlightEngineState() !== 'failed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(highlightEngineState()).toBe('failed')
    expect(el.querySelectorAll('.kb-code-block code [class^="tok-"]').length).toBe(0)
    // 编辑照常：改代码后保存出来的 Markdown 带上改动
    view.dispatch(view.state.tr.insertText(' + 2', view.state.doc.content.size - 1))
    expect(await surface.query({ type: 'text' })).toBe('```js\nconst a = 1 + 2\n```\n')
  })
})
