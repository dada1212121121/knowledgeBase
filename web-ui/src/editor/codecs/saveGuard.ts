/**
 * 保存前的本地守卫
 *
 * 原件的替换接口一旦写入就推进版本，所以「明显坏掉」的字节必须在发请求前拦住：
 * 1. 空字节：引擎保存失败时可能拿到 0 长度，绝不能覆盖原件；
 * 2. 不是 ZIP：xlsx 是 OPC 包，必须以 `PK\x03\x04` 开头、以中央目录结束标记收尾，
 *    少了结尾说明序列化被截断（Worker 崩溃 / 内存不足），这类文件 Excel 会提示修复；
 * 3. 超过服务端 `max_replace_bytes`：先拦下来给出准确提示，而不是等 413。
 *
 * 这里只做结构级校验，内容级（部件、公式、关系）校验由服务端 `replace_bytes` 内置的
 * `office_check::validate` 完成，前端不重复实现 OOXML 校验器。
 */

/** 服务端替换接口的默认上限（与 `OfficeEditor` 的 64 MB 一致） */
export const MAX_REPLACE_BYTES = 64 * 1024 * 1024

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04] as const
const ZIP_END_RECORD = [0x50, 0x4b, 0x05, 0x06] as const

export type SaveGuardResult = { ok: true } | { ok: false; reason: string }

/** 是否是一个结构完整的 ZIP 字节流（不做 CRC / 部件解析） */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < ZIP_LOCAL_HEADER.length + 4) return false
  for (let i = 0; i < ZIP_LOCAL_HEADER.length; i += 1) {
    if (bytes[i] !== ZIP_LOCAL_HEADER[i]) return false
  }
  // 结尾目录签名不一定正好在最后 22 字节内（ZIP 注释可长达 64 KB），只在尾部区间里找
  const tailStart = Math.max(0, bytes.byteLength - 22 - 0xffff)
  for (let i = bytes.byteLength - ZIP_END_RECORD.length; i >= tailStart; i -= 1) {
    let matched = true
    for (let j = 0; j < ZIP_END_RECORD.length; j += 1) {
      if (bytes[i + j] !== ZIP_END_RECORD[j]) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}

/** 保存前守卫的参数：`kind` 是格式名（写进错误提示），`label` 是文件的称呼（表格 / 演示文稿） */
export interface OfficeGuardOptions {
  maxBytes?: number
  label?: string
  kind?: string
  defaultLabel?: string
}

/** 保存前守卫：空 / 截断 / 超限都给出可直接展示的中文原因（xlsx / pptx / docx 共用） */
export function checkOfficeSaveable(bytes: Uint8Array, options: OfficeGuardOptions = {}): SaveGuardResult {
  const name = options.label ?? options.defaultLabel ?? '文档'
  const kind = options.kind ?? 'Office'
  if (bytes.byteLength === 0) return { ok: false, reason: `${name}没有生成任何内容，已取消保存` }
  const maxBytes = options.maxBytes ?? MAX_REPLACE_BYTES
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      reason: `${name}有 ${formatBytes(bytes.byteLength)}，超过服务端 ${formatBytes(maxBytes)} 上限，请改用下载后本地编辑再上传`,
    }
  }
  if (!looksLikeZip(bytes)) {
    return { ok: false, reason: `${name}的保存结果不是完整的 ${kind} 包，已取消保存以免覆盖原件` }
  }
  return { ok: true }
}

/** 保存前本地守卫（xlsx） */
export function checkXlsxSaveable(bytes: Uint8Array, options: { maxBytes?: number; label?: string } = {}): SaveGuardResult {
  return checkOfficeSaveable(bytes, { ...options, kind: 'xlsx', defaultLabel: '表格' })
}

/** SHA-256 十六进制摘要；用于乐观锁的 `expected_sha256` 与「是否真的改过」判断 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持 SHA-256')
  // 传副本：subtle.digest 不接受带 offset 的视图在部分实现里会算错
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 字节级相等；保存前判断「引擎没有改动」用它，避免无意义地推进版本 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}
