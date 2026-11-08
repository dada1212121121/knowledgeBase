/**
 * Word 字体能力与缺失提示
 *
 * 排版宽度取决于字体：用了不同字体，一行放多少字、在哪里换行、整篇有几页都会变。引擎在浏览器里读不到系统字体，
 * 只能用随站点提供的那一批。所以必须把"哪些字体能原样提供、哪些是近似替代、哪些根本没有"明说给用户——
 * 静默替换会让用户以为看到的版式和 Word 里一样，然后拿去排版、打印、对页码，出了错也不知道为什么。
 *
 * "有没有度量兼容的替代字体"这件事的权威答案是字体包自己的别名表（`resolveMetricCompatFamily`），不在这里另抄一份：
 * 起初手写的族名表把 Verdana / Tahoma / Consolas 都当成"近似"，而包里其实没有它们——抄的表会和包的真实能力悄悄漂移。
 * 因此判断函数收一个 `resolve` 注入（引擎入口传包里的真函数），单测用假的也能覆盖每一类。
 *
 * 本站的特殊处：
 * - 简体 / 日文的 CJK 字体统一换成 Noto Sans SC 的 GB2312 裁剪版（见 engines/fonts/docxFonts.ts）。
 *   包的别名表会把宋体解析成 Noto Serif SC（衬线），但站点实际画的是黑体子集——字宽一致、字形不同，提示要按站点实际说；
 * - 随站点提供的拉丁字体只有一小组精选的（为了 dist 的字体预算）："有没有替代"以 `resolve` 注入的函数为准
 *   （引擎入口传 docxFonts 的 `resolveShippedFamily`，只认真正随站点提供的），不是包的别名表；
 * - 繁体中文 / 韩文 / 阿拉伯文 / 希伯来文没有随站点提供字体，文档用到时这些字画不出来，要单独说明（{@link UNAVAILABLE_SCRIPT_LABELS}）。
 */

export type FontSupport =
  /** 度量兼容的拉丁字体随站点提供：字宽与 Word 一致，分页一致 */
  | 'exact'
  /** CJK：字宽按全角一致，字形用思源黑体（子集）近似 */
  | 'approximate'
  /** 没有对应字体：回退到默认字体，换行和分页可能与 Word 不同 */
  | 'missing'
  /** 文档自己内嵌了这个字体：按原样用 */
  | 'embedded'
  /** 符号字体（Symbol / Wingdings 等）：只用于项目符号这类私用区码点，不是正文文字，不影响换行分页，不算缺失 */
  | 'symbol'

export interface FontVerdict {
  family: string
  support: FontSupport
  /** 实际显示用的字体（给用户看的名字） */
  rendersAs: string
}

/** 包的度量兼容解析：族名 → 随包字体族名，没有则 undefined */
export type MetricResolver = (family: string) => string | undefined

/**
 * 没有随站点提供字体的文字区域（引擎的脚本名 → 给用户看的名字）。
 * docxFonts.ts 的 `UNAVAILABLE_SCRIPTS` 由它派生，两边不会漂移。
 */
export const UNAVAILABLE_SCRIPT_LABELS: Readonly<Record<string, string>> = {
  'cjk-tc': '繁体中文',
  'cjk-kr': '韩文',
  arabic: '阿拉伯文',
  hebrew: '希伯来文',
}

/** 站点用裁剪版代画的 CJK 族（包的别名表里指向这些，站点实际画的是 Noto Sans SC 子集） */
const CJK_FAMILIES = new Set(['Noto Sans SC', 'Noto Serif SC', 'Noto Sans JP'])

/** 缺失时引擎回退到的字体（没有注入 `fallback` 时的默认写法；引擎入口传 docxFonts 的 `fallbackFamilyFor`，写的就是实际画的那个族） */
const FALLBACK_FAMILY = 'Carlito'

/**
 * 符号字体：包里没有它们的替代，但**不能**因此报缺失。
 * 依据（实测 20 页样本的 numbering.xml）：Symbol 在这里只用于项目符号字符 U+F0B7（私用区码点，要 Symbol 才显示成圆点），
 * 而且 Word 的默认模板总会在 numbering.xml 里带着 Symbol / Wingdings 的项目符号定义，哪怕文档里一个列表都没有
 * （该样本正文 numPr 为 0）。按字体表去报，几乎每份文档都会弹"缺字体"，用户学会无视，真正的缺失提示也就失效了。
 */
const SYMBOL_FAMILIES = new Set(['symbol', 'wingdings', 'wingdings 2', 'wingdings 3', 'webdings', 'marlett', 'mt extra'])

