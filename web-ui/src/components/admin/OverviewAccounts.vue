<script setup lang="ts">
// 系统概览里的「账号与存储」一行(只读):用户数、全站存储占用、磁盘剩余。
// 有对应功能点才取数(用户与权限 sys.users;存储与用量 sys.ops),没开通的那一格不出现;
// 任何一个取不到也只是那一格不出现,不影响概览页其它内容。在线协作房间数目前没有对应的能力,所以没有做。
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { KbStat } from '@kb-ui/index'
import { storageOverview, type StorageOverview } from '@/api/usage'
import { userList } from '@/utils/adminApi'
import { useFeature } from '@/composables/useFeature'
import { PATHS } from '@/router/paths'
import { alertCounts, diskLevel, formatBytes, gbText } from '@/utils/usage'

const canUsers = useFeature('sys.users')
const canOps = useFeature('sys.ops')

const accounts = ref<{ total: number; disabled: number } | null>(null)
const storage = ref<StorageOverview | null>(null)

async function load() {
  await Promise.all([
    canUsers.value
      ? Promise.all([userList({ page_size: 1 }), userList({ status: 'disabled', page_size: 1 })])
          .then(([all, disabled]) => (accounts.value = { total: all.total, disabled: disabled.total }))
          .catch(() => undefined)
      : undefined,
    canOps.value ? storageOverview(100).then((value) => (storage.value = value)).catch(() => undefined) : undefined,
  ])
}
void load()

const alerts = computed(() => (storage.value ? alertCounts(storage.value.top) : { over: 0, warn: 0 }))
const disk = computed(() => (storage.value ? diskLevel(storage.value.disk) : 'ok'))
const shown = computed(() => accounts.value !== null || storage.value !== null)
</script>

<template>
  <section v-if="shown" class="kb-oa" aria-label="账号与存储" data-testid="overview-accounts">
    <div class="kb-grid kb-grid-3">
      <KbStat v-if="accounts" label="账号" :value="`${accounts.total} 人`" :delta="accounts.disabled ? `${accounts.disabled} 人已停用` : '没有停用的账号'" />
      <KbStat v-if="storage" label="全站存储占用" :value="formatBytes(storage.totals.total_bytes)" :delta="`${storage.totals.measured_spaces} / ${storage.totals.total_spaces} 个知识库已统计`" />
      <KbStat
        v-if="storage"
        label="磁盘剩余"
        :value="gbText(storage.disk.free_gb)"
        :delta="disk === 'paused' ? '低于保留空间,已暂停上传' : alerts.over + alerts.warn ? `${alerts.over + alerts.warn} 人接近或超出存储配额` : '没有人接近配额'"
        :tone="disk === 'paused' ? 'danger' : disk === 'warn' || alerts.over + alerts.warn ? 'warning' : 'neutral'"
      />
    </div>
    <RouterLink v-if="canOps" class="kb-oa-link m kb-small" :to="PATHS.usage">查看存储与用量详情 →</RouterLink>
  </section>
</template>

<style>
.kb-oa{display:flex;flex-direction:column;gap:var(--gap-sm,8px)}
.kb-oa-link{align-self:flex-end;color:var(--accent-text,var(--accent))}
/* 平板上三格排成两列时,落单的最后一格占满整行,不留半行空白 */
@media (min-width:640px) and (max-width:1023px){.kb-oa .kb-grid > :last-child:nth-child(odd){grid-column:span 2}}
</style>
