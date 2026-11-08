// 搜索页纯逻辑:范围选项与解析、结果来源、点结果去哪、高级选项的记忆。
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, DEFAULT_SCOPE, type AnyHit, changedCount, degradedText, hitRoute, hitSource, kindLabel, parseScope, pickScope, readPrefs, rerankParam, scopeOptions } from './search'

const hit = (extra: Partial<AnyHit> = {}): AnyHit => ({ id: 'ck_1', collection: 'proj/docs', kind: 'doc', source: 'guide/run.md', start_line: null, end_line: null, symbol: null, title: null, snippet: 's', score: 1, related: [], explain: null, ...extra })
const alice = { id: 'usr_alice', username: 'alice', display_name: 'Alice', avatar: null }

describe('kindLabel', () => {
  it('类型用中文名;不认识的类型不显示英文原词', () => {
    expect(['insight', 'code', 'doc', 'external', 'summary'].map(kindLabel)).toEqual(['笔记', '代码', '文档', '网页', '摘要'])
    expect(kindLabel('weird')).toBe('内容')
  })
})

describe('scopeOptions / parseScope', () => {
  it('没有人分享内容给我:没有「共享」选项', () => {
    const values = scopeOptions(['a', 'b'], 0).map((option) => option.value)
    expect(values).toEqual(['auto:', 'auto:a', 'auto:b', 'all:', 'global:'])
  })
  it('有共享:多出「我的 + 共享给我的」「只搜共享给我的」', () => {
    const options = scopeOptions([], 3)
    expect(options.slice(-2)).toEqual([
      { value: 'shared:all', label: '我的 + 共享给我的' },
      { value: 'shared:only', label: '只搜共享给我的' },
    ])
  })
  it('解析:我的知识库沿用 scope / project;共享走 include', () => {
    expect(parseScope('auto:')).toEqual({ kind: 'mine', scope: 'auto', project: '' })
    expect(parseScope('auto:knowledgeBase')).toEqual({ kind: 'mine', scope: 'auto', project: 'knowledgeBase' })
    expect(parseScope('all:')).toEqual({ kind: 'mine', scope: 'all', project: '' })
    expect(parseScope('global:')).toEqual({ kind: 'mine', scope: 'global', project: '' })
    expect(parseScope('shared:only')).toEqual({ kind: 'shared', include: 'shared' })
    expect(parseScope('shared:all')).toEqual({ kind: 'shared', include: 'all' })
  })
  it('项目名里带冒号也不丢', () => {
    expect(parseScope('auto:team:docs')).toEqual({ kind: 'mine', scope: 'auto', project: 'team:docs' })
  })
  it('认不出的值退回「当前项目」,不抛错', () => {
    expect(parseScope('')).toEqual({ kind: 'mine', scope: 'auto', project: '' })
    expect(parseScope('bogus:x')).toEqual({ kind: 'mine', scope: 'auto', project: '' })
  })
})

describe('pickScope', () => {
  const options = scopeOptions(['a'], 2)
  it('地址里的范围在可选项里就用它', () => {
    for (const option of options) expect(pickScope(option.value, options)).toBe(option.value)
  })
  it('不在可选项里(项目删了 / 共享收回了 / 手改地址 / 旧链接)退回默认,不拿它去搜', () => {
    expect(pickScope('auto:deleted', options)).toBe(DEFAULT_SCOPE)
    expect(pickScope('shared:all', scopeOptions(['a'], 0))).toBe(DEFAULT_SCOPE)
    expect(pickScope('rm -rf', options)).toBe(DEFAULT_SCOPE)
    expect(pickScope('', options)).toBe(DEFAULT_SCOPE)
  })
})

describe('hitSource', () => {
  it('普通检索的命中是我的', () => {
    expect(hitSource(hit())).toEqual({ mine: true, label: '我的', role: '' })
  })
  it('共享检索里 role 为 owner 的是我自己的', () => {
    expect(hitSource(hit({ space_id: 'sp_me', role: 'owner' }))).toEqual({ mine: true, label: '我的', role: '' })
  })
  it('别人分享的:写明谁、我的角色', () => {
    expect(hitSource(hit({ space_id: 'sp_alice', owner: alice, role: 'editor' }))).toEqual({ mine: false, label: '来自 Alice', role: '可编辑' })
    expect(hitSource(hit({ space_id: 'sp_alice', owner: alice, role: 'viewer' })).role).toBe('可查看')
  })
  it('分享人账号已不存在也不崩', () => {
    expect(hitSource(hit({ space_id: 'sp_x', owner: null, role: 'commenter' }))).toEqual({ mine: false, label: '别人分享的', role: '可评论' })
  })
})

