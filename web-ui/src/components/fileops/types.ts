// 文件操作(删除 / 移动 / 回收站)的前端类型。字段名与后端 `FileActions` / `FileOp` 的 serde 输出一致。
export type FileOrigin = 'upload' | 'archive' | 'web' | 'git' | 'local_dir' | 'project' | 'note' | 'attachment' | 'unknown'
export type FileOpState = 'running' | 'done' | 'partial' | 'failed' | 'rolled_back'
export type TrashMode = 'trash' | 'unindex'

export interface FileActionAvailability {
  allowed: boolean
  reason: string | null
}

export interface FileActions {
  collection: string
  path: string
  origin: FileOrigin
  managed: boolean
  folder: boolean
  files: number
  fingerprint: { value: string; files: number }
  delete: FileActionAvailability
  move: FileActionAvailability
}

export interface FileOp {
  id: string
  collection: string
  /** 跨知识库移动的目标库;同库移动 / 删除等为空。 */
  target_collection?: string | null
  kind: string
  state: FileOpState
  total: number
  done: number
  failed: number
  error: string | null
  created_at: number
  finished_at: number | null
}

export interface TrashEntry {
  id: string
  op_id: string
  collection: string
  original_path: string
  trash_path: string | null
  source_id: string | null
  metadata_key: string
  mode: TrashMode
  size: number
  created_at: number
  expires_at: number | null
  restored_at: number | null
  purged_at: number | null
}

/** 菜单 / 对话框指向的一个文件或文件夹。`name` 只用于界面显示。 */
export interface FileTarget {
  collection: string
  path: string
  name: string
  /** 从树里点文件夹时提前知道;从菜单请求后以服务端返回为准 */
  folder?: boolean
}

export const ORIGIN_LABEL: Record<FileOrigin, string> = {
  upload: '上传的副本',
  archive: '压缩包解出的副本',
  web: '网页抓取缓存',
  git: '仓库克隆副本',
  local_dir: '本地目录原件',
  project: '项目文件',
  note: '笔记',
  attachment: '附件',
  unknown: '未知来源',
}
