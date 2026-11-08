/**
 * 类型化示例：用 TypeScript + `@/editor/api` 写一个把七类贡献各注册一遍的扩展
 *
 * 它有两个用处：
 * 1. `vue-tsc` 会检查它——公开类型（`ExtensionContext`、各 `*Spec`、`Surface` 等）改坏了，这里先编译不过；
 * 2. 给用 TypeScript 写内置扩展的人（迁移内置贡献）一个照抄的样子。
 *
 * 这个文件和真正的第三方扩展处在同样的位置：只从 `@/editor/api` 导入（eslint 的 no-restricted-imports 保证）。
 */
import { defineExtension } from '@/editor/api'
import type { Surface } from '@/editor/api'

export const TYPED_MANIFEST_ID = 'kb.typed'

/** 一个最小的只读内容面：把文本逐行画成列表。 */
function createLinesSurface(): Surface {
  let root: HTMLElement | null = null
  return {
    async mount(el, ctx) {
      const source = ctx.document.payload as { kind: 'text'; text: string } | { kind: 'bytes'; bytes: Uint8Array }
      const text = source.kind === 'text' ? source.text : new TextDecoder().decode(source.bytes)
      root = document.createElement('ul')
      for (const line of text.split('\n')) {
        const item = document.createElement('li')
        item.textContent = line
        root.append(item)
      }
      el.append(root)
    },
    unmount() {
      root?.remove()
      root = null
    },
    resize() {},
    focus() {},
    setReadonly() {},
    async command() {
      return { ok: false, reason: 'readonly_surface' }
    },
    async query() {
      return null
    },
    capture() {
      return { kind: `ext:${TYPED_MANIFEST_ID}.surface` }
    },
    restore() {},
  }
}

export default defineExtension({
  activate(ctx) {
    ctx.registerCommand('kb.typed.hello', (_args, api) => {
      api.notify(`你好，来自 ${api.manifest.name}`)
    })
    ctx.registerToolbarItem({ id: 'kb.typed.button', label: '打招呼', icon: '👋', command: 'kb.typed.hello' })
    ctx.registerSlashItem({ id: 'kb.typed.slash', label: '打招呼', command: 'kb.typed.hello', keywords: ['hello'] })
    ctx.registerPanel({
      id: 'kb.typed.panel',
      title: '示例面板',
      mount(el, api) {
        const subscription = api.document.onChange(() => {
          void api.document.read().then((doc) => {
            el.textContent = `${doc.text.length} 个字符`
          })
        })
        return () => subscription.dispose()
      },
    })
    ctx.registerCodec({
      id: 'kb.typed.codec',
      decode: (bytes, codecCtx) => ({ kind: 'text', text: new TextDecoder().decode(bytes), name: codecCtx.name }),
      encode: (source) => new TextEncoder().encode(source.kind === 'text' ? source.text : ''),
    })
    ctx.registerSurface({ id: 'kb.typed.surface', create: createLinesSurface })
    ctx.registerAITool({
      id: 'kb.typed.ai',
      title: '转大写',
      run: (input) => ({ text: input.text.toUpperCase(), note: '示例工具，只转大写' }),
    })
  },
})
