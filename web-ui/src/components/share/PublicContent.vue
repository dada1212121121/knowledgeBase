<script setup lang="ts">
// 公开分享页的正文区:链接指向一篇文档 → 直接显示;指向文件夹 / 集合 → 目录列表,点一篇进去,面包屑回上一级;
// 合集链接(多选生成)→ 一个虚拟目录,里面是选中的这些项(合集里被删掉 / 移出权限的项,后端打开时自动不返回)。
// 读写全部经 linkAccess(token, can) 走 /share/{token}/call/…,白名单之外的操作后端一律拒绝。
import { computed, onMounted, ref, watch } from 'vue'
import { KbIcon, useConfirm } from '@kb-ui/index'
import SharedDoc from './SharedDoc.vue'
import SharedFolder from './SharedFolder.vue'
import { linkAccess, type PublicActive, type ShareTarget } from '@/api/share'
import { rootKind, rootLabel } from '@/utils/publicShare'
import { targetKey } from '@/utils/share'

const props = defineProps<{ info: PublicActive; token: string }>()
const emit = defineEmits<{ title: [title: string]; dirty: [value: boolean] }>()

const confirmer = useConfirm()
const access = computed(() => linkAccess(props.token, props.info.can, { guest: props.info.visitor.kind === 'guest', spaceId: props.info.roots[0]?.space_id }))
const myId = computed(() => (props.info.visitor.kind === 'user' ? (props.info.visitor.id ?? null) : null))

interface Step {
  target: ShareTarget
  title: string
}
const FOLDERS = new Set(['dir', 'collection', 'space'])
const isFolder = (target: ShareTarget) => FOLDERS.has(target.kind)

/** 合集:没有选定任何一项时显示根列表;单个链接一进来就是它指向的那一项 */
const bundle = computed(() => props.info.bundle && props.info.roots.length !== 1)
const trail = ref<Step[]>([])
function reset() {
  trail.value = bundle.value || !props.info.roots[0] ? [] : [{ target: props.info.roots[0], title: props.info.title ?? '' }]
}
reset()
watch(() => props.token, reset)

const current = computed(() => trail.value[trail.value.length - 1] ?? null)
const doc = ref<{ dirty: boolean } | null>(null)

// 合集根列表里的笔记要显示标题:后端的 roots 只给资源(没有标题),逐个 get_item 取(限量、限并发,取不到就显示「笔记」)
const titles = ref<Record<string, string>>({})
const LABEL_LIMIT = 60
async function loadTitles() {
  if (!bundle.value) return
  const wanted = props.info.roots.filter((root) => root.kind === 'insight' && root.id).slice(0, LABEL_LIMIT)
  for (let at = 0; at < wanted.length; at += 6) {
    await Promise.all(
      wanted.slice(at, at + 6).map(async (root) => {
        try {
          const found = await access.value.call<{ item: { title: string | null } }>('get_item', { id: root.id })
          if (found.item.title) titles.value = { ...titles.value, [root.id!]: found.item.title }
        } catch {
          // 只是少一个标题:这一项显示「笔记」,点开时会说清楚能不能打开
        }
      }),
    )
  }
}
onMounted(() => void loadTitles())

async function leaveOk(): Promise<boolean> {
  if (!doc.value?.dirty) return true
  return confirmer.ask({ title: '放弃未保存的修改?', message: '这篇文档的改动不会保留。', confirmText: '放弃修改', cancelText: '继续编辑', tone: 'danger' })
}
async function open(target: ShareTarget, title: string) {
  if (!(await leaveOk())) return
  trail.value = [...trail.value, { target, title }]
}
async function goTo(index: number) {
  // index -1 = 回到合集根列表
  if (index === trail.value.length - 1 || !(await leaveOk())) return
  trail.value = trail.value.slice(0, index + 1)
}
const canGoUp = computed(() => trail.value.length > (bundle.value ? 0 : 1))
const crumbs = computed(() => trail.value.map((step, index) => ({ ...step, index })))

watch(current, (step) => emit('title', step?.title ?? props.info.title ?? ''), { immediate: true })
</script>

<template>
  <div class="kb-pcon" data-testid="public-content">
    <nav v-if="canGoUp || (bundle && current)" class="kb-pcon-crumb" aria-label="位置">
      <button v-if="bundle" type="button" class="kb-pcon-crumb-btn" data-testid="public-crumb-root" @click="goTo(-1)">{{ info.title || '合集' }}</button>
      <template v-for="step in crumbs" :key="step.index">
        <span v-if="bundle || step.index > 0" class="kb-pcon-sep">/</span>
        <button v-if="step.index < crumbs.length - 1" type="button" class="kb-pcon-crumb-btn" @click="goTo(step.index)">{{ step.title }}</button>
        <b v-else-if="bundle || step.index > 0">{{ step.title }}</b>
      </template>
    </nav>

    <!-- 合集的根列表 -->
    <template v-if="!current">
      <h1 class="kb-pcon-title" data-testid="public-title">{{ info.title || '合集' }}</h1>
      <p class="kb-pcon-sub">共 {{ info.roots.length }} 项</p>
      <ul class="kb-sfold-list" aria-label="合集内容" data-testid="public-roots">
        <li v-for="root in info.roots" :key="targetKey(root)">
          <button type="button" class="kb-sfold-row" :data-testid="`public-root-${rootLabel(root, titles)}`" @click="open(root, rootLabel(root, titles))">
            <span class="kb-sfold-icon" aria-hidden="true">{{ rootKind(root) }}</span>
            <span class="kb-sfold-main"><b>{{ rootLabel(root, titles) }}</b></span>
            <KbIcon name="forward" :size="14" />
          </button>
        </li>
      </ul>
    </template>

    <SharedFolder v-else-if="isFolder(current.target)" :target="current.target" :access="access" @open="open" />
    <SharedDoc v-else :key="targetKey(current.target)" ref="doc" :target="current.target" :access="access" :my-id="myId" :in-app-note="false" @dirty="(value: boolean) => emit('dirty', value)" @loaded="(value: string) => emit('title', value)" />
  </div>
</template>

<style>
.kb-pcon { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-pcon-title { margin: 0; font-size: var(--text-24); font-weight: var(--fw-title); line-height: var(--lh-tight); overflow-wrap: anywhere; }
.kb-pcon-sub { margin: 0; color: var(--text-tertiary); font-size: var(--text-13); }
.kb-pcon-crumb { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--text-13); color: var(--text-secondary); }
.kb-pcon-crumb b { font-weight: var(--fw-medium); color: var(--text-primary); overflow-wrap: anywhere; }
.kb-pcon-crumb-btn { border: 0; background: none; padding: 0; color: var(--accent-text, var(--accent)); font: inherit; text-decoration: underline; cursor: pointer; }
.kb-pcon-sep { color: var(--text-tertiary); }
@media (pointer: coarse) { .kb-pcon-crumb-btn { min-height: 44px; } }
</style>
