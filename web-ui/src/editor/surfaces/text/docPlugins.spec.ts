import { afterEach, describe, expect, it, vi } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import {
  COMPOSITION_END_META,
  COMPOSITION_SETTLE_MS,
  decoKey,
  decorationsPlugin,
  mediaPlayer,
  calloutType,
  inputPlugin,
  parseWikilink,
  scrollMarginPlugin,
  wikilinkIds,
} from './docPlugins'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
})
const p = (...parts: (string | [string])[]) =>
  schema.node('paragraph', null, parts.map((part) => (typeof part === 'string' ? schema.text(part) : schema.text(part[0], [schema.mark('strong')]))))

describe('wikilinks', () => {
  it('parses id and alias', () => {
    expect(parseWikilink('[[ins_8b10]]')).toEqual({ id: 'ins_8b10', alias: '' })
    expect(parseWikilink('[[ins_8b10|降级方案]]')).toEqual({ id: 'ins_8b10', alias: '降级方案' })
    expect(parseWikilink('[x]')).toBeNull()
  })
  it('collects unique ids', () => {
    expect(wikilinkIds('a [[x]] b [[y|标题]] c [[x|again]]')).toEqual(['x', 'y'])
  })
})

describe('calloutType', () => {
  it('recognises the five GitHub alert types, case-insensitively', () => {
    expect(calloutType('[!NOTE] 内容')).toEqual({ type: 'note', length: 7 })
    expect(calloutType('[!warning]')).toEqual({ type: 'warning', length: 10 })
    expect(calloutType('[!OTHER]')).toBeNull()
    expect(calloutType('普通引用')).toBeNull()
  })
})

describe('inputPlugin:`[[` 触发与输入法组字', () => {
  afterEach(() => {
    vi.useRealTimers()
    metas.length = 0
  })

  /** 只造 inputPlugin 用到的那一点 EditorView:是否组字中、光标位置、光标前的文字 */
  const metas: unknown[] = []
  function fakeView(before: string, options: { composing?: boolean; empty?: boolean; destroyed?: boolean } = {}) {
    const at = before.length
    return {
      composing: options.composing ?? false,
      isDestroyed: options.destroyed ?? false,
      // 空事务只记它带的标记
      dispatch: (tr: { meta: unknown }) => metas.push(tr.meta),
      state: {
        selection: { from: at, empty: options.empty ?? true },
        doc: { textBetween: (from: number, to: number) => before.slice(Math.max(0, from), to) },
        tr: { setMeta: (_key: string, meta: unknown) => ({ meta }) },
      },
    } as unknown as EditorView
  }
  function setup(readonly = false) {
    const onWikilinkTrigger = vi.fn()
    const plugin = inputPlugin({ readonly: () => readonly, onFiles: vi.fn(), onWikilinkTrigger })
    const props = plugin.props as unknown as {
      handleTextInput: (view: EditorView, from: number, to: number, text: string) => boolean
      handleDOMEvents: { compositionend: (view: EditorView, event: Event) => boolean }
    }
    return { onWikilinkTrigger, ...props }
  }
  const ended = (data: string) => ({ data }) as unknown as Event

  it('逐键输入第二个 `[` 时弹出选择器(位置是第二个 `[` 之后)', () => {
    vi.useFakeTimers()
    const { onWikilinkTrigger, handleTextInput } = setup()
    // 文档里已经有一个 `[`,刚输入第二个:from 是第二个 `[` 要落的位置(1)
    expect(handleTextInput(fakeView('[['), 1, 1, '[')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(onWikilinkTrigger).toHaveBeenCalledWith(2)
  })

  it('组字过程中凑出来的 `[` 不弹(选择器会抢走焦点、打断组字)', () => {
    vi.useFakeTimers()
    const { onWikilinkTrigger, handleTextInput } = setup()
    handleTextInput(fakeView('[[', { composing: true }), 1, 1, '[')
    vi.advanceTimersByTime(1000)
    expect(onWikilinkTrigger).not.toHaveBeenCalled()
  })

  it('只读时不弹', () => {
    vi.useFakeTimers()
    const { onWikilinkTrigger, handleTextInput, handleDOMEvents } = setup(true)
    handleTextInput(fakeView('[['), 1, 1, '[')
    handleDOMEvents.compositionend(fakeView('[['), ended('['))
    vi.advanceTimersByTime(1000)
    expect(onWikilinkTrigger).not.toHaveBeenCalled()
  })

  it('组字结束后,光标前是 `[[` 才弹,而且在 ProseMirror 收尾之后再读', () => {
    vi.useFakeTimers()
    const { onWikilinkTrigger, handleDOMEvents } = setup()
    expect(handleDOMEvents.compositionend(fakeView('参见 [['), ended('['))).toBe(false)
    vi.advanceTimersByTime(COMPOSITION_SETTLE_MS - 1)
    expect(onWikilinkTrigger).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onWikilinkTrigger).toHaveBeenCalledWith(5)
  })

  it('组字结束但最终文本不是 `[[`,或上屏的文字里没有 `[`,或选区不为空:不弹', () => {
    vi.useFakeTimers()
    const { onWikilinkTrigger, handleDOMEvents } = setup()
    handleDOMEvents.compositionend(fakeView('你好'), ended('你好'))
    handleDOMEvents.compositionend(fakeView('['), ended('['))
    // 光标前恰好有 `[[`,但这次上屏的是别的字(用户 Esc 关掉选择器后又在原处组了个字再取消)
    handleDOMEvents.compositionend(fakeView('[['), ended('字'))
    handleDOMEvents.compositionend(fakeView('[[', { empty: false }), ended('['))
    vi.advanceTimersByTime(1000)
    expect(onWikilinkTrigger).not.toHaveBeenCalled()
  })

  it('每次组字结束都推一个空事务:上屏文字和预编辑一样时文档没变化,斜杠菜单要靠它按最终文本重新过滤', () => {
    vi.useFakeTimers()
    const { handleDOMEvents } = setup()
    handleDOMEvents.compositionend(fakeView('/标题'), ended('标题'))
    expect(metas).toEqual([])
    vi.advanceTimersByTime(COMPOSITION_SETTLE_MS)
    expect(metas).toEqual([true])
    expect(COMPOSITION_END_META).toBe('kb-composition-end')
  })

  it('编辑器已销毁(组字结束的定时器到点时)不再派发;只读不推', () => {
    vi.useFakeTimers()
    const { handleDOMEvents } = setup()
    handleDOMEvents.compositionend(fakeView('/标题', { destroyed: true }), ended('标题'))
    const readonly = setup(true)
    readonly.handleDOMEvents.compositionend(fakeView('/标题'), ended('标题'))
    vi.advanceTimersByTime(1000)
    expect(metas).toEqual([])
  })
})

