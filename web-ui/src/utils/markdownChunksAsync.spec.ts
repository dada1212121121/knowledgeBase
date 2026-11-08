// Worker 版入口的退路：没有 Worker（jsdom）时同步算，结果与直接调用解析函数完全一致。
import { describe, expect, it } from 'vitest'
import { extractDocLinks } from './docLinks'
import { extractDocLinksAsync, LINKS_WORKER_THRESHOLD, renderMarkdownChunksAsync } from './markdownChunksAsync'
import { createMarkdownRenderer, renderMarkdownChunks } from './markdownRenderer'

const BIG = `${'[甲](docs/a.md) 与 ![图](img/b.png) 与 [[kb-note]]\n\n正文一段。\n\n'.repeat(Math.ceil(LINKS_WORKER_THRESHOLD / 40))}`

describe('markdownChunksAsync', () => {
  it('大文档的链接提取与同步版一致（大于阈值才走 Worker 通道）', async () => {
    expect(BIG.length).toBeGreaterThan(LINKS_WORKER_THRESHOLD)
    expect(await extractDocLinksAsync(BIG)).toEqual(extractDocLinks(BIG))
  })

  it('小文档同步算', async () => {
    expect(await extractDocLinksAsync('[a](b.md)')).toEqual(extractDocLinks('[a](b.md)'))
  })

  it('分段结果与同步版一致', async () => {
    expect(await renderMarkdownChunksAsync(BIG)).toEqual(renderMarkdownChunks(createMarkdownRenderer(), BIG))
  })
})
