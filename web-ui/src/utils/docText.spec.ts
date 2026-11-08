import { afterEach, describe, expect, it } from 'vitest'
import {
  buildOutline,
  clearDraft,
  collabDraftFields,
  countWords,
  draftCarriesBody,
  draftWorthRestoring,
  hasResumableDraft,
  leadingHeading,
  loadDraft,
  outlineDepth,
  readingMinutes,
  repeatsTitle,
  restoreMode,
  sameTitle,
  saveDraft,
  scopedDraftId,
  type Draft,
} from './docText'

const draftOf = (patch: Partial<Draft> = {}): Draft => ({ title: 't', body: 'edited', base: 'old', savedAt: Date.now(), ...patch })

describe('countWords', () => {
  it('counts CJK characters one by one and other text by word', () => {
    expect(countWords('你好世界')).toBe(4)
    expect(countWords('hello world')).toBe(2)
    expect(countWords('用 RRF 融合 3 路结果')).toBe(8)
  })
  it('ignores markdown syntax, code and link targets', () => {
    expect(countWords('# 标题\n\n- **加粗** 与 `code`\n\n```js\nconst a = 1\n```\n\n[链接](https://x.com/a)')).toBe(7)
    expect(countWords('')).toBe(0)
  })
  it('turns word counts into reading minutes (at least one)', () => {
    expect(readingMinutes(0)).toBe(1)
    expect(readingMinutes(1200)).toBe(3)
  })
})

describe('buildOutline', () => {
  it('drops a single h1 used as the document title', () => {
    const outline = buildOutline([
      { level: 1, text: '标题' },
      { level: 2, text: '现象' },
      { level: 3, text: '细节' },
      { level: 2, text: '做法' },
    ])
    expect(outline.map((item) => [item.level, item.text, item.index])).toEqual([
      [2, '现象', 1],
      [3, '细节', 2],
      [2, '做法', 3],
    ])
    expect(outline.map(outlineDepth(outline))).toEqual([0, 1, 0])
  })
  it('keeps several h1s, skips h5/h6 and empty headings', () => {
    const outline = buildOutline([
      { level: 1, text: 'A' },
      { level: 1, text: 'B' },
      { level: 5, text: 'deep' },
      { level: 2, text: '  ' },
    ])
    expect(outline.map((item) => item.text)).toEqual(['A', 'B'])
  })
})

describe('drafts', () => {
  afterEach(() => localStorage.clear())
  it('saves, loads and clears a draft', () => {
    const now = Date.now()
    expect(saveDraft('ins_1', { title: 't', body: 'b', base: 'old' }, now)).toBe(true)
    expect(loadDraft('ins_1')).toEqual({ title: 't', body: 'b', base: 'old', savedAt: now })
    clearDraft('ins_1')
    expect(loadDraft('ins_1')).toBeNull()
  })
  it('only offers to restore drafts that differ from the server copy', () => {
    expect(draftWorthRestoring(null, { title: 't', body: 'b' })).toBe(false)
    expect(draftWorthRestoring({ title: 't', body: 'b', base: '', savedAt: 1 }, { title: 't', body: 'b' })).toBe(false)
    expect(draftWorthRestoring({ title: 't', body: 'changed', base: '', savedAt: 1 }, { title: 't', body: 'b' })).toBe(true)
  })
  it('keeps at most 30 drafts, dropping the oldest', () => {
    const base = Date.now()
    for (let at = 0; at < 35; at += 1) saveDraft(`d${at}`, { title: '', body: String(at), base: '' }, base + at)
    expect(loadDraft('d0')).toBeNull()
    expect(loadDraft('d34')?.body).toBe('34')
    expect(Object.keys(localStorage).filter((key) => key.startsWith('kb.draft.'))).toHaveLength(30)
  })
  it('ignores corrupt entries', () => {
    localStorage.setItem('kb.draft.bad', '{not json')
    expect(loadDraft('bad')).toBeNull()
  })
})

