import { describe, expect, it } from 'vitest'
import { extractDocLinks } from './docLinks'

describe('docLinks · 从 Markdown 找链接', () => {
  it('链接和图片都找出来,同一 href 只留一次', () => {
    const links = extractDocLinks('# 标题\n\n[规则](./项目规则.md) 和 [再来一次](./项目规则.md)\n\n![图](./pic.png)\n\n`[不是链接](./no.md)`')
    expect(links.map((link) => link.href)).toEqual(['./%E9%A1%B9%E7%9B%AE%E8%A7%84%E5%88%99.md', './pic.png'])
    expect(links[1]?.label).toBe('图')
    expect(links[0]?.line).toBe(3)
  })

  it('双链参与体检:文件按集合根,笔记走 kb://note', () => {
    const links = extractDocLinks('[[docs/规范.md|规范]] 和 [[01a19f63-f0ea-72fe-aa19-9998f6e2e5ad|旧笔记]]\n\n`[[代码里不算]]`')
    expect(links).toEqual([
      { href: 'docs/规范.md', line: 1, label: '规范', fromRoot: true },
      { href: 'kb://note/01a19f63-f0ea-72fe-aa19-9998f6e2e5ad', line: 1, label: '旧笔记', fromRoot: false },
    ])
  })
})
