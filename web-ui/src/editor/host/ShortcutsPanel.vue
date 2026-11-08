<script setup lang="ts">
/**
 * 快捷键一览（Ctrl+/ 打开）：按钮的快捷键 + 工具栏之外的键 + Markdown 快捷输入。
 *
 * 内容由 Chrome 从工具栏数据里现取（按钮上的 `shortcut` 字段），所以和按钮提示永远一致；
 * 这里只负责排版。不抢焦点：开着它也能接着打字，光标还在原处（Esc、再按一次 Ctrl+/、点外面都能关掉）。
 */
import { shortcutLabel } from './shortcutLabel'

export interface ShortcutSection {
  title: string
  items: readonly { label: string; keys: string }[]
  /** 打字类（Markdown 快捷输入）：按键列用等宽字体原样显示，不按平台换成 ⌘ */
  typed?: boolean
}

defineProps<{ sections: readonly ShortcutSection[] }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="kb-editor-shortcuts" role="region" aria-label="快捷键一览" data-testid="editor-shortcuts">
    <div class="kb-editor-shortcuts-head">
      <span>快捷键</span>
      <button type="button" class="btn sm kb-ghost" aria-label="关闭快捷键一览" data-testid="editor-shortcuts-close" @click="emit('close')">关闭</button>
    </div>
    <div class="kb-editor-shortcuts-body">
      <section v-for="section in sections" :key="section.title" class="kb-editor-shortcuts-sec">
        <h3>{{ section.title }}</h3>
        <dl>
          <div v-for="item in section.items" :key="item.label" class="kb-editor-shortcuts-row">
            <dt>{{ item.label }}</dt>
            <dd :class="{ 'is-typed': section.typed }">{{ section.typed ? item.keys : shortcutLabel(item.keys) }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>

<style>
.kb-editor-shortcuts {
  position: absolute;
  top: calc(100% + 6px);
  right: 7px;
  z-index: 31;
  width: min(560px, calc(100vw - 24px));
  max-height: min(70vh, 560px);
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border: var(--hl) solid var(--border-default);
  border-radius: var(--r3);
  box-shadow: var(--sh3);
  overflow: hidden;
}
.kb-editor-shortcuts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 8px 4px 14px;
  color: var(--text-primary);
  font-size: calc(13px * var(--fs));
  font-weight: 600;
}
.kb-editor-shortcuts-body {
  padding: 2px 14px 12px;
  overflow: auto;
  columns: 2 220px;
  column-gap: 20px;
}
.kb-editor-shortcuts-sec {
  break-inside: avoid;
  margin: 0 0 10px;
}
.kb-editor-shortcuts-sec h3 {
  margin: 6px 0 4px;
  color: var(--text-tertiary);
  font-size: calc(12px * var(--fs));
  font-weight: 500;
}
.kb-editor-shortcuts-sec dl {
  margin: 0;
}
.kb-editor-shortcuts-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: calc(13px * var(--fs));
  line-height: 1.4;
}
.kb-editor-shortcuts-row dt {
  color: var(--text-secondary);
}
.kb-editor-shortcuts-row dd {
  margin: 0;
  flex: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  white-space: nowrap;
}
.kb-editor-shortcuts-row dd.is-typed {
  font-family: var(--font-mono);
  font-size: calc(12px * var(--fs));
}
</style>
