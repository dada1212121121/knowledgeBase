// PowerPoint 引擎要调用方把字体字节传进去(浏览器里不读系统字体)。
//
// 登记办法是实测出来的(验证样例):同一个族名下,**英文字体在前、中文字体在后**。
// 英文字符用 Carlito(与 Calibri 字宽相同,换行位置和 PowerPoint 一致),中文字符用 Noto Sans SC 的 GB2312 裁剪版。
// 试过另外两种,都不好:中文字体放在前面会让英文字符用中文字体里的拉丁字形(字宽不对);
// 把中文字体登记成「兜底字体」(`registerFallbackFont`),中文字符的排版宽度和绘制出来的字形对不上,文字叠在一起。
//
// 幻灯片面(只读 / 编辑 / 协同)采用「引擎只拿度量字体、浏览器按需取字形」:
// 引擎排版用的是字形轮廓清空、只留字宽 / 字距 / 纵向度量的度量字体(gen/metrics-*.ttf,合计约 56 KB brotli),
// 真正画出来的字形由 glyphFaces.ts 按文档里实际出现的字分片取 woff2。完整的 Carlito / Noto Sans SC 不再随页面下载
// (从该版本起,旧编辑岛的 loadOfficeFonts 一并删除;完整字体文件只留在仓库里作为 scripts/build-office-fonts.py 的生成源)。
import metricsCjk from './gen/metrics-cjk.ttf?url'
import metricsLatinBold from './gen/metrics-latin-bold.ttf?url'
import metricsLatinRegular from './gen/metrics-latin-regular.ttf?url'

/**
 * 幻灯片面只登记 Calibri：deck 里写了别的族名(微软雅黑、宋体、Arial、华文细黑 …)而没登记时,引擎用登记过的字体顶上,
 * 并且显示列表里报告的就是顶上的那个族名,所以 Arial 的文字也按 Carlito 排版、按 Calibri 绘制。
 * 验证范围有限：只比对了 4 份 deck（01_standard_business、deck-yahei、deck-30p、05_unicode_cjk_emoji）
 * 每页布局 JSON 的长度（去掉 fontFamily 字段后），不是逐字段全量对比；其余 deck 靠“不改保存”和渲染 e2e 兜底。
 * 每多登记一个族名,引擎里就多复制一份字体进内存、浏览器多解析一份。
 */
export const NATIVE_FONT_FAMILIES = ['Calibri'] as const

async function bytesOf(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`字体下载失败(HTTP ${response.status}):${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** 只缓存成功:下载失败时用户重试要重新下 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null
  return () => {
    cached ??= load().catch((error) => {
      cached = null
      throw error
    })
    return cached
  }
}

/**
 * 幻灯片面(引擎排版)用的度量字体:字形轮廓清空、字宽 / 字距表 / 纵向度量原样保留,三个文件合计约 56 KB(brotli),
 * 原来的完整 Carlito + Noto Sans SC 要 1.6 MB。排版结果逐页一致(pptxFonts.parity.spec.ts 比对过),
 * 真正画出来的字形由 glyphFaces.ts 按需提供。生成方式与许可见 scripts/build-office-fonts.py。
 *
 * 拉丁度量（常规 + 粗体）任何文档都要；中文度量单独取：读路径只在排版里出现中文时才取，纯拉丁 deck 不下载任何中文相关文件；
 * 编辑 / 协同始终取（引擎的字体表只能在打开时给，敲进中文时再补不进去）。
 * 中文度量登记进引擎的位置与时机会改变英文字宽（同族名后登记者覆盖常规体），这是现有排版行为，各引擎适配里原样保留。
 */
export interface LatinMetrics {
  regular: Uint8Array
  bold: Uint8Array
}

export const loadLatinMetrics = once<LatinMetrics>(async () => {
  const [regular, bold] = await Promise.all([bytesOf(metricsLatinRegular), bytesOf(metricsLatinBold)])
  return { regular, bold }
})

export const loadCjkMetrics = once<Uint8Array>(() => bytesOf(metricsCjk))
