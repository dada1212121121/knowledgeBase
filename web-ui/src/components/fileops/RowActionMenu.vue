<script setup lang="ts">
// 非文件行的右键菜单(笔记 / 集合 / 分类)。
// 为什么单独做:FileActionMenu 绑的是「原件路径 + 移动 / 删除原件」,笔记和集合没有原件可动;
// 桌面右键这些行以前完全没反应(手机上长按还有反馈),用户会以为右键功能坏了。
// 定位 / 关闭 / 键盘的操作和 FileActionMenu 保持一致:Esc 关、点外面关、贴近视口边缘时向内收。
import { computed, onBeforeUnmount, onMounted } from 'vue'

/** 一条可点的菜单项;run 抛错由调用方自己处理(这里只负责关菜单)。 */
export interface RowMenuEntry {
  label: string
  run: () => void
  danger?: boolean
}

/** 菜单状态:鼠标位置 + 标题 + 菜单项。 */
export interface RowMenuState {
  x: number
  y: number
  title: string
  subtitle?: string
  entries: RowMenuEntry[]
}

const props = defineProps<{ state: RowMenuState }>()
const emit = defineEmits<{ close: [] }>()

// 高度按条目数估,超过视口就往回收,免得菜单被切掉一半
const style = computed(() => {
  const width = 224
  const height = 42 + props.state.entries.length * 34
  return {
    left: `${Math.max(8, Math.min(props.state.x, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(props.state.y, window.innerHeight - height - 8))}px`,
  }
})

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}
// 用 mousedown 而不是 click:点空白处要立刻关,且不能把这一次点击漏给底下的行(会顺手把行点开)
function onPointer(event: PointerEvent) {
  if (!(event.target as HTMLElement).closest('.kb-row-menu')) emit('close')
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
    <div class="kb-row-menu" role="menu" :style="style" data-testid="row-action-menu" @click.stop>
      <div class="kb-row-menu-head">
        <b :title="state.title">{{ state.title }}</b>
        <span v-if="state.subtitle" class="m">{{ state.subtitle }}</span>
      </div>
      <button
        v-for="entry in state.entries"
        :key="entry.label"
        type="button"
        role="menuitem"
        class="kb-row-menu-item"
        :class="{ 'is-danger': entry.danger }"
        data-testid="row-menu-item"
        @click="emit('close'); entry.run()"
      >
        {{ entry.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.kb-row-menu {
  position: fixed;
  z-index: 900;
  display: flex;
  min-width: 200px;
  flex-direction: column;
  padding: 5px;
  border: var(--hl) solid var(--b2);
  border-radius: var(--r3);
  background: var(--panel);
  box-shadow: var(--shadow-lg, 0 12px 40px rgb(0 0 0 / 18%));
}
.kb-row-menu-head { display: grid; gap: 2px; padding: 6px 9px 8px; }
.kb-row-menu-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-13); }
.kb-row-menu-head .m { font-size: var(--text-11); }
.kb-row-menu-item {
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
.kb-row-menu-item:hover { background: var(--hover); }
.kb-row-menu-item.is-danger { color: var(--status-danger-text); }
</style>
