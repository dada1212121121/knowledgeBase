/**
 * AI 写作预览里的字词级对比（UI-3）：润色 / 翻译这类「替换选中」的结果，标出删掉的和新加的字。
 *
 * 切词：中日韩文字逐字、英文和数字按词、空白和标点各算一段——中文润色常常只改几个字，按行对比看不出来。
 * 用 LCS 求最长公共子序列；两边词数乘积超过上限（长段落整体重写）就退化成「整段删 + 整段加」，不卡页面。
 */
export interface DiffSegment {
  kind: 'equal' | 'add' | 'remove'
  text: string
}

/** LCS 表最多算这么多格（约 700 × 700 个词），再大就不逐词对比 */
const MAX_CELLS = 500_000

const TOKEN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/** 相邻同类的段合并成一段 */
function push(out: DiffSegment[], kind: DiffSegment['kind'], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

export function diffWords(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ kind: 'equal', text: before }] : []
  const a = tokenize(before)
  const b = tokenize(after)
  const out: DiffSegment[] = []
  // 公共前后缀先剥掉：改一句话时两头大段相同，表就小得多
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  push(out, 'equal', a.slice(0, start).join(''))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    push(out, 'remove', midA.join(''))
    push(out, 'add', midB.join(''))
  } else {
    // dp[i][j] = midA[i..] 与 midB[j..] 的 LCS 长度（用一维数组按行存）
    const width = midB.length + 1
    const dp = new Uint32Array((midA.length + 1) * width)
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        dp[i * width + j] = midA[i] === midB[j] ? dp[(i + 1) * width + j + 1]! + 1 : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        push(out, 'equal', midA[i]!)
        i += 1
        j += 1
      } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
        push(out, 'remove', midA[i]!)
        i += 1
      } else {
        push(out, 'add', midB[j]!)
        j += 1
      }
    }
    push(out, 'remove', midA.slice(i).join(''))
    push(out, 'add', midB.slice(j).join(''))
  }
  push(out, 'equal', a.slice(endA).join(''))
  return out
}
