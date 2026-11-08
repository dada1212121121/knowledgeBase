/**
 * CommandBus：编辑器唯一修改入口
 *
 * 为什么必须有它（设计规范）：
 * 1. 一个文档可能同时被「用户输入 / AI 建议 / 协同回放 / 扩展 API」四条路径改写。
 *    如果各 Surface 自己接这些入口，权限判断、只读拦截、审计与历史合并会四份实现、四处漏。
 * 2. 因此全仓约定：**任何修改都必须先过 CommandBus**，并显式携带 `source`。
 * 3. 派发是串行的：同一会话的修改按到达顺序逐个落地，避免 AI 批量改写与用户键入交错造成
 *    中间态脏数据；只读类命令（view./nav./search. 等）不进串行队列，避免卡住键入。
 */
import {
  canExecuteCommand,
  type CommandResult,
  type CommandSource,
  type EditorCommand,
  type EditorPermissions,
} from '../types'

/** 单个命令处理器：返回 true 表示已处理；返回 false 表示交回上层的 Surface 默认逻辑 */
export type CommandHandler = (command: EditorCommand) => Promise<CommandResult> | CommandResult

/** 命令处理器的注册形态：按命令前缀匹配（`text.` 匹配 `text.insert`） */
interface HandlerRegistration {
  /** 匹配前缀；空串表示兜底处理器 */
  prefix: string
  handler: CommandHandler
  /** 更具体的注册优先（前缀越长越先匹配） */
  order: number
}

/** 命令执行审计记录（用于诊断面板与 AI 变更来源追溯，不落库） */
export interface CommandAuditRecord {
  id: string
  type: string
  source: CommandSource
  ok: boolean
  reason?: string
  at: number
}

export interface CommandBusOptions {
  /** 只读态判定；会话在保存/冲突期间可能临时切换，因此用函数取值而不是快照 */
  readonly: () => boolean
  /** 当前权限 */
  permissions: () => EditorPermissions
  /** 命令真正落到 Surface 的出口 */
  dispatch: (command: EditorCommand) => Promise<CommandResult>
  /** 审计环形缓冲区容量，默认 100 */
  auditLimit?: number
  /** 注入时钟，便于测试合并与排序 */
  now?: () => number
}

export class CommandBus {
  private readonly handlers: HandlerRegistration[] = []
  private readonly audit: CommandAuditRecord[] = []
  private readonly opts: Required<Pick<CommandBusOptions, 'auditLimit' | 'now'>> & CommandBusOptions
  /** 串行队列尾指针；所有写命令挂在它后面 */
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(options: CommandBusOptions) {
    this.opts = {
      ...options,
      auditLimit: options.auditLimit ?? 100,
      now: options.now ?? Date.now,
    }
  }

  /** 注册命令处理器；同一前缀可重复注册，后注册的优先（便于 Surface 覆盖默认实现） */
  register(prefix: string, handler: CommandHandler): () => void {
    const registration: HandlerRegistration = {
      prefix,
      handler,
      order: this.handlers.length,
    }
    this.handlers.push(registration)
    return () => {
      const index = this.handlers.indexOf(registration)
      if (index >= 0) this.handlers.splice(index, 1)
    }
  }

  /** 最近审计记录（最新在后），供诊断与调试面板读取 */
  getAudit(): readonly CommandAuditRecord[] {
    return this.audit
  }

  /**
   * 派发命令。
   *
   * 顺序：权限/只读守卫 → 串行排队 → 前缀处理器 → Surface 默认出口。
   * 只读安全命令走快通道，不排队（否则连续翻页/搜索会被写命令拖住）。
   */
  async execute(command: EditorCommand): Promise<CommandResult> {
    if (this.disposed) {
      return { ok: false, reason: '编辑器已关闭' }
    }

    const guard = canExecuteCommand(command, this.opts.readonly(), this.opts.permissions())
    if (!guard.ok) {
      this.pushAudit(command, guard)
      return guard
    }

    const run = async (): Promise<CommandResult> => {
      const handler = this.findHandler(command.type)
      try {
        const result = handler ? await handler(command) : await this.opts.dispatch(command)
        this.pushAudit(command, result)
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        // 命令异常不能冒泡成未捕获 Promise，否则一次 AI 批量改写失败会打断整个会话
        const result: CommandResult = { ok: false, reason: error.message }
        this.pushAudit(command, result)
        return result
      }
    }

    if (isReadonlySafeCommand(command)) {
      return run()
    }

    const next = this.tail.then(run, run)
    // 队列自身吞掉异常，保证后续命令仍能执行
    this.tail = next.catch(() => undefined)
    return next
  }

  /** 等待队列中所有已排队的写命令落地（保存/卸载前调用） */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined)
  }

  /** 释放：清空处理器与队列，之后的命令一律拒绝 */
  dispose(): void {
    this.disposed = true
    this.handlers.length = 0
    this.audit.length = 0
  }

  private findHandler(type: string): CommandHandler | null {
    let best: HandlerRegistration | null = null
    for (const registration of this.handlers) {
      if (registration.prefix === '' || type === registration.prefix || type.startsWith(registration.prefix)) {
        // 前缀越长越具体；同长度取后注册者
        if (
          !best ||
          registration.prefix.length > best.prefix.length ||
          (registration.prefix.length === best.prefix.length && registration.order > best.order)
        ) {
          best = registration
        }
      }
    }
    return best?.handler ?? null
  }

  private pushAudit(command: EditorCommand, result: CommandResult): void {
    this.audit.push({
      id: command.id,
      type: command.type,
      source: command.source,
      ok: result.ok,
      reason: result.reason,
      at: this.opts.now(),
    })
    if (this.audit.length > this.opts.auditLimit) {
      this.audit.splice(0, this.audit.length - this.opts.auditLimit)
    }
  }
}

/** 只读安全命令前缀（与 types.ts 的 READONLY_SAFE_PREFIXES 保持一致语义） */
const READONLY_SAFE_PREFIXES = ['view.', 'nav.', 'search.', 'zoom.', 'sheet.select', 'slide.select', 'copy']

/** 该命令是否只读安全：这类命令在只读文档里也允许执行，且不进串行写队列 */
export function isReadonlySafeCommand(command: EditorCommand): boolean {
  if (command.readonlySafe === true) return true
  return READONLY_SAFE_PREFIXES.some(
    (prefix) => command.type === prefix || command.type.startsWith(prefix),
  )
}
