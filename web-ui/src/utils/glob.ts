// 极简 glob(文件夹预览用):`**` 跨目录、`*` 不跨 `/`、`?` 单字符。
// 与服务端 include/exclude 的语义一致;真正的忽略规则仍由服务端扫描器复核。

export function globToRegExp(glob: string): RegExp {
  // 先把 {a,b} 换成占位符再转义,最后还原成 (?:a|b);花括号不嵌套
  const alternatives: string[] = []
  const withoutBraces = glob.trim().replace(/\{([^{}]*)\}/g, (_, body: string) => {
    alternatives.push(body)
    return `\u0003${alternatives.length - 1}\u0003`
  })
  const escaped = withoutBraces
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*')
    .replace(/\u0003(\d+)\u0003/g, (_, index: string) => {
      const body = alternatives[Number(index)] ?? ''
      return `(?:${body
        .split(',')
        .map((item) => item.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.'))
        .join('|')})`
    })
  return new RegExp(`^${escaped}$`)
}

/** 逗号分隔的规则串 → 正则数组(花括号里的逗号不算分隔符)。 */
export function parseGlobs(text: string): RegExp[] {
  const rules: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '{') depth += 1
    if (char === '}') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      rules.push(current)
      current = ''
    } else current += char
  }
  rules.push(current)
  return rules
    .map((item) => item.trim())
    .filter(Boolean)
    .map(globToRegExp)
}
