<script setup lang="ts">
// 分享面板（设计规范）:照腾讯文档,两个页签「协作者」「链接分享」。
// 电脑是居中的对话框(KbDialog),手机是底部弹层(KbSheet),里面的内容是同一份。
// 传一个资源 = 分享这一项;传多个 = 多选分享(协作者一次写到每一项,链接生成合集链接)。
// 所有改动即时生效(不是「填完再保存」),所以底部只有「完成」。
import { computed, ref } from 'vue'
import { KbDialog, KbSheet, KbTabs, PHONE_QUERY, useConfirm, useMedia, type TabItem } from '@kb-ui/index'
import ShareCollaborators from './ShareCollaborators.vue'
import ShareLink from './ShareLink.vue'
import type { LinkInfo, ShareTarget } from '@/api/share'
import { targetKey, targetName, uniqueTargets } from '@/utils/share'

const props = defineProps<{
  targets: ShareTarget[]
  /** 资源键 → 标题(笔记的标题后端没法从 target 里推出来,由调用方给) */
  titles?: Record<string, string>
  initialTab?: 'people' | 'link'
  /** 只管理这一条已有的链接(「我的分享」里点进来):不显示协作者页签 */
  link?: LinkInfo
}>()
const emit = defineEmits<{ close: []; changed: [] }>()

const confirmer = useConfirm()
const phone = useMedia(PHONE_QUERY)
// 触屏上一打开就弹出软键盘会盖住半个面板:只在有物理键盘 / 鼠标的设备上自动聚焦输入框
const touch = useMedia('(pointer: coarse)')

const targets = computed(() => uniqueTargets(props.targets))
const multi = computed(() => targets.value.length > 1)
const linkOnly = computed(() => !!props.link)
const tab = ref<'people' | 'link'>(props.link ? 'link' : (props.initialTab ?? 'people'))
// 链接页第一次切过去才挂载,之后一直保留(刚创建的完整地址在内存里,切回协作者页再回来不能丢)
const linkVisited = ref(tab.value === 'link')
const linkPane = ref<InstanceType<typeof ShareLink> | null>(null)

const tabs = computed<TabItem[]>(() => [
  ...(linkOnly.value ? [] : [{ value: 'people', label: '协作者' }]),
  { value: 'link', label: multi.value ? '合集链接' : '链接分享' },
])
function onTab(value: string) {
  tab.value = value as 'people' | 'link'
  if (value === 'link') linkVisited.value = true
}

const title = computed(() => {
  if (props.link) return props.link.bundle ? `合集链接「${props.link.title || '未命名'}」` : `分享链接「${props.link.title || targetName(props.targets[0]!)}」`
  if (multi.value) return `分享选中的 ${targets.value.length} 项`
  const only = targets.value[0]!
  return `分享「${targetName(only, props.titles?.[targetKey(only)])}」`
})
const bundleTitle = computed(() => {
  const first = targets.value[0]
  return first ? `${targetName(first, props.titles?.[targetKey(first)])} 等 ${targets.value.length} 项` : ''
})

/** 关闭前:刚生成的链接地址还没复制就关,后面再也找不回来,先问一句 */
async function requestClose() {
  if (linkPane.value?.pendingUrl) {
    const leave = await confirmer.ask({
      title: '链接地址还没复制',
      message: '完整地址只显示这一次,关掉面板就找不回来了。你仍然可以之后「重置链接」换一个新地址。',
      confirmText: '仍要关闭',
      cancelText: '回去复制',
    })
    if (!leave) return
  }
  emit('close')
}
</script>

<template>
  <component
    :is="phone ? KbSheet : KbDialog"
    :title="title"
    v-bind="phone ? {} : { width: '600px' }"
    :no-autofocus="touch || tab === 'link'"
    @close="requestClose"
  >
    <div class="kb-share-panel" data-testid="share-panel">
      <KbTabs :model-value="tab" :tabs="tabs" flush @update:model-value="onTab" />
      <div v-if="!linkOnly" v-show="tab === 'people'" class="kb-share-pane" role="tabpanel"><ShareCollaborators :targets="targets" :titles="titles" @changed="emit('changed')" /></div>
      <div v-if="linkVisited" v-show="tab === 'link'" class="kb-share-pane" role="tabpanel">
        <ShareLink ref="linkPane" :targets="targets" :titles="titles" :bundle-title="bundleTitle" :initial-link="link" @changed="emit('changed')" @gone="linkOnly && emit('close')" />
      </div>
    </div>
    <template #footer>
      <button type="button" class="btn pri" data-testid="share-done" @click="requestClose">完成</button>
    </template>
  </component>
</template>

<style>
/* 左右各留 4px:触屏上 KbButton 小按钮的可点区域伪元素会向两侧各外扩 4px,贴着右缘的按钮不留余量就会让面板多出横向滚动 */
.kb-share-panel { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; padding-inline: var(--sp-1); }
.kb-share-pane { min-width: 0; }
</style>
