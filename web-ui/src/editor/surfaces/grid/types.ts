/**
 * Grid Surface 的纯数据契约
 *
 * 这一层刻意不依赖 Vue / DOM：CSV、XLSX 以及测试里的合成表都只需要实现
 * `GridSheet`，网格只负责几何、选区、绘制与键盘，不关心数据来自文件还是引擎。
 * 这样 5 万格性能测试可以直接喂一个生成器，不必启动整个编辑器。
 */

/** 0 基坐标；右上/左下边界都包含在选区内 */
export interface CellCoord {
  row: number
  col: number
}

/** 单元格矩形（0 基，单位：格） */
export interface GridRange {
  top: number
  left: number
  bottom: number
  right: number
}

/** 单元格的对齐 / 数字格式由数据源给出，网格只按字符串画 */
export type GridAlign = 'left' | 'center' | 'right'

/** 一个可绘制的单元格；空单元格返回 null 而不是空对象，省掉大量分配 */
export interface GridCell {
  /** 显示文本（公式显示结果，不显示 `=` 本身） */
  text: string
  /** 原始输入（公式栏显示这个；缺省等于 text） */
  raw?: string
  /** 公式以 `=` 开头；编辑时预填 raw */
  formula?: string
  align?: GridAlign
  /** 粗体 / 填充色只用于 xlsx 只读保真，CSV 不填 */
  bold?: boolean
  background?: string
  color?: string
  /** 合并区域：只有左上角返回内容，其余返回 null；几何查询用它扩选 */
  merged?: GridRange
}

/** 数据源：网格只读它，不反向修改；编辑命令由上层适配器落到 codec / engine */
export interface GridSheet {
  readonly name: string
  readonly rowCount: number
  readonly colCount: number
  cell(row: number, col: number): GridCell | null
  /** 列宽（CSS px）；缺省用 geometry 的默认值 */
  columnWidth?(col: number): number | undefined
  /** 行高（CSS px）；缺省用 geometry 的默认值 */
  rowHeight?(row: number): number | undefined
  /** 冻结行列数（只影响绘制时的固定区，滚动仍由 view 处理） */
  readonly frozenRows?: number
  readonly frozenCols?: number
  /** 合并区域列表；点击合并区时选区扩到整块 */
  mergedRanges?(): readonly GridRange[]
  /**
   * 查找只扫这些行区间（`[起, 止)`，升序、不重叠）；缺省扫全表。
   * 服务端分页的表只有读进来的页有内容，扫整张百万行的表既慢又没有意义。
   */
  scanRanges?(): ReadonlyArray<readonly [number, number]>
}

/** 选区：anchor 是起点，focus 是活动端（Shift 扩选时只动 focus） */
export interface GridSelection {
  anchor: CellCoord
  focus: CellCoord
}

/** 视口：scroll 是内容坐标，宽高是 CSS 像素 */
export interface GridViewport {
  scrollTop: number
  scrollLeft: number
  width: number
  height: number
}

/** 可见范围（含 overscan），last 为开区间 */
export interface VisibleRange {
  firstRow: number
  lastRow: number
  firstCol: number
  lastCol: number
}

/** 一次粘贴要写入的单元格（相对起点） */
export interface GridPasteCell {
  row: number
  col: number
  text: string
}

/** 一次单元格编辑（行列为 0 基；text 为空表示清空） */
export interface GridEdit {
  row: number
  col: number
  text: string
}

/** 键盘解析后的语义动作；view 只执行，不自己判断平台差异 */
export type GridKeyAction =
  | { kind: 'move'; rowDelta: number; colDelta: number; extend: boolean; jump: boolean }
  | { kind: 'page'; direction: 'up' | 'down'; extend: boolean }
  | { kind: 'edit' }
  | { kind: 'clear' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'find' }
  | { kind: 'selectAll' }
  | null

/** 单元格命中结果：列/行头也返回，方便 view 做整行整列选择 */
export type GridHit =
  | { kind: 'cell'; row: number; col: number }
  | { kind: 'rowHeader'; row: number }
  | { kind: 'colHeader'; col: number }
  | { kind: 'corner' }
  | null
