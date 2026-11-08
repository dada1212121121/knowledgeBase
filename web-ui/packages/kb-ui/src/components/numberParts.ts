// 把一段显示文字拆成「前缀 + 一个数字 + 后缀」,好让数字部分滚动、其余原样保留。
// 例:「12,438」「84 ms」「1.5 GB」「¥ 3.20」「63%」。没有数字(「—」)返回 null,调用方直接显示原文。
// 只处理**第一个**数字:「38 / 62 GB」滚动 38,后面的 62 GB 当后缀;日期、编号这类不该滚的文字不要交给它。

export interface NumberParts {
  prefix: string
  number: number
  decimals: number
  suffix: string
  /** 原文带千分位逗号:滚动时也带 */
  locale: boolean
}

export function splitNumber(value: string | number | null | undefined): NumberParts | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  const match = text.match(/^(\D*?)(\d[\d,]*(?:\.(\d+))?)(.*)$/s)
  if (!match) return null
  const raw = (match[2] ?? '').replace(/,/g, '')
  const number = Number(raw)
  // 超过 15 位有效数字的(ID、哈希前缀)不是「数量」,不滚
  if (!Number.isFinite(number) || raw.replace('.', '').length > 15) return null
  return { prefix: match[1] ?? '', number, decimals: (match[3] ?? '').length, suffix: match[4] ?? '', locale: (match[2] ?? '').includes(',') }
}
