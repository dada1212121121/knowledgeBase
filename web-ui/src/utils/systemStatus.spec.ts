import { describe, expect, it } from 'vitest'
import {
  attentionNotes,
  blockReady,
  bytesText,
  clockText,
  componentState,
  cpuRows,
  diskRows,
  envRows,
  countOf,
  gbText,
  gpuRows,
  groupComponents,
  hostsText,
  ingestRows,
  ingestStateText,
  isAiJob,
  isAiKind,
  jobKindText,
  jobStateRows,
  jobStateText,
  jobStateTone,
  kindInfo,
  levelName,
  llmRows,
  levelOf,
  mbText,
  memoryRows,
  networkRows,
  notReadyNote,
  parseLogLine,
  ratioText,
  readyCount,
  recentProblems,
  scaleRows,
  serviceRows,
  tabFromQuery,
  tailLines,
  totalOf,
  transportText,
  uptimeText,
  visibleComponents,
  wanText,
  type Provider,
  type SystemSnapshot,
} from './systemStatus'

const provider = (over: Partial<Provider> = {}): Provider => ({ kind: 'embed', id: 'bge-m3', name: 'bge-m3', installed: true, ready: true, current: true, detail: null, model: null, ...over })

const FULL: SystemSnapshot = {
  overview: { service: { version: '0.4.0', uptime_seconds: 10 } },
  resources: { cpu: { cores: 8, busy_ratio: 0.2, load: [1, 1, 1] }, memory: { total_mb: 100, available_mb: 50, used_ratio: 0.5 }, disk: { mount: '/', free_gb: 1, total_gb: 2, used_ratio: 0.5 }, gpu: {} },
  components: [provider()],
  env: { cpu_cores: 8 },
  jobs: { by_state: [['done', 3]], recent: [], ingest: [] },
  network: { listen: '127.0.0.1:7878' },
  logs: { dir: '/x', files: [], tail: [] },
}

describe('blockReady · 各块是否读到', () => {
  it('完整数据:每一块都读到了', () => {
    for (const key of ['overview', 'network', 'resources', 'env', 'components', 'jobs', 'logs'] as const) expect(blockReady(FULL, key), key).toBe(true)
  })

  it('一块缺了只影响它自己', () => {
    const broken: SystemSnapshot = { ...FULL, logs: undefined }
    expect(blockReady(broken, 'logs')).toBe(false)
    for (const key of ['overview', 'network', 'resources', 'env', 'components', 'jobs'] as const) expect(blockReady(broken, key), key).toBe(true)
  })

  it('形状不对也算没读到(例如 null、字段不是数组)', () => {
    expect(blockReady({ ...FULL, jobs: { by_state: [], recent: null as never, ingest: [] } }, 'jobs')).toBe(false)
    expect(blockReady({ ...FULL, components: null as never }, 'components')).toBe(false)
    expect(blockReady({ ...FULL, resources: { cpu: {}, memory: {} } }, 'resources')).toBe(false)
    expect(blockReady({ ...FULL, overview: { collections: 3 } }, 'overview')).toBe(false)
    expect(blockReady({ ...FULL, logs: { files: [], tail: 'x' as never } }, 'logs')).toBe(false)
  })

  it('还没有数据时每一块都是没读到', () => {
    expect(blockReady(null, 'overview')).toBe(false)
    expect(blockReady({}, 'network')).toBe(false)
  })
})

describe('页签', () => {
  it('旧的 overview / network 并入「服务」,认不出的取值回到第一页', () => {
    expect(tabFromQuery('overview')).toBe('service')
    expect(tabFromQuery('network')).toBe('service')
    expect(tabFromQuery('resources')).toBe('resources')
    expect(tabFromQuery('logs')).toBe('logs')
    expect(tabFromQuery('nope')).toBe('service')
    expect(tabFromQuery(undefined)).toBe('service')
    expect(tabFromQuery(['logs'])).toBe('service')
  })
})

