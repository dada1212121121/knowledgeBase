/**
 * Word 轻只读渲染前的「样式瘦身」：把文档里**没人用**的样式定义从 styles.xml 里去掉，再交给 docx-preview。
 *
 * 为什么要做：Word 2010 及更早的模板会把整套内置样式（164 个，带 stylesWithEffects）都写进 styles.xml（20 页样本里 349 KB），
 * 而正文只用到其中十几个。docx-preview 对 styles.xml 的处理是：DOMParser 整份解析（4× 降速 100~200 ms 的一条长任务）→ 逐个样式解析 →
 * 为每个样式生成一段 CSS（样本里 200 KB 的样式表，之后每次布局都要在这几千条规则里匹配）。没人用的样式在页面上不会匹配到任何元素，
 * 去掉它们渲染结果不变，但解析 / 生成 / 样式匹配的成本跟着下降一个数量级（样本：styles 349 KB → 25 KB，CSS 201 KB → 9 KB，渲染出的 HTML 逐字相同）。
 *
 * 保守原则（宁可多留，不能错删）：
 *  - 「被用到」= 样式 ID 作为带引号的属性值（任意一对相邻引号之间的整段）出现在 word/ 下**任何其它** XML 部件里（正文、页眉页脚、脚注尾注、批注、编号、设置……）；
 *  - 默认样式（w:default）永远留；
 *  - 留下的样式通过 basedOn / link / next / 其它引用到的样式一并留下（沿引号值闭包，不挑属性名）；
 *  - 只删 <w:style> 元素本身，docDefaults、latentStyles 等其它内容原样不动；除 styles.xml 之外的部件字节不变；
 *  - 样式很少、或者去掉的不到 20% 时不改（返回 null，调用方用原文件）。
 * 解析是纯字符串处理，不依赖 DOM，所以放在 Worker 里做（docx-prune.worker.ts），主线程不背这份成本。
 */
import JSZip from 'jszip'

export const STYLES_PATH = 'word/styles.xml'
/** styles.xml 小于这么多字符就不值得动（现代 Word 写出来的通常 30~60 KB 以内，解析只要几毫秒） */
export const PRUNE_MIN_STYLES_CHARS = 48 * 1024
/** 至少能去掉这么大比例才改 */
const PRUNE_MIN_GAIN = 0.2
/** 样式少于这么多个就不值得动 */
const PRUNE_MIN_STYLES = 20

/** 门槛：默认值是线上用的；单测和保真核对时放低，好在小文件上也走一遍裁剪逻辑 */
export interface PruneThresholds {
  minChars: number
  minStyles: number
  minGain: number
}
const DEFAULT_THRESHOLDS: PruneThresholds = { minChars: PRUNE_MIN_STYLES_CHARS, minStyles: PRUNE_MIN_STYLES, minGain: PRUNE_MIN_GAIN }

