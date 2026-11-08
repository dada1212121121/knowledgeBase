// 导入页的纯逻辑:数据来源(类型 / 状态 / 归属)与导入记录(筛选 / 内容列 / 进度)。
import { describe, expect, it } from 'vitest'
import { KIND_LABEL, SERVER_KINDS, SOURCE_FILTERS, USER_KINDS, aiStatusText, everyLabel, isServerKind, kindText, matchesFilter, normalizeWebUrl, removeSourceMessage, since, statusTag, successRate, type SourceKind } from './importSources'
import { ACTIVE_STATES, RECORD_FILTERS, contentText, countRecords, etaText, filterRecords, formatElapsed, overallPercent, parseExtractMeta, parseRecordFilter, stageDots, stateTag, type IngestFileRow } from './ingest'

const NOW = Date.UTC(2026, 9, 28, 7, 0, 0) // 上海 10-28 15:00

describe('来源归属', () => {
  it('服务器目录和 Git 归管理员,网页 / 上传 / 压缩包 / 笔记归用户;六种类型一种不漏、不重叠', () => {
    expect([...SERVER_KINDS].sort()).toEqual(['git', 'local_dir'])
    expect([...USER_KINDS].sort()).toEqual(['archive', 'note', 'upload', 'web'])
    expect(new Set([...SERVER_KINDS, ...USER_KINDS]).size).toBe(6)
    expect(Object.keys(KIND_LABEL).sort()).toEqual([...SERVER_KINDS, ...USER_KINDS].sort())
    expect(isServerKind('git')).toBe(true)
    expect(isServerKind('local_dir')).toBe(true)
    expect(isServerKind('web')).toBe(false)
    expect(isServerKind('whatever')).toBe(false)
  })
  it('本地目录对用户叫「服务器目录」(它读的是服务器上的路径)', () => {
    expect(KIND_LABEL.local_dir).toBe('服务器目录')
  })
})

describe('matchesFilter', () => {
  const kinds: SourceKind[] = ['web', 'upload', 'archive', 'note']
  it('全部放行;上传包含压缩包;网页和笔记各管各的', () => {
    expect(kinds.filter((kind) => matchesFilter({ kind }, 'all'))).toEqual(kinds)
    expect(kinds.filter((kind) => matchesFilter({ kind }, 'upload'))).toEqual(['upload', 'archive'])
    expect(kinds.filter((kind) => matchesFilter({ kind }, 'web'))).toEqual(['web'])
    expect(kinds.filter((kind) => matchesFilter({ kind }, 'note'))).toEqual(['note'])
  })
  it('筛选项不再有「本地」「Git」(那是管理组的)', () => {
    expect(SOURCE_FILTERS.map((item) => item.value)).toEqual(['all', 'web', 'upload', 'note'])
  })
})

