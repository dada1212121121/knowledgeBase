// 「备份」分区:四种状态、事实行(上次 / 下次 / 校验 / 目录)、策略只说一遍、立即备份(含失败常驻)、
// 打包进度的兜底轮询、已有备份(校验结果留在行里、删除 / 清理要确认)、异地副本现状、恢复步骤默认折起。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: vi.fn() }))
const confirmState = vi.hoisted(() => ({ answer: true, calls: [] as { title: string; message?: string; tone?: string }[] }))
vi.mock('@kb-ui/index', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirm: () => ({
    ask: async (options: { title: string; message?: string; tone?: string; action?: () => Promise<unknown> }) => {
      confirmState.calls.push(options)
      if (!confirmState.answer) return false
      await options.action?.()
      return true
    },
  }),
}))
import { toasts } from '@kb-ui/components/useToast'

import { CapabilityError } from '@/api/client'
import { BACKUP_SETTLED_EVENT } from '@/utils/backup'
import { toDraft } from '@/utils/settingsFields'
import BackupSection from './BackupSection.vue'

const NOW = Date.UTC(2026, 9, 20, 16, 42, 0)
const HOUR = 3_600_000
const STATUS = {
  home: '/home/kb/.kb',
  dir: '/home/kb/.kb/backups',
  last_backup_at: NOW - 26 * HOUR,
  policy: { enabled: true, interval_hours: 24, keep_count: 7, keep_days: 0, include_sources: false, mirror_dirs: ['/mnt/usb/kb-backups', '/mnt/nas/kb-offsite'] },
  next_backup_at: NOW + 22 * HOUR,
  last_auto: { at: NOW - 26 * HOUR, ok: true, error: null },
  progress: null,
  alert: null,
  failures: [],
  mirrors: [
    { dir: '/mnt/usb/kb-backups', last_ok_at: NOW - 26 * HOUR, last_error: null, error_at: 0, copies: 3, has_latest: true },
    { dir: '/mnt/nas/kb-offsite', last_ok_at: NOW - 50 * HOUR, last_error: '建目录 /mnt/nas/kb-offsite 失败: No such file or directory', error_at: NOW - 26 * HOUR, copies: 1, has_latest: false },
  ],
  last_check: { at: NOW - 26 * HOUR, name: 'kb-20261019-004200.tar.gz', ok: true, error: null, files: 12, uncompressed_bytes: 15_728_640, meta_db_bytes: 12_582_912 },
  usage: { meta_db_bytes: 12_582_912, lance_bytes: 1_073_741_824, sources_bytes: 268_435_456, uploads_bytes: 0, skills_bytes: 4096, eval_bytes: 131_072, config_bytes: 3072, backups_bytes: 18_874_368 },
  entries: [
    { name: 'kb-20261019-004200.tar.gz', size_bytes: 14_680_064, created_at: NOW - 26 * HOUR },
    { name: 'kb-20261017-213015.tar.gz', size_bytes: 4_194_304, created_at: NOW - 74 * HOUR },
  ],
  notes: ['备份内容:元数据库、config.toml、skills、评测数据;原件(sources)可选'],
}
const CONFIG = { backup: STATUS.policy }