describe('leadingHeading / sameTitle(页面大标题让给正文标题)', () => {
  it('跳过 YAML 头、空行和开头的提示块,取第一行的一级标题', () => {
    expect(leadingHeading('# 标题\n正文')).toBe('标题')
    expect(leadingHeading('---\na: 1\n---\n\n# 标题')).toBe('标题')
    expect(leadingHeading('> [!TIP]\n> 测试\n\n# sampleproj 规范\n')).toBe('sampleproj 规范')
    expect(leadingHeading('# **加粗**标题 #')).toBe('加粗标题')
  })
  it('开头误按出来的空标题行（只有 #）不算,也不挡后面真正的标题', () => {
    expect(leadingHeading('#\n\n> [!TIP]\n> 测试\n\n# sampleproj 项目开发规范（初版）\n\n正文')).toBe('sampleproj 项目开发规范（初版）')
    expect(leadingHeading('##  \n# 标题')).toBe('标题')
    expect(leadingHeading('#\n\n只有空标题和正文')).toBeNull()
  })
  it('开头不是一级标题就返回 null', () => {
    expect(leadingHeading('正文\n# 标题')).toBeNull()
    expect(leadingHeading('## 二级')).toBeNull()
    expect(leadingHeading('')).toBeNull()
  })
  it('全角半角、空白、大小写不影响判断;空标题不和谁相同', () => {
    expect(sameTitle('sampleproj 项目开发规范（初版）', 'sampleproj 项目开发规范(初版)')).toBe(true)
    expect(sameTitle('Deploy  Guide', 'deploy guide')).toBe(true)
    expect(sameTitle('', '')).toBe(false)
    expect(sameTitle('甲', '乙')).toBe(false)
  })
})

describe('repeatsTitle(正文第一行是和标题一样的一级标题)', () => {
  it('第一个非空行是 # 标题,文字和页面标题相同:是重复', () => {
    expect(repeatsTitle('Sample 项目清单', '# Sample 项目清单\n\n正文')).toBe(true)
    expect(repeatsTitle('Sample 项目清单', '\n\n# Sample 项目清单\n正文')).toBe(true)
  })
  it('忽略首尾空白、标题尾部的 #、行内加粗 / 代码等格式符号', () => {
    expect(repeatsTitle('部署手册', '#   部署手册   \n')).toBe(true)
    expect(repeatsTitle('部署手册', '# 部署手册 #\n')).toBe(true)
    expect(repeatsTitle('部署手册', '# **部署**手册\n')).toBe(true)
    expect(repeatsTitle('部署 kb', '# 部署 `kb`\n')).toBe(true)
  })
  it('标题文字不同:不是重复(不能因为都是一级标题就藏掉)', () => {
    expect(repeatsTitle('部署手册', '# 回滚手册\n')).toBe(false)
    expect(repeatsTitle('部署手册', '# 部署手册(续)\n')).toBe(false)
  })
  it('只认一级标题:二级标题、普通段落、列表同名都不算', () => {
    expect(repeatsTitle('部署手册', '## 部署手册\n')).toBe(false)
    expect(repeatsTitle('部署手册', '部署手册\n')).toBe(false)
    expect(repeatsTitle('部署手册', '- 部署手册\n')).toBe(false)
  })
  it('只看第一个非空行:第二行才出现同名一级标题,不算', () => {
    expect(repeatsTitle('部署手册', '前言\n\n# 部署手册\n')).toBe(false)
  })
  it('YAML 头(--- 包起来的)不是正文,跳过它再看', () => {
    expect(repeatsTitle('部署手册', '---\ntitle: x\n---\n# 部署手册\n')).toBe(true)
  })
  it('标题或正文是空的:不是重复,不会把空标题当成匹配', () => {
    expect(repeatsTitle('', '# \n')).toBe(false)
    expect(repeatsTitle('', '')).toBe(false)
    expect(repeatsTitle('部署手册', '')).toBe(false)
  })
  it('大小写不同算相同,全角 / 半角空格不影响', () => {
    expect(repeatsTitle('Deploy Guide', '# deploy guide\n')).toBe(true)
    expect(repeatsTitle('部署 手册', '# 部署\u3000手册\n')).toBe(true)
  })
})

