<script setup lang="ts">
// 公开分享页的状态页:链接不存在 / 关闭 / 过期 / 撤销 / 暂不可用 / 需要登录 / 没权限 / 访问太频繁 / 连不上。
// 失效类只能联系所有者,不放「重试」;需要登录的放「登录」,登录后回到这个链接。
// 外观用通用的 StatusPage(和 404 / 服务不可用同一套)。
import { computed } from 'vue'
import { KbButton } from '@kb-ui/index'
import StatusPage from '@/components/StatusPage.vue'
import type { StatusView } from '@/utils/publicShare'

const props = defineProps<{ view: StatusView; token: string }>()
const emit = defineEmits<{ retry: [] }>()

const loginHref = computed(() => `/login?next=${encodeURIComponent(`/s/${props.token}`)}`)
</script>

<template>
  <div class="kb-pstat" data-testid="public-status" :data-code="view.code">
    <StatusPage :icon="view.icon" :title="view.title" :description="view.text">
      <template v-if="view.action">
        <a v-if="view.action === 'login'" class="btn pri" :href="loginHref" data-testid="public-login">登录</a>
        <KbButton v-else data-testid="public-retry" @click="emit('retry')">重试</KbButton>
      </template>
    </StatusPage>
  </div>
</template>
