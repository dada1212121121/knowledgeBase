<script setup lang="ts">
// 页面骨架的第一块（设计规范）:标题、说明、可选面包屑、主操作。
//   PageHeader(标题 / 说明 / 主操作)→ 可选统计卡片 → 工具栏 → 内容
// 手机上操作区换到标题下面并允许折行,按钮不会被挤出屏幕;back 给嵌套页面一个返回键。
import { nextTick, onMounted, ref, watch } from 'vue'
import KbIcon from './KbIcon.vue'

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    /** 显示返回键(点击发出 back);手机上嵌套页面用 */
    back?: boolean
    /** 标题的语义级别:页面里通常是 1;放在卡片 / 抽屉里时用 2 */
    level?: 1 | 2
  }>(),
  { description: '', back: false, level: 1 },
)
defineEmits<{ back: [] }>()

// 手机顶栏(#kb-slot-mbar)已经写了页面名:页内标题和它一模一样时,视觉上再画一遍只是白占一行(设计稿)。
// 标题仍留在 DOM 里(读屏软件和 h1 结构需要它),只是视觉隐藏;和顶栏不同的(首页的问候语、嵌套页的子标题)照常显示。
// 比较的是文字,所以顶栏里的名字和页内标题不一致时不会误藏。
const dup = ref(false)
function sync() {
  const bar = document.getElementById('kb-slot-mbar')?.textContent?.trim()
  dup.value = !!bar && bar === props.title.trim()
}
onMounted(() => void nextTick(sync))
watch(() => props.title, () => void nextTick(sync))
</script>

<template>
  <header class="kb-ph">
    <div v-if="$slots.breadcrumb" class="kb-ph-crumb"><slot name="breadcrumb" /></div>
    <div class="kb-ph-row">
      <button v-if="back" type="button" class="kb-icon-btn kb-ph-back" aria-label="返回" @click="$emit('back')"><KbIcon name="back" :size="18" /></button>
      <div class="kb-ph-main">
        <component :is="`h${level}`" class="kb-ph-title" :class="{ 'is-dup': dup }">{{ title }}</component>
        <p v-if="description" class="kb-ph-desc">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="kb-ph-actions"><slot name="actions" /></div>
    </div>
    <div v-if="$slots.default" class="kb-ph-extra"><slot /></div>
  </header>
</template>
