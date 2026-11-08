<script setup lang="ts">
// 项目里的文件去哪了(项目与集合页,卡 G):每个项目一行堆叠条,分已入库、二进制、被排除、太大、生成文件、出错。
// 项目索引时会按规则跳过一部分文件(二进制、超过大小上限、命中排除、生成代码);这里让人一眼看到「有多少被跳过、为什么」,
// 排除规则写得对不对、有没有漏掉大目录,看比例就知道。数据是 project_file_stats(服务端按集合、按状态数好)。
import { computed, shallowRef } from 'vue'
import { KbChartCard, KbHBars, type HBarRow } from '@kb-ui/index'
import { projectFileStats, type ProjectFileStats } from '@/api/metrics'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { failureOf } from '@/utils/loadState'

const props = defineProps<{ projects: { name: string; collection: string }[] }>()

const data = shallowRef<ProjectFileStats | undefined>(undefined)
const failure = shallowRef('')
async function load() {
  try {
    data.value = await projectFileStats()
    failure.value = ''
  } catch (err) {
    failure.value = failureOf(err, '读取文件状态').message
  }
}
// 文件状态只在索引时变:半分钟看一次足够
const live = useLiveRefresh({ load, interval: 30_000 })

/** 状态 → (图例里的名字, 颜色)。同一个名字在每一行里颜色一致 */
const KINDS: { key: string; name: string; color: string }[] = [
  { key: 'ok', name: '已入库', color: 'var(--viz-2)' },
  { key: 'binary', name: '二进制', color: 'var(--viz-other)' },
  { key: 'excluded', name: '被排除', color: 'var(--viz-4)' },
  { key: 'too_large', name: '太大', color: 'var(--viz-3)' },
  { key: 'generated', name: '生成文件', color: 'var(--viz-5)' },
  { key: 'error', name: '出错', color: 'var(--viz-6)' },
]
const nameOf = computed(() => new Map(props.projects.map((project) => [project.collection, project.name])))

const rows = computed<HBarRow[]>(() =>
  (data.value?.collections ?? [])
    // 只列项目的集合(笔记 / 全局集合没有「被跳过的文件」这回事)
    .filter((entry) => nameOf.value.has(entry.collection))
    .map((entry) => {
      const known = KINDS.map((kind) => ({ name: kind.name, value: entry.statuses[kind.key] ?? 0, color: kind.color }))
      const rest = entry.total - known.reduce((sum, segment) => sum + segment.value, 0)
      const segments = rest > 0 ? [...known, { name: '其他', value: rest, color: 'var(--viz-1)' }] : known
      const ok = entry.statuses.ok ?? 0
      return { key: entry.collection, label: nameOf.value.get(entry.collection)!, segments, totalText: `${entry.total.toLocaleString()} 个 · ${entry.total ? Math.round((ok / entry.total) * 100) : 0}% 入库` }
    })
    .sort((left, right) => right.segments.reduce((sum, s) => sum + s.value, 0) - left.segments.reduce((sum, s) => sum + s.value, 0)),
)
const skipped = computed(() => rows.value.reduce((sum, row) => sum + row.segments.filter((segment) => segment.name !== '已入库').reduce((acc, segment) => acc + segment.value, 0), 0))
const all = computed(() => rows.value.reduce((sum, row) => sum + row.segments.reduce((acc, segment) => acc + segment.value, 0), 0))
const headline = computed(() => (all.value ? `${rows.value.length} 个项目共 ${all.value.toLocaleString()} 个文件,其中 ${skipped.value.toLocaleString()} 个被跳过(二进制、太大、被排除、生成文件)` : ''))
const state = computed<'ready' | 'loading' | 'empty' | 'error'>(() => (failure.value && data.value === undefined ? 'error' : data.value === undefined ? 'loading' : all.value ? 'ready' : 'empty'))
</script>

<template>
  <KbChartCard title="文件状态" :headline="headline" :state="state" empty-text="项目还没有扫描过文件,索引之后这里会显示每个项目有多少文件进了库、多少被跳过。" :error-text="failure" :min-height="120" data-testid="file-status" @retry="live.refresh('manual')">
    <KbHBars :rows="rows" label="各项目的文件状态" legend :format="(value: number) => value.toLocaleString()" />
  </KbChartCard>
</template>
