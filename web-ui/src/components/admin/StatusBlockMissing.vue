<script setup lang="ts">
// 系统状态页里「这一块没读到」:只占这一块的位置,其它块照常显示。
import { KbButton, KbEmpty } from '@kb-ui/index'

defineProps<{ name: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="card kb-sbm" role="alert" data-testid="block-missing" :data-block="name">
    <KbEmpty icon="failed" size="sm" :title="`「${name}」这一块没有读到`" description="其它部分不受影响。点「重新读取」再试一次;一直读不到,说明服务端采集这一块时出错了,需要到服务器上看守护进程的日志。">
      <template #action><KbButton size="sm" @click="$emit('retry')">重新读取</KbButton></template>
    </KbEmpty>
  </div>
</template>

<style>
.kb-sbm { flex: 0 0 auto; min-width: 0; }
</style>
