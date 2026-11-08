<script setup lang="ts">
// 某个分区里由字段表驱动的所有卡片(每个分组一张)。AI 总开关关闭时,AI 分组整张不出现。
// 分区里字段表之外的内容(状态、按钮、列表)通过具名插槽放:`in-<分组 id>` 在卡片里、字段下面,`after-<分组 id>` 在卡片外、紧跟其后。
import { computed } from 'vue'
import { KbCard } from '@kb-ui/index'
import SettingRows from './SettingRows.vue'
import { groupsOf, type ChoiceOption, type Draft } from '@/utils/settingsFields'
import type { SectionId } from '@/utils/settingsNav'

const props = defineProps<{
  section: SectionId
  aiOn: boolean
  draft: Draft
  errors: Record<string, string>
  choices?: Record<string, ChoiceOption[]>
}>()
const emit = defineEmits<{ update: [path: string, value: string | boolean] }>()

const groups = computed(() => groupsOf(props.section, props.aiOn))
</script>

<template>
  <template v-for="group in groups" :key="group.id">
    <KbCard :title="group.title" :data-group="group.id" class="kb-st-card">
      <p v-if="group.note" class="kb-st-note">{{ group.note }}</p>
      <SettingRows :fields="group.fields" :draft="draft" :errors="errors" :choices="choices" @update="(path, value) => emit('update', path, value)" />
      <!-- 卡片里、字段下面的补充内容(例如这一类组件的引擎列表) -->
      <div v-if="$slots[`in-${group.id}`]" class="kb-st-in"><slot :name="`in-${group.id}`" /></div>
    </KbCard>
    <slot :name="`after-${group.id}`" />
  </template>
</template>

<style>
.kb-st-card{flex:0 0 auto;min-width:0}
.kb-st-in{margin-top:12px;padding-top:12px;border-top:var(--hl) solid var(--b);display:flex;flex-direction:column;gap:var(--gap-sm,8px);min-width:0}
.kb-st-inline-error{display:flex;align-items:center;gap:var(--gap-sm,8px);flex-wrap:wrap;margin:0;color:var(--status-danger-text);font-size:calc(13px*var(--fs));line-height:1.55;overflow-wrap:anywhere}
.kb-st-ok{margin:0;color:var(--status-success-text);font-size:calc(13px*var(--fs));line-height:1.55;overflow-wrap:anywhere}
.kb-st-nowrap{flex:0 0 auto;white-space:nowrap}
.kb-st-block{display:block;min-width:0;overflow-wrap:anywhere}
.kb-st-key-form{display:flex;align-items:center;gap:var(--gap-sm,8px);flex-wrap:wrap;min-width:0}
.kb-st-key-form .kb-input{flex:1 1 220px;min-width:0}
.kb-st-key-hint{min-width:0;overflow-wrap:anywhere}
/* 表格每行末尾的操作按钮:桌面排成一行(列窄了也不竖着叠),手机卡片里可以折行 */
.kb-st-actions{display:flex;gap:var(--gap-xs,4px);justify-content:flex-end;flex-wrap:nowrap}
.kb-rt.is-cards .kb-st-actions{flex-wrap:wrap;justify-content:flex-start}
.kb-st-bad{color:var(--status-danger-text);font-size:calc(13px*var(--fs));line-height:1.55}
.kb-st-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--gap-sm,8px);min-width:0}
.kb-st-mirror{display:flex;align-items:center;gap:var(--gap-sm,8px);min-width:0;flex-wrap:wrap}
.kb-st-details > summary{cursor:pointer;color:var(--text-secondary);font-size:calc(13px*var(--fs));padding:6px 0}
.kb-st-details[open] > summary{margin-bottom:var(--gap-sm,8px)}
@media (pointer:coarse){.kb-st-details > summary{min-height:44px;display:flex;align-items:center}}
.kb-st-wrap-left{margin:0;min-width:0;overflow-wrap:anywhere}
.kb-st-code{margin:0;padding:8px 10px;overflow-x:auto;max-width:100%;border-radius:var(--r2);background:var(--surface-2);font-size:calc(12px*var(--fs));white-space:pre}
/* 触屏:小按钮(36px)用伪元素把可点区域撑到 44px 以上(与 device.css 里 .btn.sm 的做法一致);两个字的按钮宽度只有 ~38px,min-width 撑到 44px */
@media (pointer:coarse){.kb-settings-body .kb-btn{min-width:44px}.kb-settings-body .kb-btn.is-sm{position:relative}.kb-settings-body .kb-btn.is-sm::before{content:"";position:absolute;inset:-5px 0}}
.kb-st-note{margin:0 0 12px;color:var(--text-secondary);font-size:calc(13px*var(--fs));line-height:1.6}
</style>
