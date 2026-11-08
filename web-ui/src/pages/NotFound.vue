<script setup lang="ts">
// 404:地址不对(输错了、书签过期、页面搬了)。放在外壳里,侧栏还在,用户一眼能去别处。
// 登录了才会走到这里(未登录会先被守卫带去登录页)。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KbButton } from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import StatusPage from '@/components/StatusPage.vue'
import { useFeature } from '@/composables/useFeature'
import { PATHS } from '@/router/paths'

const route = useRoute()
const router = useRouter()
const canSearch = useFeature('search.basic')
// 有上一页就给「返回上一页」(新开的标签页没有历史,按钮点了没反应,不如不放)
const canGoBack = computed(() => typeof window !== 'undefined' && window.history.length > 1)
</script>

<template>
  <AppShell>
    <StatusPage icon="search" title="找不到这个页面" description="地址可能输错了,或者这个页面已经移走、删除了。" data-testid="not-found">
      <KbButton variant="primary" data-testid="nf-home" @click="router.push(PATHS.home)">回首页</KbButton>
      <KbButton v-if="canSearch" data-testid="nf-search" @click="router.push(PATHS.search)">去搜索</KbButton>
      <KbButton v-if="canGoBack" data-testid="nf-back" @click="router.back()">返回上一页</KbButton>
      <template #detail><span class="mono" data-testid="nf-path">{{ route.fullPath }}</span></template>
    </StatusPage>
  </AppShell>
</template>