describe('草稿的账号隔离与过期', () => {
  afterEach(() => localStorage.clear())

  it('草稿键带账号:同一台电脑换账号登录,看不到上一个人没写完的内容', () => {
    expect(scopedDraftId('usr_a', 'new:c')).toBe('usr_a:new:c')
    expect(scopedDraftId('usr_a', 'new:c')).not.toBe(scopedDraftId('usr_b', 'new:c'))
    expect(scopedDraftId(null, 'x')).toBe('anon:x')
    saveDraft(scopedDraftId('usr_a', 'new:c'), { title: '甲的', body: 'x', base: '' })
    expect(loadDraft(scopedDraftId('usr_b', 'new:c'))).toBeNull()
    expect(loadDraft(scopedDraftId('usr_a', 'new:c'))?.title).toBe('甲的')
  })

  it('存不进去(存储已满 / 隐私模式)返回 false,调用方据此知道离开会丢东西', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    try {
      expect(saveDraft('x', { title: '', body: 'b', base: '' })).toBe(false)
    } finally {
      Storage.prototype.setItem = original
    }
  })

  it('超过 30 天的草稿当没有,并顺手清掉', () => {
    const now = Date.now()
    saveDraft('old', { title: '', body: 'b', base: '' }, now - 31 * 24 * 3600 * 1000)
    saveDraft('fresh', { title: '', body: 'b', base: '' }, now - 29 * 24 * 3600 * 1000)
    expect(loadDraft('old', now)).toBeNull()
    expect(localStorage.getItem('kb.draft.old')).toBeNull()
    expect(loadDraft('fresh', now)?.body).toBe('b')
  })
})

describe('restoreMode(单人编辑:什么时候可以静默放回)', () => {
  const server = { title: 't', body: 'old' }

  it('没有草稿,或草稿和服务器一样:none', () => {
    expect(restoreMode(null, server)).toBe('none')
    expect(restoreMode(draftOf({ body: 'old' }), server)).toBe('none')
  })

  it('草稿是在现在这一版上改的:silent', () => {
    expect(restoreMode(draftOf(), server)).toBe('silent')
  })

  it('服务器上的正文在草稿之后变过:ask(静默覆盖会丢掉那些改动)', () => {
    expect(restoreMode(draftOf({ base: 'older' }), server)).toBe('ask')
  })

  it('标题在草稿之后变过也是 ask;老草稿没记录 baseTitle 时按没变处理', () => {
    expect(restoreMode(draftOf({ baseTitle: '旧标题' }), server)).toBe('ask')
    expect(restoreMode(draftOf({ baseTitle: 't' }), server)).toBe('silent')
    expect(restoreMode(draftOf(), server)).toBe('silent')
  })

  it('标签 / 种类(extra)在草稿之后变过:ask;只有 extra 变了也值得恢复', () => {
    const withExtra = { ...server, extra: '{"tags":["b"]}' }
    expect(restoreMode(draftOf({ body: 'old', extra: '{"tags":["a"]}', baseExtra: '{"tags":["b"]}' }), withExtra)).toBe('silent')
    expect(restoreMode(draftOf({ body: 'old', extra: '{"tags":["a"]}', baseExtra: '{"tags":["c"]}' }), withExtra)).toBe('ask')
    expect(draftWorthRestoring(draftOf({ body: 'old', extra: '{"tags":["a"]}' }), withExtra)).toBe(true)
  })

  it('正文末尾的换行差异不算改动(编辑器序列化会多一个换行)', () => {
    expect(restoreMode(draftOf({ body: 'old\n' }), server)).toBe('none')
    expect(restoreMode(draftOf({ body: 'new', base: 'old\n' }), server)).toBe('silent')
  })

  it('allowSilent=false:即使 base 一致也只能 ask', () => {
    expect(restoreMode(draftOf(), server, false)).toBe('ask')
  })
})

