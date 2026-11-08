<script setup lang="ts">
// 布局图(设计规范): 侧栏 / 图标栏 / 顶部导航 / 内容宽度。
withDefaults(defineProps<{ label: string; active: boolean; kind?: 'sidebar' | 'rail' | 'topnav' | 'fluid' | 'centered' }>(), {
  kind: 'sidebar',
})
const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <div class="lay" :class="{ on: active }" @click="emit('select')">
    <div class="pg">
      <template v-if="kind === 'sidebar'">
        <div class="hl" style="width: 30%"></div>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px"><div style="height: 8px"></div><div style="flex: 1"></div></div>
      </template>
      <template v-else-if="kind === 'rail'">
        <div class="hl" style="width: 10%"></div>
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px"><div style="height: 8px"></div><div style="flex: 1"></div></div>
      </template>
      <template v-else-if="kind === 'topnav'">
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px; background: none">
          <div class="hl" style="height: 10px; border-radius: 3px"></div>
          <div style="flex: 1; border-radius: 3px; background: rgba(var(--ink), .08)"></div>
        </div>
      </template>
      <template v-else-if="kind === 'fluid'">
        <div style="flex: 1; display: flex; flex-direction: column; gap: 4px; background: none">
          <div class="hl" style="flex: 1; border-radius: 3px"></div>
        </div>
      </template>
      <template v-else-if="kind === 'centered'">
        <div style="flex: 1; display: flex; justify-content: center; background: none">
          <div class="hl" style="width: 56%; border-radius: 3px"></div>
        </div>
      </template>
    </div>
    <div class="nm">{{ label }}</div>
  </div>
</template>