describe('scrollMarginPlugin', () => {
  it('把调用方持有的余量对象原样交给 ProseMirror:原地改 bottom,下一次滚动就读到新值', () => {
    const margin = { top: 5, right: 5, bottom: 5, left: 5 }
    const threshold = { top: 0, right: 0, bottom: 0, left: 0 }
    const props = scrollMarginPlugin(margin, threshold).props as { scrollMargin: unknown; scrollThreshold: unknown }
    expect(props.scrollMargin).toBe(margin)
    expect(props.scrollThreshold).toBe(threshold)
    margin.bottom = 64
    expect((props.scrollMargin as typeof margin).bottom).toBe(64)
  })
})

describe('视频 / 音频附件:卡片后面挂播放器', () => {
  const linkSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
      text: { group: 'inline' },
    },
    marks: { link: { attrs: { href: {}, title: { default: null } }, toDOM: () => ['a', 0] } },
  })
  const raw = (path: string) => `/api/v1/raw?collection=c&path=${encodeURIComponent(path)}`
  const attachment = (name: string, path: string) =>
    linkSchema.text(`📎 ${name}`, [linkSchema.mark('link', { href: raw(path), title: '1.2 MB' })])
  function widgetsOf(...names: Array<[string, string]>) {
    const doc = linkSchema.node('doc', null, names.map(([name, path]) => linkSchema.node('paragraph', null, [attachment(name, path)])))
    const state = EditorState.create({ schema: linkSchema, doc, plugins: [decorationsPlugin({ readonly: () => true, titleOf: () => undefined })] })
    return decoKey
      .getState(state)!
      .find()
      .filter((decoration) => String((decoration as unknown as { spec: { key?: string } }).spec.key ?? '').startsWith('media:'))
      .map((decoration) => (decoration as unknown as { spec: { key: string } }).spec.key)
  }

  it('mp4 / mp3 附件各得到一个播放器,普通附件(pdf、mkv)没有', () => {
    const keys = widgetsOf(['演示.mp4', '_attachments/a/演示.mp4'], ['录音.mp3', '_attachments/a/录音.mp3'], ['手册.pdf', '_attachments/a/手册.pdf'], ['录屏.mkv', '_attachments/a/录屏.mkv'])
    expect(keys).toEqual([`media:video:${raw('_attachments/a/演示.mp4')}`, `media:audio:${raw('_attachments/a/录音.mp3')}`])
  })

  it('不是本站原件地址的链接(外链)不挂播放器', () => {
    const doc = linkSchema.node('doc', null, [
      linkSchema.node('paragraph', null, [linkSchema.text('📎 远程.mp4', [linkSchema.mark('link', { href: 'https://example.com/x.mp4' })])]),
    ])
    const state = EditorState.create({ schema: linkSchema, doc, plugins: [decorationsPlugin({ readonly: () => true, titleOf: () => undefined })] })
    expect(decoKey.getState(state)!.find().filter((decoration) => String((decoration as unknown as { spec: { key?: string } }).spec.key ?? '').startsWith('media:'))).toHaveLength(0)
  })

  it('播放器:带控制条、只取元数据不预加载整段、不可编辑', () => {
    const video = mediaPlayer('video', raw('_attachments/a/演示.mp4'), '演示.mp4')
    expect(video.contentEditable).toBe('false')
    const element = video.querySelector('video')!
    expect(element.controls).toBe(true)
    expect(element.preload).toBe('metadata')
    expect(element.getAttribute('src')).toBe(raw('_attachments/a/演示.mp4'))
    expect(element.getAttribute('aria-label')).toBe('演示.mp4')
    expect(mediaPlayer('audio', '/x', 'a.mp3').querySelector('audio')).not.toBeNull()
  })
})

