/**
 * 编辑器扩展 API 的对外入口
 *
 * 扩展（包括随应用打包的内置扩展和仓库里的示例扩展）只能从这里 import，
 * 不能碰 `editor/` 下的其它模块——eslint 的 `no-restricted-imports` 与
 * `extensions/examples.spec.ts` 都会拦。这里只导出「类型 + `defineExtension` + 版本常量」，
 * 没有任何能让扩展拿到编辑器内部对象的东西。
 *
 * 版本规则（设计规范）：新增可选字段不升版本；破坏性变更升 `EDITOR_API_VERSION`。
 */
import type { EditorExtension } from '../extensions/api'

export { EDITOR_API_VERSION } from '../extensions/api'
export type {
  AIToolInput,
  AIToolResult,
  AIToolSpec,
  BuiltinSurfaceKindName,
  ClipboardApi,
  CodecContext,
  CodecSpec,
  CommandHandler,
  Disposable,
  DocumentApi,
  DocumentSnapshot,
  EditorExtension,
  ExtensionContext,
  ExtensionManifest,
  HostApi,
  HostCapability,
  ManifestContributes,
  PageChannel,
  PageEvent,
  PanelSpec,
  Permission,
  SlashItemSpec,
  StatusArea,
  StatusItemHandle,
  StatusItemSpec,
  StatusState,
  SurfaceKindName,
  SurfaceSpec,
  ToolbarActionSpec,
  ToolbarCheckSpec,
  ToolbarChoiceSpec,
  ToolbarItemSpec,
} from '../extensions/api'
// 内容面 / Codec 的输入输出类型，扩展写 Surface 与 Codec 时需要
export type {
  CommandResult,
  EditorCommand,
  EditorSource,
  Surface,
  SurfaceContext,
  SurfaceQuery,
  SurfaceState,
} from '../types'

/**
 * 定义一个扩展。恒等函数：只为了让编辑器在 `activate(ctx)` 里推断出 `ctx` 的类型。
 *
 * ```ts
 * export default defineExtension({
 *   activate(ctx) {
 *     ctx.registerCommand('kb.demo.hello',  => console.log('hello'))
 *   },
 * })
 * ```
 */
export function defineExtension<T extends EditorExtension>(extension: T): T {
  return extension
}
