<script setup lang="ts">
// 骨架屏(uilab 的 app-skeleton + 设计规范「加载用骨架屏」):首次加载时用占位块代替「读取中…」,光带从左扫到右。
//   variant=lines(默认,几行文字)· list(头像 + 两行)· card(卡片:标题 + 正文)· table(表头 + 若干行)
// 读屏软件只读一次「加载中」,不逐块朗读;减少动效时光带不动(见 motion-ui.css)。
withDefaults(
  defineProps<{ lines?: number; height?: string; width?: string; rows?: boolean; variant?: 'lines' | 'list' | 'card' | 'table' }>(),
  { lines: 3, height: '12px', width: '100%', rows: false, variant: 'lines' },
)
</script>

<template>
  <div class="kb-skel" :class="[{ 'is-rows': rows }, `is-${variant}`]" role="status" aria-busy="true" aria-label="加载中">
    <template v-if="variant === 'list'">
      <div v-for="index in lines" :key="index" class="kb-skel-item">
        <span class="skel kb-skel-avatar"></span>
        <span class="kb-skel-stack"><span class="skel kb-skel-line kb-skel-w70"></span><span class="skel kb-skel-line kb-skel-w40"></span></span>
      </div>
    </template>
    <template v-else-if="variant === 'card'">
      <span class="skel kb-skel-line kb-skel-w40 kb-skel-title"></span>
      <span v-for="index in lines" :key="index" class="skel kb-skel-line" :class="index === lines ? 'kb-skel-w62' : 'kb-skel-w100'"></span>
    </template>
    <template v-else-if="variant === 'table'">
      <span class="skel kb-skel-line kb-skel-head"></span>
      <span v-for="index in lines" :key="index" class="skel kb-skel-line kb-skel-row"></span>
    </template>
    <template v-else>
      <span
        v-for="index in lines"
        :key="index"
        class="skel kb-skel-line"
        :style="{ height, width: index === lines && lines > 1 ? '62%' : width }"
        style-allow="骨架块尺寸"
      ></span>
    </template>
  </div>
</template>
