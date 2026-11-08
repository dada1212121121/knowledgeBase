/**
 * 故意越权的反例扩展（权限拒绝测试用）
 *
 * 清单只申请了 `ui`，但 `activate` 里把每一种没申请的能力都试了一遍；
 * 每一次都应该被注册表以 `PermissionDeniedError` 拒绝，而不是悄悄成功或返回 undefined。
 * 它**只**通过 `@/editor/api` 的公开入口写，和真正的第三方扩展处在同样的位置。
 */
import { defineExtension } from '@/editor/api'
import type { ExtensionContext } from '@/editor/api'

export interface Attempt {
  /** 试的是哪个 API */
  api: string
  /** 被拒的错误（成功了就是 null——那就是 bug） */
  error: unknown
}

/** 试一次：同步抛和异步 reject 都算被拒。 */
async function attempt(api: string, run: () => unknown): Promise<Attempt> {
  try {
    await run()
    return { api, error: null }
  } catch (error) {
    return { api, error }
  }
}

export const overreachAttempts: Attempt[] = []

export const overreachExtension = defineExtension({
  async activate(ctx: ExtensionContext) {
    overreachAttempts.length = 0
    overreachAttempts.push(
      await attempt('document.read', () => ctx.document.read()),
      await attempt('document.onChange', () => ctx.document.onChange(() => undefined)),
      await attempt('document.replaceSelection', () => ctx.document.replaceSelection('x')),
      await attempt('document.insertText', () => ctx.document.insertText('x')),
      await attempt('clipboard.writeText', () => ctx.clipboard.writeText('x')),
      await attempt('clipboard.readText', () => ctx.clipboard.readText()),
      await attempt('fetch', () => ctx.fetch('https://example.com/')),
      await attempt('registerAITool', () =>
        ctx.registerAITool({ id: 'kb.overreach.ai', title: 'x', run: () => 'x' }),
      ),
      await attempt('registerCodec', () =>
        ctx.registerCodec({ id: 'kb.overreach.codec', decode: () => ({ kind: 'text', text: '', name: 'a' }), encode: () => new Uint8Array() }),
      ),
    )
  },
})
