/**
 * PPTX 保存编解码
 *
 * 保存走和 xlsx 同一条经过验证的整包链路（officeSave.ts）：
 * - 本地守卫：空 / 截断 / 超限的字节发请求之前就拦住，绝不覆盖原件；
 * - `PUT /api/v1/files/replace`：服务端 `office_check::validate` 整包检查不完整就拒绝，原文件不动；乐观锁 + 编辑权；
 * - 保存前的无损预检用 `/api/v1/files/roundtrip-check`（见 OfficeEditor 打开时的检查）。
 * 引擎侧的字节来自 `PptxEditBackend.save`：未改动的部件原样保留，只有被编辑的 slide XML 会变。
 */
import type { SessionTransport } from '../session/DocumentSession'
import type { SaveResult } from '../types'
import type { RoundtripReport } from '../../api/officeEdit'
import { createOfficeSaveTransport, saveOfficeBytes, type OfficeKindInfo, type OfficeSaveOptions } from './officeSave'

export type PptxSaveOptions = OfficeSaveOptions

const PPTX: OfficeKindInfo = { kind: 'pptx', defaultLabel: '演示文稿', emptyReason: '没有可保存的演示文稿字节' }

/** 保存整份演示文稿（守卫 → 可选无损预检 → replace） */
export function savePptxBytes(bytes: Uint8Array, options: OfficeSaveOptions & { roundtrip?: boolean }): Promise<SaveResult & { roundtrip?: RoundtripReport }> {
  return saveOfficeBytes(PPTX, bytes, options)
}

/** 组装 `DocumentSession` 的保存通道 */
export function createPptxSaveTransport(options: OfficeSaveOptions): SessionTransport {
  return createOfficeSaveTransport(PPTX, options)
}
