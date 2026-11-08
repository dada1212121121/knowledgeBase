import { describe, expect, it } from 'vitest'
import {
  extractInsightId,
  isFilePath,
  isMultiFiles,
  jobCardTimes,
  jobDetailRows,
  jobErrorSamples,
  fileChangeText,
  fileChangeTone,
  jobFileCountsText,
  jobFileSummary,
  jobTargetFiles,
  jobTargetInsight,
  type JobTimeInput,
} from './jobView'
import type { JobBrief, JobFileRow } from '@/api/jobs'

const NOW = 1_000_000_000_000
const base: JobTimeInput = { state: 'running', created_at: NOW - 600_000, started_at: NOW - 125_000, finished_at: null }
const clock = (at: number) => `T${at}`

describe('jobCardTimes(手机任务卡片的进度条与时间行)', () => {
  it('排队中:没有开始就没有进度可言,不画进度条,时间行写已等多久', () => {
    const result = jobCardTimes({ ...base, state: 'queued', started_at: null }, NOW, clock)
    expect(result.showBar).toBe(false)
    expect(result.line).toBe('排队中 · 已等 10m 0s')
    expect(result.line).not.toContain('—')
  })
  it('排队中:刚入队也说清楚,不出现负数', () => {
    expect(jobCardTimes({ ...base, state: 'queued', started_at: null, created_at: NOW + 5_000 }, NOW, clock).line).toBe('排队中 · 已等 0s')
  })
  it('运行中:画进度条,写开始时刻和耗时(算到现在,措辞与桌面表格的「耗时」列一致)', () => {
    const result = jobCardTimes(base, NOW, clock)
    expect(result.showBar).toBe(true)
    expect(result.line).toBe(`开始 T${base.started_at} · 耗时 2m 5s`)
  })
  it('已完成 / 失败 / 取消:画进度条,写开始时刻和耗时(结束时间减开始时间)', () => {
    const finished = { ...base, state: 'done' as const, finished_at: NOW - 5_000 }
    const result = jobCardTimes(finished, NOW, clock)
    expect(result.showBar).toBe(true)
    expect(result.line).toBe(`开始 T${base.started_at} · 耗时 2m 0s`)
    expect(jobCardTimes({ ...finished, state: 'failed' }, NOW, clock).line).toContain('耗时 2m 0s')
    expect(jobCardTimes({ ...finished, state: 'canceled' }, NOW, clock).line).toContain('耗时')
  })
  it('已暂停:有进度条(暂停也是开始过的)', () => {
    const result = jobCardTimes({ ...base, state: 'paused' }, NOW, clock)
    expect(result.showBar).toBe(true)
    expect(result.line).toContain('开始')
  })
  it('没开始就结束的(排队时被取消 / 失败):不画进度条,不显示"—"', () => {
    const result = jobCardTimes({ state: 'canceled', created_at: NOW - 60_000, started_at: null, finished_at: NOW - 30_000 }, NOW, clock)
    expect(result.showBar).toBe(false)
    expect(result.line).not.toContain('—')
    expect(result.line).toContain('未开始')
  })
  it('超过一小时用 h m 表示', () => {
    const result = jobCardTimes({ ...base, state: 'queued', started_at: null, created_at: NOW - 3_900_000 }, NOW, clock)
    expect(result.line).toBe('排队中 · 已等 1h 5m')
  })
})

describe('jobDetailRows(任务详情卡)', () => {
  const brief = (extra: Partial<JobBrief> = {}): JobBrief => ({
    id: 'j1',
    kind: 'index',
    collection: 'proj_a',
    state: 'done',
    progress_done: 30,
    progress_total: 30,
    rate: 2.5,
    error: null,
    created_at: NOW - 600_000,
    started_at: NOW - 125_000,
    finished_at: NOW - 5_000,
    payload: { project_id: 'p1', mode: 'incremental', paths: { total: 5000, items: ['a.rs'] } },
    checkpoint: { done: 30, total: 30, embedded: 120, deleted_chunks: 4, errors: 2, error_samples: ['a.rs: 读不出', ''] },
    ...extra,
  })
  const map = (rows: { key: string; value: string }[]) => Object.fromEntries(rows.map((row) => [row.key, row.value]))

  it('索引任务:方式、文件数(截短的数组按总数算)、进度和速率、写入 / 清掉的块、出错数、时间', () => {
    const rows = map(jobDetailRows(brief(), NOW, clock))
    expect(rows).toMatchObject({
      state: '完成',
      target: 'proj_a',
      mode: '增量 · 5000 个文件',
      progress: '30 / 30 · 2.5 块/秒',
      embedded: '120 块',
      deleted: '4 块',
      errors: '2 个',
      started: `T${NOW - 125_000}`,
      finished: `T${NOW - 5_000}`,
      took: '2m 0s',
    })
  })

  it('全量重建没有文件清单:写「整个项目」;没有的数字不占行', () => {
    const rows = map(jobDetailRows(brief({ payload: { mode: 'full', paths: [] }, checkpoint: null }), NOW, clock))
    expect(rows.mode).toBe('全量 · 整个项目')
    expect(rows).not.toHaveProperty('embedded')
    expect(rows).not.toHaveProperty('errors')
  })

  it('排队中:没有开始和耗时,写已等多久', () => {
    const rows = map(jobDetailRows(brief({ state: 'queued', started_at: null, finished_at: null, payload: null, checkpoint: null, progress_done: 0, progress_total: null }), NOW, clock))
    expect(rows.waited).toBe('10m 0s')
    expect(rows).not.toHaveProperty('took')
    expect(rows).not.toHaveProperty('progress')
    expect(rows).not.toHaveProperty('mode')
  })

  it('出错样例:去掉空的;payload 是解析不了的字符串时不报错', () => {
    expect(jobErrorSamples(brief())).toEqual(['a.rs: 读不出'])
    expect(jobErrorSamples(brief({ checkpoint: '截断的原文' }))).toEqual([])
    expect(() => jobDetailRows(brief({ payload: '截断的原文' }), NOW, clock)).not.toThrow()
  })
})

