/** 查找 / 替换的纯逻辑与控制器单测：用假后端，不起引擎。真引擎上的中文 / 跨页 / 替换全部在 editor-native 的 docx-find 场景。 */
import { describe, expect, it, vi } from 'vitest'
import { DocxFindController, type FindBackend, type FindRect } from './docx-find-controller'
import { buildReplaceRequest, EMPTY_FIND, highlightRange, selectionForMatch, stepIndex, toFindResult, validateReplacement, type DocxMatch } from './docx-find'

const match = (paraId: string, start: number, end: number, text = 'x'): DocxMatch => ({ text, range: { story: 'body', start: { paraId, offset: start }, end: { paraId, offset: end }, view: 'accepted' } })

describe('stepIndex', () => {
  it('首尾相接', () => {
    expect(stepIndex(0, 3, false)).toBe(1)
    expect(stepIndex(2, 3, false)).toBe(0)
    expect(stepIndex(0, 3, true)).toBe(2)
    expect(stepIndex(1, 3, true)).toBe(0)
  })
  it('没有当前命中时：往后从头、往前从尾', () => {
    expect(stepIndex(-1, 3, false)).toBe(0)
    expect(stepIndex(-1, 3, true)).toBe(2)
  })
  it('没有命中是 -1', () => {
    expect(stepIndex(-1, 0, false)).toBe(-1)
    expect(stepIndex(0, 0, true)).toBe(-1)
  })
})

describe('命中的形状转换', () => {
  const m = match('p1', 3, 5, '你好')
  it('命中 → 选区（引擎的位置形状）', () => {
    expect(selectionForMatch(m)).toEqual({ anchor: { story: 'body', paraId: 'p1', offset: 3 }, focus: { story: 'body', paraId: 'p1', offset: 5 } })
  })
  it('命中 → 高亮范围（没有 view 字段）', () => {
    expect(highlightRange(m)).toEqual({ story: 'body', start: { paraId: 'p1', offset: 3 }, end: { paraId: 'p1', offset: 5 } })
    expect('view' in highlightRange(m)).toBe(false)
  })
  it('toFindResult：总数、下标、当前命中所在页', () => {
    const state = { query: '你好', matches: [m, match('p2', 0, 2)], index: 1, truncated: false }
    expect(toFindResult(state, () => 4)).toEqual({ query: '你好', total: 2, index: 1, anchors: [{ kind: 'page', page: 4, text: '你好' }] })
    expect(toFindResult(EMPTY_FIND)).toEqual({ query: '', total: 0, index: -1, anchors: [] })
  })
  it('替换文字不能含换行', () => {
    expect(validateReplacement('a\nb')).toContain('换行')
    expect(validateReplacement('a\u2028b')).toContain('换行')
    expect(validateReplacement('一二三')).toBeNull()
    expect(validateReplacement('')).toBeNull()
  })
  it('替换请求：range 原样作为目标，带查找时的版本；修订模式带作者', () => {
    expect(buildReplaceRequest([m], '新', 'v7')).toEqual({ targets: [m.range], text: '新', expectVersion: 'v7' })
    expect(buildReplaceRequest([m], '新', 'v7', { name: '甲' })).toMatchObject({ suggesting: { name: '甲' } })
    // 是拷贝：改请求不会改到命中
    const request = buildReplaceRequest([m], '新', 'v7')
    request.targets[0]!.story = 'x'
    expect(m.range.story).toBe('body')
  })
})

/* ---------------- 控制器 ---------------- */

