/**
 * Office 整包保存（xlsx / pptx 共用， 起， 抽出）
 *
 * 保存链路刻意复用旧链路已经验证过的两个服务端能力，而不是新造接口：
 * - `PUT /api/v1/files/replace`：整份字节替换，内部跑 `office_check::validate`，
 *   并用 `expected_sha256` 做乐观锁（别人先保存 → 409），用 `session` 校验编辑权；
 * - `POST /api/v1/files/roundtrip-check`：可选的无损预检（本次字节相对原件改了哪些部件）。
 *
 * 本层只负责「字节 → SaveResult」的映射与错误分类，HTTP 细节留在 `api/officeEdit.ts`，
 * 会话状态机（saving/conflict/error）由 `DocumentSession` 维护，避免两处各写一套。
 */
import { OfficeEditError, replaceFile, roundtripCheck, type RoundtripReport } from '../../api/officeEdit'
import type { SessionSaveRequest, SessionTransport } from '../session/DocumentSession'
import type { EditorSource, SaveResult } from '../types'
import { checkOfficeSaveable, sha256Hex } from './saveGuard'

export interface OfficeSaveOptions {
  collection: string
  path: string
  /**
   * 打开（或上次保存）时的原件哈希；服务端据此判断是否被别人改过。
   * 传函数是为了编辑会话保存成功后更新基线，而 transport 只创建一次。
   */
  expectedSha256: string | (() => string)
  /** 编辑器窗口编号；有编辑权锁时一并带上，服务端会校验持有人 */
  sessionId?: string
  maxBytes?: number
  /** 文件名，用于错误提示 */
  label?: string
}

/** 各格式的差异：错误提示里的格式名与文件称呼 */
export interface OfficeKindInfo {
  kind: string
  defaultLabel: string
  /** 没有可保存字节时的提示 */
  emptyReason: string
}

/** 从 `EditorSource` 里取二进制；Office 只接受 bytes，别的形状说明装配错了 */
export function sourceBytes(source: EditorSource | null | undefined): Uint8Array | null {
  if (!source || source.kind !== 'bytes') return null
  return source.bytes
}

/**
 * 保存整份文档。
 *
 * `roundtrip` 为真时先打一次无损预检：失败只作为提示返回，不阻断保存——
 * 引擎重新打包本来就可能调整部件顺序，真正的硬校验在 replace 内部。
 */
export async function saveOfficeBytes(
  info: OfficeKindInfo,
  bytes: Uint8Array,
  options: OfficeSaveOptions & { roundtrip?: boolean },
): Promise<SaveResult & { roundtrip?: RoundtripReport }> {
  const guard = checkOfficeSaveable(bytes, { maxBytes: options.maxBytes, label: options.label, kind: info.kind, defaultLabel: info.defaultLabel })
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

/**
 * 组装 `DocumentSession` 的保存通道。
 *
 * 会话只认 `EditorSource`，这里在每次保存时取表面提供的字节、做守卫、再交给 replace；
 * 返回的 `SaveResult` 会驱动会话进入 ready / conflict / error。
 */
export function createOfficeSaveTransport(info: OfficeKindInfo, options: OfficeSaveOptions): SessionTransport {
  return {
    async save(request: SessionSaveRequest): Promise<SaveResult> {
      const bytes = sourceBytes(request.source)
      if (!bytes) return { ok: false, revision: request.revision, sha256: '', reason: info.emptyReason }
      const expected = typeof options.expectedSha256 === 'function' ? options.expectedSha256() : options.expectedSha256
      // 内容没变（引擎重打包后字节完全相同）就不推进版本
      if (expected && (await sha256Hex(bytes)) === expected) {
        return { ok: true, revision: request.revision, sha256: expected, unchanged: true }
      }
      return saveOfficeBytes(info, bytes, options)
    },
  }
}
