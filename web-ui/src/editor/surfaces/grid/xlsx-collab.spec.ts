import { describe, expect, it } from 'vitest'
import {
  OFFICE_COLLAB_MAX_BYTES,
  collabLimitReason,
  peersOnSheet,
  xlsxCollabText,
} from './xlsx-collab'
import type { XlsxCollabPeer, XlsxCollabStatus } from '../../engines/xlsx'

const peer = (name: string, sheet: string): XlsxCollabPeer => ({
  clientId: name.length,
  name,
  color: '#e03131',
  sheet,
  anchor: { row: 0, col: 0 },
  head: { row: 0, col: 0 },
})

describe('xlsx 协同辅助', () => {
  it('只保留当前工作表的远端光标', () => {
    const peers = [peer('甲', 's1'), peer('乙', 's2'), peer('丙', 's1')]
    expect(peersOnSheet(peers, 's1').map((item) => item.name)).toEqual(['甲', '丙'])
    expect(peersOnSheet(peers, undefined)).toEqual([])
  })

  it('状态条区分连接中 / 同步中 / 离线，并列出在线的人', () => {
    const status = (patch: Partial<XlsxCollabStatus>): XlsxCollabStatus => ({
      status: 'connected',
      synced: true,
      peers: [],
      ...patch,
    })
    expect(xlsxCollabText(status({}))).toBe('多人协同 · 已同步')
    expect(xlsxCollabText(status({ synced: false }))).toBe('多人协同 · 同步中…')
    expect(xlsxCollabText(status({ status: 'disconnected' }))).toContain('离线')
    expect(xlsxCollabText(status({ peers: [peer('甲', 's1')] }))).toContain('另有 1 人在编辑：甲')
  })

  it('超过 1.5 MB 时给出明确原因，不静默退回单人', () => {
    expect(OFFICE_COLLAB_MAX_BYTES).toBe(1.5 * 1024 * 1024)
    expect(collabLimitReason(2 * 1024 * 1024)).toContain('2.0 MB')
    expect(collabLimitReason(2 * 1024 * 1024)).toContain('单人编辑')
    expect(collabLimitReason(2 * 1024 * 1024, '协同服务没装')).toBe('协同服务没装')
  })
})
