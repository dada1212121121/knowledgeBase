<script setup lang="ts" generic="Row extends Record<string, unknown>">
// 响应式表格(设计规范列表与表格):桌面是表格,手机自动变成卡片(主字段 + 次要字段 + 操作);
// 支持多选与批量条。同一份 columns 定义:每列用 `mobile` 说明在卡片里怎么放——
//   primary = 卡片标题(加粗);meta = 「标签:值」的次要行;hidden = 手机上不显示。
//
// 多选:
//   - 桌面:第一列是复选框,表头有全选(半选态);
//   - 手机:卡片上没有复选框,「选择」按钮或长按卡片进入多选模式,之后点卡片切换选中;
//   - 选中项通过 v-model:selected(主键数组)交给调用方,批量条出现在表格底部。
// 触屏上所有可点区域 ≥44px;行操作放在 row-actions 插槽(卡片里是常驻的 ⋯ 位置,不依赖悬停)。
import { computed, ref, watch } from 'vue'
import KbBatchBar from './KbBatchBar.vue'
import KbEmpty from './KbEmpty.vue'
import KbSkeleton from './KbSkeleton.vue'
import { useLongPress } from '../composables/useLongPress'
import { useScrollFocus } from '../composables/useScrollFocus'
import { PHONE_QUERY, useMedia } from '../composables/useMedia'

export interface RtColumn {
  key: string
  label: string
  align?: 'left' | 'right'
  width?: string
  clip?: boolean
  cellClass?: string
  mobile?: 'primary' | 'meta' | 'hidden'
  /** 手机卡片里这一行没内容(返回 true)就不渲染,免得留一行「所属批次 —」。桌面表格不受影响:单元格要保留,列才对得齐 */
  hideWhen?: (row: Record<string, unknown>) => boolean
}

const props = withDefaults(
  defineProps<{
    columns: RtColumn[]
    rows: Row[]
    rowKey?: string
    selectable?: boolean
    selected?: string[]
    loading?: boolean
    empty?: string
    /** auto = 手机宽度用卡片;always / never 强制(测试和特殊页面用) */
    cards?: 'auto' | 'always' | 'never'
    /** 整行可点(键盘 Enter 也行);选中模式下点击改为切换选中 */
    clickable?: boolean
    /** 表格比容器宽、横向滚动区能被键盘聚焦时读屏念的名字;不传就叫「数据表格」 */
    label?: string
  }>(),
  { rowKey: 'id', selectable: false, selected: () => [], loading: false, empty: '暂无数据', cards: 'auto', clickable: false, label: '数据表格' },
)
const emit = defineEmits<{ 'update:selected': [keys: string[]]; rowClick: [row: Row] }>()

const phone = useMedia(PHONE_QUERY)
// 表格比容器宽时在 .kb-scroll 里横向滚动:溢出了就让它能被键盘聚焦,否则键盘用户滚不动(axe scrollable-region-focusable)
const scrollEl = ref<HTMLElement | null>(null)
const scrollable = useScrollFocus(scrollEl)
const asCards = computed(() => (props.cards === 'always' ? true : props.cards === 'never' ? false : phone.value))

const keyOf = (row: Row) => String(row[props.rowKey] ?? '')
const selectedSet = computed(() => new Set(props.selected))
const allKeys = computed(() => props.rows.map(keyOf))
const allChecked = computed(() => allKeys.value.length > 0 && allKeys.value.every((key) => selectedSet.value.has(key)))
const someChecked = computed(() => !allChecked.value && allKeys.value.some((key) => selectedSet.value.has(key)))

// 数据换了(翻页、筛选)时,丢掉已经不在当前行里的选中项
watch(
  () => props.rows,
  () => {
    const keep = props.selected.filter((key) => allKeys.value.includes(key))
    if (keep.length !== props.selected.length) emit('update:selected', keep)
  },
)

