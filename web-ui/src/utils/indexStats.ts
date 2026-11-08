// 向量表的体检结果(能力 index_stats,功能点 sys.ops):每张物理表有多少行、碎成几片、版本留了多少、索引覆盖到哪。
//
// 这一页只做「看见」:碎片与版本数是检索变慢的第一现场(见检索性能说明 ),
// 以前这些数字只在服务器上用 ls/find 数文件才知道。
// 文案统一中文,不出现 table / fragment 之类的实现词(用户看到的是「表」「碎片」)。

/** 后端一行(kb-cli 的 index_stats 输出,字段名与 TableStats 对齐)。
 *  用 type 而不是 interface:表格组件要 Record<string, unknown>,interface 没有隐式索引签名。 */
export type TableStatRow = {
  table: string
  /** 集合名;表被历史记录引用过时可能对不上,取不到就是 null */
  collection: string | null
  rows: number
  fragments: number
  data_files: number
  version: number
  versions: number
  index_kind: string | null
  index_rows: number | null
  index_unindexed_rows: number | null
  index_created_at: number | null
  /** 行数过了阈值却没有索引:夜间任务本该建上 */
  missing_vector_index: boolean
}

export interface IndexStats {
  /** 建索引的行数阈值(index.vector_index_min_rows) */
  threshold: number
  tables: TableStatRow[]
}

/** 数据文件多到这个数就该整理:与 kb doctor 的提示口径一致 */
export const FRAGMENT_WARN = 200

const KIND_LABELS: Record<string, string> = {
  ivf_hnsw_sq: 'IVF-HNSW 量化',
  ivf_hnsw_flat: 'IVF-HNSW',
  ivf_pq: 'IVF-PQ',
  ivf_flat: 'IVF',
}

/** 索引类型的中文名;认不出来就原样显示(升级后多出新类型时不至于空白)。 */
export const indexKindText = (kind: string | null | undefined): string =>
  !kind ? '没有索引' : (KIND_LABELS[kind] ?? kind)

/** 表名:优先显示集合名,对不上时退回物理表名。 */
export const tableName = (row: TableStatRow): string => row.collection ?? row.table

/** 索引一句话:没建 / 建了但还有行没并进去 / 全覆盖。 */
export function indexNote(row: TableStatRow): string {
  if (!row.index_kind) return row.missing_vector_index ? '过了阈值还没建' : '没建索引'
  const pending = row.index_unindexed_rows ?? 0
  return pending > 0 ? `还有 ${pending.toLocaleString('en-US')} 行没并进去` : '已覆盖全部行'
}

/** 碎片一句话:检索要扫的正是这些文件。 */
export const fragmentsNote = (row: TableStatRow): string =>
  row.fragments > FRAGMENT_WARN ? '碎片偏多' : row.fragments > 20 ? '有点碎' : '正常'

/** 需要人看一眼:该建的索引没建,或者碎片攒太多。 */
export const needsAttention = (row: TableStatRow): boolean =>
  row.missing_vector_index || row.fragments > FRAGMENT_WARN

/** 面板顶部的一句话总结(表数 / 行数 / 最碎的那张)。 */
export function statsSummary(stats: IndexStats | null): string {
  if (!stats || !stats.tables.length) return '还没有物理表'
  const rows = stats.tables.reduce((sum, row) => sum + row.rows, 0)
  const fattest = stats.tables.reduce((worst, row) => (row.fragments > worst.fragments ? row : worst), stats.tables[0])
  const parts = [`${stats.tables.length} 张表`, `${rows.toLocaleString('en-US')} 行`]
  if (fattest.fragments > 20) parts.push(`最碎的是 ${tableName(fattest)}(${fattest.fragments} 个碎片)`)
  return parts.join(' · ')
}

/** 有表过了阈值却没索引时,才值得把「整理索引」摆出来。 */
export const hasMissingIndex = (stats: IndexStats | null): boolean =>
  !!stats && stats.tables.some((row) => row.missing_vector_index)
