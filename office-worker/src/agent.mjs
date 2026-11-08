// AI(经 MCP)在服务端副本上改文档:一批「把这段文字换成那段」。
// 用 @betteroffice/agents 挂在活的副本上找、提建议再接受;改动之后由房间作为服务端的一笔更新广播给所有人。
// 每处原文必须恰好出现一次;任何一处不满足整批不改(先全部找到,再一次性接受)。
import { attachDocx, attachPptx, attachXlsx } from '@betteroffice/agents'

function exactlyOne(matches, old) {
  if (!matches.length) throw new Error(`没找到要替换的原文:${old.slice(0, 40)}`)
  if (matches.length > 1) throw new Error(`原文出现了 ${matches.length} 处,不知道改哪一处,请带上更多上下文:${old.slice(0, 40)}`)
  return matches[0]
}

/** 在副本上做替换,返回改了几处。`dry` 只核对每处原文能不能定位,不改。 */
export async function agentEdit(replica, edits, author = 'AI', { dry = false } = {}) {
  if (!Array.isArray(edits) || !edits.length) return 0
  for (const edit of edits) {
    if (typeof edit?.old !== 'string' || !edit.old) throw new Error('要替换的原文不能为空')
    if (typeof edit.new !== 'string') throw new Error('替换后的文字必须是字符串')
  }
  if (replica.format === 'xlsx') {
    const agent = attachXlsx(replica.handle, { name: 'doc.xlsx' })
    const planned = []
    for (const edit of edits) {
      const hits = agent.grep({ query: edit.old, caseSensitive: true, limit: 3 }).matches
      const hit = exactlyOne(hits, edit.old)
      const [cell] = agent.readCells({ sheet: hit.sheet, range: hit.a1 }).cells
      if (!cell) throw new Error(`格子 ${hit.a1} 读不到`)
      if (cell.formula) throw new Error(`格子 ${hit.a1} 是公式,不能按文字替换`)
      // 按格子里存的值替换(不是显示出来的格式化文字),替换结果和在格子里敲进去一样解析
      const raw = cell.value.kind === 'empty' ? '' : String(cell.value.value)
      const at = raw.indexOf(edit.old)
      if (at < 0) throw new Error(`格子 ${hit.a1} 显示的是「${cell.displayText}」,存的值是「${raw}」,请按存的值写原文`)
      if (raw.indexOf(edit.old, at + 1) >= 0) throw new Error(`原文在格子 ${hit.a1} 里出现了不止一次:${edit.old.slice(0, 40)}`)
      const where = `${hit.sheet}!${hit.a1}`
      if (planned.some((step) => step.where === where)) throw new Error(`同一个格子 ${hit.a1} 改了两次,请合成一处`)
      planned.push({ where, cell: cell.cell, input: raw.slice(0, at) + edit.new + raw.slice(at + edit.old.length) })
    }
    if (dry) return planned.length
    const proposal = agent.proposeCells({ author, edits: planned.map(({ cell, input }) => ({ cell, input })) })
    await agent.accept(proposal.id)
    return planned.length
  }
  const agent = replica.format === 'docx' ? attachDocx(replica.handle, { name: 'doc.docx' }) : attachPptx(replica.handle, { name: 'doc.pptx' })
  const planned = edits.map((edit) => {
    const hit = exactlyOne(agent.grep({ query: edit.old, caseSensitive: true, limit: 3 }).matches, edit.old)
    return { match: hit.match, newText: edit.new }
  })
  if (dry) return planned.length
  const proposal = agent.propose({ author, edits: planned })
  await agent.accept(proposal.id)
  return planned.length
}

/** 把文档读成纯文本给 AI 看(和 agentEdit 的查找用同一份内容):docx 每段一行,pptx 按幻灯片分组,xlsx 按工作表、每行用制表符分格。 */
export function agentRead(replica, { maxCells = 20000 } = {}) {
  const lines = []
  if (replica.format === 'xlsx') {
    const agent = attachXlsx(replica.handle, { name: 'doc.xlsx' })
    let budget = maxCells
    const sheets = []
    for (let offset = 0; offset !== null; ) {
      const page = agent.outline({ offset, limit: 100 })
      sheets.push(...page.items)
      offset = page.nextOffset
    }
    for (const sheet of sheets) {
      lines.push(`## 工作表 ${sheet.name}${sheet.usedRange ? `(${sheet.usedRange})` : ''}`)
      if (!sheet.usedRange || budget <= 0) continue
      const rows = new Map()
      let offset = 0
      while (offset !== null && budget > 0) {
        const page = agent.readCells({ sheet: sheet.name, range: sheet.usedRange, offset, limit: 100 })
        for (const cell of page.cells) {
          if (cell.value.kind === 'empty' && !cell.formula) continue
          budget -= 1
          const [, col, row] = /^([A-Z]+)(\d+)$/.exec(cell.a1 ?? '') ?? []
          if (!row) continue
          if (!rows.has(row)) rows.set(row, [])
          const raw = cell.formula ? `=${cell.formula}` : String(cell.value.value)
          rows.get(row).push(`${col}${row}=${raw.replace(/[\t\n]/g, ' ')}`)
        }
        offset = page.nextOffset
      }
      for (const [, cellsInRow] of [...rows].sort((a, b) => Number(a[0]) - Number(b[0]))) lines.push(cellsInRow.join('\t'))
    }
    if (budget <= 0) lines.push(`……(格子超过 ${maxCells} 个,后面的没列出)`)
    return lines.join('\n')
  }
  const agent = replica.format === 'docx' ? attachDocx(replica.handle, { name: 'doc.docx' }) : attachPptx(replica.handle, { name: 'doc.pptx' })
  let offset = 0
  let slide = null
  while (offset !== null) {
    const page = agent.list({ offset, limit: 100 })
    for (const item of page.items) {
      let text = item.text ?? ''
      if (text.length < (item.length ?? 0)) text = agent.read(item.ref).text ?? text
      if (replica.format === 'pptx' && item.slide !== slide) {
        slide = item.slide
        lines.push(`## 第 ${slide} 张幻灯片`)
      }
      lines.push(text)
    }
    offset = page.nextOffset
  }
  return lines.join('\n')
}