/** 假文档：一个字符串数组（每段一项），查找 = 在各段里找子串；替换 = 改字符串 */
function fakeDocument(paragraphs: string[]) {
  let version = 1
  const docs = { paragraphs }
  const find = (query: string): DocxMatch[] => {
    const out: DocxMatch[] = []
    docs.paragraphs.forEach((text, index) => {
      let at = text.indexOf(query)
      while (query && at >= 0) {
        out.push(match(`p${index}`, at, at + query.length, query))
        at = text.indexOf(query, at + query.length)
      }
    })
    return out
  }
  const selects: DocxMatch[] = []
  const replaces: Array<ReturnType<typeof buildReplaceRequest>> = []
  let suggesting: { name: string } | undefined
  const backend: FindBackend = {
    find: async (query) => ({ version: String(version), matches: find(query), truncated: false }),
    select: async (m) => {
      selects.push(m)
      return { ok: true, shown: Promise.resolve() }
    },
    replace: async (request) => {
      replaces.push(request)
      if (request.expectVersion !== String(version)) return { ok: false, reason: '文档版本过期' }
      // 倒序替换，位置不受前面替换影响
      for (const target of [...request.targets].reverse()) {
        const index = Number(target.start.paraId.slice(1))
        const text = docs.paragraphs[index]!
        docs.paragraphs[index] = text.slice(0, target.start.offset) + request.text + text.slice(target.end.offset)
      }
      version += 1
      return { ok: true }
    },
    highlights: async (matches) => matches.map((m, i) => [{ pageId: 'pg', pageIndex: Math.floor(i / 2), x: i, y: i, width: 10, height: 10 }]),
    suggesting: () => suggesting,
  }
  return {
    backend,
    docs,
    selects,
    replaces,
    bump: () => (version += 1),
    setSuggesting: (value: { name: string } | undefined) => (suggesting = value),
  }
}

function setup(paragraphs: string[]) {
  const doc = fakeDocument(paragraphs)
  const painted: FindRect[][] = []
  const revealed: Array<unknown> = []
  const controller = new DocxFindController(doc.backend, {
    onHighlights: (rects) => painted.push([...rects]),
    reveal: () => revealed.push(true),
    pageOf: (pageIndex) => pageIndex + 1,
  })
  return { doc, controller, painted, revealed }
}

describe('DocxFindController.set / step', () => {
  it('查找：总数、停在第一个、选中并滚过去、高亮里只有当前那块标当前', async () => {
    const { controller, painted, doc, revealed } = setup(['你好世界你好', '再见', '你好吗'])
    const result = await controller.set('你好')
    expect(result.data).toMatchObject({ query: '你好', total: 3, index: 0 })
    expect(doc.selects).toHaveLength(1)
    expect(revealed).toHaveLength(1)
    const last = painted.at(-1)!
    expect(last).toHaveLength(3)
    expect(last.filter((rect) => rect.current)).toHaveLength(1)
    expect(last[0]!.current).toBe(true)
  })

  it('没有命中：total 0、不选中、清掉高亮', async () => {
    const { controller, doc, painted } = setup(['abc'])
    const result = await controller.set('zzz')
    expect(result.data).toMatchObject({ total: 0, index: -1 })
    expect(doc.selects).toHaveLength(0)
    expect(painted.at(-1)).toEqual([])
  })

  it('下一个 / 上一个：首尾相接，每次选中并滚动', async () => {
    const { controller, doc } = setup(['a a a'])
    await controller.set('a')
    expect((await controller.step(false)).data).toMatchObject({ index: 1 })
    expect((await controller.step(false)).data).toMatchObject({ index: 2 })
    expect((await controller.step(false)).data).toMatchObject({ index: 0 })
    expect((await controller.step(true)).data).toMatchObject({ index: 2 })
    expect(doc.selects).toHaveLength(5)
  })

  it('空查询 = 清除', async () => {
    const { controller, painted } = setup(['a'])
    await controller.set('a')
    const result = await controller.set('')
    expect(result.data).toMatchObject({ total: 0, index: -1, query: '' })
    expect(painted.at(-1)).toEqual([])
  })

  it('快速连续输入：旧请求晚到不会盖掉新结果', async () => {
    const { controller, doc } = setup(['abc abd'])
    const original = doc.backend.find
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    doc.backend.find = vi.fn(async (query: string) => {
      if (query === 'ab') await slow
      return original(query)
    })
    const first = controller.set('ab')
    const second = controller.set('abd')
    await second
    release()
    await first
    expect(controller.current.query).toBe('abd')
    expect(controller.current.matches).toHaveLength(1)
  })

  it('空文档 / 没有命中时 step 不抛错', async () => {
    const { controller } = setup([''])
    await controller.set('x')
    expect((await controller.step(false)).ok).toBe(true)
  })
})

