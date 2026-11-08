<script setup lang="ts">
// 账号没有开通「文档分享」功能时直接访问分享相关页面的提示(术语表:你的账号没有开通这个功能,请联系管理员)。
// 入口本来就按功能点隐藏了;这里是有人拿着旧链接 / 书签直接打开页面的兜底,后端对每个能力照样检查。
import { KbEmpty } from '@kb-ui/index'

defineProps<{ what?: string }>()
</script>

<template>
  <KbEmpty icon="lock" title="你的账号没有开通这个功能,请联系管理员" :description="`${what ?? '分享'}需要管理员给你的角色开通「文档分享」。`" data-testid="feature-off" />
</template>