describe('数字的写法', () => {
  it('运行时长:分钟 / 时分 / 天时', () => {
    expect(uptimeText(null)).toBe('—')
    expect(uptimeText(undefined)).toBe('—')
    expect(uptimeText(-1)).toBe('—')
    expect(uptimeText(59)).toBe('0 分钟')
    expect(uptimeText(45 * 60)).toBe('45 分钟')
    expect(uptimeText(3600 + 5 * 60)).toBe('1 小时 5 分')
    expect(uptimeText(23 * 3600 + 59 * 60)).toBe('23 小时 59 分')
    expect(uptimeText(3 * 86400 + 4 * 3600 + 600)).toBe('3 天 4 小时')
  })

  it('百分比不带小数,取不到显示「—」', () => {
    expect(ratioText(0.78)).toBe('78%')
    expect(ratioText(0.785)).toBe('79%')
    expect(ratioText(0)).toBe('0%')
    expect(ratioText(null)).toBe('—')
    expect(ratioText(undefined)).toBe('—')
    expect(ratioText(Number.NaN)).toBe('—')
  })

  it('大小:单位前留空格,不到 1 GB 写 MB', () => {
    expect(mbText(512)).toBe('512 MB')
    expect(mbText(1024)).toBe('1.0 GB')
    expect(mbText(32768)).toBe('32.0 GB')
    expect(mbText(null)).toBe('—')
    expect(gbText(22)).toBe('22 GB')
    expect(gbText(22.54)).toBe('22.5 GB')
    expect(gbText(undefined)).toBe('—')
    expect(bytesText(512)).toBe('512 B')
    expect(bytesText(2048)).toBe('2 KB')
    expect(bytesText(5 * 1024 ** 2)).toBe('5.0 MB')
  })

  it('大数:一万以上写「万」,以下写千分位', () => {
    expect(wanText(182_000)).toBe('18.2 万')
    expect(wanText(9_999)).toBe('9,999')
    expect(wanText(0)).toBe('0')
  })

  it('时钟', () => {
    expect(clockText(Date.UTC(2026, 9, 19, 19, 4, 5))).toBe('03:04:05') // 上海 10-20 03:04:05
  })
})

describe('资源水位', () => {
  it('80% 起偏高,90% 起快满了(和头像上的小圆点同一条线)', () => {
    expect(levelOf(0.5)).toBe('ok')
    expect(levelOf(0.79)).toBe('ok')
    expect(levelOf(0.8)).toBe('high')
    expect(levelOf(0.89)).toBe('high')
    expect(levelOf(0.9)).toBe('full')
    expect(levelOf(1)).toBe('full')
    expect(levelOf(null)).toBe('ok')
  })
})

describe('任务', () => {
  it('状态和类型写中文,不认识的原样显示', () => {
    expect(jobStateText('queued')).toBe('排队')
    expect(jobStateText('paused')).toBe('已暂停')
    expect(jobStateText('weird')).toBe('weird')
    expect(jobKindText('index')).toBe('索引')
    expect(jobKindText('migrate')).toBe('更换索引模型')
    expect(jobKindText('custom_kind')).toBe('custom_kind')
    expect(ingestStateText('embedding')).toBe('建立索引')
    expect(ingestStateText('quarantined')).toBe('已隔离')
  })

  it('状态徽标颜色:运行中强调、失败红、完成绿,其余中性', () => {
    expect(jobStateTone('running')).toBe('accent')
    expect(jobStateTone('failed')).toBe('danger')
    expect(jobStateTone('done')).toBe('success')
    expect(jobStateTone('queued')).toBe('neutral')
  })

  it('自动提炼 / 审核类的任务算 AI 相关', () => {
    expect(isAiJob('evolve')).toBe(true)
    expect(isAiJob('extract')).toBe(true)
    expect(isAiJob('review')).toBe(true)
    expect(isAiJob('index')).toBe(false)
    expect(isAiJob('backup')).toBe(false)
  })

  it('各状态的数量:没有的状态算 0', () => {
    const pairs: [string, number][] = [['done', 42], ['queued', 2]]
    expect(countOf(pairs, 'queued')).toBe(2)
    expect(countOf(pairs, 'failed')).toBe(0)
    expect(countOf(undefined, 'failed')).toBe(0)
    expect(totalOf(pairs)).toBe(44)
    expect(totalOf(undefined)).toBe(0)
  })
})

