import { describe, expect, it, vi } from 'vitest'
import { EditorDocumentSession } from './DocumentSession'
import { SessionRegistry } from './SessionRegistry'
import type { EditorOpenRequest, EditorPermissions } from '../types'

const FULL: EditorPermissions = { read: true, write: true, comment: true, ai: true, export: true }

function makeRequest(fileId: string, format = 'md'): EditorOpenRequest {
  return {
    fileId,
    format,
    source: { kind: 'text', text: '', name: `${fileId}.${format}` },
    readonly: false,
    revision: 1,
    permissions: FULL,
  }
}

describe('SessionRegistry：同文件单会话 + single-flight', () => {
  it('54. 并发打开同一文件只真正创建一次会话', async () => {
    const registry = new SessionRegistry()
    const factory = vi.fn(async (request: EditorOpenRequest) => {
      // 故意慢一点，模拟解析 + 无损预检耗时
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new EditorDocumentSession({ request })
    })

    const [a, b, c] = await Promise.all([
      registry.open(makeRequest('f1'), factory),
      registry.open(makeRequest('f1'), factory),
      registry.open(makeRequest('f1'), factory),
    ])

    expect(factory).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(registry.size).toBe(1)
  })

  it('55. 已驻留会话被复用，并刷新 LRU 访问顺序', async () => {
    const registry = new SessionRegistry({ maxSessions: 2 })
    const factory = (request: EditorOpenRequest) => new EditorDocumentSession({ request })

    const first = await registry.open(makeRequest('f1'), factory)
    await registry.open(makeRequest('f2'), factory)
    // 再次访问 f1，使 f2 变成最久未用
    const again = await registry.open(makeRequest('f1'), factory)
    expect(again).toBe(first)

    await registry.open(makeRequest('f3'), factory)
    expect(registry.has('f1')).toBe(true)
    expect(registry.has('f2')).toBe(false)
    expect(registry.has('f3')).toBe(true)
  })

  it('56. 未注册工厂时明确报错，而不是静默返回空会话', async () => {
    const registry = new SessionRegistry()
    await expect(registry.open(makeRequest('f1', 'docx'))).rejects.toThrow('docx')
  })

  it('57. 按格式注册的工厂可被自动选用', async () => {
    const registry = new SessionRegistry()
    registry.registerFactory('MD', (request) => new EditorDocumentSession({ request }))
    const session = await registry.open(makeRequest('f9', 'md'))
    expect(session.format).toBe('md')
    expect(registry.has('f9')).toBe(true)
  })

  it('58. 超限淘汰最久未用的会话并回调 onEvict（给未保存改动留提示机会）', async () => {
    const evicted: string[] = []
    const registry = new SessionRegistry({
      maxSessions: 1,
      onEvict: (session) => evicted.push(session.fileId),
    })
    const factory = (request: EditorOpenRequest) => new EditorDocumentSession({ request })

    await registry.open(makeRequest('f1'), factory)
    await registry.open(makeRequest('f2'), factory)

    expect(evicted).toEqual(['f1'])
    expect(registry.size).toBe(1)
    expect(registry.get('f1')).toBeNull()
  })

  it('59. close 会销毁会话；closeAll 清空全部', async () => {
    const registry = new SessionRegistry({ maxSessions: 8 })
    const factory = (request: EditorOpenRequest) => new EditorDocumentSession({ request })
    const s1 = await registry.open(makeRequest('f1'), factory)
    await registry.open(makeRequest('f2'), factory)

    registry.close('f1')
    expect(s1.phase).toBe('destroyed')
    expect(registry.has('f1')).toBe(false)
    expect(registry.size).toBe(1)

    registry.closeAll()
    expect(registry.size).toBe(0)
    expect(registry.list()).toHaveLength(0)
  })

  it('60. adopt 直接登记已建好的会话（不重复创建）', () => {
    const registry = new SessionRegistry()
    const session = new EditorDocumentSession({ request: makeRequest('f5') })
    registry.adopt(session)
    expect(registry.get('f5')).toBe(session)
    expect(registry.list()).toEqual([session])
  })
})
