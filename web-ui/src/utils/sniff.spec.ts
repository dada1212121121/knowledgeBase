import { describe, expect, it } from 'vitest'
import { decodeBytes, resolveSniffed, sniffMagic, sniffOleStreams, sniffTextEncoding, sniffTextKind, sniffZipEntries } from './sniff'

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

describe('sniffMagic', () => {
  it('recognises common signatures', () => {
    expect(sniffMagic(text('%PDF-1.7'))).toBe('pdf')
    expect(sniffMagic(bytes(0x50, 0x4b, 3, 4))).toBe('zip')
    expect(sniffMagic(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('ole')
    expect(sniffMagic(bytes(0x1f, 0x8b, 8))).toBe('gzip')
    expect(sniffMagic(bytes(0x89, 0x50, 0x4e, 0x47))).toBe('png')
    expect(sniffMagic(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpg')
    expect(sniffMagic(text('{\\rtf1\\ansi'))).toBe('rtf')
    expect(sniffMagic(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63))).toBe('heic')
    expect(sniffMagic(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d))).toBe('mp4')
    expect(sniffMagic(text('RIFF\0\0\0\0WAVEfmt '))).toBe('wav')
  })
  it('returns null for plain text', () => {
    expect(sniffMagic(text('hello world'))).toBeNull()
  })
})

describe('sniffTextEncoding / decodeBytes', () => {
  it('accepts utf-8 and falls back to gb18030', () => {
    expect(sniffTextEncoding(text('你好 world'))).toBe('utf-8')
    expect(sniffTextEncoding(bytes(0xc4, 0xe3, 0xba, 0xc3, 0x20, 0xc4, 0xe3))).toBe('gb18030')
    expect(decodeBytes(bytes(0xc4, 0xe3, 0xba, 0xc3))).toBe('你好')
  })
  it('rejects binary data and detects utf-16 BOMs', () => {
    expect(sniffTextEncoding(bytes(1, 2, 0, 3, 4))).toBeNull()
    expect(sniffTextEncoding(bytes(0xff, 0xfe, 0x61, 0))).toBe('utf-16le')
    expect(decodeBytes(bytes(0xff, 0xfe, 0x61, 0, 0x62, 0))).toBe('ab')
  })
  it('treats an empty file as text', () => {
    expect(sniffTextEncoding(new Uint8Array())).toBe('utf-8')
  })
})

describe('sniffTextKind', () => {
  it('splits html / svg / json / text', () => {
    expect(sniffTextKind('<!DOCTYPE html><html></html>')).toBe('html')
    expect(sniffTextKind('<svg xmlns="..."></svg>')).toBe('svg')
    expect(sniffTextKind('{"a":1}')).toBe('json')
    expect(sniffTextKind('{not json')).toBe('text')
    expect(sniffTextKind('just words')).toBe('text')
  })
})

describe('container identity', () => {
  it('tells office / odf / epub zips from plain archives', () => {
    expect(sniffZipEntries(['[Content_Types].xml', 'word/document.xml'])).toBe('docx')
    expect(sniffZipEntries(['[Content_Types].xml', 'xl/workbook.xml'])).toBe('xlsx')
    expect(sniffZipEntries(['[Content_Types].xml', 'ppt/presentation.xml'])).toBe('pptx')
    expect(sniffZipEntries(['mimetype', 'META-INF/container.xml', 'OEBPS/a.xhtml'])).toBe('epub')
    expect(sniffZipEntries(['mimetype', 'content.xml', 'meta.xml'])).toBe('odt')
    expect(sniffZipEntries(['a.txt', 'b/c.png'])).toBe('archive')
  })
  it('tells legacy office streams apart', () => {
    expect(sniffOleStreams(['WordDocument', '1Table'])).toBe('doc')
    expect(sniffOleStreams(['Workbook'])).toBe('xls')
    expect(sniffOleStreams(['PowerPoint Document', 'Current User'])).toBe('ppt')
    expect(sniffOleStreams(['__substg1.0_0037001F'])).toBe('msg')
    expect(sniffOleStreams(['x'])).toBe('ole')
  })
})

describe('resolveSniffed', () => {
  const zip = bytes(0x50, 0x4b, 3, 4)
  const ole = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)
  it('resolves containers by their inside', () => {
    expect(resolveSniffed(zip, ['[Content_Types].xml', 'word/document.xml'])).toEqual({ format: 'docx', binary: false })
    expect(resolveSniffed(zip, ['mimetype', 'content.xml'], 'application/vnd.oasis.opendocument.spreadsheet').format).toBe('ods')
    expect(resolveSniffed(zip, ['mimetype', 'content.xml'], 'application/vnd.oasis.opendocument.presentation').format).toBe('odp')
    expect(resolveSniffed(zip, ['a.txt']).format).toBe('zip')
    expect(resolveSniffed(ole, [], '', ['WordDocument']).format).toBe('doc')
    expect(resolveSniffed(ole, [], '', ['Workbook']).format).toBe('xls')
    expect(resolveSniffed(ole, [], '', ['Mystery'])).toEqual({ format: 'bin', binary: true })
  })
  it('resolves plain content by kind and falls back to binary', () => {
    expect(resolveSniffed(text('<!doctype html><p>x'))).toEqual({ format: 'html', binary: false })
    expect(resolveSniffed(text('{"a":1}')).format).toBe('json')
    expect(resolveSniffed(text('just notes')).format).toBe('txt')
    expect(resolveSniffed(bytes(1, 2, 0, 0, 5, 6))).toEqual({ format: 'bin', binary: true })
    expect(resolveSniffed(text('%PDF-1.4')).format).toBe('pdf')
    expect(resolveSniffed(bytes(0x1f, 0x8b, 8)).format).toBe('gz')
    expect(resolveSniffed(bytes(0x89, 0x50, 0x4e, 0x47)).format).toBe('png')
  })
})