describe('组件', () => {
  it('种类写中文名并带一句说明,不认识的原样显示', () => {
    expect(kindInfo('rerank').label).toBe('重排模型')
    expect(kindInfo('embed').label).toBe('索引模型')
    expect(kindInfo('ocr').label).toContain('OCR')
    expect(kindInfo('future').label).toBe('future')
    expect(kindInfo('future').help).toBe('')
    for (const kind of ['ocr', 'transcribe', 'embed', 'rerank', 'llm', 'review', 'sidecar']) expect(kindInfo(kind).help.length, kind).toBeGreaterThan(6)
  })

  it('AI 关闭时,云端模型和审核模型不出现,其余照常', () => {
    const all = [provider(), provider({ kind: 'rerank', id: 'rr' }), provider({ kind: 'llm', id: 'ds' }), provider({ kind: 'review', id: 'qw' }), provider({ kind: 'sidecar', id: 'onnx' })]
    expect(visibleComponents(all, true)).toHaveLength(5)
    expect(visibleComponents(all, false).map((item) => item.kind)).toEqual(['embed', 'rerank', 'sidecar'])
    expect(visibleComponents(undefined, true)).toEqual([])
    expect(isAiKind('llm')).toBe(true)
    expect(isAiKind('rerank')).toBe(false)
  })

  it('按种类分组,常见种类固定在前', () => {
    const groups = groupComponents([provider({ kind: 'sidecar', id: 'a' }), provider({ kind: 'rerank', id: 'b' }), provider({ kind: 'ocr', id: 'c' }), provider({ kind: 'zzz', id: 'd' }), provider({ kind: 'embed', id: 'e' }), provider({ kind: 'ocr', id: 'f' })])
    expect(groups.map(([kind]) => kind)).toEqual(['ocr', 'embed', 'rerank', 'sidecar', 'zzz'])
    expect(groups[0]![1].map((item) => item.id)).toEqual(['c', 'f'])
  })

  it('状态:就绪 / 未就绪(装了但不能用) / 未安装', () => {
    expect(componentState({ installed: true, ready: true })).toEqual({ text: '就绪', tone: 'success' })
    expect(componentState({ installed: true, ready: false })).toEqual({ text: '未就绪', tone: 'warning' })
    expect(componentState({ installed: false, ready: false })).toEqual({ text: '未安装', tone: 'danger' })
  })

  it('就绪数与没就绪的说明', () => {
    const list = [provider(), provider({ ready: false, installed: false, kind: 'ocr', id: 'rapidocr', name: 'RapidOCR' })]
    expect(readyCount(list)).toEqual([1, 2])
    expect(notReadyNote(list)).toBe('有 1 个组件没有就绪:RapidOCR(文字识别(OCR),未安装)。')
    expect(notReadyNote([provider()])).toBeNull()
    expect(readyCount([])).toEqual([0, 0])
  })
})

describe('网络', () => {
  it('传输方式写人话,主机名单为空说明只允许本机', () => {
    expect(transportText('stdio')).toBe('本机进程(stdio)')
    expect(transportText('http')).toBe('网络请求(http)')
    expect(transportText('ws')).toBe('ws')
    expect(hostsText([])).toBe('只允许本机访问')
    expect(hostsText(undefined)).toBe('只允许本机访问')
    expect(hostsText(['a.example.com', 'b.example.com'])).toBe('a.example.com、b.example.com')
  })
})

describe('日志', () => {
  it('拆出时间 / 级别 / 正文,带颜色码和日期前缀也行', () => {
    expect(parseLogLine('00:22:04 INFO  reindex start')).toEqual({ time: '00:22:04', level: 'INFO', text: 'reindex start' })
    expect(parseLogLine('2026-10-20T00:23:40.123Z WARN chunk truncated')).toEqual({ time: '00:23:40', level: 'WARN', text: 'chunk truncated' })
    expect(parseLogLine('\u001b[2m00:23:40\u001b[0m ERROR boom')).toMatchObject({ level: 'ERROR', text: 'boom' })
    expect(parseLogLine('stack frame #1')).toEqual({ time: '', level: '', text: 'stack frame #1' })
  })

  it('最近的警告和错误只看解析出来的级别,正文里碰巧有 WARN 的不算', () => {
    const tail = ['00:00:01 INFO  ok', '00:00:02 WARN  slow', '00:00:03 INFO  mentions WARN in text', '00:00:04 ERROR failed', 'free text with ERROR inside']
    expect(recentProblems(tail).map((line) => `${line.level}:${line.text}`)).toEqual(['WARN:slow', 'ERROR:failed'])
  })

  it('最多取最近 6 条;没有日志不出错', () => {
    const tail = Array.from({ length: 9 }, (_, index) => `00:00:0${index} WARN  w${index}`)
    expect(recentProblems(tail).map((line) => line.text)).toEqual(['w3', 'w4', 'w5', 'w6', 'w7', 'w8'])
    expect(recentProblems(undefined)).toEqual([])
    expect(recentProblems([])).toEqual([])
  })

  it('级别用中文名,尾部取最近若干行', () => {
    expect(levelName('ERROR')).toBe('错误')
    expect(levelName('WARN')).toBe('警告')
    expect(levelName('INFO')).toBe('信息')
    expect(levelName('FATAL')).toBe('FATAL')
    const tail = Array.from({ length: 100 }, (_, index) => `00:00:00 INFO  line${index}`)
    expect(tailLines(tail, 5).map((line) => line.text)).toEqual(['line95', 'line96', 'line97', 'line98', 'line99'])
    expect(tailLines(undefined)).toEqual([])
  })
})

