/**
 * 笔记文本面的图片 / 附件上传
 *
 * 规则逐条照搬旧编辑器（已删除的 components/DocEditor.vue 里的 uploadOne / uploadFiles）：
 * - 没有目标集合不能传；超过 MAX_ATTACHMENT_BYTES 的文件拒绝并说明大小；
 * - 存到 `_attachments/…`（attachmentPath 保证不重名），打 `attachment` 标签，进检索；
 * - 写回正文的是相对路径（同集合）或 `kb://`（新笔记 / 跨集合），不写 `/api/v1/raw?…`：
 *   那种地址换域名、导出离线就失效，还把内部接口写进了正文；
 * - 图片写成 `![名](地址)`，其它文件写成附件卡片 `[📎 名](地址 "大小")`。
 *
 * 为什么抽成不依赖 Vue 组件的模块：粘贴 / 拖入 / 工具栏 / 斜杠菜单四个入口共用同一条上传流水线，
 * 且上传进度要在页面上显示；纯函数 + 一个小的任务列表，单测就能把超限、失败、重名、多文件都测全。
 */
import { reactive } from 'vue'
import { uploadFile } from '@/api/upload'
import { MAX_ATTACHMENT_BYTES, attachmentMarkdown, attachmentPath, imageMarkdown, imageUploadName } from '@/utils/attachments'
import { humanSize } from '@/utils/hexdump'
import { hrefForTarget, isTemplatePath } from '@/utils/links'
import type { TextServices } from '../types'

/** 一个上传任务的可见状态（进度条 / 失败原因） */
export interface UploadTask {
  id: number
  name: string
  percent: number
  error: string
}

export interface TextUploader {
  /** 进行中 / 刚失败的任务（失败的 8 秒后自己消失） */
  tasks: UploadTask[]
  /** 上传一个文件，成功返回要写进正文的 Markdown；失败 / 被拒绝返回 null（原因已通过 notify 或任务行告知） */
  uploadOne(file: File): Promise<string | null>
  /** 依次上传多个文件，返回成功的 Markdown 片段 */
  uploadAll(files: File[]): Promise<string[]>
}

export interface TextUploaderDeps {
  services: () => Pick<TextServices, 'collection' | 'sourcePath'>
  notify: (message: string) => void
  /** 可替换，单测用 */
  upload?: typeof uploadFile
  /** 失败任务行保留多久（毫秒） */
  errorLingerMs?: number
}

export function createTextUploader(deps: TextUploaderDeps): TextUploader {
  const tasks = reactive<UploadTask[]>([])
  const upload = deps.upload ?? uploadFile
  const linger = deps.errorLingerMs ?? 8000
  let seq = 0

  async function uploadOne(file: File): Promise<string | null> {
    const services = deps.services()
    const collection = services.collection()
    if (!collection) {
      deps.notify('这里不能上传附件(没有目标集合)')
      return null
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      deps.notify(`${file.name} 有 ${humanSize(file.size)},超过 ${humanSize(MAX_ATTACHMENT_BYTES)} 的附件上限`)
      return null
    }
    const task: UploadTask = reactive({ id: ++seq, name: file.name, percent: 0, error: '' })
    tasks.push(task)
    // 是图片就用规范文件名（见 imageUploadName）；不是图片仍按原名当附件
    const imageName = imageUploadName(file)
    const path = attachmentPath(imageName ?? file.name)
    try {
      const done = await upload(file, {
        collection,
        relPath: path,
        tags: ['attachment'],
        onProgress: (percent: number) => (task.percent = percent),
        // 要字节级进度：一个分片传到一半条也在走，不会在大图 / 大附件上一直停在 0
        onBytes: () => undefined,
      })
      const stored = done.files[0]?.rel_path ?? done.skipped[0]?.existing?.rel_path ?? path
      tasks.splice(tasks.indexOf(task), 1)
      const href = hrefForTarget(collection, services.sourcePath(), collection, stored, { download: isTemplatePath(stored) })
      return imageName ? imageMarkdown(imageName, href) : attachmentMarkdown(file.name, href, file.size)
    } catch (error) {
      task.error = error instanceof Error ? error.message : '上传失败'
      setTimeout(() => {
        const at = tasks.indexOf(task)
        if (at >= 0) tasks.splice(at, 1)
      }, linger)
      return null
    }
  }

  async function uploadAll(files: File[]): Promise<string[]> {
    const pieces: string[] = []
    for (const file of files) {
      const piece = await uploadOne(file)
      if (piece) pieces.push(piece)
    }
    return pieces
  }

  return { tasks, uploadOne, uploadAll }
}

/** 全部成功后给用户的一句话：附件会被解析进检索，图片不会，所以只在有附件时提一句 */
export function uploadedNotice(files: File[], count: number): string {
  const allImages = files.every((file) => imageUploadName(file) !== null)
  return `已上传 ${count} 个文件${allImages ? '' : ',附件也会被解析进检索'}`
}