describe('DocxFindController.replaceOne', () => {
  it('替换当前命中；停在原下标（= 原来的下一个）；总数少 1', async () => {
    const { controller, doc } = setup(['猫 猫 猫'])
    await controller.set('猫')
    const result = await controller.replaceOne('狗')
    expect(result.ok).toBe(true)
    expect(doc.docs.paragraphs[0]).toBe('狗 猫 猫')
    expect(result.data).toMatchObject({ total: 2, index: 0 })
  })

  it('中间那个：替换后停在原下标指向的下一个', async () => {
    const { controller, doc } = setup(['猫 猫 猫'])
    await controller.set('猫')
    await controller.step(false)
    const result = await controller.replaceOne('狗')
    expect(doc.docs.paragraphs[0]).toBe('猫 狗 猫')
    expect(result.data).toMatchObject({ total: 2, index: 1 })
  })

  it('替换成更长的字也不会错位（替换后重新查）', async () => {
    const { controller, doc } = setup(['a a a'])
    await controller.set('a')
    await controller.replaceOne('一二三四五')
    await controller.replaceOne('一二三四五')
    expect(doc.docs.paragraphs[0]).toBe('一二三四五 一二三四五 a')
  })

  it('查找之后文档被改了、这一处不在了：不替换别处，更新列表并说明', async () => {
    const { controller, doc } = setup(['猫 猫'])
    await controller.set('猫')
    doc.docs.paragraphs[0] = '猫'
    doc.bump()
    await controller.step(false)
    const result = await controller.replaceOne('狗')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('已经不在原位置')
    expect(doc.replaces).toHaveLength(0)
    expect(doc.docs.paragraphs[0]).toBe('猫')
    expect(controller.current.matches).toHaveLength(1)
  })

  it('替换文字含换行：拒绝，不提交', async () => {
    const { controller, doc } = setup(['a'])
    await controller.set('a')
    expect((await controller.replaceOne('x\ny')).ok).toBe(false)
    expect(doc.replaces).toHaveLength(0)
  })

  it('没有命中时替换：说明原因', async () => {
    const { controller } = setup(['a'])
    await controller.set('z')
    expect(await controller.replaceOne('x')).toEqual({ ok: false, reason: '没有可替换的命中' })
  })

  it('引擎拒绝：把原因带出来，文档不变', async () => {
    const { controller, doc } = setup(['a'])
    await controller.set('a')
    doc.backend.replace = async () => ({ ok: false, reason: '只读' })
    expect(await controller.replaceOne('b')).toEqual({ ok: false, reason: '只读' })
  })
})

describe('DocxFindController.replaceAll', () => {
  it('整批一次提交（一个请求），全部替换，返回替换了几处', async () => {
    const { controller, doc } = setup(['你好 你好', '你好'])
    await controller.set('你好')
    const result = await controller.replaceAll('hi')
    expect(doc.replaces).toHaveLength(1)
    expect(doc.replaces[0]!.targets).toHaveLength(3)
    expect(doc.docs.paragraphs).toEqual(['hi hi', 'hi'])
    expect(result.data).toMatchObject({ replaced: 3, total: 0 })
  })

  it('用的是替换前重新查到的命中与版本（不是查找时的旧状态）', async () => {
    const { controller, doc } = setup(['a a'])
    await controller.set('a')
    doc.docs.paragraphs[0] = 'a a a'
    doc.bump()
    const result = await controller.replaceAll('b')
    expect(result.ok).toBe(true)
    expect(doc.docs.paragraphs[0]).toBe('b b b')
  })

  it('没有命中：替换了 0 处，不提交', async () => {
    const { controller, doc } = setup(['a'])
    await controller.set('z')
    const result = await controller.replaceAll('x')
    expect(result.data).toMatchObject({ replaced: 0 })
    expect(doc.replaces).toHaveLength(0)
  })

  it('命中被截断（超过上限）：拒绝，要求缩小范围，不替换一部分', async () => {
    const { controller, doc } = setup(['a'])
    await controller.set('a')
    doc.backend.find = async () => ({ version: '1', matches: [match('p0', 0, 1, 'a')], truncated: true })
    const result = await controller.replaceAll('b')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('缩小查找范围')
    expect(doc.replaces).toHaveLength(0)
  })

  it('修订模式：替换请求带作者（变成修订标记而不是直接改）', async () => {
    const { controller, doc } = setup(['a a'])
    doc.setSuggesting({ name: '甲' })
    await controller.set('a')
    await controller.replaceAll('b')
    expect(doc.replaces[0]).toMatchObject({ suggesting: { name: '甲' } })
  })

  it('没有查找内容：拒绝', async () => {
    const { controller } = setup(['a'])
    expect((await controller.replaceAll('x')).ok).toBe(false)
  })
})

