/**
 * 协同时本地光标的平移
 *
 * 光标是「第几个字符」的数字。别人在我前面插入 / 删除文字后，同一个数字指向的已经不是原来那个位置——
 * 我正在文末敲字，对方在行首打了 5 个字，我的字就会落到离文末 5 个字符的地方（e2e 实测会敲成 `BBBBB3BBBBB`）。
 * 引擎在远端更新里不给「相对位置」，所以用前后两份文字的差异把光标平移过去：
 * 找出最长公共前缀 / 后缀，中间就是被改的那一段，光标在它后面就整体平移，落在里面就收到这一段的边界。
 */

export interface TextDelta {
  /** 被改的区间在旧文字里的起点 */
  start: number
  /** 旧文字里被替换掉 / 删除的长度 */
  removed: number
  /** 新文字里写进来的长度 */
  added: number
}

/** 两份文字的最小差异；完全相同返回 null */
export function textDelta(before: string, after: string): TextDelta | null {
  if (before === after) return null
  const shortest = Math.min(before.length, after.length)
  let start = 0
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start += 1
  let tail = 0
  // 后缀不能和前缀重叠，否则「aa → aaa」会算出负长度
  while (tail < shortest - start && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail += 1
  return { start, removed: before.length - start - tail, added: after.length - start - tail }
}

/**
 * 把一个光标位置平移到改动之后：
 * - 在改动区间之前（含正好在起点）：不动，我正在敲的位置不被别人的插入顶走；
 * - 在改动区间之后：整体平移；
 * - 落在被替换 / 删除的区间里：收到新文字里最接近的位置，不越过这段新写入的文字。
 */
export function shiftOffset(offset: number, delta: TextDelta): number {
  if (offset <= delta.start) return offset
  if (offset >= delta.start + delta.removed) return offset + delta.added - delta.removed
  return delta.start + Math.min(offset - delta.start, delta.added)
}
