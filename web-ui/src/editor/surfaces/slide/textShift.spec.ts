import { describe, expect, it } from 'vitest'
import { shiftOffset, textDelta } from './textShift'

/** 按差异平移后，光标原来指向的字符仍然是同一个字符（只要那个字符没被删） */
function follows(before: string, after: string, offset: number): number {
  const delta = textDelta(before, after)
  return delta ? shiftOffset(offset, delta) : offset
}

describe('协同光标平移', () => {
  it('完全相同没有差异', () => {
    expect(textDelta('abc', 'abc')).toBeNull()
  })

  it('行首插入：文末的光标整体后移（e2e 里敲成 BBBBB3BBBBB 的场景）', () => {
    expect(textDelta('review 3', 'AAAAAreview 3')).toEqual({ start: 0, removed: 0, added: 5 })
    expect(follows('review 3', 'AAAAAreview 3', 8)).toBe(13)
  })

  it('我前面的删除让光标前移；我后面的修改不影响光标', () => {
    expect(follows('hello world', 'world', 11)).toBe(5)
    expect(follows('hello world', 'hello world!!', 5)).toBe(5)
  })

  it('正好在插入点：光标留在原地（别人的字落在我右边，不顶走我正在敲的位置）', () => {
    expect(follows('abcd', 'abXXcd', 2)).toBe(2)
    expect(follows('abcd', 'abXXcd', 3)).toBe(5)
  })

  it('光标落在被删的区间里：收到区间起点；落在被替换的区间里：不越过新写入的文字', () => {
    expect(follows('abcdef', 'af', 3)).toBe(1)
    expect(follows('abcdef', 'aXYf', 4)).toBe(3)
    expect(follows('abcdef', 'aXYf', 2)).toBe(2)
  })

  it('重复字符（aa → aaa）：前后缀不重叠，不会算出负长度', () => {
    expect(textDelta('aa', 'aaa')).toEqual({ start: 2, removed: 0, added: 1 })
    expect(textDelta('aaa', 'aa')).toEqual({ start: 2, removed: 1, added: 0 })
  })

  it('全部换掉 / 清空 / 从空开始', () => {
    expect(textDelta('abc', 'xyz')).toEqual({ start: 0, removed: 3, added: 3 })
    expect(follows('abc', '', 2)).toBe(0)
    expect(follows('', 'hi', 0)).toBe(0)
  })

  it('多段文字里换行也是普通字符', () => {
    expect(follows('第一段\n第二段', '新的第一段\n第二段', 7)).toBe(9)
  })
})