describe('inputPlugin:粘贴文字 + 文件', () => {
  // 只造 onPaste 用到的那一点 EditorView:光标位置、dom(截住 addEventListener)、pasteHTML/pasteText
  function setup() {
    const onFiles = vi.fn()
    const plugin = inputPlugin({ readonly: () => false, onFiles, onWikilinkTrigger: vi.fn() })
    const listeners: Record<string, (event: ClipboardEvent) => void> = {}
    let pos = 5
    const view = {
      get state() {
        return {
          selection: { from: pos },
          tr: { insertText: (text: string) => ({ text }) },
        }
      },
      dom: {
        addEventListener: (type: string, fn: (event: ClipboardEvent) => void) => {
          listeners[type] = fn
        },
        removeEventListener: vi.fn(),
      },
      dispatch: vi.fn(),
      pasteHTML: vi.fn(() => {
        pos = 9
        return true
      }),
      pasteText: vi.fn(() => {
        pos = 7
        return true
      }),
    } as unknown as EditorView
    // view 挂在 spec 上(Plugin 实例本身不转发它)
    plugin.spec.view?.(view)
    return { onFiles, listeners, view }
  }
  const png = () => new File([Uint8Array.from([1])], 'pasted.png', { type: 'image/png' })
  function pasteEvent({ text = '', html = '', files = [] as File[] }) {
    return {
      clipboardData: { files, items: [], getData: (type: string) => (type === 'text/html' ? html : text) },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as ClipboardEvent
  }

  it('只有文件:接管粘贴,文件插在光标处', () => {
    const { onFiles, listeners } = setup()
    const event = pasteEvent({ files: [png()] })
    listeners.paste(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(onFiles).toHaveBeenCalledWith([expect.any(File)], 5)
  })

  it('文字 + 文件:文字先进文档,文件接在文字后面(以前文字被一起吞掉)', () => {
    const { onFiles, listeners, view } = setup()
    listeners.paste(pasteEvent({ text: '从 Word 粘的一段话', files: [png()] }))
    expect(view.pasteText).toHaveBeenCalledWith('从 Word 粘的一段话', expect.anything())
    expect(onFiles).toHaveBeenCalledWith([expect.any(File)], 7)
  })

  it('带格式的 HTML 优先按 HTML 解析,并且剔掉指向本机的 <img>(图片走上传)', () => {
    const { onFiles, listeners, view } = setup()
    listeners.paste(
      pasteEvent({ text: '加粗', html: '<p><strong>加粗</strong><img src="file:///tmp/x.png"></p>', files: [png()] }),
    )
    expect(view.pasteHTML).toHaveBeenCalledWith('<p><strong>加粗</strong></p>', expect.anything())
    expect(onFiles).toHaveBeenCalledWith([expect.any(File)], 9)
  })

  it('ProseMirror 不收这段文字时,退化成手动插入纯文本', () => {
    const { onFiles, listeners, view } = setup()
    view.pasteText = vi.fn(() => false)
    listeners.paste(pasteEvent({ text: '兜底文字', files: [png()] }))
    expect(view.dispatch).toHaveBeenCalled()
    expect(onFiles).toHaveBeenCalledWith([expect.any(File)], 5)
  })
})
