<script setup lang="ts">
// 微信 / QQ 等内置浏览器里下载会被拦住、点了没反应(设计规范)。在下载按钮旁说明怎么办,并给「复制链接」备用。
// 不在内置浏览器里什么都不渲染,所以调用方不用自己判断;只是提示,不会去拦截下载本身。
import { KbCopyButton } from '@kb-ui/index'
import { inAppDownloadNote } from '@/utils/inApp'

const note = inAppDownloadNote(typeof navigator === 'undefined' ? '' : navigator.userAgent)
/**
 * 复制的是当前页面的地址:粘到系统浏览器里打开同一页,再点下载。
 * 不复制文件的直链:没登录的浏览器、没带链接 cookie 的浏览器(有访问密码的分享)直接打开直链会被拒绝。
 */
const pageLink = () => window.location.href
</script>

<template>
  <div v-if="note" class="kb-inapp" role="note" data-testid="inapp-download">
    <span class="kb-inapp-text">{{ note }}</span>
    <KbCopyButton :text="pageLink" label="复制链接" />
  </div>
</template>

<style>
.kb-inapp { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: rgb(var(--ink), 0.04); color: var(--text-secondary); font-size: var(--text-12); line-height: var(--lh-body); }
.kb-inapp-text { flex: 1 1 14em; min-width: 0; overflow-wrap: anywhere; }
</style>
