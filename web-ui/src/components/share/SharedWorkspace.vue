<script setup lang="ts">
// 知识库页右侧「共享给我」的工作区:打开别人分享给我的一份内容(文档,或文件夹 / 集合里的文档)。
// 顶部说清楚是谁分享的、我是什么权限;不能编辑时显示「只读」+「申请编辑」(access_request),
// 可管理的人还能继续分享(最多授予与自己相同的角色)。内容的读写都带 X-KB-Space 走对方的知识库(后端逐次检查)。
import { computed, onMounted, ref, watch } from 'vue'
import { KbBadge, KbButton, KbIcon, useConfirm } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import RequestAccessDialog from './RequestAccessDialog.vue'
import SharedDoc from './SharedDoc.vue'
import SharedFolder from './SharedFolder.vue'
import SharePanel from './SharePanel.vue'
import { accessRequests, spaceAccess, type ShareTarget, type SharedWithMeItem } from '@/api/share'
import { useFeature } from '@/composables/useFeature'
import { useSessionStore } from '@/stores/session'
import { personName, roleLabel, roleRank, sameTarget, targetKey } from '@/utils/share'

const props = defineProps<{
  item: SharedWithMeItem
  narrow?: boolean
  /** 进来就直接打开的那篇文档(授权是它的上级目录 / 集合时,从通知点进来用);不给就停在授权本身 */
  focus?: ShareTarget | null
}>()
const emit = defineEmits<{ back: []; hide: [item: SharedWithMeItem] }>()

const confirmer = useConfirm()
const session = useSessionStore()
const canShareFeature = useFeature('collab.share')

interface Step {
  target: ShareTarget
  title: string
}
const baseTrail = (): Step[] => {
  const root: Step = { target: props.item.target, title: props.item.title }
  const focus = props.focus
  // 只直达文档,且它不是授权本身;标题先用文件名,SharedDoc 读到后自己显示真正的标题
  if (focus && (focus.kind === 'insight' || focus.kind === 'file') && !sameTarget(focus, props.item.target)) {
    return [root, { target: focus, title: focus.kind === 'file' ? (focus.path?.split('/').pop() ?? '文档') : '文档' }]
  }
  return [root]
}
const trail = ref<Step[]>(baseTrail())
const current = computed(() => trail.value[trail.value.length - 1]!)
const isFolder = computed(() => ['dir', 'collection', 'space'].includes(current.value.target.kind))
const space = computed(() => props.item.target.space_id ?? '')
const access = computed(() => spaceAccess(space.value, props.item.role))
const doc = ref<{ dirty: boolean } | null>(null)

watch(
  () => props.item.key,
  () => {
    trail.value = baseTrail()
    void loadRequests()
  },
)

/** 有未保存的修改时,离开这一篇之前先问 */
async function leaveOk(): Promise<boolean> {
  if (!doc.value?.dirty) return true
  return confirmer.ask({ title: '放弃未保存的修改?', message: '这篇文档的改动不会保留。', confirmText: '放弃修改', cancelText: '继续编辑', tone: 'danger' })
}
async function open(target: ShareTarget, title: string) {
  if (!(await leaveOk())) return
  trail.value = [...trail.value, { target, title }]
}
async function goTo(index: number) {
  if (index === trail.value.length - 1 || !(await leaveOk())) return
  trail.value = trail.value.slice(0, index + 1)
}
async function up() {
  if (trail.value.length > 1) await goTo(trail.value.length - 2)
  else if (await leaveOk()) emit('back')
}

// ---------------------------------------------------------------- 申请编辑 / 继续分享
const requesting = ref(false)
const sharing = ref(false)
/** 我已经发出、还在等对方处理的申请(对这份内容或它所在的根) */
const pendingRequest = ref(false)
async function loadRequests() {
  try {
    const result = await accessRequests()
    pendingRequest.value = result.mine.some((request) => request.state === 'pending' && request.target && (sameTarget(request.target, current.value.target) || sameTarget(request.target, props.item.target)))
  } catch {
    // 只是少一个「已申请」的提示:取不到时照常允许申请,后端会拦住 24 小时内的重复申请
    pendingRequest.value = false
  }
}
onMounted(() => void loadRequests())
watch(() => targetKey(current.value.target), () => void loadRequests())

