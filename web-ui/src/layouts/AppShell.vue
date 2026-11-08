<script setup lang="ts">
// 页面框架:每个页面的根组件(名字沿用 AppShell,页面代码不用改)。
//
// 真正的外壳(侧栏 / 顶栏 / 页脚 / 全局浮层)在 ShellFrame.vue,整个应用只挂载一次——
// 这样切页时侧栏不会销毁重建(导航高亮能滑动、滚动位置和展开状态都保留)。
// 本组件做两件事:
//   1) 把 #breadcrumb / #actions 插槽「传送」进常驻外壳的顶栏;
//   2) 渲染页面内容(.content 或 bare 的顶层容器)和宽屏右栏。
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AsideRail from '@/components/AsideRail.vue'
import { PATHS } from '@/router/paths'

// bare:页面自己就是 .setrow / .panes 这类顶层容器(设置、浏览器),不要再包一层 .content
// roomy:项目 / 评测等设计稿的内容区内边距更大(18px 22px,间距 14px)
// rail:宽屏(≥1920)右侧的「新增笔记 / 审核收件箱 / 快捷键」栏——仪表盘、任务、搜索的设计稿都有
// title:页面自己指定顶栏标题。默认取路由 meta.title;「没有开通」这类页面不能用路由里的名字
// (例如 AI 总开关关闭时,/assistant 的路由名带「AI」字样),就由页面传一个中性的标题进来
const props = withDefaults(defineProps<{ bare?: boolean; roomy?: boolean; rail?: boolean; title?: string }>(), { bare: false, roomy: false, rail: false, title: undefined })
const route = useRoute()
// 手机顶栏的页面名:挂在「设置」下的页面(外观 / 项目与集合 / 系统状态)顶栏都显示「设置」,导入下的页面(全部 / 队列)都显示「导入」
const GROUP_TITLE: Record<string, string> = { [PATHS.import]: '导入' }
const title = computed(
  () => props.title ?? GROUP_TITLE[route.meta.group as string] ?? ((route.meta.title as string) ?? '首页').split(' · ')[0] ?? '首页',
)
</script>

<template>
  <div class="kb-page-root">
    <Teleport defer to="#kb-slot-bc">
      <slot name="breadcrumb"><b>{{ title }}</b></slot>
    </Teleport>
    <!-- 手机顶栏只放页面名(设计稿的 .mbar 都是「☰ 页面名 🔍」);完整面包屑只在桌面顶栏 -->
    <Teleport defer to="#kb-slot-mbar">
      <b>{{ title }}</b>
    </Teleport>
    <!-- 页面操作:各页自己放。全局顶栏不再有「刷新」——数据靠 WebSocket 自动更新,需要手动刷新的页面在自己的工具栏里放 -->
    <Teleport defer to="#kb-slot-actions">
      <slot name="actions"></slot>
    </Teleport>

    <slot v-if="bare" />
    <div v-else class="content" :class="{ 'is-roomy': roomy }"><slot /></div>
    <aside v-if="$slots.aside" class="xaside"><slot name="aside" /></aside>
    <AsideRail v-else-if="rail" />
  </div>
</template>
