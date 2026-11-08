// 「关系」页签的数据整理:把 `doc_links` 的原始行拆成两组——出链(这篇引用了谁)、入链(谁引用了这篇)。
//
// 服务端按「一处链接一行」返回:同一篇文档在一段里引用了两次就会出现两行。页签是导航,按目标
// 去重,重复次数记在 count 里;行号取第一处,点进去由正文自己定位。
// 标题优先用服务端存的标题,其次用链接文字,最后退回 id / 文件名——不能因为标题读不到就让整项消失。
export interface DocLinkRow {
  source_kind?: string
  source_collection?: string
  source_id?: string
  source_title?: string
  href?: string
  line?: number
  label?: string
  /** 解析失败的原因(例如笔记 id 不合法):这类链接不放进导航,点进去只会报错 */
  reason?: string
  target_kind?: string
  target_collection?: string
  target_id?: string
}

/** `doc_links` 的返回(只声明界面用到的字段,多出来的字段忽略) */
export interface DocLinksReply {
  outbound?: DocLinkRow[]
  inbound?: DocLinkRow[]
}

export interface DocRelation {
  kind: 'note' | 'file'
  collection: string
  /** 笔记是 note id,文件是 collection 内的相对路径 */
  id: string
  title: string
  /** 第一处引用的行号;拿不到就是 0 */
  line: number
  /** 同一个目标 / 来源出现几次 */
  count: number
}

/** 文件路径的显示名:关系列表里只放文件名,完整路径留在 title 提示里 */
export function relationFileName(path: string): string {
  const name = path.split('/').pop()
  return name || path
}

/** 出链里哪些目标需要查标题(只有笔记;文件用文件名) */
export function noteTargetIds(rows: DocLinkRow[] = []): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.target_kind === 'note' && row.target_id) ids.add(row.target_id)
  }
  return [...ids]
}

function push(
  target: Map<string, DocRelation>,
  item: Omit<DocRelation, 'count' | 'line'> & { count: number; line: number },
): void {
  const key = `${item.kind}:${item.collection}:${item.id}`
  const found = target.get(key)
  if (found) {
    found.count += item.count
    if (!found.line && item.line) found.line = item.line
    // 标题先到先得,但空标题不能占住位置
    if (!found.title && item.title) found.title = item.title
    return
  }
  target.set(key, item)
}

/** 按标题排序;同标题再按行号,保证每次打开顺序一致 */
function byTitle(a: DocRelation, b: DocRelation): number {
  return a.title.localeCompare(b.title, 'zh') || a.line - b.line
}

export function splitRelations(reply: DocLinksReply | null | undefined, titles: Record<string, string> = {}): {
  outbound: DocRelation[]
  inbound: DocRelation[]
} {
  const outbound = new Map<string, DocRelation>()
  for (const row of reply?.outbound ?? []) {
    if (row.reason) continue
    // 锚点(#小节)和外部链接(target_kind=external)没有可打开的文档目标,导航里不列
    if (row.target_kind !== 'note' && row.target_kind !== 'file') continue
    const kind: DocRelation['kind'] = row.target_kind === 'note' ? 'note' : 'file'
    const id = row.target_id || row.href || ''
    if (!id) continue
    const title = kind === 'note' ? titles[id] || row.label || id : relationFileName(id) || row.label || id
    push(outbound, {
      kind,
      collection: row.target_collection ?? '',
      id,
      title,
      line: row.line ?? 0,
      count: 1,
    })
  }
  const inbound = new Map<string, DocRelation>()
  for (const row of reply?.inbound ?? []) {
    // 来源笔记已删 / id 不合法时服务端在 reason 里说明;列出来点了只会报错,不放
    if (row.reason) continue
    const id = row.source_id || ''
    if (!id) continue
    const kind: DocRelation['kind'] = row.source_kind === 'note' ? 'note' : 'file'
    push(inbound, {
      kind,
      collection: row.source_collection ?? '',
      id,
      title: row.source_title || relationFileName(id),
      line: row.line ?? 0,
      count: 1,
    })
  }
  return {
    // 出链保持正文顺序(行号),入链按标题排:一个是「读文章的顺序」,一个是「找那篇文档」
    outbound: [...outbound.values()].sort((a, b) => a.line - b.line || byTitle(a, b)),
    inbound: [...inbound.values()].sort(byTitle),
  }
}