describe('各卡片的行:中文标签 + 帮助文字,键名放在帮助文字里', () => {
  const snapshot: SystemSnapshot = {
    ...FULL,
    overview: { service: { version: '0.4.0', uptime_seconds: 3 * 86400 + 4 * 3600, home: '/data/kb' }, collections: 7, projects: 3, sources: 12_000 },
    resources: {
      cpu: { cores: 8, busy_ratio: 0.214, load: [0.8, 0.7, 0.6] },
      memory: { total_mb: 32768, available_mb: 18000, used_ratio: 0.45 },
      disk: { mount: '/data', free_gb: 22, total_gb: 100, used_ratio: 0.78 },
      gpu: { name: null, utilization: null, memory_used_mb: null, note: '未采集' },
    },
    network: { listen: '127.0.0.1:7878', socket: '/run/kb.sock', allow_remote: false, mcp_transports: ['stdio', 'http'], mcp_allowed_hosts: [], llm_calls_today: 18, llm_tokens_today: [182_000, 41_000] },
    env: { has_nvidia: false, has_intel_gpu: true, tools: ['git', 'node'] },
  }
  const byKey = (rows: { key: string; value: string }[]) => Object.fromEntries(rows.map((row) => [row.key, row.value]))

  it('服务与规模', () => {
    expect(byKey(serviceRows(snapshot))).toEqual({ version: '0.4.0', uptime: '3 天 4 小时', home: '/data/kb' })
    expect(byKey(scaleRows(snapshot))).toEqual({ collections: '7 个', projects: '3 个', sources: '12,000 个' })
    expect(serviceRows(snapshot).find((row) => row.key === 'home')!.help).toContain('KB_HOME')
  })

  it('缺字段时显示「—」或 0,不编数字也不抛错', () => {
    expect(byKey(serviceRows({ overview: { service: {} } }))).toEqual({ version: '—', uptime: '—', home: '—' })
    expect(byKey(scaleRows({}))).toEqual({ collections: '0 个', projects: '0 个', sources: '0 个' })
    expect(byKey(networkRows({}))).toMatchObject({ listen: '—', socket: '—', transports: '—', hosts: '只允许本机访问' })
    expect(byKey(cpuRows({}))).toEqual({ cores: '—', busy: '—', load: '—' })
    expect(byKey(memoryRows({}))).toEqual({ used: '—', available: '—', total: '—' })
    expect(byKey(diskRows({}))).toEqual({ mount: '—', used: '—', free: '— / —' })
  })

  it('网络:远程访问关闭是绿色「已关闭」,开启是黄色「已开启」;文字本身就说明状态', () => {
    const off = networkRows(snapshot).find((row) => row.key === 'remote')!
    expect(off).toMatchObject({ value: '已关闭', tone: 'success' })
    const on = networkRows({ network: { ...snapshot.network, allow_remote: true } }).find((row) => row.key === 'remote')!
    expect(on).toMatchObject({ value: '已开启', tone: 'warning' })
    expect(byKey(networkRows(snapshot)).transports).toBe('本机进程(stdio)、网络请求(http)')
    expect(networkRows(snapshot).find((row) => row.key === 'hosts')!.help).toContain('mcp.allowed_hosts')
  })

  it('云端模型用量用「额度」,大数写万,不出现 token', () => {
    const rows = llmRows(snapshot)
    expect(byKey(rows)).toEqual({ calls: '18 次', quota: '输入 18.2 万 · 输出 4.1 万' })
    expect(JSON.stringify(rows)).not.toMatch(/token/i)
    expect(JSON.stringify(rows)).not.toContain('AI')
  })

  it('资源:百分比不带小数,负载三个数', () => {
    expect(byKey(cpuRows(snapshot))).toEqual({ cores: '8 核', busy: '21%', load: '0.80 / 0.70 / 0.60' })
    expect(byKey(memoryRows(snapshot))).toEqual({ used: '45%', available: '17.6 GB', total: '32.0 GB' })
    expect(byKey(diskRows(snapshot))).toEqual({ mount: '/data', used: '78%', free: '22 GB / 100 GB' })
  })

  it('显卡:后端没有采集的字段写「未采集」,而不是编一个数', () => {
    expect(byKey(gpuRows(snapshot))).toEqual({ name: '没有检测到独立显卡', utilization: '未采集', memory: '未采集' })
    const withGpu = gpuRows({ resources: { ...snapshot.resources, gpu: { name: 'Intel Iris Xe', utilization: 0.38, memory_used_mb: 512 } } })
    expect(byKey(withGpu)).toEqual({ name: 'Intel Iris Xe', utilization: '38%', memory: '512 MB' })
  })

  it('运行环境', () => {
    const rows = envRows(snapshot)
    expect(rows.find((row) => row.key === 'intel')).toMatchObject({ value: '可用', tone: 'success' })
    expect(rows.find((row) => row.key === 'nvidia')).toMatchObject({ value: '未检测到', tone: 'neutral' })
    expect(byKey(rows).tools).toBe('git、node')
  })

  it('任务队列:失败数大于 0 用红色、运行中用强调色;0 不着色', () => {
    const rows = jobStateRows([['done', 42], ['queued', 2], ['running', 1], ['failed', 1], ['canceled', 0]])
    expect(rows.map((row) => row.label)).toEqual(['完成', '排队', '运行中', '失败', '已取消'])
    expect(rows.find((row) => row.key === 'failed')!.tone).toBe('danger')
    expect(rows.find((row) => row.key === 'running')!.tone).toBe('accent')
    expect(rows.find((row) => row.key === 'done')!.tone).toBeUndefined()
    expect(jobStateRows([['failed', 0]])[0]!.tone).toBeUndefined()
    expect(jobStateRows(undefined)).toEqual([])
  })

  it('导入队列只列有文件的状态,失败 / 隔离用红色;全是 0 返回空', () => {
    const rows = ingestRows([['queued', 0], ['embedding', 3], ['done', 120], ['failed', 2], ['quarantined', 1]])
    expect(rows.map((row) => `${row.label}${row.value}`)).toEqual(['建立索引3', '完成120', '失败2', '已隔离1'])
    expect(rows.filter((row) => row.tone === 'danger').map((row) => row.key)).toEqual(['failed', 'quarantined'])
    expect(ingestRows([['queued', 0], ['done', 0]])).toEqual([])
    expect(ingestRows(undefined)).toEqual([])
  })
})

