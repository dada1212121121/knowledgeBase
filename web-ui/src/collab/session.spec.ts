import { describe, expect, it } from 'vitest'
import { collabUrl, diagnosisFromStatus, probeRequest } from './session'

describe('collabUrl', () => {
  it('登录用户:同源 ws(https 下是 wss),资源键整体做 URL 编码', () => {
    expect(collabUrl({ spaceId: 'sp_a', collection: '_global', doc: { insight: 'x1' } }, { protocol: 'http:', host: '127.0.0.1:7878' })).toBe(
      'ws://127.0.0.1:7878/api/v1/collab/ws?doc=doc%3Asp_a%2F_global%2Fi%2Fx1',
    )
    expect(collabUrl({ spaceId: 'sp_a', collection: 'c', doc: { file: 'a b.txt' } }, { protocol: 'https:', host: 'kb.example.com' })).toBe(
      'wss://kb.example.com/api/v1/collab/ws?doc=doc%3Asp_a%2Fc%2Ff%2Fa%2520b.txt',
    )
  })
  it('分享链接的访问者走链接自己的入口', () => {
    expect(collabUrl({ spaceId: 'sp_a', collection: 'c', doc: { insight: 'i' }, linkToken: 'Tok_en-1' }, { protocol: 'https:', host: 'h' })).toBe(
      'wss://h/api/v1/share/Tok_en-1/collab?doc=doc%3Asp_a%2Fc%2Fi%2Fi',
    )
  })
})

describe('握手失败后的原因探测', () => {
  it('状态码翻成人话:没登录 / 没权限 / 不存在 / 已删除是终止性的,限流和暂不可用只提示继续重试', () => {
    expect(diagnosisFromStatus(401)).toMatchObject({ kind: 'unauthorized' })
    expect(diagnosisFromStatus(403)).toMatchObject({ kind: 'denied' })
    expect(diagnosisFromStatus(404)).toMatchObject({ kind: 'denied' })
    expect(diagnosisFromStatus(410)).toMatchObject({ kind: 'deleted' })
    expect(diagnosisFromStatus(429)).toMatchObject({ kind: 'retry' })
    expect(diagnosisFromStatus(503)).toMatchObject({ kind: 'retry' })
    expect(diagnosisFromStatus(200)).toMatchObject({ kind: 'retry' })
    expect(diagnosisFromStatus(500)).toBeNull()
  })
  it('404 的说法不泄露文档到底存不存在(和后端「对陌生人一律 404」一致)', () => {
    expect(diagnosisFromStatus(404)!.message).toContain('不存在,或者')
  })
  it('探测请求:笔记用 get_item、文件用 file_preview,都带上文档所在的知识库;链接访问者问链接自己', () => {
    const note = probeRequest({ spaceId: 'sp_a', collection: 'c', doc: { insight: 'n1' } })
    expect(note.url).toBe('/api/v1/capabilities/get_item')
    expect((note.init.headers as Record<string, string>)['x-kb-space']).toBe('sp_a')
    expect(JSON.parse(note.init.body as string)).toEqual({ id: 'n1' })
    const file = probeRequest({ spaceId: 'sp_a', collection: 'c', doc: { file: 'a/b.txt' } })
    expect(file.url).toBe('/api/v1/capabilities/file_preview')
    expect(JSON.parse(file.init.body as string)).toEqual({ collection: 'c', path: 'a/b.txt' })
    expect(probeRequest({ spaceId: 'sp_a', collection: 'c', doc: { insight: 'n1' }, linkToken: 'T k' }).url).toBe('/api/v1/share/T%20k')
  })
})
