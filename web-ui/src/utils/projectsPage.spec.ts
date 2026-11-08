import { describe, expect, it } from 'vitest'
import type { JobSummary, ProjectInfo } from '@/api/client'
import {
  collectionKind,
  collectionsSummary,
  deleteCollectionMessage,
  durationText,
  embedderName,
  excludeText,
  globsText,
  hasMigrating,
  HOOKS_ENABLE_MESSAGE,
  HOOKS_MANAGED_BY_OTHER_TEXT,
  HOOKS_NOT_GIT_NOTE,
  includeText,
  indexedText,
  migrationPercent,
  modelText,
  pageSummary,
  parseGlobs,
  planRows,
  projectRows,
  projectSwitches,
  sameModel,
  sortProjects,
  statusView,
  type CollectionRow,
} from './projectsPage'

const collection = (over: Partial<CollectionRow> = {}): CollectionRow => ({
  name: 'knowledgeBase/code',
  kind: 'project',
  project_id: 'p1',
  embedder_id: 'fastembed:bge-m3-int8',
  dim: 1024,
  active_table: 'kb_code__v2',
  rows: 3112,
  migrating_to: null,
  ...over,
})
const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'j1', kind: 'migrate', collection: 'knowledgeBase/code', state: 'running', progress_done: 41, progress_total: 100, rate: null, error: null, created_at: 1, started_at: 1, finished_at: null, ...over })
const info = (name: string, last: number | null, over: Record<string, unknown> = {}): ProjectInfo =>
  ({ project: { id: name, name, slug: name, root_path: `/data/${name}`, include: [], exclude: [], is_git: true, last_commit: null, last_indexed_at: last, allow_cloud_llm: false, extract_enabled: false, hooks_installed: false, created_at: 1, ...over }, collection: name, rows: 1 }) as ProjectInfo

describe('项目', () => {
  it('最近索引过的排前面,没索引过的在最后,一样新的按名字排', () => {
    const sorted = sortProjects([info('b', null), info('a', 100), info('c', 300), info('d', 100)])
    expect(sorted.map((item) => item.project.name)).toEqual(['c', 'a', 'd', 'b'])
  })

  it('排序不改原数组', () => {
    const list = [info('b', 1), info('a', 2)]
    sortProjects(list)
    expect(list.map((item) => item.project.name)).toEqual(['b', 'a'])
  })

  it('规则输入:中英文逗号和换行都能分隔,去掉空项和首尾空格', () => {
    expect(parseGlobs('src/**, docs/**')).toEqual(['src/**', 'docs/**'])
    expect(parseGlobs('src/**，docs/**\n*.md , ')).toEqual(['src/**', 'docs/**', '*.md'])
    expect(parseGlobs('   ')).toEqual([])
    expect(parseGlobs('')).toEqual([])
    expect(globsText(['a', 'b'])).toBe('a, b')
  })

  it('没有规则时写明白意思:包含 = 全部文件,排除 = 无', () => {
    expect(includeText([])).toBe('全部文件')
    expect(excludeText([])).toBe('无')
    expect(includeText(['src/**', 'docs/**'])).toBe('src/**  docs/**')
  })

  it('卡片上的行:中文标签,没有规则时写明意思', () => {
    const rows = projectRows(info('x', 1, { include: ['src/**'], exclude: ['target/**'] }))
    expect(rows.map((row) => row.label)).toEqual(['只索引这些文件', '不索引这些文件'])
    expect(rows.map((row) => row.value)).toEqual(['src/**', 'target/**'])
    // 规则的解释每张卡片都一样,放在小节标题下面说一次(include / exclude 在那里),不在每张卡片里重复
    expect(rows.every((row) => !row.help)).toBe(true)
  })

  it('上次索引时间', () => {
    expect(indexedText(null, () => 'x')).toBe('还没有索引过')
    expect(indexedText(0, () => 'x')).toBe('还没有索引过')
    expect(indexedText(5, () => '5 分钟前')).toBe('上次索引 5 分钟前')
  })
})

