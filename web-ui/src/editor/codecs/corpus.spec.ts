/**
 * 真实笔记语料往返测试（真实语料往返）
 *
 * 为什么用仓库里的真实文档而不是自造样本：
 * 自造样本只会覆盖「我以为的 Markdown」，而往返失真几乎全部来自真实内容里的边角
 * （表格单元格里的 `|`、列表项里的引用、行首像标题的普通文字、带反引号的代码段……）。
 *
 * 判定口径：
 * - 语义层：`canonicalizeDoc` 相同即认为「打开 → 不改保存」内容没变；
 * - 字节层：未改动时 TextSurface 直接回写原文（见 TextSurface.serializeCurrent），
 *   所以这里统计的字节差异只影响「改动后的序列化风格」，不影响保真承诺。
 */
import { describe, expect, it } from 'vitest'
import { canonicalizeDoc, parseMarkdown, serializeMarkdown } from '@/editor/codecs/markdown'

/** 仓库根目录下的真实 Markdown（docs / 根目录 / skills），共 100+ 篇 */
const CORPUS = import.meta.glob(['../../../../docs/**/*.md', '../../../../*.md', '../../../../skills/**/*.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const paths = Object.keys(CORPUS).sort()

function roundtrip(source: string): string {
  const parsed = parseMarkdown(source)
  return serializeMarkdown(parsed.doc, { frontmatter: parsed.frontmatter, eol: parsed.eol })
}

describe('真实笔记语料', () => {
  it('30. 语料规模足够（≥ 20 篇真实 Markdown）', () => {
    expect(paths.length).toBeGreaterThanOrEqual(20)
  })

  it('31. 每篇「打开 → 不改保存」语义完全相同', () => {
    const drift: string[] = []
    for (const path of paths) {
      const source = CORPUS[path]
      const before = canonicalizeDoc(parseMarkdown(source).doc)
      const after = canonicalizeDoc(parseMarkdown(roundtrip(source)).doc)
      if (JSON.stringify(before) !== JSON.stringify(after)) drift.push(path)
    }
    // 失败时把具体文件打出来，避免只看到一句「不相等」
    expect(drift).toEqual([])
  })

  it('32. 序列化幂等：第二次往返不再变化', () => {
    const unstable: string[] = []
    for (const path of paths) {
      const once = roundtrip(CORPUS[path])
      const twice = roundtrip(once)
      if (once !== twice) unstable.push(path)
    }
    expect(unstable).toEqual([])
  })

  it('33. 字节级一致的比例不低于 25%（风格规范化的回归护栏）', () => {
    const identical = paths.filter((path) => roundtrip(CORPUS[path]) === CORPUS[path])
    // 目前约 32%：其余是 `*` 列表规整成 `-`、表格空格补齐、行尾多余空行等既定风格差异
    expect(identical.length / paths.length).toBeGreaterThanOrEqual(0.25)
  })
})