describe('文案', () => {
  it('刷新间隔', () => {
    expect([60, 1440, 10080, 2880, 120, 45].map(everyLabel)).toEqual(['每小时', '每天', '每周', '每 2 天', '每 2 小时', '每 45 分钟'])
  })
  it('类型列带抓取深度 / 刷新策略;没有的字段不显示', () => {
    expect(kindText({ kind: 'web', depth: 2, refresh_minutes: 1440 })).toBe('网页抓取 · 深度 2 · 每天刷新')
    expect(kindText({ kind: 'web', depth: 0, refresh_minutes: null })).toBe('网页抓取')
    expect(kindText({ kind: 'git', depth: 0, refresh_minutes: 60 })).toBe('Git 仓库 · 每小时拉取')
    expect(kindText({ kind: 'local_dir', depth: 0, refresh_minutes: null })).toBe('服务器目录 · 手动同步')
    expect(kindText({ kind: 'local_dir', depth: 0, refresh_minutes: 60 })).toBe('服务器目录 · 每小时同步')
    expect(kindText({ kind: 'archive', depth: 0, refresh_minutes: null })).toBe('压缩包 · 递归解析')
    expect(kindText({ kind: 'upload', depth: 0, refresh_minutes: null })).toBe('文件上传')
    // 网页来源打开了 AI 规范化:类型列里标出来;没有这个字段(旧接口)按关
    expect(kindText({ kind: 'web', depth: 1, refresh_minutes: null, ai_extract: true })).toBe('网页抓取 · 深度 1 · AI 规范化')
    expect(kindText({ kind: 'web', depth: 1, refresh_minutes: null, ai_extract: false })).toBe('网页抓取 · 深度 1')
  })

  it('AI 规范化的整理情况:只写有的数,没跑过就是空', () => {
    expect(aiStatusText(null)).toBe('')
    expect(aiStatusText(undefined)).toBe('')
    expect(aiStatusText({ done: 3, pending: 0, failed: 0, note: null, updated_at: 1 })).toBe('已整理 3 页')
    expect(aiStatusText({ done: 1, pending: 2, failed: 1, note: '暂停', updated_at: 1 })).toBe('已整理 1 页 · 待整理 2 页 · 失败 1 页')
  })
  it('状态徽标:网页叫抓取中、其它叫同步中;出错、待同步、已同步', () => {
    expect(statusTag({ status: 'syncing', kind: 'web', last_synced_at: 1 }).text).toBe('抓取中')
    expect(statusTag({ status: 'syncing', kind: 'git', last_synced_at: 1 }).text).toBe('同步中')
    expect(statusTag({ status: 'error', kind: 'web', last_synced_at: 1 })).toEqual({ tone: 'danger', text: '出错' })
    expect(statusTag({ status: 'idle', kind: 'web', last_synced_at: null })).toEqual({ tone: 'neutral', text: '待同步' })
    expect(statusTag({ status: 'idle', kind: 'web', last_synced_at: 5 })).toEqual({ tone: 'success', text: '已同步' })
  })
  it('最近同步:各档', () => {
    const at = (offset: number) => ({ status: 'idle' as const, last_synced_at: NOW - offset })
    expect(since({ status: 'syncing', last_synced_at: null }, NOW)).toBe('进行中')
    expect(since({ status: 'idle', last_synced_at: null }, NOW)).toBe('从未同步')
    expect(since(at(10_000), NOW)).toBe('刚刚')
    expect(since(at(5 * 60_000), NOW)).toBe('5 分钟前')
    expect(since(at(2 * 3_600_000), NOW)).toBe('2 小时前')
    expect(since(at(8 * 3_600_000 - 3600_000 * 1), NOW)).toMatch(/^今天 \d\d:\d\d$|^昨天$/)
    expect(since(at(26 * 3_600_000), NOW)).toBe('昨天')
    expect(since(at(5 * 86_400_000), NOW)).toMatch(/^\d\d-\d\d$/)
  })
})

describe('successRate', () => {
  it('(总数 − 失败 − 隔离) / 总数,向下取到 0.1%:有失败时不会显示成 100%', () => {
    expect(successRate({ total: 1000, failed: 0, quarantined: 0 })).toBe('100.0%')
    expect(successRate({ total: 1000, failed: 1, quarantined: 0 })).toBe('99.9%')
    expect(successRate({ total: 3, failed: 1, quarantined: 1 })).toBe('33.3%')
  })
  it('没有文件 / 还没取到:空串,不写 NaN', () => {
    expect(successRate(null)).toBe('')
    expect(successRate({ total: 0, failed: 0, quarantined: 0 })).toBe('')
  })
})

const file = (state: IngestFileRow['state'], extra: Partial<IngestFileRow> = {}): IngestFileRow => ({
  id: `f_${state}`,
  batch_id: 'b1',
  collection: 'c',
  rel_path: 'a.pdf',
  size: 2048,
  state,
  error: null,
  chunks: 12,
  vectors: 12,
  elapsed_ms: 800,
  ...extra,
})

describe('导入记录:筛选与计数', () => {
  const files = [file('done'), file('done'), file('queued'), file('embedding'), file('failed'), file('quarantined'), file('skipped')]
  it('计数:进行中 = 排队 / 解析 / 分块 / 向量化', () => {
    expect(countRecords(files)).toEqual({ all: 7, done: 2, active: 2, failed: 1, quarantined: 1 })
    expect(ACTIVE_STATES).toEqual(['queued', 'extracting', 'chunking', 'embedding'])
  })
  it('筛选', () => {
    expect(filterRecords(files, 'all')).toHaveLength(7)
    expect(filterRecords(files, 'active').map((item) => item.state)).toEqual(['queued', 'embedding'])
    expect(filterRecords(files, 'failed')).toHaveLength(1)
    expect(filterRecords(files, 'quarantined')).toHaveLength(1)
  })
  it('地址里的 filter 只认四个值', () => {
    expect(RECORD_FILTERS.map(parseRecordFilter)).toEqual([...RECORD_FILTERS])
    expect(['bogus', '', null, undefined, 3].map(parseRecordFilter)).toEqual(['all', 'all', 'all', 'all', 'all'])
  })
})

