/**
 * 度量字体与完整字体的排版一致性（冷开优化）
 *
 * 引擎排版只用字宽 / 字距表 / 纵向度量，不用字形轮廓，所以幻灯片面改成只给它「清空轮廓的度量字体」（几十 KB），
 * 浏览器画字用的字形另外按需加载。这个改动成立的前提是：**排版结果和给完整字体时逐页相同**——这里用真实引擎、
 * 真实 deck 把它守住。比较的是整页显示列表的 JSON（去掉 glyphId：那是字体内部的字形编号，度量字体里编号不同，
 * 画布用文字和位置画字，不看它）。
 *
 * 登记顺序与代码里真实使用的完全一致，而且**不能“改进”**：同一族名下后登记的中文字体会覆盖常规体，
 * 所以读路径只在排版出现中文时才登记中文度量，编辑 / 协同始终登记——这是现有的排版行为（Latin 字宽因此不同），
 * 这里连同它一起保住。完整字体来自仓库里留作生成源的那几个文件（Carlito-*.ttf、NotoSansSC-GB2312-Regular.ttf，不再随页面下载）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initWasm, openPresentation } from '@betteroffice/pptx'

const ROOT = resolve(import.meta.dirname, '../../..')
const FONTS = resolve(ROOT, 'src/editor/engines/fonts')
const bytes = (path: string) => new Uint8Array(readFileSync(path))

const full = {
  regular: bytes(`${FONTS}/Carlito-Regular.ttf`),
  bold: bytes(`${FONTS}/Carlito-Bold.ttf`),
  cjk: bytes(`${FONTS}/NotoSansSC-GB2312-Regular.ttf`),
}
const metrics = {
  regular: bytes(`${FONTS}/gen/metrics-latin-regular.ttf`),
  bold: bytes(`${FONTS}/gen/metrics-latin-bold.ttf`),
  cjk: bytes(`${FONTS}/gen/metrics-cjk.ttf`),
}

const DECKS = ['deck-30p.pptx', 'deck-latin-8p.pptx'].map((name) => resolve(ROOT, 'e2e/fixtures/editor', name)).concat(resolve(ROOT, 'e2e/fixtures/sample.pptx'))

/** 与 pptxModel.ts 的 hasCjk 同一批码位 */
const HAS_CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/

type Set3 = { regular: Uint8Array; bold: Uint8Array; cjk: Uint8Array }

function layouts(handle: ReturnType<typeof openPresentation>): string[] {
  const count = handle.snapshot().slides.length
  const out: string[] = []
  for (let index = 0; index < count; index += 1) out.push(JSON.stringify(handle.layoutSlide(index), (key, value) => (key === 'glyphId' ? undefined : value)))
  return out
}

/** 只读：Carlito 常规 + 粗体；排版出现中文才再登记中文（pptx.ts 的 ensureCjk），登记后重新排版 */
function readLayouts(deck: Uint8Array, fonts: Set3): string[] {
  const handle = openPresentation(deck, { fonts: [{ family: 'Calibri', bytes: fonts.regular }, { family: 'Calibri', bold: true, bytes: fonts.bold }] })
  let out = layouts(handle)
  if (out.some((json) => HAS_CJK.test(json))) {
    handle.registerFont({ family: 'Calibri', bytes: fonts.cjk })
    out = layouts(handle)
  }
  return out
}

/** 编辑 / 协同：一开始就带上 Carlito 常规 + 粗体 + 中文（pptxEdit.ts / pptxCollab.ts） */
function editLayouts(deck: Uint8Array, fonts: Set3): string[] {
  const handle = openPresentation(deck, {
    fonts: [
      { family: 'Calibri', bytes: fonts.regular },
      { family: 'Calibri', bold: true, bytes: fonts.bold },
      { family: 'Calibri', bytes: fonts.cjk },
    ],
  })
  return layouts(handle)
}

beforeAll(async () => {
  await initWasm(bytes(resolve(ROOT, 'node_modules/@betteroffice/pptx/dist/generated/pptx_wasm_bg.wasm')))
})

describe('度量字体与完整字体排版逐页一致', () => {
  for (const path of DECKS) {
    const name = path.split('/').pop()!
    it(`${name}：只读（按需登记中文）`, () => {
      const deck = bytes(path)
      const expected = readLayouts(deck, full)
      const actual = readLayouts(deck, metrics)
      expect(actual).toHaveLength(expected.length)
      actual.forEach((json, index) => expect(json === expected[index], `第 ${index + 1} 页排版不同`).toBe(true))
    })
    it(`${name}：编辑 / 协同（始终登记中文）`, () => {
      const deck = bytes(path)
      const expected = editLayouts(deck, full)
      const actual = editLayouts(deck, metrics)
      expect(actual).toHaveLength(expected.length)
      actual.forEach((json, index) => expect(json === expected[index], `第 ${index + 1} 页排版不同`).toBe(true))
    })
  }

  it('反证：去掉字距表（GPOS）的度量字体会让排版不同——说明上面的比较确实能发现字体信息缺失', () => {
    // 没有这条，一个两边都恒为空的比较也会"通过"。这里故意用一份缺 GPOS 的字体，应当被发现
    const deck = bytes(resolve(ROOT, 'e2e/fixtures/editor/deck-latin-8p.pptx'))
    const expected = readLayouts(deck, full)
    const crippled = { ...metrics, regular: stripGpos(metrics.regular), bold: stripGpos(metrics.bold) }
    const actual = readLayouts(deck, crippled)
    expect(actual.some((json, index) => json !== expected[index])).toBe(true)
  })
})

/** 把 TTF 里的 GPOS 表项改名成不存在的标签（字体仍然有效，但引擎读不到字距表） */
function stripGpos(font: Uint8Array): Uint8Array {
  const copy = new Uint8Array(font)
  const view = new DataView(copy.buffer)
  const tables = view.getUint16(4)
  for (let at = 0; at < tables; at += 1) {
    const entry = 12 + at * 16
    if (String.fromCharCode(...copy.subarray(entry, entry + 4)) === 'GPOS') copy.set([0x58, 0x58, 0x58, 0x58], entry)
  }
  return copy
}
