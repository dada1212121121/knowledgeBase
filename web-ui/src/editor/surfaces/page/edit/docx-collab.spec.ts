/** Word 协同接入的纯逻辑单测：clientId、选项构造、状态条文案。真房间行为在 e2e/editor-docx-collab.mjs。 */
import { describe, expect, it, vi } from 'vitest'
import type { DocxCollabStatus } from '../../../engines/docx'
import { createDocxCollabOptions, docxCollabText, randomClientId } from './docx-collab'

const status = (over: Partial<DocxCollabStatus> = {}): DocxCollabStatus => ({ status: 'connected', synced: true, peers: [], ...over })
const peer = (name: string, clientId = 1) => ({ clientId, name, color: '#123456' })

describe('randomClientId', () => {
  it('31 位非零整数', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = randomClientId()
      expect(Number.isInteger(id)).toBe(true)
      expect(id).toBeGreaterThan(0)
      expect(id).toBeLessThanOrEqual(0x7fffffff)
    }
  })

  it('随机源给 0 或最高位为 1 的值也不会得到 0 / 负数', () => {
    expect(randomClientId(() => new Uint32Array([0]))).toBe(1)
    expect(randomClientId(() => new Uint32Array([0x80000000]))).toBe(1)
    expect(randomClientId(() => new Uint32Array([0xffffffff]))).toBe(0x7fffffff)
  })

  it('两次调用基本不撞（同一页多次开会话各自有身份）', () => {
    expect(new Set(Array.from({ length: 50 }, () => randomClientId())).size).toBeGreaterThan(45)
  })
})

describe('createDocxCollabOptions', () => {
  it('用工厂建传输（地址原样传入），带上用户、初始状态、可写标记与回调', () => {
    const transport = { connect: vi.fn(), disconnect: vi.fn() } as never
    const factory = vi.fn(() => transport)
    const onStatus = vi.fn()
    const onClosed = vi.fn()
    const seed = new Uint8Array([1, 2, 3])
    const options = createDocxCollabOptions(
      { url: 'ws://h/api/v1/office/collab?doc=d', userName: '甲', userColor: '#f00', initialUpdate: seed, writable: false, onStatus, onClosed },
      factory,
    )
    expect(factory).toHaveBeenCalledWith('ws://h/api/v1/office/collab?doc=d')
    expect(options).toMatchObject({ transport, userName: '甲', userColor: '#f00', writable: false, onStatus, onClosed })
    expect(options.initialUpdate).toBe(seed)
    expect(options.clientId).toBeGreaterThan(0)
  })

  it('每次调用建一条新传输、一个新身份（重新打开不复用）', () => {
    const factory = vi.fn(() => ({}) as never)
    const a = createDocxCollabOptions({ url: 'ws://x', userName: 'a', writable: true }, factory)
    const b = createDocxCollabOptions({ url: 'ws://x', userName: 'a', writable: true }, factory)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(a.transport).not.toBe(b.transport)
  })
})

describe('docxCollabText', () => {
  it('没有状态时不显示', () => {
    expect(docxCollabText(null)).toBe('')
  })

  it('连接阶段：同步中 / 已同步 / 连接中 / 已关闭 / 离线', () => {
    expect(docxCollabText(status({ synced: false }))).toBe('多人协同 · 同步中…')
    expect(docxCollabText(status())).toBe('多人协同 · 已同步')
    expect(docxCollabText(status({ status: 'connecting', synced: false }))).toBe('多人协同 · 连接中…')
    expect(docxCollabText(status({ status: 'destroyed' }))).toBe('多人协同 · 连接已关闭')
    expect(docxCollabText(status({ status: 'disconnected', synced: false }))).toBe('多人协同 · 离线，修改会在连上后同步')
  })

  it('列出别人，最多点三个名字，超过加"等"', () => {
    expect(docxCollabText(status({ peers: [peer('乙')] }))).toBe('多人协同 · 已同步 · 另有 1 人在编辑：乙')
    expect(docxCollabText(status({ peers: [peer('乙', 1), peer('丙', 2), peer('丁', 3)] }))).toContain('乙、丙、丁')
    const many = docxCollabText(status({ peers: [peer('a', 1), peer('b', 2), peer('c', 3), peer('d', 4)] }))
    expect(many).toContain('另有 4 人在编辑：a、b、c 等')
    expect(many).not.toContain('d')
  })

  it('错误原因带在括号里', () => {
    expect(docxCollabText(status({ status: 'disconnected', synced: false, error: '网络断了' }))).toContain('（网络断了）')
  })
})
