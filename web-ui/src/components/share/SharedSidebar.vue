<script setup lang="ts">
// 知识库页侧栏「共享给我」那一页:按分享人分组,每行显示内容名和我的角色。
// 多选（设计规范）:点「选择」、Ctrl/⌘ + 点击、Shift + 点击连选,触屏长按进入;选中后可批量「移出我的列表」
// (只是不显示,不影响授权)或「放回」。
import { computed, ref, watch } from 'vue'
import { KbBadge, KbBatchBar, KbButton, KbEmpty, KbIcon, KbSkeleton, KbSwitch, useLongPress, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import type { SharedWithMeItem } from '@/api/share'
import { dateText, personName, roleLabel, targetKindLabel, type OwnerGroup } from '@/utils/share'
import { MAX_SELECTION, pick, selectAll, type SelectionState } from '@/utils/selection'

const props = defineProps<{
  groups: OwnerGroup[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorText: string
  /** 正在看的那一项(根资源的键) */
  activeKey: string | null
  showHidden: boolean
  hiddenCount: number
}>()
const emit = defineEmits<{
  select: [item: SharedWithMeItem]
  retry: []
  'update:showHidden': [value: boolean]
  hide: [items: SharedWithMeItem[], hidden: boolean]
}>()

const toast = useToast()

const flat = computed(() => props.groups.flatMap((group) => group.items))
const order = computed(() => flat.value.map((item) => item.key))
const byKey = computed(() => new Map(flat.value.map((item) => [item.key, item])))

// ---------------------------------------------------------------- 多选
const state = ref<SelectionState>({ selected: [], anchor: null, selecting: false })
const selectedItems = computed(() => state.value.selected.map((key) => byKey.value.get(key)).filter((item): item is SharedWithMeItem => !!item))
const canHide = computed(() => selectedItems.value.some((item) => !item.hidden))
const canRestore = computed(() => selectedItems.value.some((item) => item.hidden))

// 列表变了(重读、切「显示已移出」),丢掉已经看不到的选中项
watch(order, (keys) => {
  const visible = new Set(keys)
  const kept = state.value.selected.filter((key) => visible.has(key))
  if (kept.length !== state.value.selected.length) state.value = { ...state.value, selected: kept }
})

function applyPick(result: ReturnType<typeof pick>) {
  state.value = { selected: result.selected, anchor: result.anchor, selecting: result.selecting }
  if (result.dropped) toast.push(`一次最多选 ${MAX_SELECTION} 项,多出的 ${result.dropped} 项没有选上`, 'danger')
}
function onRowClick(event: MouseEvent, item: SharedWithMeItem) {
  if (press.consumeClick()) return
  const result = pick(order.value, state.value, item.key, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey, selecting: state.value.selecting })
  if (result.handled) applyPick(result)
  else emit('select', item)
}
function toggleSelecting() {
  state.value = state.value.selecting || state.value.selected.length ? { selected: [], anchor: null, selecting: false } : { ...state.value, selecting: true }
}
function clear() {
  state.value = { selected: [], anchor: null, selecting: false }
}
function all() {
  const result = selectAll(order.value)
  state.value = { selected: result.selected, anchor: result.selected[0] ?? null, selecting: true }
  if (result.dropped) toast.push(`一次最多选 ${MAX_SELECTION} 项,多出的 ${result.dropped} 项没有选上`, 'danger')
}

// 触屏长按进入多选并选中这一行(鼠标不触发,抬手那一下的 click 被吞掉)
let pressed: SharedWithMeItem | null = null
const press = useLongPress(() => {
  if (pressed && !state.value.selected.includes(pressed.key)) applyPick({ selected: [...state.value.selected, pressed.key], anchor: pressed.key, selecting: true, handled: true, dropped: 0 })
  else state.value = { ...state.value, selecting: true }
})
function pressStart(event: PointerEvent, item: SharedWithMeItem) {
  pressed = item
  press.start(event)
}

function runHide(hidden: boolean) {
  const targets = selectedItems.value.filter((item) => item.hidden !== hidden)
  if (!targets.length) return
  emit('hide', targets, hidden)
  clear()
}

const selectingNow = computed(() => state.value.selecting || state.value.selected.length > 0)
const isSelected = (item: SharedWithMeItem) => state.value.selected.includes(item.key)
</script>

<template>
  <div class="kb-ssb" data-testid="shared-sidebar">
    <div class="kb-ssb-tools">
      <button type="button" class="btn sm" :aria-pressed="selectingNow" data-testid="shared-select-toggle" @click="toggleSelecting">{{ selectingNow ? '完成' : '选择' }}</button>
      <label v-if="hiddenCount || showHidden" class="kb-ssb-hidden">
        <KbSwitch :model-value="showHidden" aria-label="显示已移出的" data-testid="shared-show-hidden" @update:model-value="(on: boolean) => emit('update:showHidden', on)" />
        <span>已移出 {{ hiddenCount }}</span>
      </label>
    </div>

    <div class="kb-ssb-body">
      <KbSkeleton v-if="status === 'loading' || status === 'idle'" variant="list" :lines="4" />
      <KbEmpty v-else-if="status === 'error'" icon="failed" title="共享给我的内容没有加载出来" :description="errorText" size="sm" data-testid="shared-error">
        <template #action><KbButton size="sm" @click="emit('retry')">重试</KbButton></template>
      </KbEmpty>
      <KbEmpty
        v-else-if="!groups.length"
        icon="users"
        :title="hiddenCount ? '你把共享的内容都移出了列表' : '还没有人分享内容给你'"
        :description="hiddenCount ? '移出只是不显示,授权还在。打开「已移出」开关可以放回来。' : '别人把笔记、文件或文件夹分享给你之后,会按分享人出现在这里,并显示你的权限。'"
        size="sm"
        data-testid="shared-empty"
      >
        <template v-if="hiddenCount" #action><KbButton size="sm" @click="emit('update:showHidden', true)">显示已移出的</KbButton></template>
      </KbEmpty>

      <template v-else>
        <section v-for="group in groups" :key="group.owner.id" class="kb-ssb-group" :data-testid="`shared-group-${group.owner.username}`">
          <h3 class="kb-ssb-owner">
            <UserAvatar :user-id="group.owner.id" :name="personName(group.owner)" :file="group.owner.avatar" :size="20" />
            <span class="kb-ssb-owner-name">{{ personName(group.owner) }}</span>
            <span class="kb-ssb-count">{{ group.items.length }}</span>
          </h3>
          <ul class="kb-ssb-list">
            <li v-for="item in group.items" :key="item.key">
              <button
                type="button"
                class="kb-ssb-row"
                :class="{ 'is-active': activeKey === item.key, 'is-selected': isSelected(item), 'is-hidden': item.hidden }"
                :aria-pressed="selectingNow ? isSelected(item) : undefined"
                :data-testid="`shared-item-${item.title}`"
                @click="onRowClick($event, item)"
                @pointerdown="pressStart($event, item)"
                @pointermove="press.move"
                @pointerup="press.end"
                @pointercancel="press.end"
                @contextmenu="selectingNow && $event.preventDefault()"
              >
                <!-- 勾选框只是视觉:按钮里不能再嵌可点的输入框,选中状态由按钮的 aria-pressed 表达 -->
                <span v-if="selectingNow" class="kb-ssb-check" :class="{ 'is-on': isSelected(item) }" aria-hidden="true"><KbIcon v-if="isSelected(item)" name="check" :size="12" /></span>
                <span class="kb-ssb-kind">{{ targetKindLabel(item.target) }}</span>
                <span class="kb-ssb-main">
                  <b>{{ item.title }}</b>
                  <small>
                    {{ roleLabel(item.role) }}<template v-if="item.expires_at"> · 到期 {{ dateText(item.expires_at) }}</template>
                  </small>
                </span>
                <KbBadge v-if="item.hidden" tone="neutral">已移出</KbBadge>
              </button>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <KbBatchBar :count="state.selected.length" :total="order.length" @clear="clear" @all="all">
      <KbButton v-if="canHide" size="sm" data-testid="shared-hide" @click="runHide(true)">移出我的列表</KbButton>
      <KbButton v-if="canRestore" size="sm" data-testid="shared-restore" @click="runHide(false)">放回我的列表</KbButton>
    </KbBatchBar>
  </div>
</template>

<style>
.kb-ssb { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.kb-ssb-tools { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); flex: none; }
.kb-ssb-hidden { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--text-12); color: var(--text-secondary); cursor: pointer; }
.kb-ssb-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 var(--sp-2) var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-3); }
.kb-ssb-owner { display: flex; align-items: center; gap: var(--sp-2); margin: 0; padding: var(--sp-1) var(--sp-2); font-size: var(--text-12); font-weight: var(--fw-medium); color: var(--text-secondary); min-width: 0; }
.kb-ssb-owner-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-ssb-count { font-weight: var(--fw-regular); color: var(--text-tertiary); }
.kb-ssb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.kb-ssb-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; min-height: 40px; padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--r1); background: none; color: var(--text-secondary); font: inherit; text-align: left; cursor: pointer; user-select: none; min-width: 0; }
.kb-ssb-row:hover { background: rgb(var(--ink), 0.05); color: var(--text-primary); }
.kb-ssb-row:focus-visible { outline: none; box-shadow: var(--accent-ring); }
.kb-ssb-row.is-active { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text-primary); }
.kb-ssb-row.is-selected { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.kb-ssb-row.is-hidden { opacity: 0.7; }
.kb-ssb-kind { flex: none; min-width: 36px; padding: 1px 6px; border-radius: var(--r-xs); background: rgb(var(--ink), 0.08); color: var(--text-secondary); font-size: var(--text-11); text-align: center; }
.kb-ssb-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.kb-ssb-main b { font-weight: var(--fw-medium); font-size: var(--text-13); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-ssb-main small { color: var(--text-tertiary); font-size: var(--text-12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-ssb-check { flex: none; display: inline-grid; place-items: center; width: 18px; height: 18px; border: var(--hl) solid var(--border-strong); border-radius: var(--r-xs); color: var(--on-accent); }
.kb-ssb-check.is-on { background: var(--accent); border-color: var(--accent); }
@media (pointer: coarse) {
  .kb-ssb-row { min-height: 52px; }
  .kb-ssb-hidden { min-height: 44px; }
}
</style>
