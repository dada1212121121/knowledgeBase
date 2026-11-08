<script setup lang="ts">
// 管理页的「加载中 / 报错 / 无权限」三种非正常内容态(第四种「空」由各页按自己的内容给下一步)。
//   loading   骨架屏,不用「加载中…」文字;
//   error     出了什么事 + 怎么办,带「重试」;
//   forbidden 账号没有开通这个功能(后端 403):说明原因,不给重试(重试不会变)。
import { KbButton, KbEmpty, KbSkeleton } from '@kb-ui/index'
import type { LoadPhase } from '@/utils/loadState'

withDefaults(
  defineProps<{
    phase: LoadPhase
    message?: string
    /** 骨架屏的样子,尽量贴近真实内容。 */
    skeleton?: 'table' | 'card' | 'lines'
  }>(),
  { message: '', skeleton: 'table' },
)
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="phase === 'loading'" class="card kb-als" data-testid="admin-loading">
    <KbSkeleton :variant="skeleton" :lines="5" />
  </div>
  <div v-else-if="phase === 'forbidden'" class="card kb-als" data-testid="admin-forbidden">
    <KbEmpty icon="lock" title="你的账号没有开通这个功能" :description="message || '请联系管理员为你的账号开通。'" />
  </div>
  <div v-else-if="phase === 'error'" class="card kb-als" role="alert" data-testid="admin-error">
    <KbEmpty icon="failed" title="没能读到数据" :description="message">
      <template #action><KbButton variant="primary" @click="$emit('retry')">重试</KbButton></template>
    </KbEmpty>
  </div>
</template>

<style>
.kb-als{padding:var(--card-pad,16px)}
</style>
