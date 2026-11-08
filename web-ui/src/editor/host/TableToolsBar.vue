<script setup lang="ts">
/**
 * 表格工具条：光标在表格里时出现在顶部工具栏的下面（和以前的颜色条同一个位置），离开表格就收起。
 *
 * 取代了原来跟着光标飘在表格旁边的浮动工具条：浮着的东西会盖住表格内容、随光标乱跑，点的时候还容易点偏。
 * 这里按钮固定在工具栏下面，只发命令（与别的编辑同一条通道：撤销栈、只读守卫、协同一致）。
 * 按钮 id / 命令和浮动工具条一致（row-above … table-delete），不动编辑器焦点（mousedown 不默认处理），光标留在格子里。
 */
import ToolIcon from './ToolIcon.vue'
import { namedToolIcon, type ToolIconName } from './toolIcons'

const emit = defineEmits<{ (e: 'run', type: string, args?: unknown): void }>()

interface Tool {
  id: string
  label: string
  icon: ToolIconName
  type: string
  args?: unknown
}
// 分组之间画竖线：行 | 列 | 对齐 | 整张表
const GROUPS: readonly (readonly Tool[])[] = [
  [
    { id: 'row-above', label: '在上方插入一行', icon: 'rowAbove', type: 'table.addRow', args: { where: 'before' } },
    { id: 'row-below', label: '在下方插入一行', icon: 'rowBelow', type: 'table.addRow', args: { where: 'after' } },
    { id: 'row-delete', label: '删除当前行（表头行不能删）', icon: 'rowDelete', type: 'table.deleteRow' },
  ],
  [
    { id: 'col-left', label: '在左侧插入一列', icon: 'colLeft', type: 'table.addColumn', args: { where: 'before' } },
    { id: 'col-right', label: '在右侧插入一列', icon: 'colRight', type: 'table.addColumn', args: { where: 'after' } },
    { id: 'col-delete', label: '删除当前列', icon: 'colDelete', type: 'table.deleteColumn' },
  ],
  [
    { id: 'align-left', label: '本列左对齐', icon: 'alignLeft', type: 'table.align', args: { align: 'left' } },
    { id: 'align-center', label: '本列居中', icon: 'alignCenter', type: 'table.align', args: { align: 'center' } },
    { id: 'align-right', label: '本列右对齐', icon: 'alignRight', type: 'table.align', args: { align: 'right' } },
  ],
  [{ id: 'table-delete', label: '删除整张表格', icon: 'tableDelete', type: 'table.delete' }],
]
</script>

<template>
  <div class="kb-editor-chrome-sub kb-table-tools" role="toolbar" aria-label="表格工具" data-testid="editor-table-tools" @mousedown.prevent>
    <span class="kb-editor-chrome-hint">表格</span>
    <template v-for="(group, index) in GROUPS" :key="index">
      <span v-if="index > 0" class="kb-editor-chrome-sep" aria-hidden="true"></span>
      <button
        v-for="tool in group"
        :key="tool.id"
        type="button"
        class="kb-editor-tool"
        :class="{ 'is-danger': tool.id === 'table-delete' }"
        :aria-label="tool.label"
        :title="tool.label"
        :data-action="tool.id"
        @click="emit('run', tool.type, tool.args)"
      >
        <ToolIcon :paths="namedToolIcon(tool.icon)" />
      </button>
    </template>
  </div>
</template>

<style>
.kb-table-tools {
  gap: 2px;
}
.kb-table-tools .kb-editor-chrome-hint {
  margin-right: 6px;
}
.kb-editor-tool.is-danger:hover:not(:disabled) {
  color: var(--status-danger-text, var(--accent));
}
</style>
