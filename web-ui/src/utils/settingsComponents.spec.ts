import { describe, expect, it } from 'vitest'
import { adoptable, envRows, installFailureText, installLabel, installTone, kindLabel, kindSummary, providerActions, recsOfKinds, type Provider, type Recommendation } from './settingsComponents'

const provider = (extra: Partial<Provider> = {}): Provider => ({
  kind: 'ocr',
  id: 'rapidocr',
  name: 'RapidOCR',
  installed: false,
  ready: false,
  current: false,
  detail: null,
  model: null,
  install_command: 'rapidocr --install',
  removable: false,
  ...extra,
})

describe('providerActions', () => {
  it('OCR:没就绪且有安装命令可以下载;任何 OCR 引擎都能设为默认', () => {
    expect(providerActions(provider())).toEqual({ install: true, setDefault: true, uninstall: false })
  })

  it('已就绪:不再给「下载」', () => {
    expect(providerActions(provider({ ready: true, installed: true })).install).toBe(false)
  })

  it('没有安装命令(要手动装):不给「下载」', () => {
    expect(providerActions(provider({ install_command: null })).install).toBe(false)
  })

  it('转写:能下载,但后端不支持一键设为默认,按钮不出现', () => {
    expect(providerActions(provider({ kind: 'transcribe', id: 'whisper-cli' }))).toEqual({ install: true, setDefault: false, uninstall: false })
  })

  it('嵌入 / 重排:只读,没有任何操作(以前每行都画「设为默认」,点了只会报错)', () => {
    for (const kind of ['embed', 'rerank']) {
      expect(providerActions(provider({ kind, install_command: 'x', ready: false }))).toEqual({ install: false, setDefault: false, uninstall: false })
    }
  })

  it('卸载以后端的 removable 为准', () => {
    expect(providerActions(provider({ removable: true })).uninstall).toBe(true)
  })
})

describe('kindSummary', () => {
  it('就绪数 / 总数', () => {
    const list = [provider({ ready: true }), provider({ id: 'tesseract' }), provider({ kind: 'embed', id: 'e', ready: true })]
    expect(kindSummary(list, 'ocr')).toBe('1/2 就绪')
    expect(kindSummary(list, 'embed')).toBe('1/1 就绪')
  })

  it('已选用但没就绪:点明', () => {
    expect(kindSummary([provider({ current: true })], 'ocr')).toBe('0/1 就绪 · 已选用的后端不可用')
  })
})

describe('envRows', () => {
  it('把内存换成人话的大小,磁盘带单位', () => {
    const rows = envRows({ cpu_cores: 16, memory_mb: 64036, disk_free_gb: 412, has_nvidia: false, gpu: 'Intel 核显', has_intel_gpu: true, tools: ['git', 'ffmpeg'] })
    expect(rows).toEqual([
      { label: '处理器', value: '16 核' },
      { label: '内存', value: '62.5 GB' },
      { label: '磁盘可用', value: '412 GB' },
      { label: '显卡', value: 'Intel 核显' },
      { label: '已装工具', value: 'git · ffmpeg' },
    ])
  })

  it('没有独立显卡 / 没有工具', () => {
    const rows = envRows({ cpu_cores: 4, memory_mb: 8192, disk_free_gb: 10, has_nvidia: false, gpu: null, has_intel_gpu: false, tools: [] })
    expect(rows[3]!.value).toBe('未检测到独立显卡')
    expect(rows[4]!.value).toBe('—')
  })

  it('还没读到:全是「—」,不编数字', () => {
    expect(envRows(null).map((row) => row.value)).toEqual(['—', '—', '—', '—', '—'])
  })

  it('字段缺失(老后端):该行「—」,别的照常', () => {
    const rows = envRows({ cpu_cores: 4 } as never)
    expect(rows[0]!.value).toBe('4 核')
    expect(rows[1]!.value).toBe('—')
  })
})

describe('推荐', () => {
  const recs: Recommendation[] = [
    { kind: 'ocr', provider: 'rapidocr', reason: 'a', already_current: false },
    { kind: 'ocr', provider: 'tesseract', reason: 'b', already_current: true },
    { kind: 'transcribe', provider: 'whisper-cli', reason: 'c', already_current: false },
    { kind: 'embed', provider: 'bge', reason: 'd', already_current: false },
  ]

  it('按类别筛', () => {
    expect(recsOfKinds(recs, ['ocr', 'transcribe']).map((item) => item.provider)).toEqual(['rapidocr', 'tesseract', 'whisper-cli'])
    expect(recsOfKinds(recs, ['embed', 'rerank']).map((item) => item.provider)).toEqual(['bge'])
  })

  it('只有 OCR 里还没采用的才能一键采用(转写 / 嵌入后端不支持一键切换)', () => {
    expect(adoptable(recs).map((item) => item.provider)).toEqual(['rapidocr'])
    expect(adoptable([])).toEqual([])
  })
})

describe('下载进度', () => {
  it('状态文字和颜色', () => {
    expect(installLabel('running')).toBe('下载中')
    expect(installLabel('done')).toBe('已完成')
    expect(installLabel('failed')).toBe('失败')
    expect(installLabel('idle')).toBe('未开始')
    expect(installTone('done')).toBe('success')
    expect(installTone('failed')).toBe('danger')
    expect(installTone('running')).toBe('warning')
    expect(installTone('idle')).toBe('neutral')
  })

  it('失败:带上原因,再说怎么重试', () => {
    expect(installFailureText({ state: 'failed', lines: 3, tail: [], error: 'exit status 1', command: 'x' })).toBe('下载没有成功:exit status 1。请检查网络和磁盘空间后,点上面对应组件的「下载」重试。')
    expect(installFailureText({ state: 'failed', lines: 0, tail: [], error: null, command: '' })).toBe('下载没有成功。请检查网络和磁盘空间后,点上面对应组件的「下载」重试。')
  })

  it('类别名用术语表的说法', () => {
    expect(kindLabel('ocr')).toBe('文字识别(OCR)')
    expect(kindLabel('rerank')).toBe('重排')
    expect(kindLabel('other')).toBe('other')
  })
})
