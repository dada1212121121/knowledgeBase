/**
 * 粘贴通道测试
 *
 * 粘贴是「外部不可信内容进入文档」的唯一入口，所以三条通道都要有断言：
 * HTML 必须被清洗、Markdown 必须按结构解析、图片必须走上传而不是 base64。
 */
import { describe, expect, it, vi } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { textSchema } from '@/editor/surfaces/text/schema'
import {
  htmlSlice,
  insertImageFiles,
  looksLikeMarkdown,
  markdownSlice,
  sanitizePastedHtml,
} from '@/editor/surfaces/text/paste'
import { serializeMarkdown } from '@/editor/codecs/markdown'

describe('HTML 清洗', () => {
  it('1. 删掉 script / style / iframe，以及全部事件属性与 style', () => {
    const html = [
      '<p onclick="steal()" style="color:red">正文</p>',
      '<script>alert(1)</script>',
      '<iframe src="https://evil"></iframe>',
      '<style>p{}</style>',
    ].join('')
    const clean = sanitizePastedHtml(html)
    expect(clean).toContain('正文')
    expect(clean).not.toContain('script')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('style=')
    expect(clean).not.toContain('iframe')
  })

  it('2. `javascript:` 链接去掉 href，但保留文字', () => {
    const clean = sanitizePastedHtml('<a href="javascript:alert(1)">点我</a>')
    expect(clean).toContain('点我')
    expect(clean).not.toContain('javascript:')
  })

  it('3. data: 图片被丢弃（体积不可控，应改用上传）', () => {
    expect(sanitizePastedHtml('<img src="data:image/png;base64,AAAA">')).not.toContain('img')
  })

  it('4. 正常图片与链接保留 src/href', () => {
    const clean = sanitizePastedHtml('<a href="https://a.b">站</a><img src="https://a.b/i.png" alt="图">')
    expect(clean).toContain('https://a.b')
    expect(clean).toContain('i.png')
  })

  it('5. HTML → Slice 后结构正确（strong / 标题 / 列表）', () => {
    const slice = htmlSlice(textSchema, '<h2>标题</h2><ul><li><strong>项</strong></li></ul>')
    expect(slice).not.toBeNull()
    const types: string[] = []
    slice!.content.forEach((node) => types.push(node.type.name))
    expect(types).toContain('heading')
    expect(types).toContain('bullet_list')
  })
})

describe('Markdown 识别与解析', () => {
  it('6. 强特征不足两条时不按 Markdown 处理（普通粘贴不该被改写）', () => {
    expect(looksLikeMarkdown('就一句普通的话')).toBe(false)
    expect(looksLikeMarkdown('2 * 3 = 6')).toBe(false)
    expect(looksLikeMarkdown('# 标题\n\n- 列表\n')).toBe(true)
  })

  it('7. Markdown → Slice 保留结构，可直接插入文档', () => {
    const slice = markdownSlice(textSchema, '## 小节\n\n- 一项\n- 二项\n')
    expect(slice).not.toBeNull()
    const state = EditorState.create({ doc: textSchema.nodes.doc.create(null, [textSchema.nodes.paragraph.create()]) })
    const next = state.apply(state.tr.replaceSelection(slice!))
    const types: string[] = []
    next.doc.forEach((node) => types.push(node.type.name))
    expect(types).toContain('heading')
    expect(types).toContain('bullet_list')
    expect(serializeMarkdown(next.doc)).toContain('- 一项')
  })

  it('8. 空 Markdown 返回 null（交给默认行为，不吞粘贴）', () => {
    expect(markdownSlice(textSchema, '   \n\n  ')).toBeNull()
  })
})

describe('图片上传', () => {
  it('9. 上传成功才插入图片节点', async () => {
    const state = EditorState.create({ doc: textSchema.nodes.doc.create(null, [textSchema.nodes.paragraph.create()]) })
    let current = state
    const view = {
      get state() {
        return current
      },
      dispatch(tr: Parameters<typeof current.apply>[0]) {
        current = current.apply(tr)
      },
    }
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    const inserted = await insertImageFiles(textSchema, view, [file], async () => 'https://cdn/x.png')
    expect(inserted).toBe(true)
    expect(JSON.stringify(current.doc.toJSON())).toContain('https://cdn/x.png')
  })

  it('10. 上传失败或没有上传通道时不插入（绝不落 base64）', async () => {
    const state = EditorState.create({ doc: textSchema.nodes.doc.create(null, [textSchema.nodes.paragraph.create()]) })
    let current = state
    const view = {
      get state() {
        return current
      },
      dispatch(tr: Parameters<typeof current.apply>[0]) {
        current = current.apply(tr)
      },
    }
    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    expect(await insertImageFiles(textSchema, view, [file], async () => null)).toBe(false)
    expect(await insertImageFiles(textSchema, view, [file], undefined)).toBe(false)
    expect(JSON.stringify(current.doc.toJSON())).not.toContain('data:')
  })

  it('11. 非图片文件被忽略', async () => {
    const state = EditorState.create({ doc: textSchema.nodes.doc.create(null, [textSchema.nodes.paragraph.create()]) })
    const view = { get state() { return state }, dispatch: vi.fn() }
    const file = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' })
    expect(await insertImageFiles(textSchema, view, [file], async () => 'https://cdn/x')).toBe(false)
    expect(view.dispatch).not.toHaveBeenCalled()
  })
})
