<script setup lang="ts">
// AI 管家的「历史会话」列表:悬浮窗与 /agent 页面共用。
// 支持置顶、重命名、按项目筛选、删除。
import { computed, ref } from 'vue'
import { KbButton, KbIcon, KbSelect, KbSkeleton, isComposing } from '@kb-ui/index'
import {
  projectOptions,
  sessionLabel,
  timeAgo,
  type AgentSessionSummary,
} from '@/utils/agent'

const props = defineProps<{
  sessions: AgentSessionSummary[]
  /** 当前会话 id(高亮用)。 */
  current: string
  loading?: boolean
  /** 读取失败:要说"没能读取"而不是"还没有会话"(读不到和没有是两回事),并给重试 */
  failed?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  remove: [id: string]
  create: []
  rename: [id: string, title: string]
  pin: [id: string, pinned: boolean]
  retry: []
}>()

/** 项目筛选(空 = 全部)。 */
const filterProject = ref('')
const options = computed(() => projectOptions(props.sessions))
const visible = computed(() =>
  filterProject.value
    ? props.sessions.filter((item) => item.project === filterProject.value)
    : props.sessions,
)

/** 行内重命名。 */
const editingId = ref('')
const editingTitle = ref('')
function startRename(item: AgentSessionSummary) {
  editingId.value = item.session_id
  editingTitle.value = item.title
}
function commitRename() {
  const id = editingId.value
  if (!id) return
  const title = editingTitle.value.trim()
  editingId.value = ''
  const before = props.sessions.find((item) => item.session_id === id)?.title ?? ''
  if (title !== before) emit('rename', id, title)
}
function cancelRename() {
  editingId.value = ''
}
</script>