describe('集合', () => {
  it('类型:代码 / 文档 / 笔记(不叫经验和 insight)/ 全局 / 外部 / 项目', () => {
    expect(collectionKind(collection({ name: 'a/code' }))).toBe('代码')
    expect(collectionKind(collection({ name: 'a/docs' }))).toBe('文档')
    expect(collectionKind(collection({ name: 'a/insights' }))).toBe('笔记')
    expect(collectionKind(collection({ name: '_global', kind: 'global' }))).toBe('全局')
    expect(collectionKind(collection({ name: '_global/外部资料', kind: 'project' }))).toBe('外部')
    expect(collectionKind(collection({ name: 'misc', kind: 'project' }))).toBe('项目')
  })

  it('索引模型去掉 fastembed: 前缀,带上向量的维数', () => {
    expect(embedderName('fastembed:bge-m3-int8')).toBe('bge-m3-int8')
    expect(embedderName('bge-m3')).toBe('bge-m3')
    expect(modelText(collection())).toBe('bge-m3-int8 · 1024 维')
  })

  it('汇总:个数和片段总数带千分位', () => {
    const list = [collection({ rows: 3112 }), collection({ name: 'b', rows: 8432 })]
    expect(collectionsSummary(list)).toBe('2 个集合 · 共 11,544 个内容片段')
    expect(collectionsSummary([])).toBe('0 个集合 · 共 0 个内容片段')
    expect(pageSummary(3, 6, 'fastembed:bge-m3-int8')).toBe('3 个项目 · 6 个集合 · 当前索引模型 bge-m3-int8')
    expect(pageSummary(0, 0, '')).toBe('0 个项目 · 0 个集合')
  })

  it('更换进度只看这个集合正在跑或排队的更换任务', () => {
    expect(migrationPercent([job()], 'knowledgeBase/code')).toBe(41)
    expect(migrationPercent([job()], 'other')).toBeNull()
    expect(migrationPercent([job({ state: 'done' })], 'knowledgeBase/code')).toBeNull()
    expect(migrationPercent([job({ state: 'queued', progress_total: null })], 'knowledgeBase/code')).toBe(0)
    expect(migrationPercent([job({ kind: 'index' })], 'knowledgeBase/code')).toBeNull()
    expect(migrationPercent([job({ progress_done: 150 })], 'knowledgeBase/code')).toBe(100)
  })

  it('状态:就绪 / 更换中 41% 并写明换成哪个模型', () => {
    expect(statusView(collection(), [])).toEqual({ text: '就绪', tone: 'success', target: '' })
    const busy = collection({ migrating_to: 'fastembed:bge-m3-q8' })
    expect(statusView(busy, [job()])).toEqual({ text: '更换中 41%', tone: 'accent', target: '换成 bge-m3-q8' })
    expect(statusView(busy, [])).toEqual({ text: '更换中', tone: 'accent', target: '换成 bge-m3-q8' })
  })

  it('有没有集合在更换', () => {
    expect(hasMigrating([collection()])).toBe(false)
    expect(hasMigrating([collection(), collection({ migrating_to: 'x' })])).toBe(true)
    expect(hasMigrating([])).toBe(false)
  })

  it('删除集合的后果写清楚:全部内容含笔记、不能恢复;笔记集合特别提醒', () => {
    expect(deleteCollectionMessage({ name: 'a/code', rows: 3112 })).toBe('集合里的全部内容(3,112 个片段,含笔记)和它的索引都会删除,不能恢复。')
    expect(deleteCollectionMessage({ name: 'a/insights', rows: 482 })).toContain('这里面的笔记也会一起删除')
    expect(deleteCollectionMessage({ name: 'a/insights', rows: 482 })).toContain('不能恢复')
  })
})

describe('更换索引模型', () => {
  it('耗时:秒 / 分秒 / 时分', () => {
    expect(durationText(0)).toBe('不到 1 秒')
    expect(durationText(0.4)).toBe('不到 1 秒')
    expect(durationText(96)).toBe('约 1 分 36 秒')
    expect(durationText(45)).toBe('约 45 秒')
    expect(durationText(3 * 3600 + 120)).toBe('约 3 小时 2 分')
    expect(durationText(-5)).toBe('不到 1 秒')
  })

  it('需要重新索引:说明要处理多少个片段、多久,用「笔记」不用 insight', () => {
    const rows = planRows({ to_table: 'x__v2', from_embedder: 'fastembed:bge-m3-int8', to_embedder: 'fastembed:bge-m3', rows: 5100, insight_rows: 390, estimated_seconds: 96, can_switch_without_reembed: false })
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]))
    expect(byKey.model!.value).toBe('bge-m3-int8 → bge-m3')
    expect(byKey.reindex).toMatchObject({ value: '需要', tone: 'warning' })
    expect(byKey.rows!.value).toBe('5,100 个片段(其中笔记 390 条)')
    expect(byKey.time!.value).toBe('约 1 分 36 秒')
    expect(byKey.table!.value).toBe('x__v2')
    expect(JSON.stringify(rows)).not.toMatch(/insight|嵌入|物理表/)
  })

  it('新旧模型兼容:不用重新索引,不再列要处理多少', () => {
    const rows = planRows({ to_table: 'x__v2', from_embedder: 'a', to_embedder: 'b', rows: 5100, estimated_seconds: 96, can_switch_without_reembed: true })
    expect(rows.map((row) => row.key)).toEqual(['model', 'reindex', 'table'])
    expect(rows.find((row) => row.key === 'reindex')).toMatchObject({ value: '不需要,切换很快', tone: 'success' })
  })

  it('估算结果缺字段不抛错,写「—」或 0', () => {
    const rows = planRows({})
    expect(rows.find((row) => row.key === 'model')!.value).toBe('— → —')
    expect(rows.find((row) => row.key === 'rows')!.value).toBe('0 个片段(其中笔记 0 条)')
    expect(rows.find((row) => row.key === 'table')!.value).toBe('—')
  })

  it('选的模型和当前一样就是不需要更换', () => {
    expect(sameModel(collection(), 'bge-m3-int8')).toBe(true)
    expect(sameModel(collection(), 'bge-m3')).toBe(false)
  })
})

