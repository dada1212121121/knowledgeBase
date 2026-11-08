<script setup lang="ts">
/**
 * 字色 / 底色悬浮面板（工具栏的「文字颜色」按钮悬停 / 点击时弹出）
 *
 * 常用色保持一排字色、一排底色（各带「恢复默认」），点「更多颜色」在下面展开 WPS 式自定义取色器：
 * 扩展常用色 + 色相条 + 饱和度/亮度面板 + hex 输入。面板只发 pick，由工具栏转成 `mark.color` 命令，
 * 不直接改编辑器；不抢编辑器焦点（mousedown 不默认处理），选区不会因为点面板而消失。
 */
import { computed, ref } from 'vue'
import { BACKGROUND_COLORS, TEXT_COLORS, colorHex } from '@/utils/colorPalette'
import ColorPicker from './ColorPicker.vue'
import '@/styles/kbColor.css'

const props = defineProps<{
  /** 光标 / 选区开头现在的字色、底色（调色板的 key 或自定义 hex），用来标出当前选中的色块 */
  fg?: string | null
  bg?: string | null
}>()
const emit = defineEmits<{ (e: 'pick', prop: 'color' | 'background-color', key: string | null): void }>()

const customFor = ref<'color' | 'background-color' | null>(null)

/** 自定义取色器的初始色：当前色优先，没设过给一个中性默认值 */
const customValue = computed(() => {
  if (!customFor.value) return '#333333'
  const key = customFor.value === 'color' ? props.fg : props.bg
  return (key && colorHex(customFor.value, key)) || (customFor.value === 'background-color' ? '#fff3a3' : '#333333')
})

function toggleCustom(prop: 'color' | 'background-color') {
  customFor.value = customFor.value === prop ? null : prop
}

function pickCustom(key: string) {
  if (!customFor.value) return
  emit('pick', customFor.value, key)
  customFor.value = null
}
</script>

<template>
  <div class="kb-color-panel" role="group" aria-label="文字颜色" data-testid="editor-color-bar" @mousedown.prevent>
    <div class="kb-color-caption">文字颜色</div>
    <div class="kb-color-grid">
      <button type="button" class="kb-editor-swatch is-none" :class="{ 'is-current': !fg }" title="默认颜色" aria-label="默认颜色" data-testid="editor-color-none" @click="emit('pick', 'color', null)">A</button>
      <button
        v-for="color in TEXT_COLORS"
        :key="`fg-${color.key}`"
        type="button"
        class="kb-editor-swatch kb-color"
        :class="[`is-fg-${color.key}`, { 'is-current': fg === color.key }]"
        :title="color.label"
        :aria-label="color.label"
        :data-testid="`editor-color-fg-${color.key}`"
        @click="emit('pick', 'color', color.key)"
      >A</button>
    </div>
    <button
      type="button"
      class="kb-color-more"
      :class="{ 'is-open': customFor === 'color' }"
      :aria-expanded="customFor === 'color'"
      aria-controls="kb-color-picker-fg"
      data-testid="editor-color-custom-color"
      @click="toggleCustom('color')"
    >
      <span aria-hidden="true">+</span> 更多颜色…
    </button>
    <ColorPicker
      v-if="customFor === 'color'"
      id="kb-color-picker-fg"
      :prop="customFor"
      :value="customValue"
      @pick="pickCustom"
      @close="customFor = null"
    />
    <div class="kb-color-caption">背景色</div>
    <div class="kb-color-grid">
      <button type="button" class="kb-editor-swatch is-none" :class="{ 'is-current': !bg }" title="无背景" aria-label="无背景" data-testid="editor-bg-none" @click="emit('pick', 'background-color', null)">⌀</button>
      <button
        v-for="color in BACKGROUND_COLORS"
        :key="`bg-${color.key}`"
        type="button"
        class="kb-editor-swatch kb-color is-bgswatch"
        :class="[`is-bg-${color.key}`, { 'is-current': bg === color.key }]"
        :title="color.label"
        :aria-label="color.label"
        :data-testid="`editor-color-bg-${color.key}`"
        @click="emit('pick', 'background-color', color.key)"
      ></button>
    </div>
    <button
      type="button"
      class="kb-color-more"
      :class="{ 'is-open': customFor === 'background-color' }"
      :aria-expanded="customFor === 'background-color'"
      aria-controls="kb-color-picker-bg"
      data-testid="editor-color-custom-bg"
      @click="toggleCustom('background-color')"
    >
      <span aria-hidden="true">+</span> 更多颜色…
    </button>
    <ColorPicker
      v-if="customFor === 'background-color'"
      id="kb-color-picker-bg"
      :prop="customFor"
      :value="customValue"
      @pick="pickCustom"
      @close="customFor = null"
    />
  </div>
