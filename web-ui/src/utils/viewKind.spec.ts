import { describe, expect, it } from 'vitest'
import { isBuiltinViewFormat, viewKindOf } from './viewKind'

describe('viewKindOf', () => {
  it.each([
    ['pdf', 'pdf'], ['PDF', 'pdf'], ['docx', 'docx'], ['dotx', 'docx'], ['pptx', 'pptx'], ['potx', 'pptx'], ['xlsx', 'sheet'], ['xltx', 'sheet'], ['csv', 'sheet'], ['xls', 'sheet'], ['ods', 'sheet'], ['numbers', 'sheet'],
    ['doc', 'legacy-doc'], ['ppt', 'legacy-ppt'], ['odt', 'odt'], ['odp', 'odp'], ['rtf', 'rtf'], ['epub', 'epub'],
    ['eml', 'mail'], ['mbox', 'mail'], ['msg', 'mail'], ['ipynb', 'notebook'], ['html', 'html'], ['htm', 'html'],
    ['zip', 'archive'], ['tar', 'archive'], ['tgz', 'archive'], ['gz', 'archive'], ['7z', 'archive'], ['jar', 'archive'],
    ['png', 'image'], ['svg', 'image'], ['heic', 'image'], ['tiff', 'image'], ['mp3', 'media'], ['mkv', 'media'], ['avi', 'media'],
    ['md', 'markdown'], ['rs', 'code'], ['cs', 'code'], ['ini', 'code'], ['log', 'code'], ['json', 'code'], ['dockerfile', 'code'],
  ])('%s → %s', (format, expected) => {
    expect(viewKindOf(format, false, true)).toBe(expected)
  })
  it('sniffs unknown extensions when the original is readable, otherwise treats them as text', () => {
    expect(viewKindOf('weird', false, true)).toBe('sniff')
    expect(viewKindOf('', false, true)).toBe('sniff')
    expect(viewKindOf('weird', false, false)).toBe('code')
  })
  it('trusts backend-provided text for unknown extensions', () => {
    expect(viewKindOf('weird', true, true)).toBe('code')
  })
  it('accepts a full file name or path', () => {
    expect(viewKindOf('docs/a.tar.gz', false, true)).toBe('archive')
  })
})

describe('isBuiltinViewFormat', () => {
  it('页面认得的格式：专门的查看器和已知的文本类扩展名，大小写与路径都不影响', () => {
    for (const name of ['pdf', 'PDF', 'docx', 'xlsx', 'csv', 'md', 'rs', 'cs', 'zip', 'png', 'mp3', 'ipynb', 'html', 'docs/a.tar.gz', 'dockerfile']) {
      expect(isBuiltinViewFormat(name), name).toBe(true)
    }
  })

  it('不认得的扩展名（含只靠内容嗅探 / 后端给了文本才能看的）返回 false', () => {
    for (const name of ['kbtodo', 'weird', 'foo.kbtodo', '', 'Makefile2']) {
      expect(isBuiltinViewFormat(name), name).toBe(false)
    }
  })

  it('和 viewKindOf 一致：认得 ⇔ 没有后备也有明确结论', () => {
    // 认得的格式不论有没有文本 / 原件，结论都不变；不认得的才随后备（文本 / 嗅探）变化
    for (const name of ['rs', 'pdf', 'zip', 'md']) {
      expect(viewKindOf(name, false, false)).toBe(viewKindOf(name, true, true))
    }
    expect(viewKindOf('kbtodo', true, true)).not.toBe(viewKindOf('kbtodo', false, true))
  })
})
