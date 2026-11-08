/**
 * DOCX 保存编解码（无损与缓存已补全）
 *
 * 保存链路与 xlsx 一致，复用服务端已有的两个能力而不是新造接口：
 * - `PUT /api/v1/files/replace`：整份字节替换，内部跑 `office_check::validate`（不是完整 Office 包就拒绝，原文件不动），
 *   并用 `expected_sha256` 做乐观锁（别人先保存 → 409），用 `session` 校验编辑权；
 * - `POST /api/v1/files/roundtrip-check`：可选的无损预检（本次字节相对原件改了哪些部件）。
 *
 * 本层只做「字节 → SaveResult」的映射与错误分类；会话状态机（saving / conflict / error）由 `DocumentSession` 维护。
 */
import { OfficeEditError, replaceFile, roundtripCheck, type RoundtripReport } from '../../api/officeEdit'
import type { SessionSaveRequest, SessionTransport } from '../session/DocumentSession'
import type { EditorSource, SaveResult } from '../types'
import { looksLikeZip, MAX_REPLACE_BYTES, sha256Hex, type SaveGuardResult } from './saveGuard'

export interface DocxSaveOptions {
  collection: string
  path: string
  /** 打开（或上次保存）时的原件哈希；传函数是为了保存成功后更新基线，而 transport 只创建一次 */
  expectedSha256: string | (() => string)
  /** 编辑器窗口编号；有编辑权锁时一并带上，服务端会校验持有人 */
  sessionId?: string
  maxBytes?: number
  label?: string
}

function formatBytes(size: number): string {
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`
}

/** 保存前守卫：空 / 截断 / 超限都给出可直接展示的中文原因 */
export function checkDocxSaveable(bytes: Uint8Array, options: { maxBytes?: number; label?: string } = {}): SaveGuardResult {
  const name = options.label ?? '文档'
  if (bytes.byteLength === 0) return { ok: false, reason: `${name}没有生成任何内容，已取消保存` }
  const maxBytes = options.maxBytes ?? MAX_REPLACE_BYTES
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: `${name}有 ${formatBytes(bytes.byteLength)}，超过服务端 ${formatBytes(maxBytes)} 上限，请改用下载后本地编辑再上传` }
  }
  if (!looksLikeZip(bytes)) return { ok: false, reason: `${name}的保存结果不是完整的 docx 包，已取消保存以免覆盖原件` }
  return { ok: true }
}

/** 从 `EditorSource` 里取二进制；docx 只接受 bytes */
export function docxSourceBytes(source: EditorSource | null | undefined): Uint8Array | null {
  return source && source.kind === 'bytes' ? source.bytes : null
}

export async function saveDocxBytes(
  bytes: Uint8Array,
  options: DocxSaveOptions & { roundtrip?: boolean },
): Promise<SaveResult & { roundtrip?: RoundtripReport }> {
  const guard = checkDocxSaveable(bytes, { maxBytes: options.maxBytes, label: options.label })
  if (!guard.ok) return { ok: false, revision: 0, sha256: '', reason: guard.reason }

  let report: RoundtripReport | undefined
  if (options.roundtrip) {
    try {
      report = await roundtripCheck(options.collection, options.path, bytes)
    } catch {
      // 预检只是提示：网络失败不应该让用户存不了盘，硬校验留给 replace
      report = undefined
    }
  }
  const expected = typeof options.expectedSha256 === 'function' ? options.expectedSha256() : options.expectedSha256
  try {
    const result = await replaceFile(options.collection, options.path, bytes, expected, options.sessionId)
    return {
      ok: true,
      revision: result.version,
      sha256: result.sha256,
      unchanged: result.unchanged,
      embedded: result.embedded,
      partsRemoved: result.parts_removed,
      roundtrip: report,
    }
  } catch (err) {
    if (err instanceof OfficeEditError) {
      if (err.status === 409) {
        return { ok: false, revision: 0, sha256: '', reason: err.message, conflict: { serverRevision: 0, message: err.message } }
      }
      return { ok: false, revision: 0, sha256: '', reason: err.message }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, revision: 0, sha256: '', reason: `保存失败：${message}` }
  }
}

/** 组装 `DocumentSession` 的保存通道：每次保存取内容面给的字节、过守卫、再交给 replace */
export function createDocxSaveTransport(options: DocxSaveOptions): SessionTransport {
  return {
    async save(request: SessionSaveRequest): Promise<SaveResult> {
      const bytes = docxSourceBytes(request.source)
      if (!bytes) return { ok: false, revision: request.revision, sha256: '', reason: '没有可保存的文档字节' }
      const expected = typeof options.expectedSha256 === 'function' ? options.expectedSha256() : options.expectedSha256
      // 内容没变（引擎重打包后字节完全相同）就不推进版本
      if (expected && (await sha256Hex(bytes)) === expected) {
        return { ok: true, revision: request.revision, sha256: expected, unchanged: true }
      }
      return saveDocxBytes(bytes, options)
    },
  }
}