describe('contentText', () => {
  it('失败的没有内容', () => {
    expect(contentText(file('failed'))).toBe('—')
  })
  it('需 OCR 优先于页数(图片的锚点恒为第 1 页)', () => {
    expect(contentText(file('done', { extract_meta: JSON.stringify({ needs_ocr: true, pages: 1 }) }))).toBe('需 OCR')
  })
  it('幻灯片 > 表 > 页', () => {
    expect(contentText(file('done', { extract_meta: JSON.stringify({ slides: 12, pages: 12 }) }))).toBe('12 页幻灯片')
    expect(contentText(file('done', { extract_meta: JSON.stringify({ sheets: 3 }) }))).toBe('3 表')
    expect(contentText(file('done', { extract_meta: JSON.stringify({ pages: 40 }) }))).toBe('40 页')
  })
  it('没有元信息:完成的写块数,没完成的写文件大小;元信息是坏数据当没有', () => {
    expect(contentText(file('done', { chunks: 1234 }))).toBe('1,234 块')
    expect(contentText(file('queued', { size: 2048 }))).toBe('2 KB')
    expect(contentText(file('done', { extract_meta: 'not json', chunks: 5 }))).toBe('5 块')
    expect(parseExtractMeta('[1]')).toBeNull()
    expect(parseExtractMeta(null)).toBeNull()
  })
})

describe('移除数据源提示', () => {
  it('本地目录明确说原始文件不会删除;托管副本与网页 / Git 各自说清删的是什么', () => {
    expect(removeSourceMessage('local_dir')).toContain('原始文件不会被删除')
    expect(removeSourceMessage('upload')).toContain('知识库中的文件')
    expect(removeSourceMessage('archive')).toContain('知识库中的文件')
    expect(removeSourceMessage('note')).toContain('知识库中的文件')
    expect(removeSourceMessage('git')).toContain('不会改动远端仓库')
    expect(removeSourceMessage('web')).toContain('不会改动源站')
  })
})

describe('进度', () => {
  const stages = [
    { stage: 'extract', label: '解析', files: 10, done: 10, chunks: 0, vectors: 0, percent: 100 },
    { stage: 'embed', label: '向量化', files: 10, done: 4, chunks: 0, vectors: 0, percent: 40 },
    { stage: 'searchable', label: '可检索', files: 10, done: 0, chunks: 0, vectors: 0, percent: 0 },
  ]
  it('总体进度取各阶段平均,不含「可检索」;没有阶段数据就用完成占比', () => {
    expect(overallPercent(stages, { all: 10, done: 1 })).toBe(70)
    expect(overallPercent([], { all: 10, done: 3 })).toBe(30)
    expect(overallPercent([], { all: 0, done: 0 })).toBe(0)
  })
  it('阶段圆点:全完成 / 有进展 / 没开始;不含「可检索」', () => {
    expect(stageDots(stages).map((dot) => [dot.key, dot.state, dot.text])).toEqual([
      ['extract', 'done', '10/10'],
      ['embed', 'active', '4/10'],
    ])
    expect(stageDots([{ stage: 'x', label: 'x', files: 0, done: 0, chunks: 0, vectors: 0, percent: 0 }])[0]!.state).toBe('idle')
  })
  it('剩余时间文案', () => {
    expect([null, undefined, 45, 120, 125].map(etaText)).toEqual(['', '', '45 秒', '2 分', '2 分 5 秒'])
  })
})

describe('已有小工具(此前没有测试)', () => {
  it('状态徽标', () => {
    expect(stateTag('done')).toEqual({ tone: 'success', text: '● 成功' })
    expect(stateTag('failed').tone).toBe('danger')
    expect(stateTag('quarantined').tone).toBe('warning')
    expect(stateTag('skipped')).toEqual({ tone: 'neutral', text: '跳过' })
  })
  it('耗时', () => {
    expect([null, undefined, 800, 1500].map(formatElapsed)).toEqual(['—', '—', '800 ms', '1.5 s'])
  })
})

describe('normalizeWebUrl', () => {
  it('完整的 http(s) 地址原样接受', () => {
    expect(normalizeWebUrl('https://docs.example.com/guide?a=1')).toBe('https://docs.example.com/guide?a=1')
    expect(normalizeWebUrl('  http://a.org  ')).toBe('http://a.org/')
  })
  it('没写协议的补 https://', () => {
    expect(normalizeWebUrl('docs.example.com/x')).toBe('https://docs.example.com/x')
    expect(normalizeWebUrl('example.com:8080/a')).toBe('https://example.com:8080/a')
  })
  it('不是网址的一律拒绝:空、带空白、别的协议、没有点的主机名', () => {
    for (const bad of ['', '   ', 'hello world', 'hello', 'localhost', 'ftp://a.com/x', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>', 'https://']) expect(normalizeWebUrl(bad), bad).toBeNull()
  })
})