</template>

<style>
.kb-color-panel,
.kb-editor-chrome-menu.kb-color-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 覆盖通用菜单的 4px：两排色块 + 取色器需要一点呼吸，触屏也不贴边框 */
  padding: 10px;
  box-sizing: border-box;
}
.kb-color-caption {
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  line-height: 1;
}
/* 两组之间多留一点空隙，第二个小标题不要贴在上一排色块下面 */
.kb-color-grid + .kb-color-more + .kb-color-caption,
.kb-color-picker + .kb-color-caption {
  margin-top: 4px;
}
.kb-color-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  margin-top: 2px;
  padding: 0 8px;
  border: var(--hl) dashed var(--border-default);
  border-radius: var(--r1);
  background: transparent;
  color: var(--text-secondary);
  font-size: calc(12px * var(--fs));
  cursor: pointer;
}
.kb-color-more:hover,
.kb-color-more.is-open {
  border-color: var(--accent);
  background: var(--surface-sunken);
  color: var(--accent);
}
.kb-color-more span {
  font-size: calc(14px * var(--fs));
  line-height: 1;
}
/* 8 个一排：默认 + 7 个常用色 */
.kb-color-grid {
  display: grid;
  grid-template-columns: repeat(8, 26px);
  gap: 4px;
}
.kb-color-panel .kb-editor-swatch {
  transition: transform var(--dur-instant) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.kb-color-panel .kb-editor-swatch:hover {
  transform: scale(1.1);
}
.kb-color-panel .kb-editor-swatch.is-current {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
@media (pointer: coarse) {
  .kb-color-grid {
    grid-template-columns: repeat(8, 34px);
    gap: 6px;
  }
  .kb-color-panel .kb-editor-swatch {
    width: 34px;
    height: 34px;
  }
  .kb-color-more {
    height: 34px;
  }
}

/* 320px 这类窄屏：8 个 34px 色块会撑出视口，改成 8 列等分；常见 390 宽不受影响 */
@media (pointer: coarse) and (max-width: 359px) {
  .kb-color-panel,
  .kb-editor-chrome-menu.kb-color-panel {
    width: calc(100vw - 16px);
  }
  .kb-color-grid {
    grid-template-columns: repeat(8, minmax(0, 1fr));
  }
  .kb-color-panel .kb-editor-swatch {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }
}

/* 触屏横屏 / 矮窗口：展开取色器后色板比屏幕高，锚在工具栏下方会整块掉到屏幕外。
   这种情况下改成居中浮层，内部滚动；键盘打开时工具栏已经贴键盘、面板自己会向上展开，不走这条。 */
@media (pointer: coarse) and (max-height: 820px) {
  html:not([data-kbd='open']) .kb-editor-chrome-menu.kb-color-panel {
    position: fixed;
    top: 50%;
    left: 50%;
    right: auto;
    bottom: auto;
    width: min(374px, calc(100vw - 16px));
    max-height: calc(100dvh - 16px);
    overflow-y: auto;
    overscroll-behavior: contain;
    translate: -50% -50% !important;
    align-items: stretch;
  }
  html:not([data-kbd='open']) .kb-editor-chrome-menu.kb-color-panel .kb-color-picker {
    width: 100%;
    max-width: 314px;
    margin-inline: auto;
  }
  html:not([data-kbd='open']) .kb-editor-chrome-menu.kb-color-panel .kb-color-presets {
    grid-template-columns: repeat(8, minmax(0, 1fr));
  }
  html:not([data-kbd='open']) .kb-editor-chrome-menu.kb-color-panel .kb-color-preset {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }
}
</style>
