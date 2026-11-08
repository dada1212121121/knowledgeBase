/**
 * Word 内容清点：判断"引擎改过一次再保存之后，文档里的东西有没有少"。
 *
 * 为什么需要它：引擎对"没改过"的文档保存时原样返回原件字节，所以"不改保存"的往返检查对任何文档都显示无损——
 * 它看不见引擎重写 `word/document.xml` 时丢东西。实测（18 份真实文档）有一份流程图，锚定在空段落里的浮动椭圆
 * （带文字）在引擎重写后消失，而整份"不改保存"仍是字节级一致。只有真实改动之后才会暴露，所以打开时要在隔离的
 * 临时会话里做一次真实的探针编辑（插入一个标记字符）再保存，用本文件比较原件与探针结果。
 *
 * 判定原则：只认"少了"——原件有、结果没有。结果里多出来的（段落 ID、引擎补的属性）不算丢。
 * 对 `mc:AlternateContent` 只看 `mc:Choice`：引擎保存时会去掉给老版本 Word 看的 `mc:Fallback`（VML 重复了一份
 * 同样的形状和文字），这是有意的瘦身，不算丢，也避免把重复的文字算成两份。
 */

/** 探针插入的标记：不可见的"隐形分隔符"，真实文档里几乎不会出现 */
export const PROBE_MARKER = '\u2063'