let status: Record<string, unknown> = {}
let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}, tweak: Record<string, unknown> = {}) {
  status = { ...structuredClone(STATUS), ...tweak }
  replies = {
    backup_status: () => structuredClone(status),
    backup_state: { running: null },
    backup_create: { name: 'kb-20261020-004200.tar.gz', size_bytes: 15_728_640, created_at: NOW, skipped: 0 },
    backup_delete: { deleted: 'x' },
    backup_prune: { removed: ['kb-20261017-213015.tar.gz'], kept: 1, failed: [] },
    backup_verify: { name: 'x', size_bytes: 1, created_at: 1, version: '1', include_sources: false, files: 12, uncompressed_bytes: 15_728_640, meta_db_bytes: 12_582_912, config_present: true, skipped: [], roots: [] },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string, args?: unknown) => {
    const reply = replies[name]
    if (typeof reply === 'function') return (reply as (a: unknown) => unknown)(args)
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const byId = (id: string) => $<HTMLButtonElement>(`[data-testid=${id}]`)!
const text = () => document.body.textContent ?? ''
const rowOf = (name: string) => $$('[data-testid=rt-row]').find((el) => el.textContent!.includes(name))!

let wrapper: VueWrapper | null = null
let updates: [string, string | boolean][] = []
async function open(props: { policyUnsaved?: boolean; savedTick?: number } = {}) {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  updates = []
  wrapper = mount(BackupSection, {
    attachTo: document.body,
    props: { aiOn: true, draft: toDraft(CONFIG), errors: {}, policyUnsaved: props.policyUnsaved ?? false, savedTick: props.savedTick ?? 0, onUpdate: (path: string, value: string | boolean) => updates.push([path, value]) },
  })
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  confirmState.answer = true
  confirmState.calls = []
  toasts.splice(0)
  backend()
})
afterEach(() => vi.useRealTimers())

describe('备份 · 四种状态', () => {
  it('加载中:骨架屏;策略和异地目录的设置照样在', async () => {
    backend({ backup_status: () => new Promise(() => undefined) })
    await open()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect($('[data-testid=backup-card]')).toBeNull()
    expect($('[data-field="backup.interval_hours"]')).not.toBeNull()
  })

  it('读取失败:原因 + 重试(以前被吞掉,页面显示“还没有备份”),设置照样能改', async () => {
    let fail = true
    backend({
      backup_status: () => {
        if (fail) throw new CapabilityError('归档目录读不了', 'internal', 500)
        return structuredClone(status)
      },
    })
    await open()
    expect($('[data-testid=admin-error]')!.textContent).toContain('读取备份信息失败:归档目录读不了')
    expect(text()).not.toContain('还没有备份')
    expect($('[data-field="backup.keep_count"] input')).not.toBeNull()
    fail = false
    $('[data-testid=admin-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=backup-card]')).not.toBeNull()
  })

  it('没有开通(403):只说没开通', async () => {
    backend({ backup_status: new CapabilityError('forbidden', 'forbidden', 403) })
    await open()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
  })

  it('空:没有备份时给下一步', async () => {
    backend({}, { entries: [], last_backup_at: null, last_check: null, last_auto: null })
    await open()
    expect($('[data-testid=backup-entries]')!.textContent).toContain('还没有备份。点上面的「立即备份」做第一份。')
    expect(byId('backup-last').textContent).toBe('还没有备份')
  })
})

