<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 回收站:上传 / 压缩包删除的文件在这里留 30 天。
// 只移除索引的条目(本地目录 / 项目 / 网页 / Git)没有磁盘副本,恢复 = 去掉排除标记后重新索引。
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { KbBadge, KbButton, KbEmpty, KbPageHeader, KbPager, KbSkeleton, useConfirm, useToast } from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import { CapabilityError, callCapability } from '@/api/client'
import type { TrashEntry } from '@/components/fileops/types'
import { PATHS } from '@/router/paths'

const router = useRouter()
const toast = useToast()
const confirmer = useConfirm()

const page = ref(1)
const pageSize = ref(20)
const entries = ref<TrashEntry[]>([])
const loading = ref(true)
const busy = ref('')
const error = ref('')
const total = ref(0)

function messageOf(err: unknown) {
  return err instanceof CapabilityError ? err.message : err instanceof Error ? err.message : '操作失败'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await callCapability<{ entries: TrashEntry[]; total?: number }>('list_trash', {
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    })
    entries.value = result.entries ?? []
    // 旧后端只返回 entries:退回「本页满则多给一页」的估算,新后端直接用总数。
    total.value = result.total ?? (page.value - 1) * pageSize.value + entries.value.length + (entries.value.length === pageSize.value ? 1 : 0)
    // 在最后一页把条目删完 / 恢复完时,自动退回上一页,不留一页空白。
    if (!entries.value.length && page.value > 1) {
      page.value = 1
      await load()
    }
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

async function restore(entry: TrashEntry) {
  if (busy.value) return
  busy.value = entry.id
  try {
    await callCapability('restore_trash', { trash_id: entry.id })
    toast.push(`已恢复 ${entry.original_path}`)
    await load()
  } catch (err) {
    // 原路径被占用是 409:明确告诉用户可以改名 / 先处理新文件,而不是只说「失败」
    toast.push(messageOf(err), 'danger')
  } finally {
    busy.value = ''
  }
}

async function purge(entry: TrashEntry) {
  if (busy.value) return
  const ok = await confirmer.ask({
    title: '彻底删除?',
    message: `${entry.original_path} 会从回收站删掉,之后无法恢复。`,
    confirmText: '彻底删除',
    tone: 'danger',
  })
  if (!ok) return
  busy.value = entry.id
  try {
    await callCapability('purge_trash', { trash_id: entry.id })
    toast.push('已彻底删除')
    await load()
  } catch (err) {
    toast.push(messageOf(err), 'danger')
  } finally {
    busy.value = ''
  }
}

function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
function when(ms: number) {
  return localeDateTime(ms, { hour12: false })
}
function left(entry: TrashEntry) {
  if (!entry.expires_at) return '不会自动清理'
  const days = Math.ceil((entry.expires_at - Date.now()) / 86_400_000)
  return days > 0 ? `${days} 天后自动清理` : '即将清理'
}
</script>

<template>
  <AppShell>
    <div class="kb-page kb-trash">
      <KbPageHeader title="回收站" description="删除的上传 / 压缩包文件会在这里保留 30 天;本地目录和项目文件只移除索引,不会动原件。">
        <template #actions>
          <KbButton size="sm" :disabled="loading" @click="load">刷新</KbButton>
          <KbButton size="sm" @click="router.push(PATHS.kb)">回到知识库</KbButton>
        </template>
      </KbPageHeader>

      <div v-if="loading" class="kb-trash-list"><KbSkeleton :lines="5" /></div>
      <KbEmpty v-else-if="error" icon="failed" title="没能读取回收站" :description="error">
        <template #action><KbButton size="sm" @click="load">重试</KbButton></template>
      </KbEmpty>
      <KbEmpty v-else-if="!entries.length" icon="trash" title="回收站是空的" description="删除的文件会先来这里,30 天内可以恢复。">
        <template #action><KbButton size="sm" @click="router.push(PATHS.kb)">去知识库看看</KbButton></template>
      </KbEmpty>
      <div v-else class="kb-trash-list" data-testid="trash-list">
        <article v-for="entry in entries" :key="entry.id" class="kb-trash-row" :data-testid="`trash-${entry.id}`">
          <div class="kb-trash-main">
            <div class="kb-trash-title">
              <b :title="entry.original_path">{{ entry.original_path }}</b>
              <KbBadge :tone="entry.mode === 'trash' ? 'warning' : 'neutral'">{{ entry.mode === 'trash' ? '回收站' : '仅移除索引' }}</KbBadge>
            </div>
            <div class="m kb-trash-meta">
              <span class="mono">{{ entry.collection }}</span>
              <span>·</span><span>{{ sizeText(entry.size) }}</span>
              <span>·</span><span>删除于 {{ when(entry.created_at) }}</span>
              <span>·</span><span>{{ left(entry) }}</span>
            </div>
          </div>
          <div class="kb-trash-actions">
            <KbButton size="sm" :disabled="!!busy" @click="restore(entry)">{{ busy === entry.id ? '处理中…' : '恢复' }}</KbButton>
            <KbButton size="sm" variant="danger" :disabled="!!busy" @click="purge(entry)">彻底删除</KbButton>
          </div>
        </article>
      </div>
      <KbPager v-if="!loading && entries.length" v-model:page="page" v-model:page-size="pageSize" :total="total" @update:page="load" @update:page-size="page = 1; load()" />
    </div>
  </AppShell>
</template>

<style scoped>
.kb-trash { display: grid; gap: 16px; }
.kb-trash-list { display: grid; gap: 8px; }
.kb-trash-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--b);
  border-radius: var(--r3);
  background: var(--panel);
}
.kb-trash-main { min-width: 0; display: grid; gap: 4px; }
.kb-trash-title { display: flex; min-width: 0; align-items: center; gap: 8px; }
.kb-trash-title b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-13); }
.kb-trash-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: var(--text-12); }
.kb-trash-actions { display: flex; flex: none; gap: 8px; }
@media (max-width: 640px) {
  .kb-trash-row { align-items: stretch; flex-direction: column; gap: 10px; }
  .kb-trash-actions { justify-content: flex-end; }
}
</style>
