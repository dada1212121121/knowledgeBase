import { describe, expect, it } from 'vitest'
import { isMarkdownName, languageFor, languageLabel } from './editorLanguage'

describe('editorLanguage', () => {
  it('recognises common source files by extension', () => {
    expect(languageLabel('src/main.rs')).toBe('Rust')
    expect(languageLabel('a/b/config.toml')).toBe('TOML')
    expect(languageLabel('x.yaml')).toBe('YAML')
    expect(languageLabel('index.vue')).toMatch(/Vue/i)
  })
  it('falls back to plain text and never throws', () => {
    expect(languageLabel('notes.log')).toBe('纯文本')
    expect(languageLabel('')).toBe('纯文本')
    expect(languageFor('Makefile.unknownext')).toBeNull()
  })
  it('maps markdown-ish aliases', () => {
    expect(languageLabel('doc.mdx')).toBe('Markdown')
    expect(isMarkdownName('a/b.markdown')).toBe(true)
    expect(isMarkdownName('a.txt')).toBe(false)
  })
})
