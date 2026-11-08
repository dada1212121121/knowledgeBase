import { describe, expect, it } from 'vitest'
import { globToRegExp, parseGlobs } from './glob'

describe('globToRegExp', () => {
  it('* 不跨目录,** 跨目录', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true)
    expect(globToRegExp('*.md').test('docs/a.md')).toBe(false)
    expect(globToRegExp('docs/**').test('docs/a/b.md')).toBe(true)
    expect(globToRegExp('**/*.md').test('a/b/c.md')).toBe(true)
    expect(globToRegExp('**/*.md').test('c.md')).toBe(true)
  })

  it('目录规则与文件规则都能命中', () => {
    expect(globToRegExp('node_modules/**').test('node_modules/x/y.js')).toBe(true)
    expect(globToRegExp('*.lock').test('Cargo.lock')).toBe(true)
    expect(globToRegExp('*.lock').test('Cargo.lock.bak')).toBe(false)
  })

  it('? 只匹配一个字符,特殊字符按字面量处理', () => {
    expect(globToRegExp('a?.md').test('ab.md')).toBe(true)
    expect(globToRegExp('a?.md').test('abc.md')).toBe(false)
    expect(globToRegExp('a+b.md').test('a+b.md')).toBe(true)
  })

  it('parseGlobs 忽略空项并去空格', () => {
    const rules = parseGlobs(' node_modules/** , , *.lock ')
    expect(rules).toHaveLength(2)
    expect(rules[0].test('node_modules/a.js')).toBe(true)
    expect(rules[1].test('yarn.lock')).toBe(true)
  })

  it('花括号选项 {a,b} 展开为或,且花括号里的逗号不拆规则', () => {
    const rules = parseGlobs('**/*.{pdf,docx,md}, node_modules/**')
    expect(rules).toHaveLength(2)
    expect(rules[0].test('论文/a.pdf')).toBe(true)
    expect(rules[0].test('b.docx')).toBe(true)
    expect(rules[0].test('c.png')).toBe(false)
    expect(rules[1].test('node_modules/x.js')).toBe(true)
  })
})
