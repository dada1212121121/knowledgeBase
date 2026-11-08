/**
 * 清单解析
 *
 * 与后端共用 `crates/kb-web/tests/fixtures/editor-manifest-cases.json`：同一份输入两边必须给出同样的结论，
 * 规则漂移（一边放宽 / 收紧）会让其中一边的测试变红。
 */
import { describe, expect, it } from 'vitest'
import CASES_RAW from '../../../../crates/kb-web/tests/fixtures/editor-manifest-cases.json?raw'
import { EDITOR_API_VERSION } from './api'
import { isSafeRelativePath, isValidExtensionId, isValidSemver, parseManifest } from './manifest'

interface Case {
  name: string
  ok: boolean
  manifest: unknown
  error_contains?: string
}
const CASES = JSON.parse(CASES_RAW) as Case[]

describe('清单：与后端共用的用例', () => {
  it('用例集读得出来（防止路径变了悄悄空转）', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20)
    expect(CASES.some((item) => item.ok)).toBe(true)
    expect(CASES.some((item) => !item.ok)).toBe(true)
  })

  it.each(CASES)('$name', (item) => {
    const result = parseManifest(item.manifest)
    expect(result.ok, JSON.stringify(result)).toBe(item.ok)
    if (!result.ok && item.error_contains) {
      expect(result.errors.some((error) => error.includes(item.error_contains!)), `${result.errors.join(' | ')} 应包含 ${item.error_contains}`).toBe(true)
    }
  })
})

describe('清单：规范化输出', () => {
  it('snake_case 输入 → camelCase 输出，缺省值补齐，权限去重保序', () => {
    const result = parseManifest({
      id: 'kb.demo',
      name: ' 演示 ',
      version: '1.2.3',
      api_version: 1,
      permissions: ['ui', 'document.read', 'ui'],
      contributes: {
        ai_tools: [{ id: 'kb.demo.ai', title: '改写' }],
        panels: [{ id: 'kb.demo.panel', title: '面板', icon: '∑' }],
        codecs: [{ id: 'kb.demo.codec', extensions: ['foo', 'foo', 'bar'] }],
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest).toEqual({
      id: 'kb.demo',
      name: '演示',
      version: '1.2.3',
      apiVersion: EDITOR_API_VERSION,
      entry: 'index.js',
      permissions: ['ui', 'document.read'],
      contributes: {
        commands: [],
        toolbar: [],
        slash: [],
        panels: [{ id: 'kb.demo.panel', title: '面板', icon: '∑' }],
        codecs: [{ id: 'kb.demo.codec', extensions: ['foo', 'bar'] }],
        surfaces: [],
        aiTools: [{ id: 'kb.demo.ai', title: '改写' }],
      },
    })
  })

  it('一次报出所有问题，而不是第一个就停', () => {
    const result = parseManifest({ id: 'Bad Id', version: '1.0', api_version: '1', permissions: ['root'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(5)
  })

  it('api_version 大于 1 的拒绝原因里说清楚要升级编辑器', () => {
    const result = parseManifest({ id: 'kb.x', name: 'x', version: '1.0.0', api_version: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('')).toMatch(/更新版本的编辑器扩展 API/)
  })

  it('不是对象 / null / 数组都不抛', () => {
    for (const raw of [null, undefined, 1, 'x', []]) expect(parseManifest(raw).ok).toBe(false)
  })
})

describe('清单：单项规则', () => {
  it('id', () => {
    for (const good of ['a', 'kb.word-count', 'a1.b2-c3']) expect(isValidExtensionId(good), good).toBe(true)
    for (const bad of ['', '.a', 'a.', 'a..b', 'a--b', 'A', 'a_b', 'a b', 'a/b', 'a'.repeat(65), 1, null]) expect(isValidExtensionId(bad), String(bad)).toBe(false)
  })

  it('semver', () => {
    for (const good of ['0.0.0', '1.2.3', '1.0.0-alpha.1', '1.0.0+build.5', '1.0.0-rc.1+x']) expect(isValidSemver(good), good).toBe(true)
    for (const bad of ['1', '1.2', '1.2.3.4', '01.2.3', '1.2.3-', '1.2.3-01', 'v1.2.3', '1.2.3+']) expect(isValidSemver(bad), bad).toBe(false)
  })

  it('扩展目录内的相对路径', () => {
    for (const good of ['index.js', 'dist/main.js', 'a-b_c.1.js']) expect(isSafeRelativePath(good), good).toBe(true)
    for (const bad of ['', '../x.js', './x.js', '/x.js', 'a//b.js', '.hidden.js', 'a b.js', 'a\\b.js', 'x%2e.js']) expect(isSafeRelativePath(bad), bad).toBe(false)
  })
})
