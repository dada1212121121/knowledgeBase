// 极简 TOML 解析:只够读 manifest.toml 与文档里的示例清单(测试 / e2e 夹具用,生产解析在后端 Rust 里做)。
//
// 支持:`键 = 值`(字符串、整数、布尔、字符串数组,数组可以跨行)、`[表]`、`[[表数组]]`、`#` 注释。
// 不支持的写法(内联表、日期、点号键、多行字符串)直接抛错,宁可让用例失败也不要悄悄解析错。

function parseString(text, at) {
  // text[at] 是起始的 "
  let out = ''
  let i = at + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') return [out, i + 1]
    if (ch === '\\') {
      const next = text[i + 1]
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }
      if (next === 'u') {
        out += String.fromCodePoint(Number.parseInt(text.slice(i + 2, i + 6), 16))
        i += 6
        continue
      }
      if (!(next in map)) throw new Error(`toml-lite: 不支持的转义 \\${next}`)
      out += map[next]
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  throw new Error('toml-lite: 字符串没有结束')
}

function skipSpace(text, at, withNewlines) {
  let i = at
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || (withNewlines && (ch === '\n' || ch === '\r'))) i += 1
    else if (withNewlines && ch === '#') while (i < text.length && text[i] !== '\n') i += 1
    else break
  }
  return i
}

function parseValue(text, at) {
  const ch = text[at]
  if (ch === '"') return parseString(text, at)
  if (ch === '[') {
    const items = []
    let i = skipSpace(text, at + 1, true)
    while (text[i] !== ']') {
      const [value, next] = parseValue(text, i)
      items.push(value)
      i = skipSpace(text, next, true)
      if (text[i] === ',') i = skipSpace(text, i + 1, true)
      else if (text[i] !== ']') throw new Error(`toml-lite: 数组里有无法识别的内容:${text.slice(i, i + 20)}`)
    }
    return [items, i + 1]
  }
  const match = /^(true|false|-?\d+)(?![\w.:-])/.exec(text.slice(at))
  if (!match) throw new Error(`toml-lite: 无法识别的值:${text.slice(at, at + 20)}`)
  const raw = match[1]
  return [raw === 'true' ? true : raw === 'false' ? false : Number(raw), at + raw.length]
}

/** @param {string} source */
export function parseToml(source) {
  const root = {}
  let table = root
  let i = 0
  while (i < source.length) {
    i = skipSpace(source, i, true)
    if (i >= source.length) break
    if (source[i] === '[') {
      const array = source[i + 1] === '['
      const close = source.indexOf(array ? ']]' : ']', i)
      const path = source.slice(i + (array ? 2 : 1), close).trim().split('.').map((part) => part.trim())
      i = close + (array ? 2 : 1)
      let node = root
      path.forEach((part, index) => {
        const last = index === path.length - 1
        if (last && array) {
          node[part] ??= []
          const item = {}
          node[part].push(item)
          node = item
        } else {
          node[part] ??= {}
          node = Array.isArray(node[part]) ? node[part][node[part].length - 1] : node[part]
        }
      })
      table = node
      continue
    }
    const eq = source.indexOf('=', i)
    const key = source.slice(i, eq).trim()
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`toml-lite: 不支持的键:${key}`)
    const [value, next] = parseValue(source, skipSpace(source, eq + 1, false))
    table[key] = value
    i = next
    // 行尾只允许空白和注释
    const lineEnd = source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i)
    const rest = source.slice(i, lineEnd).trim()
    if (rest && !rest.startsWith('#')) throw new Error(`toml-lite: 值后面有多余内容:${rest}`)
    i = lineEnd
  }
  return root
}