function toggle(row: Row) {
  const key = keyOf(row)
  const next = new Set(props.selected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  emit('update:selected', [...next])
}
function toggleAll() {
  emit('update:selected', allChecked.value ? [] : [...allKeys.value])
}
function clear() {
  emit('update:selected', [])
  selecting.value = false
}

// ---- 手机:多选模式(按钮 / 长按进入) ----
const selecting = ref(false)
watch(asCards, (value) => {
  if (!value) selecting.value = false
})
// 长按(触屏)进入多选并选中这一张;手指移动(在滚动)、鼠标都不触发
const rowPressed = ref<Row | null>(null)
const press = useLongPress(() => {
  const row = rowPressed.value
  if (!row) return
  selecting.value = true
  if (!selectedSet.value.has(keyOf(row))) toggle(row)
})
function pressStart(event: PointerEvent, row: Row) {
  if (!props.selectable || !asCards.value) return
  rowPressed.value = row
  press.start(event)
}
const pressMove = press.move
const pressEnd = press.end

function onCardClick(row: Row) {
  // 长按刚触发过选中,抬手那一下的 click 不再算点击
  if (press.consumeClick()) return
  if (props.selectable && (selecting.value || props.selected.length > 0)) toggle(row)
  else if (props.clickable) emit('rowClick', row)
}
function onRowClick(row: Row) {
  if (props.clickable) emit('rowClick', row)
}

const primary = computed(() => props.columns.find((column) => column.mobile === 'primary') ?? props.columns.find((column) => column.mobile !== 'hidden'))
const metas = computed(() => props.columns.filter((column) => column !== primary.value && column.mobile !== 'hidden' && column.mobile !== 'primary'))
/** 这一行卡片要显示的 meta:去掉列声明了 hideWhen 且当前行没内容的 */
const metasOf = (row: Row) => metas.value.filter((column) => !column.hideWhen?.(row))
const showBar = computed(() => props.selectable && props.selected.length > 0)

/**
 * 选择列的单元格(表头的全选格、每行的勾选格)整格都是点击目标:触屏上复选框只有 22px,单元格有 52×48,
 * 手指点在复选框旁边的空白处也要能勾选。直接点在复选框上的不转发(它自己会切换,再转发就切回去了)。
 * 单元格本身仍然 stop 冒泡:点这一格不触发整行点击。
 */
function forwardToCheck(event: MouseEvent) {
  const cell = event.currentTarget as HTMLElement
  if ((event.target as HTMLElement).closest('input')) return
  cell.querySelector<HTMLInputElement>('input[type=checkbox]')?.click()
}
</script>

<template>
  <div class="kb-rt" :class="{ 'is-cards': asCards }" data-testid="rtable">
    <template v-if="loading && !rows.length"><KbSkeleton :lines="5" height="14px" rows /></template>
    <template v-else-if="!rows.length">
      <slot name="empty"><KbEmpty :title="empty" /></slot>
    </template>

    <!-- 手机:卡片 -->
    <template v-else-if="asCards">
      <div v-if="selectable" class="kb-rt-tools">
        <button type="button" class="kb-rt-toggle" :aria-pressed="selecting" @click="selecting ? clear() : (selecting = true)">
          {{ selecting ? '完成' : '选择' }}
        </button>
      </div>
      <ul class="kb-rt-cards" role="list">
        <li
          v-for="(row, index) in rows"
          :key="keyOf(row) || index"
          class="kb-rt-card"
          :class="{ 'is-selected': selectedSet.has(keyOf(row)), 'is-clickable': clickable || selectable }"
          role="listitem"
          :aria-selected="selectable ? selectedSet.has(keyOf(row)) : undefined"
          :tabindex="clickable || selectable ? 0 : undefined"
          data-testid="rt-card"
          @pointerdown="pressStart($event, row)"
          @pointermove="pressMove"
          @pointerup="pressEnd"
          @pointercancel="pressEnd"
          @contextmenu="selectable && $event.preventDefault()"
          @click="onCardClick(row)"
          @keydown.enter.prevent="onCardClick(row)"
        >
          <input
            v-if="selectable && (selecting || selected.length)"
            type="checkbox"
            class="kb-rt-check"
            :checked="selectedSet.has(keyOf(row))"
            :aria-label="`选择第 ${index + 1} 项`"
            @click.stop
            @change="toggle(row)"
          />
          <div class="kb-rt-card-body">
            <slot name="card" :row="row" :index="index">
              <div v-if="primary" class="kb-rt-primary"><slot :name="`cell-${primary.key}`" :row="row" :index="index">{{ row[primary.key] }}</slot></div>
              <dl class="kb-rt-metas">
                <div v-for="column in metasOf(row)" :key="column.key" class="kb-rt-meta">
                  <dt>{{ column.label }}</dt>
                  <dd><slot :name="`cell-${column.key}`" :row="row" :index="index">{{ row[column.key] }}</slot></dd>
                </div>
              </dl>
            </slot>
          </div>
          <div v-if="$slots['row-actions']" class="kb-rt-card-actions" @click.stop><slot name="row-actions" :row="row" :index="index" /></div>
        </li>
      </ul>
    </template>

    <!-- 桌面:表格 -->
    <div v-else ref="scrollEl" class="kb-scroll" :tabindex="scrollable ? 0 : undefined" :role="scrollable ? 'region' : undefined" :aria-label="scrollable ? label : undefined">
      <table class="kb-table kb-rt-table">
        <thead>
          <tr>
            <th v-if="selectable" class="kb-rt-checkcell" @click.stop="forwardToCheck">
              <input
                type="checkbox"
                class="kb-rt-check"
                aria-label="全选"
                data-testid="rt-all"
                :checked="allChecked"
                :indeterminate.prop="someChecked"
                @change="toggleAll"
              />
            </th>
            <th v-for="column in columns" :key="column.key" :class="{ num: column.align === 'right' }" :style="column.width ? { width: column.width } : undefined" style-allow="列宽由列定义决定">
              {{ column.label }}
            </th>
            <th v-if="$slots['row-actions']" class="kb-rt-actcell"><span class="kb-sr">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in rows"
            :key="keyOf(row) || index"
            :class="{ sel: selectedSet.has(keyOf(row)), 'is-clickable': clickable }"
            :tabindex="clickable ? 0 : undefined"
            data-testid="rt-row"
            @click="onRowClick(row)"
            @keydown.enter.prevent="onRowClick(row)"
          >
            <td v-if="selectable" class="kb-rt-checkcell" @click.stop="forwardToCheck">
              <input type="checkbox" class="kb-rt-check" :checked="selectedSet.has(keyOf(row))" :aria-label="`选择第 ${index + 1} 项`" @change="toggle(row)" />
            </td>
            <td v-for="column in columns" :key="column.key" :class="[{ num: column.align === 'right', clip: column.clip }, column.cellClass]">
              <slot :name="`cell-${column.key}`" :row="row" :index="index">{{ row[column.key] }}</slot>
            </td>
            <td v-if="$slots['row-actions']" class="kb-rt-actcell" @click.stop><slot name="row-actions" :row="row" :index="index" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <KbBatchBar v-if="showBar" :count="selected.length" :total="rows.length" @clear="clear" @all="toggleAll">
      <slot name="batch" :selected="selected" />
    </KbBatchBar>
  </div>
</template>