export interface DocxInventory {
  /** 正文文字（<w:t>）按顺序拼起来，Fallback 里的重复内容不计 */
  text: string
  /**
   * 形状 / 图片：docPr 的名称（浮动形状、图片、文本框都在这里）。
   * 只按个数比较，名称仅用来报告：引擎重写一张图片时会把它重新创建并改名（`图片 7` → `Picture 1372585881`，
   * id 也变），按名称配对会把这种重命名误判成丢失（实测 18 份里有 3 份是这样）。
   */
  shapes: string[]
  counts: Record<string, number>
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'

/** 需要计数的元素（命名空间 + 本地名）：表格 / 行 / 格、超链接、书签、域、脚注尾注引用、内容控件、批注范围 */
const COUNTED: ReadonlyArray<[string, string, string]> = [
  ['表格', W, 'tbl'],
  ['表格行', W, 'tr'],
  ['单元格', W, 'tc'],
  ['超链接', W, 'hyperlink'],
  ['书签', W, 'bookmarkStart'],
  ['域', W, 'fldChar'],
  ['简单域', W, 'fldSimple'],
  ['脚注引用', W, 'footnoteReference'],
  ['尾注引用', W, 'endnoteReference'],
  ['内容控件', W, 'sdt'],
  ['批注范围', W, 'commentRangeStart'],
  ['分页符', W, 'br'],
  ['公式', 'http://schemas.openxmlformats.org/officeDocument/2006/math', 'oMath'],
]

/** 把 `mc:Fallback` 整段拿掉后再解析（见文件头） */
function withoutFallback(xml: string): string {
  return xml.replace(/<mc:Fallback[\s>][\s\S]*?<\/mc:Fallback>/g, '')
}

export function inventoryOf(documentXml: string): DocxInventory {
  const doc = new DOMParser().parseFromString(withoutFallback(documentXml), 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('document.xml 不是合法的 XML')
  const text = Array.from(doc.getElementsByTagNameNS(W, 't'), (node) => node.textContent ?? '').join('')
  const shapes = Array.from(doc.getElementsByTagNameNS(WP, 'docPr'), (node) => node.getAttribute('name') ?? '')
  const counts: Record<string, number> = { 段落: doc.getElementsByTagNameNS(W, 'p').length }
  for (const [label, ns, local] of COUNTED) counts[label] = doc.getElementsByTagNameNS(ns, local).length
  return { text, shapes, counts }
}

export interface DocxLoss {
  /** 给人看的一句话列表（"形状「椭圆 32」不见了"、"超链接少了 2 个"） */
  reasons: string[]
  /** 文字是否对不上（去掉探针标记后） */
  textChanged: boolean
}

/**
 * 原件 vs 探针保存的结果。`probe` 里多出一个 `PROBE_MARKER`，比文字时先去掉（只去一个）。
 * 段落数允许 +0（探针不拆段），少了算丢；其余计数只认减少。
 */
export function lossBetween(original: DocxInventory, probe: DocxInventory): DocxLoss {
  const reasons: string[] = []
  const at = probe.text.indexOf(PROBE_MARKER)
  const probeText = at < 0 ? probe.text : probe.text.slice(0, at) + probe.text.slice(at + PROBE_MARKER.length)
  const textChanged = probeText !== original.text
  if (textChanged) {
    let index = 0
    while (index < original.text.length && index < probeText.length && original.text[index] === probeText[index]) index += 1
    const lost = original.text.length - probeText.length
    reasons.push(lost > 0 ? `文字少了 ${lost} 个字（约在第 ${index + 1} 个字附近：“${original.text.slice(Math.max(0, index - 4), index + 12)}”）` : `文字内容对不上（约在第 ${index + 1} 个字附近）`)
  }
  if (probe.shapes.length < original.shapes.length) {
    // 名称只用来告诉用户"大概是哪个"：原件里有、结果里没有同名的，才列出来（改名的会被列成嫌疑，但个数少了才会走到这里）
    const remaining = new Map<string, number>()
    for (const shape of probe.shapes) remaining.set(shape, (remaining.get(shape) ?? 0) + 1)
    const suspects: string[] = []
    for (const shape of original.shapes) {
      const left = remaining.get(shape) ?? 0
      if (left > 0) remaining.set(shape, left - 1)
      else suspects.push(shape || '未命名')
    }
    const lost = original.shapes.length - probe.shapes.length
    reasons.push(`图形 / 图片少了 ${lost} 个（${original.shapes.length} → ${probe.shapes.length}），可能是「${suspects.slice(0, 3).join('」「')}」`)
  }
  for (const [label, count] of Object.entries(original.counts)) {
    const after = probe.counts[label] ?? 0
    if (after < count) reasons.push(`${label}少了 ${count - after} 个（${count} → ${after}）`)
  }
  return { reasons, textChanged }
}

/* ---------------- 探针结论 ---------------- */

/** 服务端 `roundtrip-check` 对"探针保存的包 vs 原件"的回答里，探针模式下我们只采信这几项 */
export interface ProbeServerReport {
  valid: boolean
  reason: string | null
  changed_parts: string[]
  removed_parts: string[]
  added_parts: string[]
}

/** 改一个词时本来就会变的部件：正文与文档属性（最后修改时间等） */
export const EXPECTED_EDIT_PARTS: readonly string[] = ['word/document.xml', 'docProps/core.xml']

export interface DocxEditVerdict {
  /** yes 放开编辑；force 文字没变但格式细节会被改写，只读并允许"仍然编辑"；no 不能编辑 */
  editable: 'yes' | 'force' | 'no'
  /** 会丢的内容（editable = no 的原因） */
  losses: string[]
  /** 除正文 / 文档属性外还会被改写的部件（editable = force 的原因） */
  rewritten: string[]
  valid: boolean
  reason: string | null
}

/**
 * 综合判定。顺序即严重程度：不是完整包 > 会丢内容 > 会改写别的部件 > 可以编辑。
 * 少了部件（removed）算"会丢内容"：引擎不认识的部件被丢掉，用户不会知道。
 */
export function verdictFromProbe(server: ProbeServerReport, original: DocxInventory, probe: DocxInventory): DocxEditVerdict {
  const loss = lossBetween(original, probe)
  const losses = [...loss.reasons, ...server.removed_parts.map((part) => `文档部件 ${part} 会被丢掉`)]
  const rewritten = [...server.changed_parts, ...server.added_parts].filter((part) => !EXPECTED_EDIT_PARTS.includes(part))
  const base = { losses, rewritten, valid: server.valid, reason: server.reason }
  if (!server.valid) return { ...base, editable: 'no' }
  if (losses.length) return { ...base, editable: 'no' }
  if (rewritten.length) return { ...base, editable: 'force' }
  return { ...base, editable: 'yes' }
}