const STYLE_BLOCK = /<w:style\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/w:style>)/g
const STYLE_ID = /\bw:styleId="([^"]*)"/
const STYLE_DEFAULT = /\bw:default="(?:1|true|on)"/
const QUOTE_CHAR = /["']/g
/** 样式 ID 不会很长；超过这个长度的片段肯定不是 ID，不必切出来比较 */
const MAX_ID_CHARS = 200

/**
 * 依次产出文本里「相邻两个引号字符之间」的每一段。属性值前后一定各有一个引号，所以每个属性值（包括样式 ID）都恰好是其中一段。
 * 不能用「成对匹配引号」的正则：一个属性值里带了另一种引号（`w:val="l'x"`）就会让后面的配对整体错位，
 * 之后一大片真实的样式引用被当成引号之间的空档漏掉——保真核对时一份 6.8 MB 的正文就这样漏掉了 5 个在用的样式。
 */
function* quotedSegments(text: string): Generator<string> {
  let previous = -1
  for (const match of text.matchAll(QUOTE_CHAR)) {
    const at = match.index!
    if (previous >= 0 && at - previous - 1 <= MAX_ID_CHARS) yield text.slice(previous + 1, at)
    previous = at
  }
}

/** 与 docx-preview 的 escapeClassName 同一规则（docx-meta.ts 的 styleClassName 也是这一条） */
const classKey = (styleId: string): string => styleId.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase()

export interface PruneResult {
  xml: string
  removed: number
  total: number
}

/** 从 zip 里读 styles.xml 并算出瘦身后的内容；没必要 / 没法瘦身返回 null */
export async function pruneUnusedStyles(zip: JSZip, thresholds: PruneThresholds = DEFAULT_THRESHOLDS): Promise<PruneResult | null> {
  const stylesFile = zip.file(STYLES_PATH)
  if (!stylesFile) return null
  const xml = await stylesFile.async('string')
  if (xml.length < thresholds.minChars) return null

  const blocks: { start: number; end: number; id: string; isDefault: boolean; text: string }[] = []
  for (const match of xml.matchAll(STYLE_BLOCK)) {
    const text = match[0]
    const open = text.slice(0, text.indexOf('>') + 1)
    const id = STYLE_ID.exec(open)?.[1]
    if (id === undefined) continue
    blocks.push({ start: match.index!, end: match.index! + text.length, id, isDefault: STYLE_DEFAULT.test(open), text })
  }
  if (blocks.length < thresholds.minStyles) return null
  const ids = new Set(blocks.map((block) => block.id))

  // 其它部件里出现过的样式 ID
  const kept = new Set<string>()
  const others = Object.keys(zip.files).filter((name) => /^word\/.+\.xml$/i.test(name) && name !== STYLES_PATH && !/\/stylesWithEffects\.xml$/i.test(name))
  for (const name of others) {
    const text = await zip.file(name)!.async('string')
    for (const segment of quotedSegments(text)) if (ids.has(segment)) kept.add(segment)
  }
  for (const block of blocks) if (block.isDefault) kept.add(block.id)

  // 闭包：留下的样式提到的样式也留下（basedOn / link / next 以及任何别的写法）
  const byId = new Map<string, string[]>()
  for (const block of blocks) byId.set(block.id, [...(byId.get(block.id) ?? []), block.text])
  const queue = [...kept]
  while (queue.length) {
    const id = queue.pop()!
    for (const text of byId.get(id) ?? []) {
      for (const value of quotedSegments(text)) {
        if (ids.has(value) && !kept.has(value)) {
          kept.add(value)
          queue.push(value)
        }
      }
    }
  }

  // docx-preview 把样式 ID 转成 CSS 类名时会抹掉大小写、把空格和点换成 "-"、把 "&" 换成 "and"，
  // 于是 ID 不同的样式（如 "ListParagraph" 与 "Listparagraph"）可能落到同一个类名上，后定义的规则会盖掉前面的。
  // 留下的样式所在的类名，同类名的样式一并留下，层叠顺序才不会变
  const keptClasses = new Set([...kept].map(classKey))
  const drop = blocks.filter((block) => !kept.has(block.id) && !keptClasses.has(classKey(block.id)))
  if (!drop.length) return null
  // 从后往前切，下标不会错位
  let out = xml
  for (let at = drop.length - 1; at >= 0; at -= 1) out = out.slice(0, drop[at]!.start) + out.slice(drop[at]!.end)
  if (out.length > xml.length * (1 - thresholds.minGain)) return null
  return { xml: out, removed: drop.length, total: blocks.length }
}

/** 整包瘦身：返回新的 docx 字节（除 styles.xml 外各部件内容不变，统一不压缩存放以便 docx-preview 最快读取）；不需要瘦身返回 null */
export async function pruneDocx(bytes: ArrayBuffer, thresholds: PruneThresholds = DEFAULT_THRESHOLDS): Promise<ArrayBuffer | null> {
  try {
    const zip = await JSZip.loadAsync(bytes)
    const result = await pruneUnusedStyles(zip, thresholds)
    if (!result) return null
    zip.file(STYLES_PATH, result.xml)
    return await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  } catch {
    // 不是合法的 zip / 读写出错：交回原文件，由 docx-preview 自己报它认得的错误
    return null
  }
}