describe('项目卡片上的开关', () => {
  it('AI 开着:提交后自动索引 / 允许发给云端模型 / 自动提炼,各带帮助文字,键名放在帮助文字里', () => {
    const rows = projectSwitches(info('x', 1, { hooks_installed: true, allow_cloud_llm: false, extract_enabled: true }), true)
    expect(rows.map((row) => [row.key, row.label, row.on])).toEqual([
      ['hooks', '提交后自动索引', true],
      ['cloud', '允许发给云端模型', false],
      ['extract', '自动提炼', true],
    ])
    expect(rows[1]!.help).toContain('allow_cloud_llm')
    expect(rows[2]!.help).toContain('extract_enabled')
    for (const row of rows) expect(row.label).not.toMatch(/LLM|hook/i)
  })

  it('git 仓库:提交后自动索引可用,没有说明文字', () => {
    const [hooks] = projectSwitches(info('x', 1), true)
    expect(hooks!.disabled).toBeUndefined()
    expect(hooks!.note).toBeUndefined()
  })

  it('非 git 目录:提交后自动索引置灰并写明原因;另外两个开关不受影响', () => {
    const rows = projectSwitches(info('x', 1, { is_git: false, hooks_installed: false, allow_cloud_llm: true }), true)
    expect(rows[0]).toMatchObject({ key: 'hooks', disabled: true, note: HOOKS_NOT_GIT_NOTE, on: false })
    expect(HOOKS_NOT_GIT_NOTE).toBe('这个目录不是 git 仓库,没有可装的提交钩子。')
    for (const row of rows.slice(1)) {
      expect(row.disabled).toBeUndefined()
      expect(row.note).toBeUndefined()
    }
    // AI 关闭时只剩这一行,同样置灰
    expect(projectSwitches(info('x', 1, { is_git: false }), false)[0]).toMatchObject({ disabled: true, note: HOOKS_NOT_GIT_NOTE })
  })

  it('开启前的确认文案:四个钩子名、.kb-orig 备份并链式调用、不调用大模型、首次全量扫描', () => {
    for (const name of ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite']) expect(HOOKS_ENABLE_MESSAGE).toContain(name)
    expect(HOOKS_ENABLE_MESSAGE).toContain('.kb-orig')
    expect(HOOKS_ENABLE_MESSAGE).toContain('链式调用')
    expect(HOOKS_ENABLE_MESSAGE).toContain('不调用大模型')
    expect(HOOKS_ENABLE_MESSAGE).toContain('全量扫描')
    expect(HOOKS_ENABLE_MESSAGE).not.toMatch(/AI|云端/)
  })

  it('hooks 目录被别的工具托管的提示:说明 kb 没有改动,并告诉用户怎么办', () => {
    expect(HOOKS_MANAGED_BY_OTHER_TEXT).toContain('core.hooksPath')
    expect(HOOKS_MANAGED_BY_OTHER_TEXT).toContain('kb 没有改动')
    expect(HOOKS_MANAGED_BY_OTHER_TEXT).toContain('手动加一行通知命令')
  })

  it('AI 关闭:云端模型和自动提炼两行不出现,页面任何位置没有「AI」字样', () => {
    const rows = projectSwitches(info('x', 1, { allow_cloud_llm: true, extract_enabled: true }), false)
    expect(rows.map((row) => row.key)).toEqual(['hooks'])
    expect(JSON.stringify(rows)).not.toContain('AI')
    expect(JSON.stringify(rows)).not.toContain('提炼')
    expect(JSON.stringify(rows)).not.toContain('云端')
  })
})