<template>
  <div class="kb-agent-sessions">
    <div class="kb-agent-sessions-head">
      <span class="m kb-small">历史会话</span>
      <KbSelect
        v-if="options.length > 1"
        v-model="filterProject"
        :options="options"
        size="sm"
        display="项目"
        align="start"
        class="kb-agent-sessions-filter"
      />
      <span class="kb-spacer"></span>
      <KbButton size="sm" @click="emit('create')">新会话</KbButton>
    </div>
    <div v-if="loading" class="kb-agent-sessions-empty" data-testid="sessions-loading"><KbSkeleton variant="lines" :lines="3" /></div>
    <div v-else-if="failed" class="kb-hint kb-agent-sessions-empty kb-agent-sessions-failed" role="alert" data-testid="sessions-error">
      <span>没能读取历史会话。请检查网络后重试。</span>
      <button type="button" class="btn sm" data-testid="sessions-retry" @click="emit('retry')">重试</button>
    </div>
    <div v-else-if="!sessions.length" class="kb-hint kb-agent-sessions-empty">
      还没有历史会话,发一句话就会出现在这里
    </div>
    <div v-else-if="!visible.length" class="kb-hint kb-agent-sessions-empty">
      这个项目还没有会话
    </div>
    <ul v-else class="kb-agent-sessions-list">
      <li
        v-for="item in visible"
        :key="item.session_id"
        class="kb-agent-sessions-item"
        :class="{ 'is-pinned': item.pinned }"
      >
        <button
          type="button"
          class="kb-agent-session-pin"
          :class="{ 'is-on': item.pinned }"
          :title="item.pinned ? '取消置顶' : '置顶这个会话'"
          :aria-label="item.pinned ? '取消置顶' : '置顶'"
          @click.stop="emit('pin', item.session_id, !item.pinned)"
        >
          {{ item.pinned ? '★' : '☆' }}
        </button>
        <input
          v-if="editingId === item.session_id"
          v-model="editingTitle"
          class="kb-agent-session-rename"
          aria-label="会话标题"
          autofocus
          @keydown.enter.prevent="!isComposing($event) && commitRename()"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <button
          v-else
          type="button"
          class="kb-agent-session"
          :class="{ 'is-active': item.session_id === current }"
          :title="item.title"
          @click="emit('select', item.session_id)"
        >
          <span class="kb-agent-session-title">{{ sessionLabel(item.title) }}</span>
          <span class="kb-agent-session-meta">
            <span v-if="item.backend === 'acp'" class="kb-agent-session-project">ACP</span>
            <span v-if="item.project" class="kb-agent-session-project">{{ item.project }}</span>
            <!-- 时间和条数包一层:侧栏只有 180 多像素宽,裸文本没法省略,会折成三行把行高撑起来 -->
            <span class="kb-agent-session-when">{{ timeAgo(item.last_at) }} · {{ item.messages }} 条</span>
          </span>
        </button>
        <button
          v-if="editingId !== item.session_id"
          type="button"
          class="btn sm kb-ghost kb-agent-session-edit"
          title="重命名"
          aria-label="重命名"
          @click.stop="startRename(item)"
        >
          <KbIcon name="edit" :size="11" />
        </button>
        <button
          v-if="editingId !== item.session_id"
          type="button"
          class="btn sm kb-ghost kb-agent-session-del"
          title="删除这个会话"
          aria-label="删除会话"
          @click.stop="emit('remove', item.session_id)"
        >
          <KbIcon name="close" :size="11" />
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.kb-agent-sessions {
  display: flex;
  flex-direction: column;
  gap: var(--gap-xs);
  padding: var(--gap-sm) var(--gap);
  border-bottom: var(--hl) solid var(--border-default);
  background: var(--surface-2);
}
.kb-agent-sessions-head {
  display: flex;
  align-items: center;
  gap: var(--gap-xs);
}
.kb-agent-sessions-filter {
  max-width: 140px;
}
.kb-agent-sessions-empty {
  padding: var(--gap-xs) 0;
}
.kb-agent-sessions-failed {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--gap-xs);
}
.kb-agent-sessions-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
}
.kb-agent-sessions-item {
  display: flex;
  align-items: center;
  gap: 2px;
}
.kb-agent-session-pin {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  color: var(--t2);
  font-size: calc(13px * var(--fs));
  line-height: 1;
  cursor: pointer;
}
.kb-agent-session-pin:hover {
  background: var(--hover);
  color: var(--t);
}
.kb-agent-session-pin.is-on {
  /* 用「警告文字色」而不是装饰黄 --y:浅色主题下 ★ 在浅底上只有 2.6:1,看不清 */
  color: var(--status-warning-text);
}
.kb-agent-session {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: var(--sp-2);
  border: var(--hl) solid transparent;
  border-radius: var(--r2);
  background: transparent;
  color: var(--t);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.kb-agent-session:hover {
  background: var(--hover);
}
.kb-agent-session.is-active {
  border-color: var(--ac);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.kb-agent-session-title {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(13px * var(--fs));
}
.kb-agent-session-meta {
  display: flex;
  /* 标题行是 flex-start,元信息这一行会缩成「内容宽度」,项目名 + 时间比它还宽时就一起被省略
     (面板 288 宽,元信息只剩 165,连「ACP」都显示不全)。撑满按钮宽度再省略 */
  width: 100%;
  align-items: center;
  /* 会话的元信息只占一行:侧栏 180 多像素宽,项目名一长就会把它折成三行,行高从 60 撑到 95,
     和相邻会话行对不上。这里显式不折行,由下面的 chip / 时间各自省略 */
  /* 侧栏 288px,元信息行只有 165px:项目名 + 时间一排放不下(两枚 chip 加起来 125,
     再加 87 就超 30px)。改成「项目在左、时间换到第二行」,两行都完整,行高靠固定两行保持整齐 */
  flex-wrap: wrap;
  overflow: hidden;
  gap: 2px var(--sp-1);
  min-width: 0;
  max-width: 100%;
  font-size: calc(11px * var(--fs));
  color: var(--t2);
}
.kb-agent-session-project {
  /* 项目名不参与收缩:一行放不下时由折行解决(见下面 .kb-agent-session-when 独占一行),
     单个 chip 最多占 64%,再长才省略 */
  flex: 0 0 auto;
  min-width: 0;
  max-width: 64%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 5px;
  border-radius: var(--r1);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--t);
}
.kb-agent-session-when {
  /* 独占第二行:项目名和「10 小时前 · 12 条」在 165px 里放不下一排 */
  flex: 0 0 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-agent-session-rename {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: var(--hl) solid var(--ac);
  border-radius: var(--r2);
  background: var(--surface-1);
  color: var(--t);
  font: inherit;
  font-size: calc(13px * var(--fs));
}
.kb-agent-session-edit,
.kb-agent-session-del {
  flex: none;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
/* 触屏:置顶星标 20px 见方太小,撑到 44px(重命名 / 删除是 .btn.sm,宽度由全局触屏规则保证 44px) */
@media (pointer: coarse) {
  .kb-agent-session-pin { width: 44px; height: 44px; font-size: calc(18px * var(--fs)); }
}
.kb-agent-sessions-item:hover .kb-agent-session-edit,
.kb-agent-sessions-item:hover .kb-agent-session-del,
.kb-agent-session-edit:focus-visible,
.kb-agent-session-del:focus-visible {
  opacity: 1;
}
</style>
