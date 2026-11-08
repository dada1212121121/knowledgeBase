<script setup lang="ts">
import { recentDayKeys } from '@/utils/time'
// 宽屏(≥1920)右栏:新增笔记热力 / 审核收件箱 / 快捷键。没有审核功能点(AI 总开关关掉时就是这样)时审核收件箱和「去审核」快捷键不出现。设计稿的仪表盘、任务、搜索三个页面都有同一份,
// 所以放在页面框架里统一渲染,页面不再各写一遍。数据来自 shell store(与侧栏同源,不额外请求)。
// 审核收件箱卡片和对应的快捷键只给有「自动提炼与审核」功能的账号(AI 总开关关闭时没有),
// 否则点「去审核」会进到没开通的页面,卡片上的「待审」也毫无意义。
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { KbCard, KbHeatmap } from '@kb-ui/index'
import { useShellStore } from '@/stores/shell'
import { useSessionStore } from '@/stores/session'
import { PATHS } from '@/router/paths'

const router = useRouter()
const shell = useShellStore()
const session = useSessionStore()
const canReview = computed(() => session.has('ai.extract'))
const canSearch = computed(() => session.has('search.basic'))
const { activity, drafts } = storeToRefs(shell)

/** 近 7 天(含今天),按日期升序;没有记录的日子是 0 */
const days = computed(() => recentDayKeys(7))
const cells = computed(() => {
  const byDay = new Map<string, number>()
  for (const item of activity.value) byDay.set(item.day, (byDay.get(item.day) ?? 0) + item.insights)
  return days.value.map((date) => ({ date, value: byDay.get(date) ?? 0 }))
})
/** 连续天数:从今天往前数,连续有新增的天数(设计稿的右栏写的就是「连续 N 天」) */
const streak = computed(() => {
  let count = 0
  for (let index = cells.value.length - 1; index >= 0; index--) {
    if ((cells.value[index]?.value ?? 0) <= 0) break
    count++
  }
  return count
})
</script>

<template>
  <aside class="xaside" aria-label="概览">
    <div class="lbl">新增笔记 · 近 16 周</div>
    <KbCard variant="dots">
      <KbHeatmap :cells="cells" :weeks="16" />
      <div class="row m kb-legend">
        少
        <span class="dot kb-heat-1"></span><span class="dot kb-heat-2"></span><span class="dot kb-heat-3"></span>
        多
        <span class="mono kb-spacer">连续 {{ streak }} 天</span>
      </div>
    </KbCard>
    <div v-if="canReview" class="lbl">审核收件箱</div>
    <KbCard v-if="canReview" class="kb-aside-card" data-testid="rail-review">
      <div class="row">
        <span class="tag" :class="{ y: drafts > 0 }">{{ drafts > 0 ? '待审' : '已清空' }}</span>
        <span class="mono m kb-spacer">{{ drafts }} 条</span>
      </div>
      <button type="button" class="btn sm kb-aside-action" @click="router.push(PATHS.review)">去审核 →</button>
    </KbCard>
    <div class="lbl">快捷键</div>
    <KbCard class="kb-aside-card kb-keys">
      <div class="row">命令面板<span class="kbd kb-spacer">⌘K</span></div>
      <div v-if="canSearch" class="row">去搜索<span class="kbd kb-spacer">G S</span></div>
      <div v-if="canReview" class="row">去审核<span class="kbd kb-spacer">G R</span></div>
    </KbCard>
  </aside>
</template>
