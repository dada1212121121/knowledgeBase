<script setup lang="ts">
// 设置分区布局(设计规范): 左侧分区导航 + 右侧内容; 窄屏自动改为顶部横向标签。
withDefaults(
  defineProps<{
    items: string[]
    active: string
    flush?: boolean
  }>(),
  {
    flush: false,
  },
)
const emit = defineEmits<{ select: [item: string] }>()
</script>

<template>
  <div class="kb-settings setrow">
    <!-- 没有分区时不渲染导航:否则桌面留一条带边框的空侧栏、手机留一条空白分隔栏 -->
    <nav v-if="items.length" class="kb-settings-nav snav">
      <!-- 分区导航项是按钮:以前是只绑了 click 的 <span>,键盘 Tab 够不到、读屏不知道能点,
           窄屏横向滚动时 axe 的 scrollable-region-focusable 也因此报错(滚动区里没有任何可聚焦的东西) -->
      <button
        v-for="item in items"
        :key="item"
        type="button"
        class="ni"
        :class="{ on: item === active }"
        :aria-current="item === active ? 'true' : undefined"
        @click="emit('select', item)"
      >
        {{ item }}
      </button>
    </nav>
    <div v-if="!flush" class="kb-settings-body"><slot /></div>
    <slot v-else />
  </div>
</template>
