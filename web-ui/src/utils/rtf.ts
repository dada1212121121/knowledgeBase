// RTF → 安全 HTML(段落、粗斜体下划线、换行、表格、Unicode / 代码页转义)。
// 不追求还原版式:字体、颜色、页边距、图片(\pict)、页眉页脚、脚注一律丢弃,保证输出只含 p / br / b / i / u / table。
// 输出已转义,调用方仍应再过一遍 sanitizeDocHtml。单测见 rtf.spec.ts。

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr',
  'footerf', 'footnote', 'private', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'generator', 'listtable',
  'listoverridetable', 'rsidtbl', 'xmlnstbl', 'fldinst', 'object', 'bkmkstart', 'bkmkend', 'shpinst', 'nonshppict',
])

const CODEPAGES: Record<number, string> = {
  437: 'ibm437', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
  1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh', 65001: 'utf-8',
}

const SYMBOLS: Record<string, string> = {
  bullet: '•', emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ',
  tab: '    ', zwj: '', zwnj: '', '~': '\u00a0', _: '‑', '-': '',
}

interface State {
  skip: boolean
  b: boolean
  i: boolean
  u: boolean
  uc: number
}

export function rtfToHtml(source: string): string {
  const stack: State[] = []
  let state: State = { skip: false, b: false, i: false, u: false, uc: 1 }
  let codepage = 'windows-1252'
  let bytes: number[] = []
  let skipChars = 0
  let cell = ''
  let paragraph = ''
  let rowCells: string[] = []
  let rows: string[][] = []
  let inRow = false
  const out: string[] = []

  const flushBytes = () => {
    if (!bytes.length) return
    const data = new Uint8Array(bytes)
    bytes = []
    try {
      text(new TextDecoder(codepage).decode(data))
    } catch {
      text(new TextDecoder('windows-1252').decode(data))
    }
  }
  const text = (value: string) => {
    if (state.skip || !value) return
    let html = escapeHtml(value)
    if (state.u) html = `<u>${html}</u>`
    if (state.i) html = `<i>${html}</i>`
    if (state.b) html = `<b>${html}</b>`
    if (inRow) cell += html
    else paragraph += html
  }
  const flushTable = () => {
    if (!rows.length) return
    out.push(`<table>${rows.map((row) => `<tr>${row.map((item) => `<td>${item || ''}</td>`).join('')}</tr>`).join('')}</table>`)
    rows = []
  }
  const endParagraph = () => {
    flushBytes()
    if (inRow) {
      cell += '<br>'
      return
    }
    flushTable()
    out.push(`<p>${paragraph}</p>`)
    paragraph = ''
  }

  let at = 0
  while (at < source.length) {
    const char = source[at]!
    if (char === '{') {
      flushBytes()
      stack.push({ ...state })
      at += 1
    } else if (char === '}') {
      flushBytes()
      state = stack.pop() ?? state
      at += 1
    } else if (char === '\\') {
      const next = source[at + 1] ?? ''
      if (/[a-zA-Z]/.test(next)) {
        const match = /^\\([a-zA-Z]+)(-?\d+)?\s?/.exec(source.slice(at, at + 40))!
        at += match[0].length
        const word = match[1]!
        const param = match[2] === undefined ? undefined : Number(match[2])
        if (SKIP_DESTINATIONS.has(word)) {
          state.skip = true
          continue
        }
        switch (word) {
          case 'ansicpg':
            if (param !== undefined) codepage = CODEPAGES[param] ?? 'windows-1252'
            break
          case 'uc':
            state.uc = param ?? 1
            break
          case 'u': {
            flushBytes()
            const code = (param ?? 0) < 0 ? (param ?? 0) + 65536 : (param ?? 0)
            text(String.fromCharCode(code))
            skipChars = state.uc
            break
          }
          case 'b':
            state.b = param !== 0
            break
          case 'i':
            state.i = param !== 0
            break
          case 'ul':
          case 'ulw':
          case 'uld':
          case 'uldb':
            state.u = param !== 0
            break
          case 'ulnone':
            state.u = false
            break
          case 'pard':
          case 'plain':
            if (word === 'plain') Object.assign(state, { b: false, i: false, u: false })
            break
          case 'par':
          case 'sect':
            endParagraph()
            break
          case 'line':
            flushBytes()
            if (inRow) cell += '<br>'
            else paragraph += '<br>'
            break
          case 'page':
            break
          case 'trowd':
            flushBytes()
            if (!inRow && paragraph) {
              out.push(`<p>${paragraph}</p>`)
              paragraph = ''
            }
            inRow = true
            rowCells = []
            cell = ''
            break
          case 'cell':
          case 'nestcell':
            flushBytes()
            rowCells.push(cell.replace(/(<br>)+$/, ''))
            cell = ''
            inRow = true
            break
          case 'row':
          case 'nestrow':
            flushBytes()
            rows.push(rowCells)
            rowCells = []
            cell = ''
            inRow = false
            break
          default:
            if (word in SYMBOLS) text(SYMBOLS[word]!)
        }
      } else if (next === "'") {
        const hex = source.slice(at + 2, at + 4)
        at += 4
        if (skipChars > 0) {
          skipChars -= 1
          continue
        }
        if (!state.skip) bytes.push(Number.parseInt(hex, 16) || 0)
      } else if (next === '*') {
        state.skip = true
        at += 2
      } else if (next === '\\' || next === '{' || next === '}') {
        flushBytes()
        text(next)
        at += 2
      } else if (next === '\n' || next === '\r') {
        endParagraph()
        at += 2
      } else {
        flushBytes()
        if (next in SYMBOLS) text(SYMBOLS[next]!)
        at += 2
      }
    } else if (char === '\r' || char === '\n') {
      at += 1
    } else {
      if (skipChars > 0) {
        skipChars -= 1
        at += 1
        continue
      }
      flushBytes()
      // 连续普通字符一次取完,避免逐字符拼接
      let end = at + 1
      while (end < source.length && !'{}\\\r\n'.includes(source[end]!)) end += 1
      text(source.slice(at, end))
      at = end
    }
  }
  flushBytes()
  if (paragraph) out.push(`<p>${paragraph}</p>`)
  flushTable()
  return out.filter((block) => block !== '<p></p>').join('\n')
}
