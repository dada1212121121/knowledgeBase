/**
 * SessionRegistry：同一文件只保留一个会话
 *
 * 为什么需要它：
 * 1. 笔记页、搜索结果预览、AI 面板可能同时想打开同一个文件。若各自建会话，
 *    会出现「两个编辑器各存一份、后保存的覆盖先保存的」的静默丢改动。
 * 2. 打开是异步的（解析 / 预检 / 拉字节），并发点击会重复发起请求；
 *    这里用 single-flight 把同 fileId 的打开请求合并成一个 Promise。
 * 3. 标签页切换时按 LRU 淘汰，避免一次拖入十几个文档后内存只增不减。
 */
import type { EditorOpenRequest } from '../types'
import { EditorDocumentSession, type EditorDocumentSessionOptions } from './DocumentSession'

/** 打开会话的工厂：把「怎么建这个会话」（transport / snapshot / history）交给调用方 */
export type SessionFactory = (
  request: EditorOpenRequest,
) => EditorDocumentSession | Promise<EditorDocumentSession>

export interface SessionRegistryOptions {
  /** 同时驻留的会话上限，默认 4（超过按最久未访问淘汰） */
  maxSessions?: number
  /** 淘汰时回调，便于上层提示「后台标签已释放」 */
  onEvict?: (session: EditorDocumentSession) => void
}

export class SessionRegistry {
  private readonly sessions = new Map<string, EditorDocumentSession>()
  private readonly pending = new Map<string, Promise<EditorDocumentSession>>()
  private readonly lastAccess = new Map<string, number>()
  private readonly factories = new Map<string, SessionFactory>()
  private readonly maxSessions: number
  private readonly onEvict?: (session: EditorDocumentSession) => void
  private seq = 0

  constructor(options: SessionRegistryOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 4)
    this.onEvict = options.onEvict
  }

  /** 为某格式注册会话工厂（同一 fileId 复用已有会话，不与格式绑定） */
  registerFactory(format: string, factory: SessionFactory): void {
    this.factories.set(format.toLowerCase(), factory)
  }

  /** 已驻留会话数 */
  get size(): number {
    return this.sessions.size
  }

  /** 是否已有该文件的会话 */
  has(fileId: string): boolean {
    return this.sessions.has(fileId)
  }

  get(fileId: string): EditorDocumentSession | null {
    return this.sessions.get(fileId) ?? null
  }

  /**
   * 打开（或复用）会话。
   * 并发调用同一 fileId 只会真正创建一次，其余等同一个 Promise。
   */
  async open(request: EditorOpenRequest, factory?: SessionFactory): Promise<EditorDocumentSession> {
    const existing = this.sessions.get(request.fileId)
    if (existing && existing.phase !== 'destroyed') {
      this.touch(request.fileId)
      return existing
    }

    const inflight = this.pending.get(request.fileId)
    if (inflight) return inflight

    const resolvedFactory = factory ?? this.factories.get(request.format.toLowerCase())
    if (!resolvedFactory) {
      throw new Error(`没有为 .${request.format} 注册编辑器会话工厂`)
    }

    const task = (async () => {
      const created = await resolvedFactory(request)
      // 打开期间会话可能已被显式关闭，此时不能强行复活，避免泄漏
      if (created.phase === 'destroyed') {
        return created
      }
      this.sessions.set(request.fileId, created)
      this.touch(request.fileId)
      this.enforceLimit()
      return created
    })()

    this.pending.set(request.fileId, task)
    try {
      return await task
    } finally {
      this.pending.delete(request.fileId)
    }
  }

  /** 用已建好的会话直接登记（测试与特殊路径使用） */
  adopt(session: EditorDocumentSession): void {
    this.sessions.set(session.fileId, session)
    this.touch(session.fileId)
    this.enforceLimit()
  }

  /** 关闭并销毁某个文件的会话 */
  close(fileId: string): void {
    const session = this.sessions.get(fileId)
    if (!session) return
    this.sessions.delete(fileId)
    this.lastAccess.delete(fileId)
    session.destroy()
  }

  /** 关闭全部会话（离开编辑器页面时调用） */
  closeAll(): void {
    for (const fileId of [...this.sessions.keys()]) {
      this.close(fileId)
    }
    this.pending.clear()
  }

  /** 当前所有会话的快照（顺序为登记顺序） */
  list(): EditorDocumentSession[] {
    return [...this.sessions.values()]
  }

  private touch(fileId: string): void {
    this.lastAccess.set(fileId, ++this.seq)
  }

  private enforceLimit(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldestId: string | null = null
      let oldest = Number.POSITIVE_INFINITY
      for (const [fileId, tick] of this.lastAccess) {
        if (!this.sessions.has(fileId)) continue
        if (tick < oldest) {
          oldest = tick
          oldestId = fileId
        }
      }
      if (!oldestId) return
      const session = this.sessions.get(oldestId)
      this.sessions.delete(oldestId)
      this.lastAccess.delete(oldestId)
      // 淘汰前先通知上层：用户可能还有未保存改动，必须给一次提示机会
      if (session) this.onEvict?.(session)
      session?.destroy()
    }
  }
}
