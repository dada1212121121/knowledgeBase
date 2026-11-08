/**
 * 内置扩展：表格（grid 面）的工具栏
 * 所有表格都有「查找」；CSV / TSV 另有「行」操作（上方 / 下方插入、删除选中行、末尾加一行）。
 * xlsx 的网格没有这些行命令，所以行操作按格式（`formats`）限定，而不是按内容面。
 */
import { defineExtension } from '../../api'
import { builtinManifest, registerToolbarGroups, type BuiltinExtension } from './register'
import { CSV_ROW_TOOLBAR, FIND_ONLY_TOOLBAR } from './text'

export const BUILTIN_GRID_ID = 'kb.builtin.grid'

export const BUILTIN_GRID: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_GRID_ID, name: '表格工具栏', description: '表格的查找，以及 CSV / TSV 的行操作', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      registerToolbarGroups(ctx, FIND_ONLY_TOOLBAR, { kinds: ['grid'] })
      registerToolbarGroups(ctx, CSV_ROW_TOOLBAR, { kinds: ['grid'], formats: ['csv', 'tsv'] })
    },
  }),
}