const canEditHere = computed(() => access.value.can.edit)
const canManage = computed(() => roleRank(props.item.role) >= roleRank('manager') && canShareFeature.value)
const owner = computed(() => props.item.owner)

defineExpose({ doc })
</script>

<template>
  <section class="kb-sws" data-testid="shared-workspace">
    <header class="kb-sws-bar">
      <button v-if="narrow || trail.length > 1" type="button" class="btn sm kb-sws-back" aria-label="返回" data-testid="shared-back" @click="up">
        <KbIcon name="chevron" :size="12" class="kb-sws-back-icon" /> <span>{{ trail.length > 1 ? '上一级' : '列表' }}</span>
      </button>
      <UserAvatar :user-id="owner.id" :name="personName(owner)" :file="owner.avatar" :size="24" />
      <span class="kb-sws-from">来自 <b>{{ personName(owner) }}</b></span>
      <KbBadge :tone="canEditHere ? 'success' : 'neutral'" data-testid="shared-role">{{ roleLabel(item.role) }}</KbBadge>
      <span class="kb-sws-spacer"></span>
      <template v-if="!canEditHere">
        <span class="kb-sws-readonly" data-testid="shared-readonly">只读</span>
        <KbButton v-if="pendingRequest" size="sm" disabled data-testid="shared-requested">已申请,等待处理</KbButton>
        <KbButton v-else size="sm" variant="primary" data-testid="shared-request" @click="requesting = true">申请编辑</KbButton>
      </template>
      <KbButton v-if="canManage" size="sm" data-testid="shared-share" @click="sharing = true">分享</KbButton>
      <KbButton v-if="trail.length === 1" size="sm" title="只是不在我的列表里显示,不影响授权" data-testid="shared-hide-one" @click="emit('hide', item)">移出列表</KbButton>
    </header>

    <nav v-if="trail.length > 1" class="kb-sws-crumb" aria-label="位置">
      <template v-for="(step, index) in trail" :key="index">
        <span v-if="index" class="kb-sws-sep">/</span>
        <button v-if="index < trail.length - 1" type="button" class="kb-sws-crumb-btn" @click="goTo(index)">{{ step.title }}</button>
        <b v-else>{{ step.title }}</b>
      </template>
    </nav>

    <div class="kb-sws-body">
      <SharedFolder v-if="isFolder" :target="current.target" :access="access" @open="open" />
      <SharedDoc v-else :key="targetKey(current.target)" ref="doc" :target="current.target" :access="access" :my-id="session.user?.id" />
    </div>

    <RequestAccessDialog
      v-if="requesting"
      :target="current.target"
      :title="current.title"
      :current-role="item.role"
      :owner="owner"
      @close="requesting = false"
      @sent="pendingRequest = true"
    />
    <SharePanel v-if="sharing" :targets="[current.target]" :titles="{ [targetKey(current.target)]: current.title }" @close="sharing = false" />
  </section>
</template>

<style>
.kb-sws { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.kb-sws-bar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2) var(--sp-4); border-bottom: var(--hl) solid var(--border-subtle); min-height: 52px; flex: none; }
.kb-sws-from { font-size: var(--text-13); color: var(--text-secondary); }
.kb-sws-from b { color: var(--text-primary); font-weight: var(--fw-medium); }
.kb-sws-spacer { flex: 1; }
.kb-sws-readonly { font-size: var(--text-12); color: var(--text-tertiary); }
.kb-sws-back-icon { transform: rotate(180deg); }
.kb-sws-crumb { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2) var(--sp-4) 0; font-size: var(--text-13); color: var(--text-secondary); }
.kb-sws-crumb b { font-weight: var(--fw-medium); color: var(--text-primary); overflow-wrap: anywhere; }
.kb-sws-crumb-btn { border: 0; background: none; padding: 0; color: var(--accent-text, var(--accent)); font: inherit; cursor: pointer; text-decoration: underline; }
.kb-sws-sep { color: var(--text-tertiary); }
.kb-sws-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: var(--sp-4); max-width: 920px; width: 100%; margin: 0 auto; box-sizing: border-box; }
@media (max-width: 599px) {
  .kb-sws-bar { padding: var(--sp-2) var(--sp-3); }
  .kb-sws-body { padding: var(--sp-3); }
}
@media (pointer: coarse) {
  .kb-sws-crumb-btn { min-height: 44px; }
}
</style>