describe('collabDraftFields(多人编辑:正文以房间为准)', () => {
  const server = { title: 't', body: 'whatever the room has', extra: '{"tags":[]}' }

  it('正文只有 unsynced 的才算数;同步过的草稿正文是空串,别人改了正文也不会触发提示', () => {
    expect(collabDraftFields(draftOf({ body: '', unsynced: false }), server).bodyUnsynced).toBe(false)
    expect(collabDraftFields(draftOf({ body: '离线写的', unsynced: true }), server).bodyUnsynced).toBe(true)
    expect(collabDraftFields(draftOf({ body: '  ', unsynced: true }), server).bodyUnsynced).toBe(false)
  })

  it('标题 / 标签按单人规则:基于现在这一版就 silent,变过就 ask,没变就 none', () => {
    expect(collabDraftFields(draftOf({ body: '', title: '新标题', baseTitle: 't' }), server).fields).toBe('silent')
    expect(collabDraftFields(draftOf({ body: '', title: '新标题', baseTitle: '更早的标题' }), server).fields).toBe('ask')
    expect(collabDraftFields(draftOf({ body: '', title: 't' }), server).fields).toBe('none')
    expect(collabDraftFields(null, server)).toEqual({ fields: 'none', bodyUnsynced: false })
  })
})

describe('hasResumableDraft(打开文档时要不要直接回到编辑)', () => {
  afterEach(() => localStorage.clear())
  const server = { title: 't', body: 'old' }

  it('单人:能静默放回才算;要问的(服务器变过)不把人强行拖进编辑态', () => {
    saveDraft('a', { title: 't', body: 'edited', base: 'old' })
    saveDraft('b', { title: 't', body: 'edited', base: 'older' })
    expect(hasResumableDraft('a', server)).toBe(true)
    expect(hasResumableDraft('b', server)).toBe(false)
    expect(hasResumableDraft('none', server)).toBe(false)
  })

  it('多人:有没同步的正文,或标题 / 标签能静默放回,才算', () => {
    saveDraft('unsynced', { title: 't', body: '离线写的', base: 'old', unsynced: true })
    saveDraft('synced', { title: 't', body: '', base: 'old', unsynced: false })
    saveDraft('title', { title: '新', body: '', base: 'old', baseTitle: 't', unsynced: false })
    expect(hasResumableDraft('unsynced', server, true)).toBe(true)
    expect(hasResumableDraft('synced', server, true)).toBe(false)
    expect(hasResumableDraft('title', server, true)).toBe(true)
    // 多人编辑留下的「已同步」草稿正文是空串。换成单人模式打开同一篇时,它不能被当成正文放回去,
    // 否则编辑器被清空,点「完成」就把空正文存上去了
    expect(hasResumableDraft('synced', server, false)).toBe(false)
  })

  it('已同步的多人草稿不带正文:不值得恢复,也不会因为正文是空串被当成「用户删光了」', () => {
    const synced = draftOf({ body: '', unsynced: false, title: 't' })
    expect(draftCarriesBody(synced)).toBe(false)
    expect(draftWorthRestoring(synced, server)).toBe(false)
    expect(restoreMode(synced, server)).toBe('none')
    // 单人草稿(unsynced 没有这一项)和没同步的多人草稿都带正文
    expect(draftCarriesBody(draftOf())).toBe(true)
    expect(draftCarriesBody(draftOf({ unsynced: true }))).toBe(true)
  })

  it('已同步的多人草稿只有标题变了:值得恢复,而且基于现在这一版就 silent', () => {
    const synced = draftOf({ body: '', unsynced: false, title: '新标题', baseTitle: 't' })
    expect(restoreMode(synced, server)).toBe('silent')
  })
})
