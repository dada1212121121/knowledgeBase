/**
 * 笔记图片 / 附件上传流水线单测
 *
 * 规则与旧编辑器逐条一致：没有集合不能传、超限拒绝并报大小、存到 _attachments、打 attachment 标签、
 * 同集合写相对路径（新笔记 / 跨集合写 kb://）、图片写 ![]、其它文件写附件卡片、失败显示原因再自己消失。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTextUploader, uploadedNotice } from './textUpload'
import { MAX_ATTACHMENT_BYTES } from '@/utils/attachments'

afterEach(() => vi.useRealTimers())

function setup(options: { collection?: string | null; sourcePath?: string | null; upload?: ReturnType<typeof vi.fn> } = {}) {
  const notices: string[] = []
  const upload =
    options.upload ??
    vi.fn(async (file: File, opts: { relPath: string }) => ({ files: [{ rel_path: opts.relPath }], skipped: [], name: file.name }))
  const uploader = createTextUploader({
    services: () => ({
      collection: () => (options.collection === undefined ? 'docs' : options.collection),
      sourcePath: () => (options.sourcePath === undefined ? 'guide/a.md' : options.sourcePath),
    }),
    notify: (message) => notices.push(message),
    upload: upload as never,
    errorLingerMs: 50,
  })
  return { uploader, notices, upload }
}

const png = () => new File(['x'], '截图.png', { type: 'image/png' })
const pdf = () => new File(['x'.repeat(2048)], '合同.pdf', { type: 'application/pdf' })

describe('上传一个文件', () => {
  it('1. 图片 → ![名](相对路径)，存到 _attachments 并打 attachment 标签', async () => {
    const { uploader, upload } = setup()
    const md = await uploader.uploadOne(png())
    expect(md).toMatch(/^!\[截图\]\(.+\)$/)
    const [, options] = upload.mock.calls[0]!
    expect(options.collection).toBe('docs')
    expect(options.relPath).toMatch(/^_attachments\//)
    expect(options.tags).toEqual(['attachment'])
    // 同集合：相对 guide/a.md 写成 ../_attachments/…，不是 /api/v1/raw
    expect(md).toContain('../_attachments/')
    expect(md).not.toContain('/api/')
  })

  it('2. 非图片 → 附件卡片 [📎 名](地址 "大小")', async () => {
    const { uploader } = setup()
    const md = await uploader.uploadOne(pdf())
    expect(md).toMatch(/^\[📎 合同\.pdf\]\(.+ "2(\.0)? KB"\)$/)
  })

  it('3. 新笔记（还没有文件路径）写 kb:// 地址', async () => {
    const { uploader } = setup({ sourcePath: null })
    const md = await uploader.uploadOne(png())
    expect(md).toContain('kb://docs/_attachments/')
  })

  it('4. 没有目标集合：不上传，提示原因', async () => {
    const { uploader, notices, upload } = setup({ collection: null })
    expect(await uploader.uploadOne(png())).toBeNull()
    expect(upload).not.toHaveBeenCalled()
    expect(notices).toEqual(['这里不能上传附件(没有目标集合)'])
  })

  it('5. 超过上限：拒绝，提示文件大小与上限', async () => {
    const { uploader, notices, upload } = setup()
    const big = new File(['x'], 'big.zip')
    Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })
    expect(await uploader.uploadOne(big)).toBeNull()
    expect(upload).not.toHaveBeenCalled()
    expect(notices[0]).toMatch(/big\.zip 有 .*超过 200 MB 的附件上限/)
  })

  it('6. 服务端判定同内容已存在（秒传）：用已有文件的路径', async () => {
    const upload = vi.fn(async () => ({ files: [], skipped: [{ existing: { rel_path: '_attachments/old.png' } }] }))
    const { uploader } = setup({ upload })
    expect(await uploader.uploadOne(png())).toContain('../_attachments/old.png')
  })

  it('7. 上传中任务行显示进度，完成后消失', async () => {
    let report: (percent: number) => void = () => undefined
    let finish: () => void = () => undefined
    const upload = vi.fn(
      (_file: File, opts: { relPath: string; onProgress: (n: number) => void }) =>
        new Promise((resolve) => {
          report = opts.onProgress
          finish = () => resolve({ files: [{ rel_path: opts.relPath }], skipped: [] })
        }),
    )
    const { uploader } = setup({ upload })
    const pending = uploader.uploadOne(png())
    await vi.waitFor(() => expect(uploader.tasks).toHaveLength(1))
    report(40)
    expect(uploader.tasks[0]).toMatchObject({ name: '截图.png', percent: 40, error: '' })
    finish()
    await pending
    expect(uploader.tasks).toHaveLength(0)
  })

  it('8. 上传失败：任务行显示原因，随后自己消失；返回 null', async () => {
    vi.useFakeTimers()
    const upload = vi.fn(async () => {
      throw new Error('磁盘已满')
    })
    const { uploader } = setup({ upload })
    expect(await uploader.uploadOne(png())).toBeNull()
    expect(uploader.tasks[0]).toMatchObject({ error: '磁盘已满' })
    vi.advanceTimersByTime(60)
    expect(uploader.tasks).toHaveLength(0)
  })
})

describe('上传多个文件', () => {
  it('9. 依次上传，只返回成功的；一个失败不影响其它', async () => {
    let n = 0
    const upload = vi.fn(async (_file: File, opts: { relPath: string }) => {
      n += 1
      if (n === 2) throw new Error('网络断了')
      return { files: [{ rel_path: opts.relPath }], skipped: [] }
    })
    const { uploader } = setup({ upload })
    const pieces = await uploader.uploadAll([png(), pdf(), png()])
    expect(pieces).toHaveLength(2)
    expect(upload).toHaveBeenCalledTimes(3)
  })

  it('10. 完成提示：全是图片不提解析进检索，有附件才提', () => {
    expect(uploadedNotice([png()], 1)).toBe('已上传 1 个文件')
    expect(uploadedNotice([png(), pdf()], 2)).toBe('已上传 2 个文件,附件也会被解析进检索')
  })
})
