/**
 * Word 编辑会话的字体环境。
 *
 * 排版要字体：字宽和 Word 一致，分页才一致。引擎在 Worker 里排版，所以字体字节要登记进 Worker：
 * - 打开时：读出文档用到的字体需求（`fontRequirements`）→ 拉取/匹配字节 → 登记 → 随 `commandInit` 一起发过去；
 * - 编辑中：用户敲了新字体的字、或换了字体，需求变了 → 只补缺的那部分，用 `setFontEnvironment` 命令发给 Worker。
 *
 * 改写自上游 `peerless/workerFonts.ts` 与 `PeerlessDocxEditor.tsx` 里 `updateFontEnvironment` 一段（Apache-2.0，见 NOTICE）；
 * 去掉了宿主自带字体（props.fonts）这条路——本站字体统一走 `engines/fonts/docxFonts.ts` 的 GB2312 裁剪版提供器，
 * 它通过 `configureDefaultFonts` 全局装好，这里不需要再传 provider。
 */
import { createRustMeasureSource, type ResidentFontRequirement } from '@betteroffice/docx/layout'
import type { DocxFontEnvironment, YrsResidentFontRegistration } from '@betteroffice/docx/yrs'

/** 把登记过的字体槽位还原成引擎要的「字体环境」：每个槽位的族名/粗斜体，加上字体链 */
export function fontEnvironmentForRegistrations(
  fonts: YrsResidentFontRegistration[],
  chains: Record<string, number[]>,
  requirements: ResidentFontRequirement[],
  families: string[],
): DocxFontEnvironment {
  const styles = new Map<number, ResidentFontRequirement>()
  for (const [key, slots] of Object.entries(chains)) {
    const [family, bold, italic] = key.split('|')
    const requirement = requirements.find((item) => item.key === key) ?? { key, family: family!, bold: bold === '1', italic: italic === '1' }
    for (const slot of slots) if (!styles.has(slot)) styles.set(slot, requirement)
  }
  return {
    faces: fonts.map((font, index) => {
      if (!(font instanceof Uint8Array)) return { ...font }
      const style = styles.get(index)
      return {
        family: style?.family ?? 'Liberation Sans',
        data: font.slice(),
        weight: style?.bold ? 'bold' : 'normal',
        style: style?.italic ? 'italic' : 'normal',
      }
    }),
    chains: structuredClone(chains),
    families: [...new Set(families)],
  }
}

/**
 * 在 `prepared` 的基础上补上 `next` 里还没覆盖的需求；全覆盖返回 null。
 * 两条需求只有「键相同且脚本顺序相同」才算覆盖：脚本顺序决定字体链，顺序不同链就不同。
 */
export function uncoveredFontRequirements(
  prepared: readonly ResidentFontRequirement[],
  next: readonly ResidentFontRequirement[],
): ResidentFontRequirement[] | null {
  const byKey = new Map(prepared.map((requirement) => [requirement.key, requirement]))
  let uncovered = false
  for (const requirement of next) {
    const known = byKey.get(requirement.key)
    if (known && (known.scripts ?? []).join() === (requirement.scripts ?? []).join()) continue
    byKey.set(requirement.key, requirement)
    uncovered = true
  }
  return uncovered ? [...byKey.values()] : null
}

/**
 * 为一组需求准备一份完整的字体环境（用于编辑中补字体）。
 * 每次都新建测量源、用完清掉：字体字节只在这份环境里存在一次，登记进 Worker 后主线程不留副本。
 */
export async function prepareWorkerFontEnvironment(options: {
  embedded: Parameters<ReturnType<typeof createRustMeasureSource>['setEmbeddedFaces']>[0]
  requirements: ResidentFontRequirement[]
  families: string[]
  compat: Parameters<ReturnType<typeof createRustMeasureSource>['setCompat']>[0]
  signal: AbortSignal
  /** 本会话的字体提供器（按文档需求取核心 / 扩展字形包）；不传则用全局默认（完整字体） */
  bundled?: Parameters<typeof createRustMeasureSource>[0]['bundled']
}): Promise<DocxFontEnvironment> {
  const fonts: YrsResidentFontRegistration[] = []
  const measurement = createRustMeasureSource({
    ...(options.bundled ? { bundled: options.bundled } : {}),
    engine: {
      registerFont(bytes) {
        options.signal.throwIfAborted()
        return fonts.push(bytes.slice()) - 1
      },
      registerSubstituteFont(substituteOf, family) {
        return fonts.push({ substituteOf, family }) - 1
      },
      clearFonts() {
        fonts.length = 0
      },
    },
  })
  try {
    measurement.setCompat(options.compat)
    measurement.setEmbeddedFaces(options.embedded)
    await measurement.prepareFontRequirements(options.requirements)
    options.signal.throwIfAborted()
    const config = measurement.measurementConfigForRequirements(options.requirements)
    if (!config) throw new Error('DOCX worker fonts are not ready')
    return fontEnvironmentForRegistrations(fonts, config.fontChains, options.requirements, options.families)
  } finally {
    measurement.setEmbeddedFaces([])
    measurement.clear()
  }
}