describe('备份 · 状态卡', () => {
  it('事实行:上次 / 下次定时 / 上次定时备份 / 最近校验 / 归档目录', async () => {
    await open()
    expect(byId('backup-last').textContent).toContain('2026/10/')
    expect(byId('backup-next').textContent).toContain('2026/10/')
    expect(byId('backup-last-auto').textContent).toContain('成功')
    expect(byId('backup-last-check').textContent).toContain('通过')
    expect(byId('backup-last-check').textContent).toContain('12 个文件')
    expect(byId('backup-dir').textContent).toBe('/home/kb/.kb/backups')
  })

  it('定时备份关了:下次写“已关闭”', async () => {
    backend({}, { policy: { ...STATUS.policy, enabled: false }, next_backup_at: null })
    await open()
    expect(byId('backup-next').textContent).toBe('定时备份已关闭')
  })

  it('上次定时备份失败:红色徽标 + 原因;最近校验没通过也一样', async () => {
    backend({}, { last_auto: { at: NOW, ok: false, error: '磁盘已满' }, last_check: { ...STATUS.last_check, ok: false, error: 'manifest 缺失' } })
    await open()
    expect(byId('backup-last-auto').textContent).toContain('失败')
    expect(byId('backup-last-auto').textContent).toContain('磁盘已满')
    expect(byId('backup-last-check').textContent).toContain('没通过')
    expect(byId('backup-last-check').textContent).toContain('manifest 缺失')
  })

  it('策略只说一遍:“每 24 小时备份一次”和“保留策略”各出现一次(以前三处各说一遍)', async () => {
    await open()
    expect((text().match(/每 24 小时备份一次/g) ?? []).length).toBe(1)
    expect((text().match(/保留策略:/g) ?? []).length).toBe(1)
    expect(byId('backup-policy-summary').textContent).toContain('保留策略:留最近 7 份,最新一份永远保留')
  })

  it('这次会打包多大:一句话,不是一排 7 个徽标;勾选原件后合计变大、原件不再列在“不备份”里', async () => {
    await open()
    expect(byId('backup-usage').textContent).toContain('这次会打包约 12.1 MB')
    expect(byId('backup-usage').textContent).toContain('不备份:向量表 1 GB(重建索引即可恢复)、原件 256 MB(没勾选)')
    $('[data-testid=backup-include-sources]')!.click()
    await nextTick()
    expect(byId('backup-usage').textContent).toContain('这次会打包约 268.1 MB')
    expect(byId('backup-usage').textContent).not.toContain('没勾选')
  })

  it('失败告警:点明哪一环、什么时候、什么原因;多次失败折在“失败记录”里', async () => {
    const failure = { at: NOW - HOUR, trigger: 'auto', kind: 'mirror', error: '外接盘没挂上' }
    backend({}, { alert: failure, failures: [failure, { at: NOW - 30 * HOUR, trigger: 'manual', kind: 'pack', error: '磁盘已满' }] })
    await open()
    expect(byId('backup-alert').textContent).toContain('异地副本失败')
    expect(byId('backup-alert').textContent).toContain('外接盘没挂上')
    expect(byId('backup-failures').textContent).toContain('最近 2 次失败记录')
    expect(byId('backup-failures').hasAttribute('open')).toBe(false)
  })
})

describe('备份 · 立即备份', () => {
  it('发请求(默认不含原件),提示名字和大小,通知外壳重读告警', async () => {
    const settled = vi.fn()
    window.addEventListener(BACKUP_SETTLED_EVENT, settled)
    await open()
    byId('backup-create').click()
    await flushPromises()
    expect(calls('backup_create')[0]![1]).toEqual({ include_sources: false })
    expect(toasts[0]!.message).toBe('备份完成:kb-20261020-004200.tar.gz(15 MB)')
    expect(settled).toHaveBeenCalledTimes(1)
    window.removeEventListener(BACKUP_SETTLED_EVENT, settled)
  })

  it('勾选原件后带上 include_sources', async () => {
    await open()
    $('[data-testid=backup-include-sources]')!.click()
    await nextTick()
    byId('backup-create').click()
    await flushPromises()
    expect(calls('backup_create')[0]![1]).toEqual({ include_sources: true })
  })

  it('跳过了文件:另给一条警告提示', async () => {
    backend({ backup_create: { name: 'a.tar.gz', size_bytes: 1024, created_at: NOW, skipped: 2 } })
    await open()
    byId('backup-create').click()
    await flushPromises()
    expect(toasts.map((item) => item.tone)).toContain('warning')
  })

  it('失败:原因常驻在卡片里(不是 5 秒就消失的提示条),也通知外壳', async () => {
    const settled = vi.fn()
    window.addEventListener(BACKUP_SETTLED_EVENT, settled)
    backend({ backup_create: new CapabilityError('磁盘空间不够', 'internal', 500) })
    await open()
    byId('backup-create').click()
    await flushPromises()
    expect(byId('backup-error').textContent).toBe('备份失败:磁盘空间不够。请检查磁盘空间后重试。')
    expect(settled).toHaveBeenCalledTimes(1)
    window.removeEventListener(BACKUP_SETTLED_EVENT, settled)
  })

  it('打包中:显示进度条,按钮变“正在打包…”并置灰', async () => {
    let release: (value: unknown) => void = () => undefined
    backend({ backup_create: () => new Promise((resolve) => (release = resolve)) })
    await open()
    byId('backup-create').click()
    await nextTick()
    expect(byId('backup-create').textContent!.trim()).toBe('正在打包…')
    expect(byId('backup-create').disabled).toBe(true)
    release({ name: 'a.tar.gz', size_bytes: 1, created_at: NOW })
    await flushPromises()
    expect(byId('backup-create').textContent!.trim()).toBe('立即备份')
  })

  it('页面打开时别人(定时备份)正在打包:显示进度,兜底轮询每秒问一次,结束后重读', async () => {
    vi.useFakeTimers()
    let running: unknown = { stage: 'packing', started_at: NOW, updated_at: NOW, files_total: 4, files_done: 1, bytes_total: 1000, bytes_done: 250, current: 'meta.db' }
    backend({ backup_state: () => ({ running }) }, { progress: running })
    await open()
    expect(byId('backup-progress').textContent).toContain('打包中 25%')
    expect(byId('backup-progress').textContent).toContain('meta.db')
    const before = calls('backup_state').length
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls('backup_state').length).toBe(before + 1)
    running = null
    status.progress = null
    const statusCalls = calls('backup_status').length
    await vi.advanceTimersByTimeAsync(1100)
    await flushPromises()
    expect($('[data-testid=backup-progress]')).toBeNull()
    expect(calls('backup_status').length).toBe(statusCalls + 1)
    // 结束后不再轮询
    const after = calls('backup_state').length
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls('backup_state').length).toBe(after)
  })
})

