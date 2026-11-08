// 资源键(后端 `ResourceKey` 的字符串写法)的解析与"谁覆盖谁"。通知里带的是键;共享给我的列表里每一项也有键。
//   space:<sid>                    整个知识库
//   col:<sid>/<集合>               一个集合
//   dir:<sid>/<集合>/<路径>        一个文件夹
//   doc:<sid>/<集合>/i/<笔记 id>   一篇笔记
//   doc:<sid>/<集合>/f/<路径>      一个文件
// 每一段都是百分号编码(除字母数字和 . _ ~ - 外的每个字节写成 %XX)。
import type { ShareTarget } from '@/api/share'

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function decodeAll(parts: string[]): string[] | null {
  const out: string[] = []
  for (const part of parts) {
    const value = decode(part)
    if (value === null) return null
    out.push(value)
  }
  return out
}

export function parseResourceKey(key: string): ShareTarget | null {
  const colon = key.indexOf(':')
  if (colon < 0) return null
  const kind = key.slice(0, colon)
  const rest = key.slice(colon + 1).split('/')
  const sid = rest[0]
  if (!sid) return null
  if (kind === 'space' && rest.length === 1) return { kind: 'space', space_id: sid }
  const parts = decodeAll(rest.slice(1))
  if (!parts || !parts[0]) return null
  const collection = parts[0]
  if (kind === 'col' && parts.length === 1) return { kind: 'collection', space_id: sid, collection }
  if (kind === 'dir' && parts.length >= 2) return { kind: 'dir', space_id: sid, collection, path: parts.slice(1).join('/') }
  if (kind === 'doc' && parts.length >= 3) {
    if (parts[1] === 'i' && parts.length === 3) return { kind: 'insight', space_id: sid, collection, id: parts[2]! }
    if (parts[1] === 'f') return { kind: 'file', space_id: sid, collection, path: parts.slice(2).join('/') }
  }
  return null
}

/** 授权 `grant` 的范围是否包含文档 `doc`(包括就是它自己)。目录按路径边界判断:`a/b` 覆盖 `a/b/c.md`,但不覆盖 `a/bc.md`。 */
export function coversTarget(grant: ShareTarget, doc: ShareTarget): boolean {
  if (!grant.space_id || grant.space_id !== doc.space_id) return false
  if (grant.kind === 'space') return true
  if (grant.collection !== doc.collection) return false
  if (grant.kind === 'collection') return true
  if (grant.kind === 'dir') {
    const dir = (grant.path ?? '').replace(/\/+$/, '')
    return doc.kind === 'file' && !!doc.path && (doc.path === dir || doc.path.startsWith(`${dir}/`))
  }
  if (grant.kind === 'file') return doc.kind === 'file' && grant.path === doc.path
  if (grant.kind === 'insight') return doc.kind === 'insight' && grant.id === doc.id
  return false
}

/** 从共享给我的列表里挑出能覆盖这篇文档的授权:先找正好就是它的,再找最具体的上级(目录 > 集合 > 整个知识库)。 */
export function bestCovering<T extends { target: ShareTarget }>(items: T[], doc: ShareTarget): T | null {
  const rank = (target: ShareTarget): number => ({ insight: 0, file: 0, dir: 1, collection: 2, space: 3 })[target.kind] ?? 9
  const covering = items.filter((item) => coversTarget(item.target, doc))
  covering.sort((left, right) => rank(left.target) - rank(right.target) || (right.target.path?.length ?? 0) - (left.target.path?.length ?? 0))
  return covering[0] ?? null
}
