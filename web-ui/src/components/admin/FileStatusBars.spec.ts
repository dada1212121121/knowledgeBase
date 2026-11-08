// 项目文件状态条:只列项目的集合、按总数排序、每行写入库比例、没有数据写说明。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), callCapability: (...args: unknown[]) => callCapability(...args) }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined, subscribeLive: () => () => undefined }))

import FileStatusBars from './FileStatusBars.vue'

const projects = [{ name: 'alpha', collection: 'proj_alpha' }, { name: 'beta', collection: 'proj_beta' }]
const reply = {
  collections: [
    { collection: 'proj_alpha', statuses: { ok: 60, binary: 25, excluded: 10, too_large: 5 }, total: 100 },
    { collection: 'proj_beta', statuses: { ok: 300, generated: 100 }, total: 400 },
    { collection: '_global', statuses: { ok: 5 }, total: 5 },
  ],
}
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  document.body.innerHTML = ''
  callCapability.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('FileStatusBars', () => {
  it('只列项目的集合(全局集合不列),文件多的在前;每行写总数和入库比例', async () => {
    callCapability.mockResolvedValue(reply)
    mount(FileStatusBars, { props: { projects }, attachTo: document.body })
    await flushPromises()
    const rows = [...document.body.querySelectorAll('.kb-hbars-row')].map((row) => row.textContent!.replace(/\s+/g, ' ').trim())
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('beta')
    expect(rows[0]).toContain('400 个 · 75% 入库')
    expect(rows[1]).toContain('alpha')
    expect(rows[1]).toContain('100 个 · 60% 入库')
    expect(document.body.textContent).not.toContain('_global')
  })

  it('结论:几个项目共多少文件、多少被跳过;图例是中文状态名', async () => {
    callCapability.mockResolvedValue(reply)
    mount(FileStatusBars, { props: { projects }, attachTo: document.body })
    await flushPromises()
    // 跳过 = 100 - 60 + 400 - 300 = 140
    expect($('[data-testid=chart-headline]')!.textContent).toBe('2 个项目共 500 个文件,其中 140 个被跳过(二进制、太大、被排除、生成文件)')
    const legend = [...document.body.querySelectorAll('.kb-hbars-legend li')].map((item) => item.textContent!.trim())
    expect(legend).toEqual(expect.arrayContaining(['已入库', '二进制', '被排除', '太大', '生成文件']))
  })

  it('没有项目文件:写说明;读失败:写原因', async () => {
    callCapability.mockResolvedValue({ collections: [] })
    mount(FileStatusBars, { props: { projects }, attachTo: document.body })
    await flushPromises()
    expect(document.body.textContent).toContain('项目还没有扫描过文件')
    document.body.innerHTML = ''
    callCapability.mockRejectedValue(new Error('boom'))
    mount(FileStatusBars, { props: { projects }, attachTo: document.body })
    await flushPromises()
    expect($('[role=alert]')).not.toBeNull()
  })
})
