/**
 * 代码 codec 测试
 *
 * 重点仍是「未改动时逐字节相同」：代码文件一旦被统一换成 LF 或补上末尾换行，
 * 每次保存都会产生整文件 diff，评审里看不出真正的改动。
 */
import { describe, expect, it } from 'vitest'
import { CODE_FORMATS, codeCodec, openCode, saveCode } from '@/editor/codecs/code'

describe('code codec', () => {
  it('1. CRLF + BOM + 无末尾换行：未改动时逐字节相同', () => {
    const source = '\uFEFFfn main() {\r\n  println!("hi");\r\n}'
    const doc = openCode({ kind: 'text', text: source, name: 'main.rs' })
    expect(doc.text).toBe('fn main() {\n  println!("hi");\n}')
    expect(saveCode(doc, doc.text)).toEqual({ kind: 'text', text: source, name: 'main.rs', encoding: 'utf-8' })
  })

  it('2. 编辑后沿用原文件的行尾 / BOM，只改用户改过的部分', () => {
    const doc = openCode({ kind: 'text', text: '\uFEFFa\r\nb\r\n', name: 'a.ts' })
    const saved = saveCode(doc, 'a\nB\n')
    expect(saved).toEqual({ kind: 'text', text: '\uFEFFa\r\nB\r\n', name: 'a.ts', encoding: 'utf-8' })
  })

  it('3. 原文件末尾没有换行，编辑后也不补', () => {
    const doc = openCode({ kind: 'text', text: 'one\ntwo', name: 'a.json' })
    expect(saveCode(doc, 'one\nTWO')).toMatchObject({ text: 'one\nTWO' })
  })

  it('4. 二进制源按 UTF-8 解码，不抛错', () => {
    const doc = openCode({ kind: 'bytes', bytes: new TextEncoder().encode('let x = 1\n'), name: 'x.js' })
    expect(doc.text).toBe('let x = 1\n')
  })

  it('5. 格式清单不含 office / pdf，避免抢占别的 Surface', () => {
    for (const format of ['docx', 'xlsx', 'pptx', 'pdf', 'md']) expect(CODE_FORMATS).not.toContain(format)
  })

  it('6. codec 薄封装处理 bytes 源时不会把正文存成空串', async () => {
    const bytes = new TextEncoder().encode('let a = 1\r\n')
    const doc = await codeCodec.open({ kind: 'bytes', bytes, name: 'a.ts' })
    expect(doc.payload).toMatchObject({ text: 'let a = 1\n', original: 'let a = 1\r\n' })
    const saved = await codeCodec.save(doc, { kind: 'bytes', bytes, name: 'a.ts' })
    expect(saved).toMatchObject({ kind: 'text', text: 'let a = 1\r\n' })
  })
})