describe('DocxFindController.refresh', () => {
  it('文档变了重新查：保持当前下标（夹在范围内），高亮跟着更新', async () => {
    const { controller, doc, painted } = setup(['a a a'])
    await controller.set('a')
    await controller.step(false)
    doc.docs.paragraphs[0] = 'a a'
    doc.bump()
    await controller.refresh()
    expect(controller.current.matches).toHaveLength(2)
    expect(controller.current.index).toBe(1)
    expect(painted.at(-1)).toHaveLength(2)
  })

  it('没有查询时什么也不做', async () => {
    const { controller, doc } = setup(['a'])
    const find = vi.spyOn(doc.backend, 'find')
    await controller.refresh()
    expect(find).not.toHaveBeenCalled()
  })
})

/** 让已排队的微任务都跑完 */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('DocxFindController：滚动要等含新选区的几何帧', () => {
  /** 每次 select 回执立刻到，`shown`（帧装好）由测试手动放行 */
  function lagging(paragraphs: string[]) {
    const ctx = setup(paragraphs)
    const frames: Array<() => void> = []
    ctx.doc.backend.select = async (m) => {
      ctx.doc.selects.push(m)
      return { ok: true, shown: new Promise<void>((resolve) => frames.push(resolve)) }
    }
    return { ...ctx, frames }
  }

  it('回执到了、帧还没到：不滚（此时读几何会读到上一个命中）；帧到了才滚一次', async () => {
    const { controller, revealed, frames } = lagging(['a a a'])
    await controller.set('a')
    await flush()
    expect(revealed).toHaveLength(0)
    frames[0]!()
    await flush()
    expect(revealed).toHaveLength(1)
  })

  it('命令返回不被帧挡住：下标 / 总数马上更新，查找条的计数不会跟着帧一起卡', async () => {
    const { controller, frames } = lagging(['a a a'])
    await controller.set('a')
    // 帧一个都没放行，step 照样返回新下标
    expect((await controller.step(false)).data).toMatchObject({ index: 1, total: 3 })
    expect((await controller.step(false)).data).toMatchObject({ index: 2, total: 3 })
    expect(frames).toHaveLength(3)
  })

  it('连按下一个：前几次的帧后到也不再滚（只让最后一次去滚），不会先滚到中间的命中', async () => {
    const { controller, revealed, frames } = lagging(['a a a a'])
    await controller.set('a')
    await controller.step(false)
    await controller.step(false)
    await controller.step(false)
    expect(controller.current.index).toBe(3)
    // 帧按提交顺序一个个到：前三次已被后面的取代
    frames[0]!()
    frames[1]!()
    frames[2]!()
    await flush()
    expect(revealed).toHaveLength(0)
    frames[3]!()
    await flush()
    expect(revealed).toHaveLength(1)
  })

  it('每次都等到帧装好再按下一个：每次都滚', async () => {
    const { controller, revealed, frames } = lagging(['a a a'])
    await controller.set('a')
    frames[0]!()
    await flush()
    await controller.step(false)
    frames[1]!()
    await flush()
    expect(revealed).toHaveLength(2)
  })

  it('选中失败（文档已变）：不滚', async () => {
    const { controller, doc, revealed } = setup(['a a'])
    doc.backend.select = async () => ({ ok: false, shown: Promise.resolve() })
    await controller.set('a')
    await flush()
    expect(revealed).toHaveLength(0)
  })
})
