/**
 * 全部内置扩展，按安装顺序排列
 *
 * 顺序有意义：工具栏分组与按钮按注册顺序出现，所以文本面的格式分组（text）必须先于它的「视图」分组（view），
 * 顶栏操作区的按钮按 export → comment 的顺序排。新增内置扩展时放在这里，`runtime.ts` 创建注册表时统一安装。
 */
import type { ExtensionRegistry } from '../registry'
import { BUILTIN_AI } from './ai.ext'
import { BUILTIN_CODE } from './code.ext'
import { BUILTIN_COMMENT } from './comment.ext'
import { BUILTIN_EXPORT } from './export.ext'
import { BUILTIN_GRID } from './grid.ext'
import { BUILTIN_PAGE } from './page.ext'
import { BUILTIN_PDF } from './pdf.ext'
import type { BuiltinExtension } from './register'
import { BUILTIN_SLIDE } from './slide.ext'
import { BUILTIN_STATS } from './stats.ext'
import { BUILTIN_TEXT } from './text.ext'
import { BUILTIN_VIEW_EXTENSION, BUILTIN_VIEW_MANIFEST } from './view'

export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
  BUILTIN_TEXT,
  { manifest: BUILTIN_VIEW_MANIFEST, extension: BUILTIN_VIEW_EXTENSION },
  BUILTIN_CODE,
  BUILTIN_PDF,
  BUILTIN_GRID,
  BUILTIN_PAGE,
  BUILTIN_SLIDE,
  BUILTIN_EXPORT,
  BUILTIN_COMMENT,
  BUILTIN_AI,
  BUILTIN_STATS,
]

/** 把全部内置扩展装进注册表。 */
export function installBuiltinExtensions(registry: ExtensionRegistry): void {
  for (const { manifest, extension } of BUILTIN_EXTENSIONS) registry.installBuiltin(manifest, extension)
}
