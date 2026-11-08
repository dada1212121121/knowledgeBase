<script setup lang="ts">
// 历史版本列表(文件和笔记共用):每条能「对比」上一版、能「恢复」成新版本。
// 对比只在相邻两版之间做——「这次改了啥」最常问的正是这个;要跨版比较就连点两次上一版。
import { KbButton } from '@kb-ui/index'
import { formatBytes } from '@/utils/accountForms'
import { localeDateTime } from '@/utils/time'

/** `file_versions` 返回的一行。 */
export interface VersionRow {
  id: string
  version: number
  author: string | null
  created_at: number
  size: number
  preview: string
  /** 二进制版本(Word / Excel / PDF…)存的是备份标记,没有可显示的文字 */
  binary?: boolean
}

const props = defineProps<{
  versions: VersionRow[]
  /** 只读(分享链接、管理员查看)时不显示恢复。 */
  readonly: boolean
  /** 空列表文案。 */
  emptyText?: string
}>()
const emit = defineEmits<{ compare: [index: number]; restore: [id: string] }>()

/** 只有相邻两版才谈得上「对比」:最早的一版没有更早的可比。 */
const canCompare = (index: number) => index + 1 < props.versions.length
/** 最新一版就是当前内容,不用「恢复」。 */
const isLatest = (index: number) => index === 0
</script>

<template>
  <div class="kb-ver-list" data-testid="version-list">
    <div v-for="(version, index) in versions" :key="version.id" class="row kb-ver-row" :data-version="version.version">
      <span class="tag ac mono">v{{ version.version }}</span>
      <span class="kb-ver-text">
        <span class="m kb-ver-meta">
          {{ version.author ?? '—' }} · {{ localeDateTime(version.created_at, { hour12: false }) }} · {{ formatBytes(version.size) }}
        </span>
        <!-- 开头几行正文:不看对比就能分清「这一版到底长什么样」——
             以前只有版本号 + 大小,几版的字数接近时列表看上去每一行都一样 -->
        <span class="m kb-ver-preview" data-testid="version-preview" :title="version.preview || undefined">
          {{ version.binary ? '二进制文件 · 只能整份恢复' : version.preview || '（正文为空）' }}
        </span>
      </span>
      <span class="kb-ver-actions">
        <KbButton
          v-if="canCompare(index)"
          size="sm"
          data-testid="version-compare"
          :title="`对比 v${versions[index + 1].version} → v${version.version} 的改动`"
          @click="emit('compare', index)"
        >
          对比
        </KbButton>
        <span v-if="isLatest(index)" class="m kb-ver-current">当前</span>
        <KbButton v-else-if="!readonly" size="sm" data-testid="version-restore" @click="emit('restore', version.id)">恢复</KbButton>
      </span>
    </div>
    <div v-if="!versions.length" class="m kb-vw-note">{{ emptyText ?? '这个文件还没有历史版本' }}</div>
  </div>
</template>

<style scoped>
.kb-ver-list { display: grid; gap: 2px; padding: 4px; }
.kb-ver-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: var(--r-xs); }
.kb-ver-row:hover { background: var(--hover); }
.kb-ver-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-ver-text { display: grid; flex: 1; min-width: 0; gap: 1px; }
/* 预览只占一行(多行会把列表撑得很长),完整内容悬停 title 或点「对比」看 */
.kb-ver-preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.75; }
.kb-ver-actions { display: inline-flex; align-items: center; gap: 4px; }
.kb-ver-current { padding: 0 4px; }
</style>
