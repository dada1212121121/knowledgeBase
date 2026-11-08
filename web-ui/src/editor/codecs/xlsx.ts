/**
 * XLSX 保存编解码：整包保存的通用实现在 officeSave.ts，这里只带上 xlsx 的格式名与提示
 */
import type { SessionTransport } from '../session/DocumentSession'
import type { SaveResult } from '../types'
import type { RoundtripReport } from '../../api/officeEdit'
import { createOfficeSaveTransport, saveOfficeBytes, sourceBytes, type OfficeKindInfo, type OfficeSaveOptions } from './officeSave'

export { sourceBytes }
export type XlsxSaveOptions = OfficeSaveOptions

const XLSX: OfficeKindInfo = { kind: 'xlsx', defaultLabel: '表格', emptyReason: '没有可保存的表格字节' }

/** 保存整份工作簿（守卫 → 可选无损预检 → replace） */
export function saveXlsxBytes(bytes: Uint8Array, options: OfficeSaveOptions & { roundtrip?: boolean }): Promise<SaveResult & { roundtrip?: RoundtripReport }> {
  return saveOfficeBytes(XLSX, bytes, options)
}

/** 组装 `DocumentSession` 的保存通道 */
export function createXlsxSaveTransport(options: OfficeSaveOptions): SessionTransport {
  return createOfficeSaveTransport(XLSX, options)
}
