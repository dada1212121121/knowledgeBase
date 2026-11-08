/**
 * History：按内容面实现的撤销 / 重做栈
 *
 * 为什么不放在 Host 里统一实现（设计规范 「History 按 Surface 实现」）：
 * 1. 文本的撤销单位是「一段输入」，表格是「一次单元格提交」，文档是「一次段落操作」，
 *    幻灯片是「一次形状变换」，四者的粒度与合并规则完全不同，Host 无法通吃。
 * 2. Host 只负责 `undo / redo` 两个入口；栈结构、合并窗口、深度上限由各 Surface 自己决定，
 *    但都复用这里的通用实现，避免四份手写栈。
 * 3. **远端变更（协同回放）不入栈**：协同撤销如果只撤自己那一份，必须由引擎 CRDT 负责；
 *    我们的栈只承载本地用户操作，`recordRemote` 仅计数不压栈。
 */

/** 一个可撤销步骤：必须同时提供撤销与重做两个方向的落地动作 */
export interface HistoryStep {
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
}

/** 压栈参数 */
export interface HistoryRecordInit {
  /** 用户可读的操作名，用于菜单里的「撤销：加粗」 */
  label?: string
  /**
   * 合并键：短时间内同键的操作合并成一步。
   * 例如连续键入的 `text.insert` 都带 `mergeKey = "insert"`，撤销一次退回整段输入。
   */
  mergeKey?: string
  step: HistoryStep
  /** 注入时间，缺省取构造时传入的时钟 */
  at?: number
}

/** 一个历史条目，包含一步或多步已合并的步骤 */
export interface HistoryEntry {
  id: string
  label?: string
  mergeKey?: string
  at: number
  steps: HistoryStep[]
}

export interface HistoryOptions {
  /** 最多保留多少条目，默认 200；超出丢弃最旧的 */
  limit?: number
  /** 相同 mergeKey 的合并时间窗，默认 400 ms（连续键入不应变成几十步撤销） */
  mergeWindowMs?: number
  /** 注入时钟，便于测试 */
  now?: () => number
}

export class History {
  private readonly undoStack: HistoryEntry[] = []
  private readonly redoStack: HistoryEntry[] = []
  private readonly limit: number
  private readonly mergeWindowMs: number
  private readonly now: () => number
  private seq = 0
  private remoteCount = 0
  /** 正在应用撤销/重做：期间的压栈一律忽略，否则撤销动作本身会再产生一条历史 */
  private applying = false

  constructor(options: HistoryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? 200)
    this.mergeWindowMs = Math.max(0, options.mergeWindowMs ?? 400)
    this.now = options.now ?? Date.now
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** 当前可撤销条目数 */
  get depth(): number {
    return this.undoStack.length
  }

  /** 当前可重做条目数 */
  get redoDepth(): number {
    return this.redoStack.length
  }

  /** 被忽略的远端变更次数（诊断用） */
  get remoteChanges(): number {
    return this.remoteCount
  }

  /** 下一个可撤销条目的标签，供 UI 显示「撤销：加粗」 */
  peekUndoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label
  }

  peekRedoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label
  }

  /**
   * 压入一个步骤。
   * - 新的本地操作会清空重做栈（标准编辑器语义）；
   * - 与栈顶条目同 mergeKey 且在合并窗口内 → 合并为同一条目的额外步骤。
   */
  record(init: HistoryRecordInit): void {
    if (this.applying) return

    const at = init.at ?? this.now()
    const top = this.undoStack[this.undoStack.length - 1]
    const canMerge =
      !!init.mergeKey &&
      !!top &&
      top.mergeKey === init.mergeKey &&
      at - top.at <= this.mergeWindowMs

    if (canMerge && top) {
      top.steps.push(init.step)
      top.at = at
      if (init.label) top.label = init.label
    } else {
      this.undoStack.push({
        id: `h${++this.seq}`,
        label: init.label,
        mergeKey: init.mergeKey,
        at,
        steps: [init.step],
      })
      this.truncate()
    }
    // 任何新的本地操作都使重做链失效
    this.redoStack.length = 0
  }

  /**
   * 记录一次远端（协同）变更：只计数，不压栈。
   * 协同撤销必须由引擎 CRDT 处理，把远端变更塞进本地栈会导致「撤掉别人的修改」。
   */
  recordRemote(): void {
    this.remoteCount += 1
  }

  /** 撤销一步；返回是否真的发生了撤销 */
  async undo(): Promise<boolean> {
    const entry = this.undoStack.pop()
    if (!entry) return false

    this.applying = true
    try {
      // 逆序撤销：合并条目里后发生的步骤要先撤
      for (let i = entry.steps.length - 1; i >= 0; i -= 1) {
        await entry.steps[i]!.undo()
      }
    } finally {
      this.applying = false
    }
    this.redoStack.push(entry)
    return true
  }

  /** 重做一步；返回是否真的发生了重做 */
  async redo(): Promise<boolean> {
    const entry = this.redoStack.pop()
    if (!entry) return false

    this.applying = true
    try {
      for (const step of entry.steps) {
        await step.redo()
      }
    } finally {
      this.applying = false
    }
    this.undoStack.push(entry)
    return true
  }

  /** 清空双向栈（重新加载文档 / 保存后重建基线时调用） */
  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.remoteCount = 0
  }

  /** 只读快照，供调试面板与测试断言使用 */
  snapshot(): { undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[] } {
    return { undo: this.undoStack, redo: this.redoStack }
  }

  private truncate(): void {
    const overflow = this.undoStack.length - this.limit
    if (overflow > 0) this.undoStack.splice(0, overflow)
  }
}
