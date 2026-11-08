// 导入时可选的"目标文件夹":文件落在集合里的哪个目录下。不填 = 集合根目录。
//
// 做法是在入口处把每个文件包成一个带前缀路径的 File:预检、续传指纹、入队、上传都靠 `relativePathOf(file)`
// 取路径,这样下游一处都不用改;压缩包解包也跟着放进这个文件夹。规则对齐服务端 `sanitize_rel_path`
// (用 `/` 分隔、不能是绝对路径、不能含 `..`、不能有控制字符),服务端仍会再校验一次。
import { relativePathOf } from '@/api/upload'

export type FolderResult = { ok: true; folder: string } | { ok: false; reason: string }

/** 规整用户填的文件夹:兼容 `\`、首尾和重复的 `/`、`./`;空串合法(= 根目录)。 */
export function normalizeFolder(raw: string): FolderResult {
  const text = raw.trim().replace(/\\/g, '/')
  if (!text) return { ok: true, folder: '' }
  const parts: string[] = []
  for (const part of text.split('/')) {
    const piece = part.trim()
    if (piece === '' || piece === '.') continue
    if (piece === '..') return { ok: false, reason: '文件夹里不能有 ..' }
    if (/[\u0000-\u001f\u007f]/.test(piece)) return { ok: false, reason: '文件夹名里有不能用的字符' }
    parts.push(piece)
  }
  return { ok: true, folder: parts.join('/') }
}

/** 给文件加上目标文件夹前缀;不填文件夹原样返回。内容不复制(File 对 Blob 是引用)。 */
export function withFolderPrefix(files: File[], folder: string): File[] {
  if (!folder) return files
  return files.map((file) => {
    const wrapped = new File([file], file.name, { type: file.type, lastModified: file.lastModified })
    Object.defineProperty(wrapped, 'webkitRelativePath', { value: `${folder}/${relativePathOf(file)}` })
    return wrapped
  })
}
