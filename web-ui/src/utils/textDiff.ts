// 逐行对比两版正文(历史版本面板用):统一 diff 的「-/+」列表 + 相邻未改动行的折叠。
//
// 只做行级对比:笔记 / 文本文件的历史版本都是整篇 Markdown,行级就够定位改动;
// 长文档中间大片没变的行折叠成一条「未改动 N 行」,免得滚半天才看到下一处改动。

/** 一行对比结果。 */
export interface DiffLine {
  /** `equal` 两边一样;`add` 只在新版;`remove` 只在旧版;`skip` 折叠掉的未改动行。 */
  kind: 'equal' | 'add' | 'remove' | 'skip'
  /** 这一行的内容(`skip` 为空)。 */
  text: string
  /** 在旧版里的行号(1 起);新增行与 `skip` 是 null。 */
  oldLine: number | null
  /** 在新版里的行号(1 起);删除行与 `skip` 是 null。 */
  newLine: number | null
  /** `skip` 折叠掉的行数。 */
  count?: number
}

/** 对比结果。 */
export interface DiffResult {
  lines: DiffLine[]
  /** 新增的行数。 */
  added: number
  /** 删掉的行数。 */
  removed: number
}

/** LCS 表格最多算这么多格,再大就退化成「整段删 + 整段加」(至少标记出改动的范围)。 */
const MAX_CELLS = 4_000_000

/**
 * 对比两段文本。
 *
 * @param before 旧版全文
 * @param after 新版全文
 * @param context 每段未改动区域保留的行数(默认 3;`0` = 全部折叠,只留改动)
 */
export function diffLines(before: string, after: string, context = 3): DiffResult {
  const a = splitLines(before)
  const b = splitLines(after)

  // 相同的前缀 / 后缀不参与 LCS:改一两行的日常编辑几乎立刻算完
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  const ops: { kind: 'equal' | 'add' | 'remove'; text: string }[] = []
  for (let i = 0; i < start; i += 1) ops.push({ kind: 'equal', text: a[i] })
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  ops.push(...diffMiddle(midA, midB))
  for (let i = endA; i < a.length; i += 1) ops.push({ kind: 'equal', text: a[i] })

  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.kind === 'equal') {
      oldNo += 1
      newNo += 1
      lines.push({ kind: 'equal', text: op.text, oldLine: oldNo, newLine: newNo })
      continue
    }
    if (op.kind === 'remove') {
      oldNo += 1
      removed += 1
      lines.push({ kind: 'remove', text: op.text, oldLine: oldNo, newLine: null })
      continue
    }
    newNo += 1
    added += 1
    lines.push({ kind: 'add', text: op.text, oldLine: null, newLine: newNo })
  }
  return { lines: collapse(lines, context), added, removed }
}

/** 两段文本是否一致(忽略末尾空白)。 */
export function sameText(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd()
}

function splitLines(text: string): string[] {
  // 末尾换行不多出一条空行:不然每份文件最后一行的对比都会多一个「新增空行」
  const trimmed = text.replace(/\n$/, '')
  return trimmed === '' ? [] : trimmed.split('\n')
}

/** 中间段的逐行对比(前缀后缀已剥掉)。 */
function diffMiddle(a: string[], b: string[]): { kind: 'equal' | 'add' | 'remove'; text: string }[] {
  if (a.length === 0) return b.map((text) => ({ kind: 'add' as const, text }))
  if (b.length === 0) return a.map((text) => ({ kind: 'remove' as const, text }))
  // 太大就不做 LCS:内存撑不住,结果至少还能看出「这一段被换掉了」
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [
      ...a.map((text) => ({ kind: 'remove' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ]
  }
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)
  const at = (i: number, j: number) => i * cols + j
  // 从右下往左上填,LCS 长度表
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)])
    }
  }
  const ops: { kind: 'equal' | 'add' | 'remove'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', text: a[i] })
      i += 1
      j += 1
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      ops.push({ kind: 'remove', text: a[i] })
      i += 1
    } else {
      ops.push({ kind: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < a.length) {
    ops.push({ kind: 'remove', text: a[i] })
    i += 1
  }
  while (j < b.length) {
    ops.push({ kind: 'add', text: b[j] })
    j += 1
  }
  return ops
}

/** 把长段未改动行折叠成一条 `skip`:每段保留头尾各 `context` 行。 */
function collapse(lines: DiffLine[], context: number): DiffLine[] {
  if (context < 0) return lines
  const out: DiffLine[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind !== 'equal') {
      out.push(lines[i])
      i += 1
      continue
    }
    let j = i
    while (j < lines.length && lines[j].kind === 'equal') j += 1
    const run = lines.slice(i, j)
    // 头尾各留 context 行后还有得折,就折;否则整段保留
    if (run.length > context * 2 + 1) {
      out.push(...run.slice(0, context))
      out.push({
        kind: 'skip',
        text: '',
        oldLine: null,
        newLine: null,
        count: run.length - context * 2,
      })
      out.push(...run.slice(run.length - context))
    } else {
      out.push(...run)
    }
    i = j
  }
  return out
}
