// 十六进制预览:`偏移  16 字节十六进制  |ASCII|`。输出是纯文本,放进 <pre> 即可。

export function hexLines(bytes: Uint8Array, perRow = 16): string[] {
  const lines: string[] = []
  for (let at = 0; at < bytes.length; at += perRow) {
    const row = bytes.subarray(at, at + perRow)
    let hex = ''
    let ascii = ''
    for (let index = 0; index < perRow; index += 1) {
      if (index < row.length) {
        const value = row[index]!
        hex += value.toString(16).padStart(2, '0') + ' '
        ascii += value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : '.'
      } else {
        hex += '   '
      }
      if (index === perRow / 2 - 1) hex += ' '
    }
    lines.push(`${at.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`)
  }
  return lines
}

/** 字节数 → 「1.4 MB」。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
