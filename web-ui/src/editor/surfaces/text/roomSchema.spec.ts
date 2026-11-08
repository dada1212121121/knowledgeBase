/**
 * 协同房间格式兼容契约
 *
 * 新 Text Surface 和旧编辑器（Milkdown / Crepe）要进同一个 y-prosemirror 房间。y-prosemirror 遇到本地 schema
 * 不认识的节点 / 标记，会把那个元素从共享文档里删掉、再同步给所有人；所以这里逐条守住：
 * 1. 旧编辑器的每个节点 / 标记，新 schema 都有，attrs 是超集，content 用到的 group 一致；
 * 2. 新 schema 的节点 / 标记名不超出旧编辑器（只多出白名单里的透传属性）；
 * 3. 同一份 Markdown，新解析器的结构和旧编辑器一致（新客户端初始化的房间，旧客户端看到的是同样的东西）；
 * 4. 文档经 Y.XmlFragment 在两种 schema 之间来回转换，一个元素都不删。
 * 旧编辑器的 schema 与解析结果是 时在真实浏览器里导出的快照（fixtures/milkdown-room.json）。 删除旧编辑器后
 * 不能再重新导出，也没有「漂移」可查——快照就是历史房间格式的定义：已存在的房间（旧编辑器写的）要永远能被新文本面打开。
 */