const norm = (family: string) => family.trim().toLowerCase().replace(/^["']|["']$/g, '')

/** 含中日文字符的族名（如"华康少女体"）：包里没有，但字宽按全角排，思源黑体子集能接住 */
const looksCjk = (family: string) => /[\u3040-\u30ff\u3400-\u9fff]/.test(family)

/** 一个字体族能不能被支持，以及实际显示成什么 */
export function judgeFont(
  family: string,
  resolve: MetricResolver,
  embedded: ReadonlySet<string> = new Set(),
  fallback: (family: string) => string = () => FALLBACK_FAMILY,
): FontVerdict {
  if (embedded.has(norm(family))) return { family, support: 'embedded', rendersAs: family }
  if (SYMBOL_FAMILIES.has(norm(family))) return { family, support: 'symbol', rendersAs: '默认符号' }
  const bundled = resolve(family)
  if (bundled) {
    if (CJK_FAMILIES.has(bundled)) return { family, support: 'approximate', rendersAs: 'Noto Sans SC（思源黑体）' }
    return { family, support: 'exact', rendersAs: bundled }
  }
  if (looksCjk(family)) return { family, support: 'approximate', rendersAs: 'Noto Sans SC（思源黑体）' }
  return { family, support: 'missing', rendersAs: fallback(family) }
}

export interface FontReport {
  verdicts: FontVerdict[]
  /** 近似替代的（字形不同，版式基本一致） */
  approximate: FontVerdict[]
  /** 找不到的（版式可能有差异） */
  missing: FontVerdict[]
  /** 文档里用到、但没有随站点提供字体的文字区域（`UNAVAILABLE_SCRIPT_LABELS` 的键）：这些字画不出来 */
  unavailableScripts: string[]
  /** 用了斜体、但随站点提供的这个族没有斜体面的字体族：斜体文字会显示成正体（字宽接近，字形不倾斜） */
  upright: string[]
  /** 值得提示用户吗："缺失"会影响版式、"字画不出来"影响阅读；"近似"只是字形不同，单独不打扰 */
  needsNotice: boolean
}

export function reportFonts(
  used: readonly string[],
  resolve: MetricResolver,
  embedded: readonly string[] = [],
  /** 文档文字用到的脚本（引擎的字体需求里带的 `scripts`） */
  usedScripts: readonly string[] = [],
  /** 文档里用了斜体的字体族（引擎的字体需求里 `italic` 为真的那些） */
  italicFamilies: readonly string[] = [],
  /** 这个族有没有随站点提供的斜体面（缺省：都有，即不报） */
  lacksItalic: (family: string) => boolean = () => false,
  /** 缺失时实际改用哪个族画（缺省 Carlito） */
  fallback?: (family: string) => string,
): FontReport {
  const embeddedKeys = new Set(embedded.map(norm))
  const seen = new Set<string>()
  const verdicts: FontVerdict[] = []
  for (const family of used) {
    const key = norm(family)
    if (!key || seen.has(key)) continue
    seen.add(key)
    verdicts.push(judgeFont(family, resolve, embeddedKeys, fallback))
  }
  const approximate = verdicts.filter((verdict) => verdict.support === 'approximate')
  const missing = verdicts.filter((verdict) => verdict.support === 'missing')
  const unavailableScripts = [...new Set(usedScripts)].filter((script) => script in UNAVAILABLE_SCRIPT_LABELS)
  // 只对「有字体、但没有斜体面」的族说：缺失的族已经单独说了；内嵌的字体按文档自带的面用
  const handled = new Set(verdicts.filter((verdict) => verdict.support === 'exact').map((verdict) => norm(verdict.family)))
  const upright = [...new Set(italicFamilies.map((family) => family.trim()).filter((family) => handled.has(norm(family)) && lacksItalic(family)))]
  return { verdicts, approximate, missing, unavailableScripts, upright, needsNotice: missing.length > 0 || unavailableScripts.length > 0 || upright.length > 0 }
}

const quoted = (items: readonly FontVerdict[], limit = 4) => `${items.slice(0, limit).map((item) => `「${item.family}」`).join('')}${items.length > limit ? ` 等 ${items.length} 种` : ''}`

/**
 * 给用户看的话。没有要说的返回空串。
 * 只在缺失时提示：中文文档几乎都用宋体/微软雅黑，每次都说"字形不同"是噪音，且这一点已写在使用说明里；
 * 缺失才会让换行和分页变化，是用户真正需要知道的。近似的信息保留在 `approximate` 里供详情面板使用。
 * 没有字体的文字区域（繁体 / 韩文 …）单独说一句：这些字在编辑区里画不出来，但文件内容不受影响；
 * 随站点提供的字体没有斜体面时也说一句：斜体会显示成正体，用户别以为文件里的斜体丢了。
 */
export function fontNotice(report: FontReport): string {
  const parts: string[] = []
  if (report.missing.length) {
    parts.push(`文档用了${quoted(report.missing)}，这里没有这些字体，改用 ${report.missing[0]!.rendersAs} 显示，换行和分页可能与 Word 不同`)
  }
  if (report.unavailableScripts.length) {
    const names = report.unavailableScripts.map((script) => UNAVAILABLE_SCRIPT_LABELS[script]).join('、')
    parts.push(`文档里有${names}文字，这里没有内置对应字体，这些字会显示成空框（文件内容不受影响，用 Word 打开正常）`)
  }
  if (report.upright.length) {
    const names = report.upright.slice(0, 4).map((family) => `「${family}」`).join('')
    parts.push(`${names}的斜体没有对应字体，斜体文字会显示成正体（字宽接近，分页基本不变）`)
  }
  return parts.join('；')
}