describe('hitRoute', () => {
  it('我的命中:路径地址(路由表里没有命名路由),带集合 / 路径 / 命中块', () => {
    const route = hitRoute(hit())
    expect(route).toEqual({ path: '/kb', query: { collection: 'proj/docs', path: 'guide/run.md', highlight: 'ck_1' } })
    expect('name' in route).toBe(false)
  })
  it('有定位信息(PDF 页码等)原样带上', () => {
    const route = hitRoute(hit({ anchor: { kind: 'page', page: 3 } }))
    expect(JSON.parse(route.query.anchor!)).toEqual({ kind: 'page', page: 3 })
  })
  it('别人分享的文件:切到共享给我,用 space + 集合 + 路径', () => {
    expect(hitRoute(hit({ space_id: 'sp_alice', owner: alice, role: 'viewer' }))).toEqual({
      path: '/kb',
      query: { scope: 'shared', space: 'sp_alice', collection: 'proj/docs', path: 'guide/run.md' },
    })
  })
  it('别人分享的笔记:带 item 而不是 path', () => {
    const route = hitRoute(hit({ kind: 'insight', id: 'ins_9', space_id: 'sp_alice', owner: alice, role: 'editor' }))
    expect(route.query).toEqual({ scope: 'shared', space: 'sp_alice', collection: 'proj/docs', item: 'ins_9' })
    expect('path' in route.query).toBe(false)
  })
})

describe('readPrefs / changedCount', () => {
  it('没有存过 = 默认:重排开、不显示排序依据、每页 10 条', () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS).toEqual({ rerank: true, explain: false, pageSize: 10 })
  })
  it('读回存过的值', () => {
    expect(readPrefs(JSON.stringify({ rerank: false, explain: true, pageSize: 20 }))).toEqual({ rerank: false, explain: true, pageSize: 20 })
  })
  it('以前存的"返回条数"(k)在新的每页条数范围里就沿用,不在就退回默认', () => {
    expect(readPrefs(JSON.stringify({ rerank: true, explain: false, k: 20 })).pageSize).toBe(20)
    expect(readPrefs(JSON.stringify({ k: 5 })).pageSize).toBe(10)
    // 两个都有:以新的为准
    expect(readPrefs(JSON.stringify({ k: 20, pageSize: 50 })).pageSize).toBe(50)
  })
  it('坏数据逐项退回默认:不是 JSON、不是对象、类型不对、条数不在可选范围', () => {
    expect(readPrefs('not json')).toEqual(DEFAULT_PREFS)
    expect(readPrefs('[1,2]')).toEqual(DEFAULT_PREFS)
    expect(readPrefs('null')).toEqual(DEFAULT_PREFS)
    expect(readPrefs(JSON.stringify({ rerank: 'yes', explain: 1, pageSize: 7 }))).toEqual(DEFAULT_PREFS)
    // 一项坏不连累别的项
    expect(readPrefs(JSON.stringify({ rerank: false, pageSize: 999 }))).toEqual({ rerank: false, explain: false, pageSize: 10 })
  })
  it('改过几项:默认 0 项,改一项算一项;每页条数在翻页条里调,不算高级选项的改动', () => {
    expect(changedCount(DEFAULT_PREFS)).toBe(0)
    expect(changedCount({ ...DEFAULT_PREFS, explain: true })).toBe(1)
    expect(changedCount({ rerank: false, explain: true, pageSize: 50 })).toBe(2)
  })
})

describe('rerankParam:请求里怎么写重排', () => {
  it('开着(默认)不传,让服务器自己判断:没装重排模型也不会被报成"出问题"', () => {
    expect(rerankParam(DEFAULT_PREFS)).toEqual({})
  })
  it('用户关掉了才明说 false', () => {
    expect(rerankParam({ ...DEFAULT_PREFS, rerank: false })).toEqual({ rerank: false })
  })
})

describe('degradedText:降级原因写成人话', () => {
  it('没有降级:不提醒', () => {
    expect(degradedText(null)).toBeNull()
    expect(degradedText(undefined)).toBeNull()
    expect(degradedText('')).toBeNull()
  })
  it('没装重排模型:只是提示(info),说明结果照样是排好序的,不露内部代号', () => {
    const shown = degradedText('rerank_unavailable')!
    expect(shown.tone).toBe('info')
    expect(shown.text).toContain('没有启用重排模型')
    expect(shown.text).not.toContain('rerank_unavailable')
  })
  it('语义模型没就绪:提醒(warn)这次只按关键词匹配,并告诉人怎么办', () => {
    for (const code of ['embedder_loading', 'embedder_unavailable']) {
      const shown = degradedText(code)!
      expect(shown.tone, code).toBe('warn')
      expect(shown.text, code).toContain('关键词')
    }
    expect(degradedText('embedder_loading')!.text).toContain('再搜一次')
  })
  it('向量还在补建:说明这次只按关键词排,补完会更好(不露内部代号)', () => {
    const shown = degradedText('vector_pending')!
    expect(shown.tone).toBe('info')
    expect(shown.text).toContain('补建向量')
    expect(shown.text).toContain('关键词')
    expect(shown.text).not.toContain('vector_pending')
  })
  it('不认识的代号也不吞:带上代号让人能反馈', () => {
    expect(degradedText('something_new')).toEqual({ text: '这次搜索有部分功能没有生效(something_new)。', tone: 'warn' })
  })
})