import { describe, expect, it } from 'vitest'
import { Node as PMNode, Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model'
import * as Y from 'yjs'
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import snapshot from './fixtures/milkdown-room.json'
import sample from './fixtures/room-sample.md?raw'
import { textSchema } from './schema'
import { canonicalizeDoc, parseMarkdown, serializeMarkdown } from '../../codecs/markdown'

type SnapshotAttrs = Record<string, { default?: unknown }>
interface SnapshotNode {
  content: string
  group: string
  inline: boolean
  atom: boolean
  marks?: string
  attrs: SnapshotAttrs
}
const legacyNodes = snapshot.nodes as unknown as Record<string, SnapshotNode>
const legacyMarks = snapshot.marks as unknown as Record<string, { attrs: SnapshotAttrs; excludes?: string }>

/** prosemirror 的 OrderedMap 没有 keys，只能 forEach */
function namesOf(map: { forEach(fn: (key: string) => void): void }): string[] {
  const names: string[] = []
  map.forEach((key) => names.push(key))
  return names
}

/** 新 schema 多出来、旧编辑器会原样忽略的透传属性（它重写该元素时会丢掉，只影响保存写法，不丢内容） */
// image.width：拖拽调整后的显示宽度。旧编辑器不认识它、重写这张图片时会丢掉宽度，图片本身（src / alt / title）不受影响
const NATIVE_ONLY_ATTRS: Record<string, string[]> = { code_block: ['kbMath'], image: ['width'] }

/** 按快照重建旧编辑器的 schema（只要名字、attrs、content、group，足够驱动 y-prosemirror 的转换） */
function legacySchema(): Schema {
  const nodes: Record<string, NodeSpec> = {}
  for (const [name, spec] of Object.entries(legacyNodes)) {
    nodes[name] = {
      ...(spec.content ? { content: spec.content } : {}),
      ...(spec.group ? { group: spec.group } : {}),
      inline: spec.inline,
      atom: spec.atom,
      ...(spec.marks !== undefined ? { marks: spec.marks } : {}),
      attrs: spec.attrs,
    }
  }
  const marks: Record<string, MarkSpec> = {}
  for (const [name, spec] of Object.entries(legacyMarks)) marks[name] = { attrs: spec.attrs, ...(spec.excludes !== undefined ? { excludes: spec.excludes } : {}) }
  return new Schema({ nodes, marks, topNode: snapshot.topNode })
}

/** 文档 → 房间里的 Y.XmlFragment → 另一种 schema 的文档；返回转换后的文档与转换前后的 XML（用来发现被删的元素） */
function throughRoom(doc: PMNode, target: Schema): { doc: PMNode; before: string; after: string } {
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment('prosemirror')
  prosemirrorToYXmlFragment(doc, fragment)
  const before = fragment.toString()
  const converted = yXmlFragmentToProseMirrorRootNode(fragment, target)
  return { doc: converted, before, after: fragment.toString() }
}

/** 比较前抹掉两边合理不同的东西：标题锚点 id（旧编辑器另算 slug）、透传属性、旧编辑器末尾自动补的空段落 */
function comparable(doc: PMNode): unknown {
  const json = doc.toJSON() as { content?: { type: string; content?: unknown[] }[] }
  const content = [...(json.content ?? [])]
  const last = content[content.length - 1]
  if (last?.type === 'paragraph' && !last.content?.length) content.pop()
  const strip = (node: Record<string, unknown>): Record<string, unknown> => {
    const attrs = { ...((node.attrs as Record<string, unknown>) ?? {}) }
    if (node.type === 'heading') delete attrs.id
    for (const key of NATIVE_ONLY_ATTRS[node.type as string] ?? []) delete attrs[key]
    return {
      ...node,
      ...(node.attrs ? { attrs } : {}),
      ...(Array.isArray(node.content) ? { content: (node.content as Record<string, unknown>[]).map(strip) } : {}),
    }
  }
  return canonicalizeDoc(PMNode.fromJSON(textSchema, strip({ ...json, content }) as never))
}

describe('协同房间格式兼容（新 Text Surface ⇄ 旧编辑器）', () => {
  it('1. 旧编辑器的每个节点 / 标记新 schema 都有：attrs 是超集、group 一致', () => {
    const problems: string[] = []
    for (const [name, spec] of Object.entries(legacyNodes)) {
      const native = textSchema.spec.nodes.get(name)
      if (!native) {
        problems.push(`缺少节点 ${name}`)
        continue
      }
      if ((native.group ?? '') !== spec.group) problems.push(`${name} 的 group ${native.group ?? ''} ≠ ${spec.group}`)
      for (const attr of Object.keys(spec.attrs)) if (!(attr in (native.attrs ?? {}))) problems.push(`${name} 缺少 attr ${attr}`)
    }
    for (const [name, spec] of Object.entries(legacyMarks)) {
      const native = textSchema.spec.marks.get(name)
      if (!native) {
        problems.push(`缺少标记 ${name}`)
        continue
      }
      for (const attr of Object.keys(spec.attrs)) if (!(attr in (native.attrs ?? {}))) problems.push(`标记 ${name} 缺少 attr ${attr}`)
    }
    expect(problems).toEqual([])
  })

  it('2. 新 schema 不产生旧编辑器不认识的节点 / 标记；必填 attrs 和旧编辑器一样只有 link.href', () => {
    const extraNodes = namesOf(textSchema.spec.nodes).filter((name) => !legacyNodes[name])
    const extraMarks = namesOf(textSchema.spec.marks).filter((name) => !legacyMarks[name])
    expect({ extraNodes, extraMarks }).toEqual({ extraNodes: [], extraMarks: [] })
    const extraAttrs: string[] = []
    const required: string[] = []
    textSchema.spec.nodes.forEach((name, spec) => {
      for (const [attr, value] of Object.entries(spec.attrs ?? {})) {
        if (!(attr in (legacyNodes[name]?.attrs ?? {})) && !NATIVE_ONLY_ATTRS[name]?.includes(attr)) extraAttrs.push(`${name}.${attr}`)
        if (!('default' in value)) required.push(`${name}.${attr}`)
      }
    })
    textSchema.spec.marks.forEach((name, spec) => {
      for (const [attr, value] of Object.entries(spec.attrs ?? {})) if (!('default' in value)) required.push(`${name}.${attr}`)
    })
    expect(extraAttrs).toEqual([])
    expect(required).toEqual(['link.href'])
  })

  it('3. 同一份 Markdown（覆盖全部语法）新解析器的结构和旧编辑器一致', () => {
    const native = parseMarkdown(sample).doc
    const legacy = PMNode.fromJSON(textSchema, snapshot.sampleDoc as never)
    expect(comparable(native)).toEqual(comparable(legacy))
  })

  it('4. 新客户端写进房间的内容，旧编辑器一个元素都不删、结构不变', () => {
    const legacy = legacySchema()
    const native = parseMarkdown(sample).doc
    const { doc, before, after } = throughRoom(native, legacy)
    expect(after).toBe(before)
    // 唯一允许的差异：y-prosemirror 不往房间里写值为 null 的属性，读的一方按自己 schema 的默认值补。
    // 旧编辑器单元格对齐的默认值是 'left'，所以「未声明对齐」的列在它那边读成 left——
    // 只有旧编辑器的房间里也一样（不是新客户端引入的）；新客户端默认 null，读旧房间时保持 `---`。
    const leftAsUnset = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/"alignment":null/g, '"alignment":"left"'))
    expect(leftAsUnset(comparable(PMNode.fromJSON(textSchema, doc.toJSON())))).toEqual(leftAsUnset(comparable(native)))
  })

  it('5. 旧编辑器写进房间的内容，新客户端一个元素都不删；保存出来的 Markdown 再读回结构不变', () => {
    const legacy = PMNode.fromJSON(legacySchema(), snapshot.sampleDoc as never)
    const { doc, before, after } = throughRoom(legacy, textSchema)
    expect(after).toBe(before)
    expect(comparable(doc)).toEqual(comparable(PMNode.fromJSON(textSchema, snapshot.sampleDoc as never)))
    // 新客户端当落地者：把房间内容存成 Markdown，再按旧编辑器的方式读回来仍是同一份文档
    const saved = serializeMarkdown(doc)
    expect(comparable(parseMarkdown(saved).doc)).toEqual(comparable(doc))
  })

  it('6. 反证：schema 少一个节点时 y-prosemirror 真的会把房间里的元素删掉（上面几条守的就是这个）', () => {
    const nodes: Record<string, NodeSpec> = {}
    textSchema.spec.nodes.forEach((name, spec) => {
      if (name !== 'math_inline') nodes[name] = spec
    })
    const crippled = new Schema({ nodes, marks: textSchema.spec.marks })
    const { before, after } = throughRoom(parseMarkdown('公式 $x$ 在这里\n').doc, crippled)
    expect(before).toContain('math_inline')
    expect(after).not.toContain('math_inline')
  })
})
