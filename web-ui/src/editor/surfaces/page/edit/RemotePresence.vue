<script setup lang="ts">
/**
 * 远端光标层：画房间里其他人的光标、选区、名字旗；同时把我自己的光标广播出去。
 *
 * 由上游 `peerless/PeerlessRemotePresence.tsx` 改写（Apache-2.0，见 NOTICE），行为保持：
 * - 位置由引擎换算（`readDocxPresence`）：对方的光标是字节编码的文档位置，主线程不解释，
 *   只能让引擎按当前版面算成页面坐标；换算期间文档或版面变了，结果丢掉等下一帧，不画错位的光标；
 * - 最近一次换算的结果在下一次进行中仍然显示（同一份文档内），所以对方打字时光标不会闪；
 * - 名字旗只在对方刚动过光标的 3 秒内显示，之后收起，避免整页都是名字。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { readDocxPresence, resolvePresenceColor, type DocxCollabHandle, type DocxEditEngine, type DocxPresenceGeometry } from '../../../engines/docx'
import { simplifyRemoteSelectionRects } from './presenceGeometry'

const props = defineProps<{
  engine: DocxEditEngine
  handle: DocxCollabHandle
  /** 当前挂载的页窗口 [start, end)（页序号）；只换算窗口内的光标 */
  pages: readonly [number, number]
}>()

const FLAG_VISIBLE_MS = 3_000
const binding = props.engine.binding
const now = () => performance.now()

const snapshot = shallowRef(binding.viewStore.getSnapshot())
const peers = shallowRef(props.handle.peers())
const paint = shallowRef<{ geometry: NonNullable<typeof snapshot.value.geometry>; reply: DocxPresenceGeometry } | null>(null)
const flagNow = ref(now())
const cleanups: Array<() => void> = []

/* ---------------- 发布我的光标 ---------------- */
let previousVersion = binding.viewStore.getSnapshot().version
let previousKey: string | undefined
function publishCursor(): void {
  const view = binding.viewStore.getSnapshot()
  const selection = view.workerSelection
  const cursor = selection && view.anchors ? { story: selection.anchor.story, anchor: view.anchors.anchor, head: view.anchors.focus } : null
  const key = cursor ? `${cursor.story}:${Array.from(cursor.anchor)}:${Array.from(cursor.head)}` : 'null'
  const changed = view.version !== previousVersion
  previousVersion = view.version
  if (key === previousKey) return
  previousKey = key
  // 第二个参数 broadcast：文档内容刚变（我在打字）时不立刻广播，让输入推断先带上位置，光标更平滑；纯选区移动才即时广播
  props.handle.setCursor(cursor, !changed)
}

/* ---------------- 读别人的光标 ---------------- */
let disposed = false
let queued = false
let busy = false
let dirty = false
const invalid = new Map<string, string>()

function schedule(): void {
  dirty = true
  if (disposed || queued || busy) return
  queued = true
  queueMicrotask(() => {
    queued = false
    if (!disposed) void read()
  })
}

async function read(): Promise<void> {
  dirty = false
  const view = binding.viewStore.getSnapshot()
  const geometry = view.geometry
  if (!geometry?.documentVersion) {
    paint.value = null
    return
  }
  const selected = peers.value
  const window = [props.pages[0], props.pages[1]] as const
  const live = new Set(selected.map((peer) => `${peer.clientId}:${peer.clock}`))
  for (const key of invalid.keys()) if (!live.has(key)) invalid.delete(key)
  const current = () => !disposed && geometry === binding.viewStore.getSnapshot().geometry && view.version === binding.viewStore.getSnapshot().version && selected === peers.value
  busy = true
  try {
    const reply = await readDocxPresence(props.engine.client, {
      // 已经确认"这个版本下解析不出来"的光标不再重复问，除非有新的输入推断
      peers: selected
        .filter((peer) => peer.inferredCursor || invalid.get(`${peer.clientId}:${peer.clock}`) !== geometry.documentVersion)
        .map((peer) => ({
          clientId: peer.clientId,
          clock: peer.clock,
          ...(peer.cursor ? { cursor: peer.cursor } : {}),
          ...(peer.inferredCursor ? { inferred: { story: peer.inferredCursor.story, paraId: peer.inferredCursor.paraId, offset: peer.inferredCursor.endOffset } } : {}),
        })),
      pages: window,
      version: geometry.documentVersion,
      frameEpoch: geometry.frameEpoch,
      layoutRevision: geometry.layoutRevision,
    })
    if (!current()) return
    if (!reply || reply.version !== geometry.documentVersion || reply.frameEpoch !== geometry.frameEpoch || reply.layoutRevision !== geometry.layoutRevision) {
      paint.value = null
      return
    }
    for (const peer of reply.peers) {
      if (peer.status === 'unresolved' && !selected.find((candidate) => candidate.clientId === peer.clientId)?.inferredCursor) {
        const clock = selected.find((candidate) => candidate.clientId === peer.clientId)?.clock
        invalid.set(`${peer.clientId}:${clock}`, geometry.documentVersion)
      }
    }
    paint.value = { geometry, reply }
  } catch {
    if (current()) paint.value = null
  } finally {
    busy = false
    if (dirty) schedule()
  }
}

