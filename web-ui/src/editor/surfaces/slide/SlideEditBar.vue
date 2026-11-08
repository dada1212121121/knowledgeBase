<script setup lang="ts">
/**
 * 幻灯片编辑工具栏：插入 / 文字格式 / 排列 / 对齐分布 / 填充 / 引擎暂不支持的能力（撤销 / 重做 / 保存在外壳顶栏，不重复放）
 *
 * 按钮全部 @mousedown.prevent：点工具栏不能让正在输入的隐藏输入框失焦，否则一点"加粗"，键盘焦点就丢了，
 * 用户得再点一下文字才能继续打字。需要真正拿焦点的（颜色选择器、文件选择）单独处理。
 * 引擎 v0.5.1 没有的能力（新建表格 / 连接线、组合 / 取消组合）按钮置灰并带说明，点灰按钮会弹提示，不会静默没反应。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AlignKind, DistributeKind } from './align'
import type { SlideEditor } from './pptx-edit'
import type { ShapePreset } from './types'

const props = defineProps<{ editor: SlideEditor }>()
const emit = defineEmits<{ pickImage: [file: File, replace: boolean] }>()

const state = props.editor
const menu = ref<'shape' | 'align' | null>(null)
const picker = ref<HTMLInputElement | null>(null)
const replacing = ref(false)
const root = ref<HTMLElement | null>(null)

const off = computed(() => state.readonly)
const hasSelection = computed(() => state.selected.value.length > 0)
const single = computed(() => state.selected.value.length === 1)
const picture = computed(() => single.value && state.shapes.value.find((shape) => shape.id === state.selected.value[0])?.kind === 'picture')
const filled = computed(() => state.shapes.value.some((shape) => state.selected.value.includes(shape.id) && shape.kind === 'shape'))
const textTarget = computed(() => !!state.text.value || state.shapes.value.some((shape) => state.selected.value.includes(shape.id) && shape.storyId))

const SHAPES: Array<{ preset: ShapePreset; label: string }> = [
  { preset: 'rect', label: '矩形' },
  { preset: 'roundRect', label: '圆角矩形' },
  { preset: 'ellipse', label: '椭圆' },
  { preset: 'triangle', label: '三角形' },
  { preset: 'diamond', label: '菱形' },
  { preset: 'rightArrow', label: '右箭头' },
  { preset: 'star5', label: '五角星' },
]
const ALIGNS: Array<{ kind: AlignKind; label: string }> = [
  { kind: 'left', label: '左对齐' },
  { kind: 'hcenter', label: '水平居中' },
  { kind: 'right', label: '右对齐' },
  { kind: 'top', label: '顶端对齐' },
  { kind: 'vcenter', label: '垂直居中' },
  { kind: 'bottom', label: '底端对齐' },
]
const DISTRIBUTES: Array<{ kind: DistributeKind; label: string }> = [
  { kind: 'horizontal', label: '横向分布' },
  { kind: 'vertical', label: '纵向分布' },
]
const UNSUPPORTED = ['表格', '连接线', '组合', '取消组合']

function toggle(which: 'shape' | 'align') {
  menu.value = menu.value === which ? null : which
}
function closeOnOutside(event: PointerEvent) {
  if (menu.value && !root.value?.contains(event.target as Node)) menu.value = null
}
onMounted(() => document.addEventListener('pointerdown', closeOnOutside, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOnOutside, true))

function choose(file: File | undefined) {
  if (file) emit('pickImage', file, replacing.value)
  if (picker.value) picker.value.value = ''
}
function openPicker(replace: boolean) {
  replacing.value = replace
  picker.value?.click()
}
function onFill(event: Event) {
  state.setFill((event.target as HTMLInputElement).value)
}
function onColor(event: Event) {
  state.format({ color: (event.target as HTMLInputElement).value })
}
</script>

<template>
  <div ref="root" class="kb-sl-editbar" role="toolbar" aria-label="幻灯片编辑工具栏" data-testid="slide-editbar">
    <span class="kb-sl-eg" role="group" aria-label="插入">
      <button type="button" class="btn sm" data-testid="slide-add-textbox" :disabled="off" title="在页面中央插入文本框" @mousedown.prevent @click="state.insertTextBox()">文本框</button>
      <span class="kb-sl-menu">
        <button type="button" class="btn sm" data-testid="slide-add-shape" :disabled="off" :aria-expanded="menu === 'shape'" aria-haspopup="menu" @mousedown.prevent @click="toggle('shape')">形状 ▾</button>
        <div v-if="menu === 'shape'" class="kb-sl-menu-pop" role="menu">
          <button v-for="item in SHAPES" :key="item.preset" type="button" role="menuitem" class="kb-sl-menu-item" :data-preset="item.preset" @mousedown.prevent @click="state.insertShape(item.preset); menu = null">{{ item.label }}</button>
        </div>
      </span>
      <button type="button" class="btn sm" data-testid="slide-add-picture" :disabled="off" title="插入图片（PNG / JPEG / GIF）" @click="openPicker(false)">图片</button>
      <button type="button" class="btn sm" data-testid="slide-replace-picture" :disabled="off || !picture" title="替换选中的图片（位置、大小、层级不变）" @click="openPicker(true)">替换图片</button>
      <input ref="picker" type="file" class="kb-sl-file" accept="image/png,image/jpeg,image/gif" tabindex="-1" aria-hidden="true" data-testid="slide-picture-input" @change="choose(($event.target as HTMLInputElement).files?.[0])" />
    </span>

    <span class="kb-sl-eg" role="group" aria-label="文字格式">
      <button type="button" class="btn sm kb-sl-b" data-testid="slide-bold" :class="{ ac: state.style.value.bold }" :aria-pressed="state.style.value.bold" :disabled="off || !textTarget" title="加粗 (Ctrl+B)" @mousedown.prevent @click="state.toggleStyle('bold')">B</button>
      <button type="button" class="btn sm kb-sl-i" data-testid="slide-italic" :class="{ ac: state.style.value.italic }" :aria-pressed="state.style.value.italic" :disabled="off || !textTarget" title="斜体 (Ctrl+I)" @mousedown.prevent @click="state.toggleStyle('italic')">I</button>
      <button type="button" class="btn sm kb-sl-u" data-testid="slide-underline" :class="{ ac: state.style.value.underline }" :aria-pressed="state.style.value.underline" :disabled="off || !textTarget" title="下划线 (Ctrl+U)" @mousedown.prevent @click="state.toggleStyle('underline')">U</button>
      <button type="button" class="btn sm" data-testid="slide-size-down" :disabled="off || !textTarget" title="减小字号" @mousedown.prevent @click="state.stepFontSize(-2)">A−</button>
      <button type="button" class="btn sm" data-testid="slide-size-up" :disabled="off || !textTarget" title="增大字号" @mousedown.prevent @click="state.stepFontSize(2)">A+</button>
      <label class="kb-sl-color" :class="{ 'is-off': off || !textTarget }" title="文字颜色">字色<input type="color" :disabled="off || !textTarget" aria-label="文字颜色" @change="onColor" /></label>
      <button type="button" class="btn sm" data-testid="slide-align-l" :class="{ ac: state.style.value.align === 'l' }" :disabled="off || !textTarget" title="左对齐文字" @mousedown.prevent @click="state.alignText('l')">居左</button>
      <button type="button" class="btn sm" data-testid="slide-align-c" :class="{ ac: state.style.value.align === 'ctr' }" :disabled="off || !textTarget" title="居中文字" @mousedown.prevent @click="state.alignText('ctr')">居中</button>
      <button type="button" class="btn sm" data-testid="slide-align-r" :class="{ ac: state.style.value.align === 'r' }" :disabled="off || !textTarget" title="右对齐文字" @mousedown.prevent @click="state.alignText('r')">居右</button>
    </span>

    <span class="kb-sl-eg" role="group" aria-label="形状">
      <label class="kb-sl-color" :class="{ 'is-off': off || !filled }" title="形状填充色">填充<input type="color" :disabled="off || !filled" aria-label="形状填充色" data-testid="slide-fill" @change="onFill" /></label>
      <button type="button" class="btn sm" data-testid="slide-z-front" :disabled="off || !hasSelection" title="置于顶层" @mousedown.prevent @click="state.zOrder('front')">置顶</button>
      <button type="button" class="btn sm" data-testid="slide-z-forward" :disabled="off || !hasSelection" title="上移一层" @mousedown.prevent @click="state.zOrder('forward')">上移</button>
      <button type="button" class="btn sm" data-testid="slide-z-backward" :disabled="off || !hasSelection" title="下移一层" @mousedown.prevent @click="state.zOrder('backward')">下移</button>
      <button type="button" class="btn sm" data-testid="slide-z-back" :disabled="off || !hasSelection" title="置于底层" @mousedown.prevent @click="state.zOrder('back')">置底</button>
      <span class="kb-sl-menu">
        <button type="button" class="btn sm" data-testid="slide-align" :disabled="off || !hasSelection" :aria-expanded="menu === 'align'" aria-haspopup="menu" title="对齐与分布（选一个对齐到页面，选多个对齐到彼此）" @mousedown.prevent @click="toggle('align')">对齐 ▾</button>
        <div v-if="menu === 'align'" class="kb-sl-menu-pop" role="menu">
          <button v-for="item in ALIGNS" :key="item.kind" type="button" role="menuitem" class="kb-sl-menu-item" :data-align="item.kind" @mousedown.prevent @click="state.align(item.kind); menu = null">{{ item.label }}</button>
          <hr class="kb-sl-menu-sep" />
          <button v-for="item in DISTRIBUTES" :key="item.kind" type="button" role="menuitem" class="kb-sl-menu-item" :data-distribute="item.kind" :title="'至少选 3 个形状'" @mousedown.prevent @click="state.distribute(item.kind); menu = null">{{ item.label }}</button>
        </div>
      </span>
      <button type="button" class="btn sm" data-testid="slide-delete" :disabled="off || !hasSelection" title="删除选中的形状 (Delete)" @mousedown.prevent @click="state.removeSelected()">删除</button>
    </span>

    <span class="kb-sl-eg" role="group" aria-label="暂不支持">
      <button v-for="name in UNSUPPORTED" :key="name" type="button" class="btn sm kb-sl-limited" :data-limited="name" aria-disabled="true" title="编辑引擎暂不支持，请在 PowerPoint 中编辑" @mousedown.prevent @click="state.unsupported(name)">{{ name }}</button>
    </span>

    <span v-if="state.notice.value" class="kb-sl-editnote" role="status" data-testid="slide-editnote">{{ state.notice.value }}</span>
  </div>
</template>

<style>
.kb-sl-editbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px var(--sp-2);
  background: var(--surface-1);
  border-bottom: var(--hl) solid var(--border-subtle);
  overflow-x: auto;
  scrollbar-width: none;
}
.kb-sl-editbar::-webkit-scrollbar {
  display: none;
}
.kb-sl-eg {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-right: 10px;
  border-right: var(--hl) solid var(--border-subtle);
}
.kb-sl-eg:last-of-type {
  border-right: 0;
}
.kb-sl-b {
  font-weight: 700;
}
.kb-sl-i {
  font-style: italic;
}
.kb-sl-u {
  text-decoration: underline;
}
.kb-sl-menu {
  position: relative;
  display: inline-flex;
}
.kb-sl-menu-pop {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  margin-top: 4px;
  min-width: 128px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r2);
  box-shadow: var(--sh3);
}
.kb-sl-menu-item {
  padding: 6px 10px;
  text-align: left;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  border-radius: var(--r1);
  cursor: pointer;
  font-size: calc(13px * var(--fs));
}
.kb-sl-menu-item:hover {
  background: var(--surface-hover);
}
.kb-sl-menu-sep {
  width: 100%;
  margin: 4px 0;
  border: 0;
  border-top: var(--hl) solid var(--border-subtle);
}
.kb-sl-file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.kb-sl-color {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  color: var(--text-secondary);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
}
.kb-sl-color input {
  width: 22px;
  height: 22px;
  padding: 0;
  border: var(--hl) solid var(--border-subtle);
  border-radius: var(--r1);
  background: transparent;
  cursor: pointer;
}
.kb-sl-color.is-off {
  opacity: 0.45;
  cursor: not-allowed;
}
.kb-sl-limited {
  opacity: 0.5;
  cursor: not-allowed;
}
.kb-sl-editnote {
  flex: none;
  margin-left: auto;
  padding: 2px 8px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--status-warning) 14%, var(--surface-1));
  border-radius: var(--r1);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
@media (pointer: coarse) {
  .kb-sl-editbar .btn {
    min-height: 36px;
    min-width: 36px;
  }
}
</style>