describe('备份 · 已有备份', () => {
  it('列出每份的大小和时间', async () => {
    await open()
    expect(rowOf('kb-20261019-004200').textContent).toContain('14 MB')
    expect(rowOf('kb-20261017-213015').textContent).toContain('4 MB')
  })

  it('校验通过:结果留在那一行里(不是提示条)', async () => {
    await open()
    rowOf('kb-20261019').querySelector<HTMLButtonElement>('[data-testid=backup-verify]')!.click()
    await flushPromises()
    expect(calls('backup_verify')[0]![1]).toEqual({ name: 'kb-20261019-004200.tar.gz' })
    expect(rowOf('kb-20261019').querySelector('[data-testid=backup-check]')!.textContent!.trim()).toBe('校验通过 · 12 个文件 · 解压后 15 MB · 元数据库 12 MB')
    expect(rowOf('kb-20261017').querySelector('[data-testid=backup-check]')).toBeNull()
  })

  it('校验没通过:红色常驻,并提醒不要拿它恢复', async () => {
    backend({ backup_verify: new CapabilityError('manifest.json 缺失', 'invalid_input', 400) })
    await open()
    rowOf('kb-20261017').querySelector<HTMLButtonElement>('[data-testid=backup-verify]')!.click()
    await flushPromises()
    const result = rowOf('kb-20261017').querySelector('[data-testid=backup-check]')!
    expect(result.textContent!.trim()).toBe('校验失败:manifest.json 缺失。这份备份可能已经损坏,不要拿它恢复。')
    expect(result.getAttribute('role')).toBe('alert')
  })

  it('删除:红色确认;有异地副本时说明副本也会被删;确认后才发请求', async () => {
    confirmState.answer = false
    await open()
    rowOf('kb-20261017').querySelector<HTMLButtonElement>('[data-testid=backup-delete]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '删除备份「kb-20261017-213015.tar.gz」?', tone: 'danger' })
    expect(confirmState.calls[0]!.message).toContain('异地副本都会被删掉')
    expect(calls('backup_delete')).toHaveLength(0)
    confirmState.answer = true
    rowOf('kb-20261017').querySelector<HTMLButtonElement>('[data-testid=backup-delete]')!.click()
    await flushPromises()
    expect(calls('backup_delete')[0]![1]).toEqual({ name: 'kb-20261017-213015.tar.gz' })
  })

  it('没有异地副本时删除的确认不提副本', async () => {
    backend({}, { mirrors: [] })
    await open()
    rowOf('kb-20261017').querySelector<HTMLButtonElement>('[data-testid=backup-delete]')!.click()
    await flushPromises()
    expect(confirmState.calls[0]!.message).not.toContain('异地副本')
  })
})

describe('备份 · 保留策略与清理', () => {
  it('「按策略清理」:确认里写明按什么策略删,清理报告用提示条', async () => {
    await open()
    byId('backup-prune').click()
    await flushPromises()
    expect(confirmState.calls[0]).toMatchObject({ title: '按保留策略清理旧备份?', tone: 'danger' })
    expect(confirmState.calls[0]!.message).toContain('超出「留最近 7 份」的归档')
    expect(calls('backup_prune')[0]![1]).toEqual({ dry_run: false })
  })

  it('有删不掉的:另给一条警告,点明原因', async () => {
    backend({ backup_prune: { removed: [], kept: 2, failed: [['kb-old.tar.gz', '权限不够']] } })
    await open()
    byId('backup-prune').click()
    await flushPromises()
    expect(toasts.find((item) => item.tone === 'warning')!.message).toContain('有 1 份删不掉')
    expect(toasts.find((item) => item.tone === 'warning')!.message).toContain('权限不够')
  })

  it('策略改了还没保存:说明显示的和清理用的都是已保存的策略', async () => {
    await open({ policyUnsaved: true })
    expect(byId('backup-policy-unsaved').textContent).toContain('都是已保存的策略')
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open({ policyUnsaved: false })
    expect($('[data-testid=backup-policy-unsaved]')).toBeNull()
  })

  it('页面保存成功(savedTick 变了)后重新读一遍,“当前生效”才跟上', async () => {
    await open()
    const before = calls('backup_status').length
    await wrapper!.setProps({ savedTick: 1 })
    await flushPromises()
    expect(calls('backup_status').length).toBe(before + 1)
  })

  it('字段由字段表驱动:策略与异地目录的改动交给页面', async () => {
    await open()
    const input = $<HTMLInputElement>('[data-field="backup.keep_count"] input')!
    input.value = '3'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(updates).toEqual([['backup.keep_count', '3']])
    expect($('[data-field="backup.mirror_dirs"]')).not.toBeNull()
  })
})

describe('备份 · 异地副本现状', () => {
  it('每个目录:已同步 / 未同步 + 份数 + 上次失败原因', async () => {
    await open()
    const items = $$('[data-testid=backup-mirrors] li')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('已同步')
    expect(items[0]!.textContent).toContain('3 份 · 最新一份已在')
    expect(items[1]!.textContent).toContain('未同步')
    expect(items[1]!.textContent).toContain('上次失败:建目录 /mnt/nas/kb-offsite 失败')
  })

  it('没配置:提醒盘坏了就一起没了', async () => {
    backend({}, { mirrors: [] })
    await open()
    expect($('[data-testid=backup-no-mirror]')!.textContent).toContain('这块盘坏了就一起没了')
  })
})

describe('备份 · 恢复步骤', () => {
  it('默认折起;展开后六步,每步有复制按钮,命令带真实目录和最新一份归档', async () => {
    await open()
    const details = $('[data-testid=backup-restore] details')!
    expect(details.hasAttribute('open')).toBe(false)
    expect($$('[data-testid=backup-restore] li')).toHaveLength(6)
    const commands = $$('[data-testid=backup-restore] pre').map((el) => el.textContent)
    expect(commands[2]).toBe('kb backup verify kb-20261019-004200.tar.gz')
    expect(commands[4]).toBe('rm -f /home/kb/.kb/meta.db-wal /home/kb/.kb/meta.db-shm && cp -a /tmp/kb-restore/. /home/kb/.kb/')
    expect(details.textContent).toContain('备份内容:元数据库、config.toml、skills、评测数据')
  })
})
