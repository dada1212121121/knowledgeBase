import { describe, expect, it } from 'vitest'
import { canEditAsMarkdown, copyEditNotice, extractorLabel, fileChip, fileLayers, formatSize, markdownCopyPath } from './files'

describe('formatSize', () => {
  it('KB 取整、MB 一位小数、整数不带 .0', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(860 * 1024)).toBe('860 KB')
    expect(formatSize(4.2 * 1024 * 1024)).toBe('4.2 MB')
    expect(formatSize(48 * 1024 * 1024)).toBe('48 MB')
    expect(formatSize(12.6 * 1024 * 1024)).toBe('12.6 MB')
    expect(formatSize(2 * 1024 ** 3)).toBe('2 GB')
  })
})

describe('fileChip', () => {
  it('常见格式归到设计稿里的缩写', () => {
    expect(fileChip('向量检索综述-2025.pdf')).toEqual({ label: 'PDF', tone: 'danger' })
    expect(fileChip('a.DOCX').label).toBe('DOC')
    expect(fileChip('b.xlsx').label).toBe('XLS')
    expect(fileChip('周会录音.m4a').label).toBe('AUD')
    expect(fileChip('x.rs')).toEqual({ label: 'RS', tone: 'm' })
    expect(fileChip('Makefile').label).toBe('文件')
  })
})

describe('fileLayers / extractorLabel', () => {
  it('按格式给出“文字是怎么来的”', () => {
    expect(fileLayers('pdf')).toBe('文字层')
    expect(fileLayers('XLSX')).toBe('表格')
    expect(fileLayers('pptx')).toBe('幻灯片')
    expect(fileLayers('PNG')).toBe('OCR')
    expect(fileLayers('m4a')).toBe('转写')
    expect(fileLayers('md')).toBe('文本层')
  })

  it('抽取器 id 换成可读标签,认不出的原样返回', () => {
    expect(extractorLabel('application/pdf')).toBe('PDF 文字层')
    expect(extractorLabel('audio|video/*')).toBe('音视频转写')
    expect(extractorLabel('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('PPTX')
    expect(extractorLabel('some/future-extractor')).toBe('some/future-extractor')
    expect(extractorLabel(null)).toBe('')
  })
})

describe('转 Markdown 副本编辑', () => {
  it('办公文档 / PDF / 电子书可以转,文本、代码、图片、旧版 Office 不行(不区分大小写)', () => {
    for (const name of ['a.docx', 'b.PPTX', 'c.xlsx', 'd.odt', 'e.rtf', 'f.epub', 'g.pdf', '目录/手册.DOCX']) expect(canEditAsMarkdown(name), name).toBe(true)
    for (const name of ['a.md', 'b.txt', 'c.rs', 'd.png', 'e.doc', 'f.xls', 'g', 'docx']) expect(canEditAsMarkdown(name), name).toBe(false)
  })

  it('副本路径只换扩展名、目录不变(与后端一致);带点的目录名不会被误当扩展名', () => {
    expect(markdownCopyPath('手册/操作 手册.docx')).toBe('手册/操作 手册.md')
    expect(markdownCopyPath('a.b/readme')).toBe('a.b/readme.md')
    expect(markdownCopyPath('报告.v2.pdf')).toBe('报告.v2.md')
  })

  it('转换前的说明讲清楚:写在哪、改的是副本、丢什么;表格和 PDF 的说法不同', () => {
    const word = copyEditNotice('手册/使用手册.docx')
    expect(word).toContain('使用手册.md')
    expect(word).toContain('使用手册.docx 本身不会被改动')
    expect(word).toContain('图片会保留')
    expect(copyEditNotice('预算.xlsx')).toContain('公式')
    expect(copyEditNotice('报告.pdf')).toContain('文字层')
  })
})