onMounted(() => {
  publishCursor()
  cleanups.push(
    binding.viewStore.subscribe(() => {
      snapshot.value = binding.viewStore.getSnapshot()
      publishCursor()
      schedule()
    }),
  )
  cleanups.push(
    props.handle.onPeers((next) => {
      peers.value = next
      schedule()
    }),
  )
  schedule()
})
watch(() => [props.pages[0], props.pages[1]], schedule)
onBeforeUnmount(() => {
  disposed = true
  for (const stop of cleanups.splice(0)) stop()
  // 离开时撤掉我的光标：否则别人那里会留一个不动的幽灵光标直到超时
  props.handle.setCursor(null)
})

/* ---------------- 名字旗的显隐计时 ---------------- */
let flagTimer: ReturnType<typeof setTimeout> | null = null
watch(
  [paint, peers, flagNow],
  () => {
    if (flagTimer) clearTimeout(flagTimer)
    flagTimer = null
    if (!paint.value) return
    const deadlines = peers.value.map((peer) => peer.cursorMovedAt + FLAG_VISIBLE_MS).filter((deadline) => deadline > now())
    if (deadlines.length) flagTimer = setTimeout(() => (flagNow.value = now()), Math.max(0, Math.min(...deadlines) - now()))
  },
  { flush: 'post' },
)
onBeforeUnmount(() => {
  if (flagTimer) clearTimeout(flagTimer)
})

/* ---------------- 绘制 ---------------- */
const sameIdentity = (left: { session: string; incarnation: number; epoch: number }, right: { session: string; incarnation: number; epoch: number }) =>
  left.session === right.session && left.incarnation === right.incarnation && left.epoch === right.epoch

/** 上一次换算的结果在新一帧到来前继续显示，但只在同一个文档会话里（换了会话位置就不对了） */
const shown = computed(() => {
  const geometry = snapshot.value.geometry
  const held = paint.value
  return geometry && held && sameIdentity(held.geometry.identity, geometry.identity) ? held : null
})

function project(rect: { pageId: string; pageIndex: number; x: number; y: number; width: number; height: number }) {
  const page = snapshot.value.geometry?.pages.find((item) => item.page.pageId === rect.pageId && item.page.pageIndex === rect.pageIndex)
  return page ? { left: page.bounds.x + rect.x, top: page.bounds.y + rect.y, width: rect.width, height: rect.height } : null
}

interface Painted {
  clientId: number
  name: string
  color: string
  flag: boolean
  caret: { left: number; top: number; width: number; height: number } | null
  rects: Array<{ left: number; top: number; width: number; height: number }>
}

const painted = computed<Painted[]>(() => {
  const current = shown.value
  if (!current) return []
  void flagNow.value
  const out: Painted[] = []
  for (const geometry of current.reply.peers) {
    const peer = peers.value.find((candidate) => candidate.clientId === geometry.clientId)
    if (!peer || geometry.status !== 'ok') continue
    const rects = simplifyRemoteSelectionRects(geometry.rects, { start: props.pages[0], end: props.pages[1] - 1 }).flatMap((rect) => {
      const pageId = geometry.rects.find((original) => original.pageIndex === rect.pageIndex)?.pageId
      const projected = pageId ? project({ ...rect, pageId }) : null
      return projected ? [projected] : []
    })
    out.push({
      clientId: peer.clientId,
      name: peer.user?.name ?? '',
      color: resolvePresenceColor(peer.clientId, peer.user?.color),
      flag: peer.cursorMovedAt > 0 && Math.max(flagNow.value, now()) - peer.cursorMovedAt < FLAG_VISIBLE_MS,
      caret: geometry.caret ? project(geometry.caret) : null,
      rects,
    })
  }
  return out
})
</script>

<template>
  <div class="kb-dex-presence" data-testid="remote-presence-overlay" aria-hidden="true">
    <template v-for="peer in painted" :key="peer.clientId">
      <div
        v-for="(rect, index) in peer.rects"
        :key="`${peer.clientId}:range:${index}`"
        class="kb-dex-presence-range"
        :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, backgroundColor: `color-mix(in srgb, ${peer.color} 18%, transparent)`, borderColor: `color-mix(in srgb, ${peer.color} 28%, transparent)` }"
      />
      <div
        v-if="peer.caret"
        class="kb-dex-presence-caret"
        data-testid="remote-presence-caret"
        :data-client-id="peer.clientId"
        :data-name="peer.name"
        :style="{ left: `${peer.caret.left - 1}px`, top: `${peer.caret.top}px`, height: `${peer.caret.height}px`, backgroundColor: peer.color }"
      >
        <div class="kb-dex-presence-flag" :class="{ 'is-visible': peer.flag }" :style="{ backgroundColor: peer.color }">{{ peer.name }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kb-dex-presence {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
  z-index: 30;
}
.kb-dex-presence-range {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid transparent;
}
.kb-dex-presence-caret {
  position: absolute;
  width: 2px;
  border-radius: 1px;
}
.kb-dex-presence-flag {
  position: absolute;
  left: 0;
  bottom: 100%;
  max-width: 0;
  padding: 0;
  overflow: hidden;
  opacity: 0;
  color: #fff;
  font: 600 11px/16px system-ui, sans-serif;
  white-space: nowrap;
  border-radius: 4px 4px 4px 0;
  transform: translateY(2px);
  transition:
    opacity 160ms ease,
    transform 160ms ease,
    max-width 160ms ease,
    padding 160ms ease;
}
.kb-dex-presence-flag.is-visible {
  max-width: 180px;
  padding: 3px 6px;
  opacity: 1;
  transform: translateY(0);
}
</style>
