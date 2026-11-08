/**
 * Word 编辑面的查找 / 替换
 *
 * 命中的来源是引擎的 `findText`（在 Worker 里按"接受修订后的文字"搜），每个命中带一个 `range`，
 * 可以原样作为替换的目标——不在前端自己扫文字再猜位置，所以中文、跨页、表格里的文字、被修订打断的文字都一样准。
 * 本文件是纯逻辑：命中列表 ↔ 外壳要的 `{query,total,index,anchors}`、当前命中的游走、替换请求的组装；
 * 和引擎、DOM 无关，所以能直接单测。引擎调用在 `DocxFindController`（同目录 `docx-find-controller.ts`）。
 */

/** 引擎给的一个命中（只写用到的字段） */
export interface DocxMatch {
  text: string
  range: {
    story: string
    start: { paraId: string; offset: number }
    end: { paraId: string; offset: number }
    view: string
  }
}

/** 外壳 `search.*` 命令的返回形状 */
export interface FindResult {
  query: string
  total: number
  /** 当前命中的下标，没有命中是 -1 */
  index: number
  anchors: Array<{ kind: 'page'; page: number; text: string }>
}

/** 单次查找最多取多少个命中：和引擎的默认上限一致，再多的文档高亮也画不下，且替换全部要整批提交 */
export const FIND_LIMIT = 1000

export interface FindState {
  query: string
  matches: readonly DocxMatch[]
  index: number
  truncated: boolean
}

export const EMPTY_FIND: FindState = { query: '', matches: [], index: -1, truncated: false }

/** 往后 / 往前走一个命中，首尾相接 */
export function stepIndex(index: number, total: number, backward: boolean): number {
  if (total <= 0) return -1
  if (index < 0) return backward ? total - 1 : 0
  return (index + (backward ? total - 1 : 1)) % total
}

/**
 * 命中 → 选区。光标落在命中末尾（和浏览器查找一致，按 Enter 继续往后找时从这里起）。
 * 选区的 anchor/focus 用引擎的位置形状 `{story, paraId, offset}`。
 */
export function selectionForMatch(match: DocxMatch): { anchor: { story: string; paraId: string; offset: number }; focus: { story: string; paraId: string; offset: number } } {
  const { story, start, end } = match.range
  return { anchor: { story, paraId: start.paraId, offset: start.offset }, focus: { story, paraId: end.paraId, offset: end.offset } }
}

/** 引擎的高亮读取用的范围形状（`YrsStoryRange`，没有 view 字段） */
export function highlightRange(match: DocxMatch) {
  const { story, start, end } = match.range
  return { story, start: { paraId: start.paraId, offset: start.offset }, end: { paraId: end.paraId, offset: end.offset } }
}

/**
 * 外壳要的结果。`pageOf` 把命中映射到页码（查找条旁的"第几页"和大纲跳转用）；
 * 引擎不给页码时由调用方用几何补，这里只负责形状。
 */
export function toFindResult(state: FindState, pageOf: (match: DocxMatch) => number = () => 0): FindResult {
  const current = state.matches[state.index]
  return {
    query: state.query,
    total: state.matches.length,
    index: state.index,
    anchors: current ? [{ kind: 'page', page: pageOf(current), text: state.query }] : [],
  }
}

/** 查找条上的替换文字不能含换行：引擎的替换是"同一段内的文字替换"，换行要拆段，那是另一个操作 */
export function validateReplacement(text: string): string | null {
  return /[\r\n\u2028\u2029]/.test(text) ? '替换文字不能包含换行（换行请在文档里直接回车）' : null
}

/**
 * 替换请求。`targets` 是命中的 range，原样交给引擎；`expectVersion` 是查找时的文档版本——
 * 查找之后文档被改了（别人敲了字），引擎会拒绝，调用方重新查找后再试，绝不会替换到错位的文字上。
 * 修订模式下 `suggesting` 带作者：替换变成"删除 + 插入"的修订标记，而不是直接改。
 */
export function buildReplaceRequest(matches: readonly DocxMatch[], text: string, version: string, suggesting?: { name: string }) {
  return {
    targets: matches.map((match) => ({ ...match.range })),
    text,
    expectVersion: version,
    ...(suggesting ? { suggesting } : {}),
  }
}
