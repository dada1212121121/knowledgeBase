<script setup lang="ts">
// 桌面右键菜单:定位在鼠标处,键盘 Esc / 点外面关闭。
// 不能做的项不隐藏——灰掉并写出原因,用户才知道为什么(比如「本地目录的文件不能移动」)。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { KbIcon } from '@kb-ui/index'
import type { MenuState } from '@/composables/useFileActions'

const props = withDefaults(defineProps<{ state: MenuState; selectable?: boolean }>(), { selectable: true })
const emit = defineEmits<{ close: []; pick: [kind: 'delete' | 'move']; select: [] }>()

const style = computed(() => {
  const point = props.state.point ?? { x: 24, y: 24 }
  const width = 236
  const height = 190
  return {
    left: `${Math.max(8, Math.min(point.x, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(point.y, window.innerHeight - height - 8))}px`,
  }
})

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}
function onPointer(event: PointerEvent) {
  if (!(event.target as HTMLElement).closest('.kb-file-menu')) emit('close')
}
onMounted(() => {
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointer, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  document.removeEventListener('pointerdown', onPointer, true)
})
</script>

<template>
  <Teleport to="body">
    <div class="kb-file-menu" role="menu" :style="style" data-testid="file-action-menu" @click.stop>
      <div class="kb-file-menu-head">
        <b :title="state.target.path">{{ state.target.name }}</b>
        <span class="m">{{ state.actions.folder ? `文件夹 · ${state.actions.files} 个文件` : '文件' }}</span>
      </div>
      <template v-if="selectable">
        <button type="button" role="menuitem" class="kb-file-menu-item" data-testid="file-menu-select" @click="emit('select')">
          <KbIcon name="check" :size="14" /><span>多选</span>
        </button>
        <div class="kb-file-menu-sep"></div>
      </template>
      <button
        type="button"
        role="menuitem"
        class="kb-file-menu-item"
        :disabled="!state.actions.move.allowed"
        :title="state.actions.move.reason ?? '移动到另一个文件夹'"
        data-testid="file-menu-move"
        @click="emit('pick', 'move')"
      >
        <KbIcon name="folder" :size="14" /><span>移动…</span>
      </button>
      <div v-if="!state.actions.move.allowed && state.actions.move.reason" class="kb-file-menu-why">{{ state.actions.move.reason }}</div>
      <button
        type="button"
        role="menuitem"
        class="kb-file-menu-item is-danger"
        :disabled="!state.actions.delete.allowed"
        :title="state.actions.delete.reason ?? '移到回收站 / 移除索引'"
        data-testid="file-menu-delete"
        @click="emit('pick', 'delete')"
      >
        <KbIcon name="trash" :size="14" /><span>删除…</span>
      </button>
      <div v-if="!state.actions.delete.allowed && state.actions.delete.reason" class="kb-file-menu-why">{{ state.actions.delete.reason }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.kb-file-menu {
  position: fixed;
  z-index: 90;
  width: 236px;
  padding: 6px;
  border: 1px solid var(--b);
  border-radius: var(--r3);
  background: var(--panel);
  box-shadow: var(--shadow-lg, 0 12px 40px rgb(0 0 0 / 18%));
}
.kb-file-menu-head { display: grid; gap: 2px; padding: 6px 9px 8px; }
.kb-file-menu-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-13); }
.kb-file-menu-head .m { font-size: var(--text-11); }
.kb-file-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border: 0;
  border-radius: var(--r1);
  background: none;
  color: var(--ink);
  font: inherit;
  font-size: var(--text-13);
  text-align: left;
  cursor: pointer;
}
.kb-file-menu-item:hover:not(:disabled) { background: var(--hover); }
.kb-file-menu-item:disabled { color: var(--m); cursor: not-allowed; }
.kb-file-menu-item.is-danger { color: var(--status-danger-text); }
.kb-file-menu-sep { height: 1px; margin: 4px 6px; background: var(--b); }
.kb-file-menu-why { padding: 0 9px 6px 32px; color: var(--m); font-size: var(--text-11); line-height: 1.4; }
</style>
