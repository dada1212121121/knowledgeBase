/**
 * PPTX 多人协同后端
 *
 * 单独成文件、由 OfficeEditor 在真正加入协同时才动态 import：单人编辑不该为协同多取一个 chunk
 * （`CollaborationProvider` 在引擎的 collaboration 子包里，单人路径多一次依赖请求，慢网络下热开多一个往返）。
 */
import { CollaborationProvider, openPresentation } from '@betteroffice/pptx'
import type { CollaborationTransport } from '@betteroffice/pptx'
import { NATIVE_FONT_FAMILIES, loadCjkMetrics, loadLatinMetrics } from './fonts/pptxFonts'
import { sharedGlyphFaces } from './fonts/glyphFaces'
import type { SlideCollab, SlidePeer } from '../surfaces/slide/types'
import { ensureEngine } from './pptx'
import { peekDeckText } from './pptxPeek'
import { PptxEditBackend, handleDriver } from './pptxEdit'

export interface CollabJoin {
  /** 房间的 WebSocket 传输（`collab/officeRoomTransport.ts` 的 createOfficeTransport） */
  transport: CollaborationTransport
  user: { name: string; color?: string }
  /** 没有写权限的参与者：能看、能看到别人的光标，不能改 */
  readonly: boolean
  /** 连接状态与在线的人变化 */
  onStatus?: (status: { status: string; synced: boolean; peers: string[] }) => void
}

/**
 * 加入多人协同编辑。和单人编辑的差别：
 * - 上游规定协同时不能用 Worker 编辑会话，句柄直接开在主线程（解析会占主线程，耗时随文档增长，没有单独测量；之后每次修改同步应用）；
 * - 从房间底稿的字节打开：浏览器副本、服务端副本、其他浏览器的初始状态天然相同，谁先连都能对上；
 * - 修改经 `CollaborationProvider` 增量发给房间，文件由服务端副本去抖落地（本地没有「保存」）；
 * - 别人的修改（含 AI 的 `doc_edit`）经同一条路到达，后端发 `remote` 变化通知，界面整体刷新。
 */
export async function openPptxCollab(bytes: Uint8Array, join: CollabJoin): Promise<PptxEditBackend> {
  const glyphs = sharedGlyphFaces()
  void glyphs.ensureCore()
  void peekDeckText(bytes).then((text) => glyphs.ensureText(text))
  const [latin, cjk] = await Promise.all([loadLatinMetrics(), loadCjkMetrics(), ensureEngine()])
  const fonts = NATIVE_FONT_FAMILIES.flatMap((family) => [
    { family, bytes: latin.regular },
    { family, bold: true, bytes: latin.bold },
    { family, bytes: cjk },
  ])
  const clientId = (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff) || 1
  const handle = openPresentation(bytes, { fonts, clientId })
  handle.setCollaborative()
  const provider = new CollaborationProvider(handle, join.transport, { user: join.user })
  const failListeners = new Set<(error: Error) => void>()
  // 协议 / 副本错误是不可恢复的（继续写会和房间分叉）；传输错误和背压会自己重试，不算失败
  const offError = provider.onError((error) => {
    if (error.code === 'protocol' || error.code === 'replica') for (const listener of [...failListeners]) listener(error)
  })
  const driver = handleDriver(handle, {
    fail: (listener) => {
      failListeners.add(listener)
      return () => failListeners.delete(listener)
    },
    dispose: () => {
      offError()
      provider.destroy()
      join.transport.disconnect()
    },
  })
  const backend = new PptxEditBackend(driver, join.readonly)
  backend.prepare([])
  await backend.loadGlyphs()
  backend.collab = makeCollab(provider, backend, join)
  provider.connect()
  return backend
}

/** 把引擎的在线状态（按 slideId）换成界面用的（按页序号） */
function makeCollab(provider: CollaborationProvider, backend: PptxEditBackend, join: CollabJoin): SlideCollab {
  const toPeers = (): SlidePeer[] =>
    provider.peers.map((peer) => {
      const cursor = peer.state.cursor
      const ids = backend.slides().map((slide) => slide.id)
      return {
        id: peer.state.clientId,
        name: peer.state.user.name,
        color: peer.state.user.color,
        slide: cursor ? ids.indexOf(cursor.slideId) : -1,
        shapeId: cursor?.shapeId ?? null,
      }
    })
  let status = { status: 'connecting', synced: false }
  const report = () => join.onStatus?.({ ...status, peers: provider.peers.map((peer) => peer.state.user.name) })
  provider.onStatus((change) => {
    status = change
    report()
  })
  provider.onPresence(report)
  return {
    peers: toPeers,
    onPeers: (listener) => provider.onPresence(() => listener()),
    setCursor(slide, shapeId) {
      if (slide === null) return provider.setCursor(null)
      const slideId = backend.slides()[slide]?.id
      if (slideId) provider.setCursor(shapeId ? { slideId, shapeId } : { slideId })
    },
  }
}
