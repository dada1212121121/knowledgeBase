import { describe, expect, it } from 'vitest'
import { NOT_IN_THE_FORM, SETTINGS_SECTIONS } from './settingsSections'

// 配置结构已按数据域拆到 config/ 目录,拼接全部源文件后再做静态检查。
const CONFIG_RS = Object.values(
  import.meta.glob('../../../crates/kb-core/src/config/*.rs', { eager: true, query: '?raw', import: 'default' }),
).join('\n')

// 后端 `Config` 的顶层字段:直接读 `config/` 的 `pub struct Config { … }`,不再手抄一份。
// 后端新增配置段时,这里自动多出一项,必须在 `SETTINGS_SECTIONS`(字段表有对应字段)/ `NOT_IN_THE_FORM` 里二选一 ——
// 漏了会让“页面能改但永远不落盘”(阻塞项;`llm` 段曾经就是这样被丢下的)。
function backendSections(): string[] {
  const start = CONFIG_RS.indexOf('pub struct Config {')
  const open = CONFIG_RS.indexOf('{', start)
  const close = CONFIG_RS.indexOf('\n}', open)
  return [...CONFIG_RS.slice(open, close).matchAll(/^\s+pub (\w+): \w+Config,/gm)].map((match) => match[1]!)
}

describe('设置页的配置段清单', () => {
  it('能从 config/ 读出后端的配置段(防止正则悄悄失效而空转)', () => {
    expect(backendSections()).toEqual(expect.arrayContaining(['server', 'llm', 'backup', 'extract', 'quota']))
    expect(backendSections().length).toBeGreaterThanOrEqual(24)
  })

  it('每个后端配置段都在表单里或有明确的不进表单理由', () => {
    const covered = new Set([...SETTINGS_SECTIONS.map((section) => section.key), ...NOT_IN_THE_FORM])
    const missing = backendSections().filter((key) => !covered.has(key))
    expect(missing).toEqual([])
  })

  it('不列出后端没有的段', () => {
    const known = new Set(backendSections())
    const covered = [...SETTINGS_SECTIONS.map((section) => section.key), ...NOT_IN_THE_FORM]
    expect(covered.filter((key) => !known.has(key))).toEqual([])
  })

  it('两个清单不重叠', () => {
    const overlap = SETTINGS_SECTIONS.map((section) => section.key).filter((key) => NOT_IN_THE_FORM.includes(key))
    expect(overlap).toEqual([])
  })

  it('llm 与 extract 段现在有表单(以前被放进「不进表单」,页面写着会保存其实永远不落盘)', () => {
    const keys = SETTINGS_SECTIONS.map((section) => section.key)
    expect(keys).toEqual(expect.arrayContaining(['llm', 'extract']))
    expect(NOT_IN_THE_FORM).not.toContain('llm')
    expect(NOT_IN_THE_FORM).not.toContain('extract')
  })

  it('备份段的字段与后端 [backup] 一致(含异地目录)', () => {
    const backup = SETTINGS_SECTIONS.find((section) => section.key === 'backup')
    expect(backup?.fields).toEqual(['enabled', 'interval_hours', 'keep_count', 'keep_days', 'include_sources', 'mirror_dirs'])
  })

  it('表单里的字段名都是后端结构里真有的', () => {
    for (const section of SETTINGS_SECTIONS) {
      // 段名是 snake_case(`web_extract` → `WebExtractConfig`)
      const struct = section.key
        .split('_')
        .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
        .join('')
      const at = CONFIG_RS.indexOf(`pub struct ${struct}Config {`)
      expect(at, `${section.key} 对应的结构`).toBeGreaterThan(-1)
      const body = CONFIG_RS.slice(at, CONFIG_RS.indexOf('\n}', at))
      for (const field of section.fields) expect(body, `${section.key}.${field}`).toMatch(new RegExp(`pub ${field}:`))
    }
  })
})
