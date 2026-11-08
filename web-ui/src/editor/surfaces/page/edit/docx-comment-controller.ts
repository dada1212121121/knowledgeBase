/**
 * Word 评论控制器：持有评论线程，执行 新建 / 回复 / 解决 / 重开 / 删除。
 *
 * 与查找同样的结构：只依赖窄接口 `CommentBackend`，真引擎绑定在 `docx-comments-backend.ts`，
 * 所以"提交前检查、引擎拒绝如何处理、操作后列表是否刷新"这些逻辑用假后端就能测。
 *
 * 每个动作的共同约定：
 * - 先过前置检查（只读、空内容、过长），不合格的根本不发给引擎，也不改本地状态；
 * - 引擎拒绝（版本过期、评论已被别人删了）把原因带给用户，并重新读一遍评论——别人（协同）的改动可能就是拒绝的原因，
 *   列表刷新后用户看到的是真实状态，而不是一个操作失败了却什么都没变的界面；
 * - 动作成功后总是重新读（而不是在本地拼）：评论 id、时间、作者都以引擎为准，协同里两个人同时评论也不会错位。
 */
import type { CommandResult } from '../../../types'
import { buildThreads, commentPermissions, validateCommentText, type CommentThread, type CommentView, type RawComment } from './docx-comments'

export interface CommentSnapshot {
  comments: RawComment[]
  /** 根评论 id → 它在文档里的位置序号（按文档顺序从 0 起） */
  positions: Map<string, number>
}

export interface CommentBackend {
  /** 读当前所有评论（含已解决） */
  read(): Promise<CommentSnapshot>
  /** 在当前选区上新建评论；选区为空 / 不在正文返回 `{ ok:false, reason }` */
  add(text: string, author: string): Promise<CommandResult>
  /** 回复某条评论（锚在它的范围上） */
  reply(parentId: string, text: string, author: string): Promise<CommandResult>
  setDone(id: string, done: boolean): Promise<CommandResult>
  remove(id: string): Promise<CommandResult>
  /** 点评论 → 选中它锚着的文字并滚过去 */
  reveal(id: string): Promise<boolean>
}

export interface CommentControllerOptions {
  /** 当前用户显示名（评论作者、"是我写的"的判定） */
  me: string
  /** 现在能不能编辑（只读 / 被收回编辑权时为假），每次动作前现取 */
  editable: () => boolean
  /** 线程变了，侧栏重画 */
  onChange(threads: readonly CommentThread[]): void
}

export class DocxCommentController {
  private threads: CommentThread[] = []
  private reading: Promise<void> | null = null
  private again = false

  constructor(
    private readonly backend: CommentBackend,
    private readonly options: CommentControllerOptions,
  ) {}

  get current(): readonly CommentThread[] {
    return this.threads
  }

  get permissions() {
    return commentPermissions(this.options.editable())
  }

  /**
   * 重新读。读的过程中又来了新的刷新请求：不并发读，读完再读一次（保证最后一次请求之后的状态一定被读到）。
   * 协同里别人评论、文档变了都会触发刷新，不去重会让侧栏闪。
   */
  refresh(): Promise<void> {
    if (this.reading) {
      this.again = true
      return this.reading
    }
    this.reading = (async () => {
      try {
        do {
          this.again = false
          const snapshot = await this.backend.read()
          this.threads = buildThreads(snapshot.comments, snapshot.positions, this.options.me)
          this.options.onChange(this.threads)
        } while (this.again)
      } finally {
        this.reading = null
      }
    })()
    return this.reading
  }

  private denied(): CommandResult | null {
    return this.options.editable() ? null : { ok: false, reason: '文档当前是只读的，不能评论' }
  }

  /** 动作的公共收尾：不管成败都刷新一次，让侧栏反映真实状态 */
  private async run(action: () => Promise<CommandResult>): Promise<CommandResult> {
    let result: CommandResult
    try {
      result = await action()
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    await this.refresh().catch(() => undefined)
    return result
  }

  async add(text: string): Promise<CommandResult> {
    const denied = this.denied()
    if (denied) return denied
    const invalid = validateCommentText(text)
    if (invalid) return { ok: false, reason: invalid }
    return this.run(() => this.backend.add(text.trim(), this.options.me))
  }

  async reply(parentId: string, text: string): Promise<CommandResult> {
    const denied = this.denied()
    if (denied) return denied
    const invalid = validateCommentText(text)
    if (invalid) return { ok: false, reason: invalid }
    if (!this.threads.some((thread) => thread.root.id === parentId || thread.replies.some((reply) => reply.id === parentId))) {
      return { ok: false, reason: '要回复的评论已经不在了' }
    }
    return this.run(() => this.backend.reply(parentId, text.trim(), this.options.me))
  }

  async setDone(id: string, done: boolean): Promise<CommandResult> {
    const denied = this.denied()
    if (denied) return denied
    return this.run(() => this.backend.setDone(id, done))
  }

  async remove(comment: CommentView): Promise<CommandResult> {
    const denied = this.denied()
    if (denied) return denied
    if (!this.permissions.canDelete(comment)) return { ok: false, reason: '只能删除自己写的评论' }
    return this.run(() => this.backend.remove(comment.id))
  }

  /** 删除整个线程（根评论是自己的才行）：先删回复再删根，任何一步失败就停，不留下没有根的回复 */
  async removeThread(thread: CommentThread): Promise<CommandResult> {
    const denied = this.denied()
    if (denied) return denied
    if (!this.permissions.canDelete(thread.root)) return { ok: false, reason: '只能删除自己写的评论' }
    // 别人的回复不能替他删：线程里有别人写的回复就拒绝，让用户先自己处理
    const foreign = thread.replies.find((reply) => !reply.mine)
    if (foreign) return { ok: false, reason: `这条评论下有 ${foreign.author} 的回复，不能连同删除` }
    return this.run(async () => {
      for (const reply of thread.replies) {
        const result = await this.backend.remove(reply.id)
        if (!result.ok) return result
      }
      return this.backend.remove(thread.root.id)
    })
  }

  reveal(id: string): Promise<boolean> {
    return this.backend.reveal(id)
  }
}
