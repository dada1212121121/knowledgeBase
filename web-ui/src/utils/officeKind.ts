// 在线编辑的办公文档格式与协同状态的类型（原在 office/island.ts，随旧 React 编辑岛一起删除时迁出）。

/** 能在线编辑的三种 Office 格式 */
export type OfficeKind = 'xlsx' | 'pptx' | 'docx'

/** 文件名对应的格式;不支持的返回 null（旧格式 doc / xls / ppt 不在线编辑）。 */
export function officeKindOf(path: string): OfficeKind | null {
  const dot = path.lastIndexOf('.')
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
  return ext === 'xlsx' ? 'xlsx' : ext === 'pptx' ? 'pptx' : ext === 'docx' ? 'docx' : null
}

/** 协同连接状态与在线的人（外层工具条的文案用） */
export interface OfficeCollabStatus {
  status: string
  synced: boolean
  peers: string[]
}
