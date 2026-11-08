<script setup lang="ts">
// 重复文件处理(重复文件):按内容哈希预检的结果。
//   同名但内容不同 → 逐文件选 跳过 / 覆盖 / 保留两者(默认保留两者,不丢数据);
//   内容完全相同 → 服务端一律跳过(秒传,不占上传流量),这里只展示、不可改。
import { computed, ref } from 'vue'
import { KbButton, KbDialog, KbSegmented, KbSwitch } from '@kb-ui/index'

import type { DedupStrategy, PrecheckResult } from '@/api/upload'
import { fileChip } from '@/utils/files'

const props = defineProps<{
  duplicates: { relPath: string; result: PrecheckResult }[]
  /** 这一批一共有多少个文件(含没有重复的),用来算「继续上传 N 个」 */
  total: number
  /** 目标集合,用来写「已存在于」 */
  collection: string
}>()
const emit = defineEmits<{
  apply: [strategies: Record<string, DedupStrategy>]
  close: []
}>()

const isSame = (result: PrecheckResult) => result.status === 'same_content'
const rows = computed(() =>
  props.duplicates.map((item) => ({
    ...item,
    same: isSame(item.result),
    chip: fileChip(item.relPath.split('/').pop() ?? item.relPath),
    name: item.relPath,
    where: `${props.collection} / ${item.result.existing?.rel_path ?? item.relPath}`,
  })),
)

/** 只有「同名不同内容」的文件需要选;默认保留两者。 */
const choices = ref<Record<string, DedupStrategy>>(
  Object.fromEntries(props.duplicates.filter((item) => !isSame(item.result)).map((item) => [item.relPath, 'keep_both' as DedupStrategy])),
)
const remember = ref(false)

const options = [
  { value: 'skip', label: '跳过' },
  { value: 'overwrite', label: '覆盖' },
  { value: 'keep_both', label: '保留两者' },
]

const skipped = computed(
  () => rows.value.filter((row) => row.same || choices.value[row.relPath] === 'skip').length,
)
const willUpload = computed(() => Math.max(0, props.total - skipped.value))

function applyAll(strategy: DedupStrategy) {
  for (const key of Object.keys(choices.value)) choices.value[key] = strategy
}

function confirm() {
  if (remember.value) {
    try {
      localStorage.setItem('kb-upload-dedup-strategy', JSON.stringify(choices.value))
    } catch {
      // 隐私模式下写不进去,忽略
    }
  }
  emit('apply', { ...choices.value })
}
</script>

<template>
  <KbDialog plain no-autofocus width="900px" title="发现重复文件" subtitle="按内容哈希比对；内容完全相同默认跳过，不占用上传流量（秒传）" @close="emit('close')">
    <template #lead><span class="tag y">{{ rows.length }} 个重复</span></template>
    <div class="kb-dup">
      <table class="kb-table kb-dup-table">
        <thead>
          <tr>
            <th>上传的文件</th>
            <th>情况</th>
            <th>已存在于</th>
            <th>处理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.relPath">
            <td>
              <span class="row kb-dup-file">
                <span class="kb-fmt mono" :class="`is-${row.chip.tone}`">{{ row.chip.label }}</span>
                <span class="kb-dup-name" :title="row.name">{{ row.name }}</span>
              </span>
            </td>
            <td>
              <span class="tag" :class="{ y: !row.same }">{{ row.same ? '完全相同（sha256 一致）' : '同名，内容不同' }}</span>
            </td>
            <td class="m mono kb-dup-where" :title="row.where">{{ row.where }}</td>
            <td>
              <KbSegmented
                :model-value="row.same ? 'skip' : (choices[row.relPath] ?? 'keep_both')"
                :options="options"
                :class="{ 'is-locked': row.same }"
                :aria-disabled="row.same"
                @update:model-value="(value: string) => !row.same && (choices[row.relPath] = value as DedupStrategy)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <template #footer>
      <span class="row kb-dup-all">
        <span class="m">全部应用：</span>
        <button type="button" class="btn sm" @click="applyAll('skip')">跳过</button>
        <button type="button" class="btn sm" @click="applyAll('overwrite')">覆盖</button>
        <button type="button" class="btn sm" @click="applyAll('keep_both')">保留两者</button>
        <KbSwitch v-model="remember" label="记住本次选择" class="kb-dup-remember" />
      </span>
      <span class="kb-row">
        <KbButton @click="emit('close')">取消</KbButton>
        <KbButton variant="primary" :disabled="willUpload <= 0" @click="confirm">继续上传 {{ willUpload }} 个</KbButton>
      </span>
    </template>
  </KbDialog>
</template>
