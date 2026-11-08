/**
 * Word 编辑字体环境的纯函数单测。
 * 不起引擎：只验证「槽位 → 字体环境」的还原与「补缺需求」的覆盖判断，这两处出错会让分页宽度和 Word 不一致。
 */
import type { ResidentFontRequirement } from '@betteroffice/docx/layout'
import { describe, expect, it } from 'vitest'
import { fontEnvironmentForRegistrations, uncoveredFontRequirements } from './fonts'

const req = (family: string, bold = false, italic = false, scripts?: ResidentFontRequirement['scripts']): ResidentFontRequirement => ({
  key: `${family.toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`,
  family,
  bold,
  italic,
  ...(scripts ? { scripts } : {}),
})

describe('fontEnvironmentForRegistrations', () => {
  it('按字体链还原每个槽位的族名、粗斜体', () => {
    const regular = req('Carlito')
    const boldItalic = req('Carlito', true, true)
    const fonts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
    const env = fontEnvironmentForRegistrations(
      fonts,
      { [regular.key]: [0], [boldItalic.key]: [1] },
      [regular, boldItalic],
      ['Carlito', 'Carlito'],
    )
    expect(env.faces).toHaveLength(2)
    expect(env.faces[0]).toMatchObject({ family: 'Carlito', weight: 'normal', style: 'normal' })
    expect(env.faces[1]).toMatchObject({ family: 'Carlito', weight: 'bold', style: 'italic' })
    expect(env.families).toEqual(['Carlito'])
  })

  it('字节是拷贝：改环境里的字节不影响登记表', () => {
    const bytes = new Uint8Array([9, 9, 9])
    const env = fontEnvironmentForRegistrations([bytes], { 'a|0|0': [0] }, [req('A')], ['A'])
    const face = env.faces[0] as { data: Uint8Array }
    face.data[0] = 0
    expect(bytes[0]).toBe(9)
  })

  it('替身槽位（substituteOf）原样带上，不当字节处理', () => {
    const env = fontEnvironmentForRegistrations(
      [new Uint8Array([1]), { substituteOf: 0, family: '宋体' }],
      { '宋体|0|0': [1] },
      [req('宋体')],
      ['宋体'],
    )
    expect(env.faces[1]).toEqual({ substituteOf: 0, family: '宋体' })
  })

  it('链里没有需求记录时从键里解析粗斜体', () => {
    const env = fontEnvironmentForRegistrations([new Uint8Array([1])], { 'foo|1|0': [0] }, [], ['foo'])
    expect(env.faces[0]).toMatchObject({ family: 'foo', weight: 'bold', style: 'normal' })
  })

  it('字体链被深拷贝', () => {
    const chains = { 'a|0|0': [0] }
    const env = fontEnvironmentForRegistrations([new Uint8Array([1])], chains, [req('a')], ['a'])
    chains['a|0|0']!.push(7)
    expect(env.chains['a|0|0']).toEqual([0])
  })
})

describe('uncoveredFontRequirements', () => {
  it('全部已覆盖返回 null', () => {
    expect(uncoveredFontRequirements([req('A'), req('B')], [req('A')])).toBeNull()
  })

  it('有新需求时返回合并后的完整列表', () => {
    const merged = uncoveredFontRequirements([req('A')], [req('A'), req('B')])
    expect(merged?.map((item) => item.key)).toEqual(['a|0|0', 'b|0|0'])
  })

  it('键相同但脚本顺序不同算未覆盖（字体链不同）', () => {
    const merged = uncoveredFontRequirements([req('A', false, false, ['cjk-sc', 'arabic'])], [req('A', false, false, ['arabic', 'cjk-sc'])])
    expect(merged).not.toBeNull()
    expect(merged![0]!.scripts).toEqual(['arabic', 'cjk-sc'])
  })

  it('脚本顺序相同算覆盖', () => {
    expect(uncoveredFontRequirements([req('A', false, false, ['cjk-sc'])], [req('A', false, false, ['cjk-sc'])])).toBeNull()
  })
})