describe('jobTargetFiles & helpers', () => {
  const dummy: JobBrief = {
    id: 'j1',
    kind: 'index',
    collection: 'proj_a',
    state: 'done',
    progress_done: 1,
    progress_total: 1,
    rate: null,
    error: null,
    created_at: NOW,
    started_at: null,
    finished_at: null,
    payload: null,
    checkpoint: null,
  }

  it('从 payload.paths 或 checkpoint.paths 提取涉及文件', () => {
    expect(jobTargetFiles({ ...dummy, payload: { paths: ['src/a.ts', 'src/b.ts'] } })).toEqual(['src/a.ts', 'src/b.ts'])
    expect(jobTargetFiles({ ...dummy, payload: { paths: { total: 100, items: ['src/a.ts'] } } })).toEqual(['src/a.ts'])
    expect(jobTargetFiles({ ...dummy, payload: {}, checkpoint: { paths: ['docs/readme.md'] } })).toEqual(['docs/readme.md'])
    expect(jobTargetFiles({ ...dummy, payload: { path: 'single/file.md' } })).toEqual(['single/file.md'])
    expect(jobTargetFiles({ ...dummy, payload: null })).toEqual([])
  })

  it('识别笔记任务与提取 id', () => {
    expect(jobTargetInsight({ ...dummy, payload: { insight_id: 'in_xyz' } })).toBe('in_xyz')
    expect(jobTargetInsight({ ...dummy, payload: null })).toBeNull()
    expect(extractInsightId('笔记 in_xyz')).toBe('in_xyz')
    expect(extractInsightId('笔记 in-123_abc')).toBe('in-123_abc')
    expect(extractInsightId('全量索引')).toBeNull()
  })

  it('文件路径与多文件匹配判断', () => {
    expect(isFilePath('crates/kb-cli/src/main.rs')).toBe(true)
    expect(isFilePath('README.md')).toBe(true)
    expect(isFilePath('3 个文件 (a.rs 等)')).toBe(false)
    expect(isFilePath('笔记 in_123')).toBe(false)
    expect(isFilePath('全量索引')).toBe(false)
    expect(isFilePath('批次 b_123')).toBe(false)
    // 任务详情里不是路径的描述不能被当成文件:git 区间、评测摘要(结尾的 .HEAD / .927 长得像扩展名)、带空格的一句话
    expect(isFilePath('diff 3da960b..HEAD')).toBe(false)
    expect(isFilePath('diff origin/main..HEAD')).toBe(false)
    expect(isFilePath('hit@5 1.00 · MRR 0.927')).toBe(false)
    expect(isFilePath('+214 −18 文件')).toBe(false)
    expect(isFilePath('2 候选 · 1 skipped_fingerprint')).toBe(false)
    expect(isFilePath('eval/kb-core.jsonl')).toBe(true)
    expect(isFilePath('docs/My Notes/第一章.md')).toBe(true)
    expect(isFilePath('Makefile.am')).toBe(true)
    expect(isFilePath('backup.7z')).toBe(true)

    expect(isMultiFiles('3 个文件 (a.rs 等)')).toBe(true)
    expect(isMultiFiles('crates/kb-cli/src/main.rs')).toBe(false)
  })
})

describe('job_files(改动的文件)的显示文案', () => {
  const file = (patch: Partial<JobFileRow>): JobFileRow => ({
    path: 'src/a.rs',
    change: 'update',
    chunks: 0,
    meta_chunks: 0,
    deleted_chunks: 0,
    error: null,
    done_at: 0,
    ...patch,
  })

  it('变化类型:中文名和徽标色调,未知类型不显示空白', () => {
    expect(['new', 'update', 'meta', 'delete', 'skip', 'error'].map((change) => fileChangeText(change))).toEqual([
      '新增',
      '更新',
      '只改元数据',
      '删除',
      '未变化',
      '失败',
    ])
    expect(fileChangeTone('error')).toBe('danger')
    expect(fileChangeTone('new')).toBe('success')
    expect(fileChangeTone('以后新增的类型')).toBe('neutral')
    expect(fileChangeText('以后新增的类型')).toBe('以后新增的类型')
  })

  it('一行摘要只写真的写过的块;未变化和失败用固定文案', () => {
    expect(jobFileSummary(file({ chunks: 12 }))).toBe('写入 12 块')
    expect(jobFileSummary(file({ chunks: 3, meta_chunks: 2, deleted_chunks: 1 }))).toBe('写入 3 块 · 元数据 2 块 · 删除 1 块')
    expect(jobFileSummary(file({ change: 'meta', meta_chunks: 4 }))).toBe('元数据 4 块')
    expect(jobFileSummary(file({ change: 'delete', deleted_chunks: 9 }))).toBe('删除 9 块')
    expect(jobFileSummary(file({ change: 'skip' }))).toBe('内容未变')
    expect(jobFileSummary(file({ change: 'error', error: 'permission denied' }))).toBe('处理失败')
  })

  it('统计只列出现过的类型,顺序固定;空统计是空串', () => {
    expect(jobFileCountsText({ update: 12, new: 3, error: 1 })).toBe('新增 3 · 更新 12 · 失败 1')
    expect(jobFileCountsText({ skip: 2, delete: 1, meta: 5 })).toBe('只改元数据 5 · 删除 1 · 未变化 2')
    expect(jobFileCountsText({ new: 0 })).toBe('')
    expect(jobFileCountsText(null)).toBe('')
  })
})
