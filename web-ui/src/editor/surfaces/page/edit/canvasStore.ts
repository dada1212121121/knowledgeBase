/**
 * 页面画布仓库
 *
 * 引擎在 Worker 里排版并出图，主线程只持有「每页一个 `<canvas>`」，把 Worker 传回的位图 `drawImage` 上去。
 * 20 页文档不能 20 张画布常驻（每张 816×1056×DPR² 像素，放大后几十 MB），所以只保留视口窗口附近和光标所在页，
 * 其余的收回：画布置零尺寸释放像素，翻回来时 Worker 重新出图。
 *
 * 画布以引擎给的 `pageId` 为键，不以页序号为键：插入页之后页序号会变，pageId 不变，画布才不会串页。
 */
export interface PageIdentity {
  pageId: string
  pageIndex: number
}

export class CanvasStore {
  private readonly canvases = new Map<string, HTMLCanvasElement>()

  /** 只返回已经存在的画布（引擎恢复与回显用，不创建） */
  existing = (page: PageIdentity): HTMLCanvasElement | null => this.canvases.get(page.pageId) ?? null

  /** 取画布，没有就建一张；建出来先不挂进 DOM，由页面组件挂 */
  ensure = (page: PageIdentity): HTMLCanvasElement => {
    let canvas = this.canvases.get(page.pageId)
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.dataset.pageId = page.pageId
      this.canvases.set(page.pageId, canvas)
    }
    return canvas
  }

  get size(): number {
    return this.canvases.size
  }

  has(pageId: string): boolean {
    return this.canvases.has(pageId)
  }

  /** 收回不在 `retained` 里的画布：从 DOM 摘下、置零尺寸释放像素内存 */
  evict(retained: ReadonlySet<string>): number {
    let removed = 0
    for (const [pageId, canvas] of this.canvases) {
      if (retained.has(pageId)) continue
      canvas.remove()
      canvas.width = 0
      canvas.height = 0
      this.canvases.delete(pageId)
      removed += 1
    }
    return removed
  }

  dispose(): void {
    this.evict(new Set())
  }
}
