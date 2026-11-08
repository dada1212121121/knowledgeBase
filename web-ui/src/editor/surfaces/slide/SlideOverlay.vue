<script setup lang="ts">
/**
 * 画布上方的交互层（骨架）
 *
 * 只负责「把幻灯片坐标里的几何画出来」：查找高亮、选中框 + 8 个控制点、对齐参考线。
 * 不做任何手势判断——指针事件原样抛给上层（编辑控制器），这样只读面也能用同一层画高亮，
 * 而编辑手势的状态机不会和只读渲染纠缠在一起。
 * 容器本身 pointer-events: none，只有选中框和控制点接收指针，不挡住下面画布的点击与文字选择。
 */
import { computed } from 'vue'
import { HANDLE_IDS, HANDLE_SIZE, HANDLE_SIZE_COARSE, handlePoint, toScreen, type Guide, type HandleId } from './overlay'
import type { SlideRect } from './types'

const props = withDefaults(
  defineProps<{
    /** 当前缩放：CSS 宽度 = 逻辑宽度 × scale */
    scale: number
    /** 画布的 CSS 尺寸，参考线要画满整页 */
    width: number
    height: number
    highlights?: readonly { rect: SlideRect; active: boolean }[]
    /** 选中的形状（包围盒）；多选时每个形状一个细框，最后一个 `box` 是整体包围盒 */
    selection?: readonly SlideRect[]
    /** 整体包围盒：有它才画控制点 */
    box?: SlideRect | null
    guides?: readonly Guide[]
    /** 触屏：控制点放大 */
    coarse?: boolean
    /** 控制点是否可拖（形状被旋转 / 翻转时引擎不支持缩放，只能移动） */
    resizable?: boolean
  }>(),
  { highlights: () => [], selection: () => [], box: null, guides: () => [], coarse: false, resizable: true },
)

const emit = defineEmits<{
  handleDown: [handle: HandleId, event: PointerEvent]
  boxDown: [event: PointerEvent]
}>()

const handleSize = computed(() => (props.coarse ? HANDLE_SIZE_COARSE : HANDLE_SIZE))
</script>

<template>
  <div class="kb-sl-overlay" data-testid="slide-overlay" aria-hidden="true">
    <div
      v-for="(item, index) in highlights"
      :key="`h${index}`"
      class="kb-sl-hit"
      :class="{ 'is-active': item.active }"
      :style="toScreen(item.rect, scale)"
    ></div>

    <div v-for="(rect, index) in selection" :key="`s${index}`" class="kb-sl-sel" :style="toScreen(rect, scale)"></div>

    <template v-if="box">
      <div class="kb-sl-box" data-testid="slide-selection-box" :style="toScreen(box, scale)" @pointerdown="emit('boxDown', $event)"></div>
      <template v-if="resizable">
        <button
          v-for="id in HANDLE_IDS"
          :key="id"
          type="button"
          tabindex="-1"
          class="kb-sl-handle"
          :class="`is-${id}`"
          :data-handle="id"
          :style="{
            left: `${handlePoint(box, id).x * scale - handleSize / 2}px`,
            top: `${handlePoint(box, id).y * scale - handleSize / 2}px`,
            width: `${handleSize}px`,
            height: `${handleSize}px`,
          }"
          @pointerdown.stop="emit('handleDown', id, $event)"
        ></button>
      </template>
    </template>

    <div
      v-for="(guide, index) in guides"
      :key="`g${index}`"
      class="kb-sl-guide"
      :class="`is-${guide.axis}`"
      :style="guide.axis === 'x' ? { left: `${guide.position * scale}px`, height: `${height}px` } : { top: `${guide.position * scale}px`, width: `${width}px` }"
    ></div>
  </div>
</template>

<style>
.kb-sl-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.kb-sl-hit {
  position: absolute;
  background: color-mix(in srgb, var(--accent) 28%, transparent);
  border-radius: 2px;
  mix-blend-mode: multiply;
}
.kb-sl-hit.is-active {
  background: color-mix(in srgb, var(--status-warning) 55%, transparent);
  outline: 2px solid var(--status-warning);
}
.kb-sl-sel {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid var(--accent);
}
.kb-sl-box {
  position: absolute;
  box-sizing: border-box;
  border: 1.5px solid var(--accent);
  pointer-events: auto;
  cursor: move;
  touch-action: none;
}
.kb-sl-handle {
  position: absolute;
  padding: 0;
  box-sizing: border-box;
  pointer-events: auto;
  background: var(--surface-1);
  border: 1.5px solid var(--accent);
  border-radius: 2px;
  touch-action: none;
}
.kb-sl-handle.is-nw,
.kb-sl-handle.is-se {
  cursor: nwse-resize;
}
.kb-sl-handle.is-ne,
.kb-sl-handle.is-sw {
  cursor: nesw-resize;
}
.kb-sl-handle.is-n,
.kb-sl-handle.is-s {
  cursor: ns-resize;
}
.kb-sl-handle.is-e,
.kb-sl-handle.is-w {
  cursor: ew-resize;
}
.kb-sl-guide {
  position: absolute;
  background: var(--status-danger, #e5484d);
  opacity: 0.85;
}
.kb-sl-guide.is-x {
  top: 0;
  width: 1px;
}
.kb-sl-guide.is-y {
  left: 0;
  height: 1px;
}
</style>