describe('需要注意', () => {
  it('组件没就绪、磁盘偏紧、有失败任务,各说一句', () => {
    const notes = attentionNotes(
      {
        ...FULL,
        components: [provider({ ready: false, installed: false, kind: 'ocr', id: 'rapidocr', name: 'RapidOCR' })],
        resources: { ...FULL.resources, disk: { mount: '/', free_gb: 5, total_gb: 100, used_ratio: 0.93 } },
        jobs: { by_state: [['failed', 2]], recent: [], ingest: [] },
      },
      true,
    )
    expect(notes).toHaveLength(3)
    expect(notes[0]).toContain('RapidOCR')
    expect(notes[1]).toBe('磁盘已用 93%,快满了,请尽快清理或扩容。')
    expect(notes[2]).toBe('有 2 个任务失败了,可以到「任务」页查看原因。')
  })

  it('磁盘 80%–90% 说空间偏紧;低于 80% 不说', () => {
    const disk = (used_ratio: number): SystemSnapshot => ({ ...FULL, resources: { ...FULL.resources, disk: { mount: '/', free_gb: 20, total_gb: 100, used_ratio } } })
    expect(attentionNotes(disk(0.85), true).join('')).toContain('空间偏紧')
    expect(attentionNotes(disk(0.79), true)).toEqual([])
  })

  it('AI 关闭时,云端模型 / 审核模型没就绪不提;没有 AI 之外的问题就什么都不说', () => {
    const snapshot: SystemSnapshot = { ...FULL, components: [provider(), provider({ kind: 'llm', id: 'ds', name: 'deepseek-chat', ready: false, installed: false })] }
    expect(attentionNotes(snapshot, true).join('')).toContain('deepseek-chat')
    expect(attentionNotes(snapshot, false)).toEqual([])
  })

  it('某一块没读到就不参与:组件块没读到时退回服务端给的一句话(AI 开着时)', () => {
    const snapshot: SystemSnapshot = { ...FULL, components: undefined, overview: { service: {}, note: '不可用组件:rapidocr' } }
    expect(attentionNotes(snapshot, true)).toEqual(['不可用组件:rapidocr'])
    expect(attentionNotes(snapshot, false)).toEqual([])
    expect(attentionNotes({ ...FULL, jobs: undefined, resources: undefined }, true)).toEqual([])
    expect(attentionNotes(null, true)).toEqual([])
  })
})
