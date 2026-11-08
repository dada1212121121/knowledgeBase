<script setup lang="ts">
/**
 * 编辑器底部状态栏
 *
 * 设计约束：
 * 1. 只展示「会话级」信息：脏标记、保存中/冲突、协同连接状态，以及扩展贡献的状态栏项（字数等）。不承载任何编辑动作，
 *    唯一例外是提供「保存」快捷键提示（真正的保存按钮在顶栏，避免两处入口状态不同步）。
 * 2. 与 EditorChrome 一致，只使用全站 CSS 变量，禁止硬编码颜色/字号/圆角。
 * 3. 状态色统一取 `--status-*` 语义变量：绿=已同步/已保存，黄=有未保存改动/同步中，红=冲突/离线。
 */
import { computed } from 'vue'
import type { StatusView } from '../extensions/registry'
import type { CollabConnectionState, CollabRoomStatus, SessionPhase } from '../types'

const props = withDefaults(
  defineProps<{
    /**
     * 底部状态栏的状态栏项（`area: 'status'`）求值后的文字。字数统计口径（文本=字数，表格=单元格数，幻灯片=页数）
     * 由内置的 `kb.builtin.stats` 决定，这里只负责排版
     */
    items?: StatusView[]
    /** 会话阶段 */
    phase?: SessionPhase
    /** 是否有未保存改动 */
    dirty?: boolean
    /** 是否只读 */
    readonly?: boolean
    /** 协同连接状态；null 表示未开启协同 */
    collabState?: CollabConnectionState | null
    /** 协同在线人数（含自己） */
    collabPeers?: number
    /** 上次保存的相对时间文案，如「刚刚」 */
    savedLabel?: string
    /**
     * 正文在协同房间里时的房间状态：房间负责落地，没有「已保存 / 未保存」这回事，
     * 以前这里照样显示「已保存」，房间还没连上、表格是空的时候尤其误导
     */
    room?: { status: CollabRoomStatus; writable: boolean } | null
  }>(),
  {
    phase: 'idle',
    dirty: false,
    readonly: false,
    items: () => [],
    collabState: null,
    collabPeers: 0,
    savedLabel: '',
    room: null,
  },
)

const ROOM_TEXT: Record<CollabRoomStatus, string> = {
  connecting: '正在连接协同…',
  syncing: '正在同步…',
  synced: '已同步',
  offline: '离线，改动先留在本页',
  closed: '协同已结束',
}

/** 状态点的语义色：success / warning / danger / idle */
const tone = computed<'idle' | 'success' | 'warning' | 'danger'>(() => {
  if (props.phase === 'error' || props.phase === 'conflict') return 'danger'
  if (props.room && props.phase === 'ready') {
    if (props.room.status === 'synced') return 'success'
    if (props.room.status === 'closed') return 'danger'
    return 'warning'
  }
  if (props.collabState === 'error' || props.collabState === 'disconnected') return 'warning'
  if (props.phase === 'saving' || props.phase === 'checking' || props.phase === 'loading') return 'warning'
  if (props.dirty) return 'warning'
  if (props.phase === 'ready') return 'success'
  return 'idle'
})

/** 主状态文案：优先显示阻塞性问题，其次才是「有改动/已保存」 */
const primaryText = computed(() => {
  if (props.phase === 'loading') return '正在打开…'
  if (props.phase === 'checking') return '正在检查无损兼容性…'
  if (props.phase === 'saving') return '正在保存…'
  if (props.phase === 'conflict') return '版本冲突：文档已被他人修改'
  if (props.phase === 'error') return '出错了'
  if (props.phase === 'destroyed') return '已关闭'
  if (props.room) {
    const text = ROOM_TEXT[props.room.status] ?? '协同'
    return props.room.writable || props.readonly ? text : `${text} · 只读`
  }
  if (props.readonly) return '只读'
  if (props.dirty) return '有未保存的改动'
  return props.savedLabel ? `已保存 · ${props.savedLabel}` : '已保存'
})

/** 协同状态文案 */
const collabText = computed(() => {
  // 有房间状态时主状态文案已经写了「已同步 / 离线…」，这里不再重复一份（也避免卡在「正在连接」）
  if (props.room) return ''
  switch (props.collabState) {
    case 'connecting':
      return '正在连接协同…'
    case 'connected':
      return props.collabPeers > 1 ? `${props.collabPeers} 人正在编辑` : '协同已连接'
    case 'disconnected':
      return '协同已断开'
    case 'error':
      return '协同连接失败'
    default:
      return ''
  }
})

</script>

<template>
  <footer
    class="kb-editor-status"
    :data-tone="tone"
    data-testid="editor-status-bar"
    role="status"
    aria-live="polite"
  >
    <span class="kb-editor-status-dot" :data-tone="tone" aria-hidden="true" />
    <span class="kb-editor-status-text" data-testid="editor-status-text">{{ primaryText }}</span>

    <span
      v-if="collabText"
      class="kb-editor-status-collab"
      data-testid="editor-status-collab"
    >{{ collabText }}</span>

    <span
      v-for="item in items"
      :key="item.extensionId + ':' + item.id"
      class="kb-editor-status-count"
      :title="item.title"
      :data-testid="`editor-status-${item.id}`"
    >{{ item.text }}</span>
  </footer>
</template>

<style>
.kb-editor-status {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 24px;
  padding: 2px var(--sp-3);
  color: var(--text-secondary);
  background: var(--surface-1);
  border-top: var(--hl) solid var(--border-default);
  font-size: var(--text-12);
  white-space: nowrap;
  overflow: hidden;
}
.kb-editor-status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
}
.kb-editor-status-dot[data-tone='success'] {
  background: var(--status-success-text);
}
.kb-editor-status-dot[data-tone='warning'] {
  background: var(--status-warning-text);
}
.kb-editor-status-dot[data-tone='danger'] {
  background: var(--status-danger-text);
}
.kb-editor-status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kb-editor-status-collab,
.kb-editor-status-count {
  flex: none;
  margin-left: auto;
}
/* 两个右侧元素同时存在时，只有最后一个贴右，前一个跟在后面，避免出现两个 margin-left:auto 的大空隙 */
.kb-editor-status-collab + .kb-editor-status-count,
.kb-editor-status-count + .kb-editor-status-count {
  margin-left: var(--sp-3);
}
</style>
