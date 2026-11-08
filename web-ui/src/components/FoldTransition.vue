<script setup lang="ts">
/**
 * 内容出现 / 消失时高度平滑展开收起（grid 0fr↔1fr，样式在 kb-ui 的 motion-ui.css 里）。
 *
 * 为什么不直接在输入条上写 v-if：条是直接插进文档流的，一帧内把下面的正文整块顶开 / 拉回，
 * 看起来就是「跳」。包一层折叠后，条是长出来的，下面的内容跟着滑过去。
 * 用法：<FoldTransition :open="linkOpen"><div class="…">…</div></FoldTransition>
 */
defineProps<{ open: boolean }>()
</script>

<template>
  <Transition name="kb-fold">
    <div v-if="open" class="kb-fold">
      <div class="kb-fold-inner"><slot /></div>
    </div>
  </Transition>
</template>
