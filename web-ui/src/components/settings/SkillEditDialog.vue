<script setup lang="ts">
// 新增 / 编辑一个 Skill。服务端按表单字段生成并校验 manifest.toml,所以这里只有表单,没有"粘贴 TOML"。
//   - 新建:先选类型(加载规则 / 笔记模板 / 提示词),每种类型下面写着它是干什么的,还有一键填入的示例;
//   - 编辑:类型不能改(换类型等于删了重建),其余都能改;
//   - 保存前先在这里检查一遍(口径与服务端一致),服务端的拒绝原因原样显示在按钮上方,内容不丢。
import { computed, reactive, ref } from 'vue'
import { KbButton, KbDialog, KbField, KbInput, KbSegmented, KbSelect, KbSwitch, KbTagEditor, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { actionFailure } from '@/utils/actionFailure'
import {
  LANG_OPTIONS,
  REQUIRED_OPTIONS,
  SKILL_KIND_HELP,
  creatableKinds,
  emptySkillDraft,
  skillKindText,
  skillPayload,
  skillPreset,
  validateSkill,
  type SkillDraft,
  type SkillErrors,
} from '@/utils/settingsExtras'

const props = defineProps<{
  aiOn: boolean
  /** 编辑已有的 skill:它的目录名和取回的内容;不传 = 新建 */
  editing?: { id: string; draft: SkillDraft } | null
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()
const isEdit = computed(() => !!props.editing)
const form = reactive<SkillDraft>(props.editing ? { ...props.editing.draft, tags: [...props.editing.draft.tags], required: [...props.editing.draft.required] } : emptySkillDraft())
const kinds = computed(() => creatableKinds(props.aiOn))
// AI 关了的站点不提"提示词"这类 AI 功能;已有的提示词 skill 仍能编辑,只是不再显示这段说明
const help = computed(() => (form.kind === 'prompt' && !props.aiOn ? undefined : SKILL_KIND_HELP[form.kind]))
const saving = ref(false)
const failure = ref('')
/** 点过一次"保存"之后才就近显示字段报错,免得刚打开就是一片红 */
const tried = ref(false)
const errors = computed<SkillErrors>(() => (tried.value ? validateSkill(form) : {}))

const langOptions = computed(() => {
  // 手写清单里可能是列表之外的分块方式:保留它,免得编辑时被悄悄换掉
  const known = LANG_OPTIONS.some((option) => option.value === form.lang)
  return known || !form.lang ? LANG_OPTIONS : [{ value: form.lang, label: form.lang }, ...LANG_OPTIONS]
})
const stageOptions = [
  { value: 'extract', label: '提炼(从对话里整理出笔记时)' },
  { value: 'review', label: '审核(决定候选笔记收不收时)' },
  { value: 'web_extract', label: '网页规范化(把抓到的网页整理成规范化内容时)' },
]

function switchKind(kind: string) {
  const keep = { name: form.name, description: form.description, enabled: form.enabled }
  Object.assign(form, emptySkillDraft(kind), keep)
  failure.value = ''
  tried.value = false
}
function fillExample() {
  Object.assign(form, skillPreset(form.kind))
  failure.value = ''
}
function toggleRequired(value: string) {
  form.required = form.required.includes(value) ? form.required.filter((item) => item !== value) : [...form.required, value]
}
const numberField = (key: 'max_body_chars' | 'max_title_chars') =>
  computed({
    get: () => (form[key] ? String(form[key]) : ''),
    set: (value: string) => {
      const parsed = Number.parseInt(value, 10)
      form[key] = Number.isFinite(parsed) && parsed > 0 ? parsed : null
    },
  })
const bodyLimit = numberField('max_body_chars')
const titleLimit = numberField('max_title_chars')

async function save() {
  tried.value = true
  failure.value = ''
  if (Object.keys(validateSkill(form)).length) return
  saving.value = true
  try {
    await callCapability('save_skill', { ...skillPayload(form, props.editing?.id ?? null), confirm: true })
    toast.push(isEdit.value ? '已保存,马上生效。' : '已新增,马上生效。')
    emit('saved')
    emit('close')
  } catch (err) {
    failure.value = actionFailure('保存', err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <KbDialog :title="isEdit ? `编辑 Skill · ${editing!.draft.name}` : '新增 Skill'" width="640px" @close="emit('close')">
    <div class="kb-stack" data-testid="skill-dialog">
      <KbSegmented v-if="!isEdit" :model-value="form.kind" :options="kinds" aria-label="类型" @update:model-value="switchKind" />
      <p v-else class="kb-hint">类型:{{ skillKindText(form.kind) }}(类型不能改;要换类型请新建一个。)</p>

      <div v-if="help" class="kb-st-skillhelp" data-testid="skill-help">
        <p class="kb-st-note">{{ help.what }}</p>
        <p class="kb-hint">{{ help.example }}</p>
        <KbButton v-if="!isEdit" size="sm" data-testid="skill-example" @click="fillExample">填入示例</KbButton>
      </div>

      <KbField v-slot="{ id, describedby, invalid }" label="名称" required :error="errors.name">
        <KbInput :id="id" v-model="form.name" placeholder="例如:接口定义文件" :aria-describedby="describedby" :aria-invalid="invalid" data-testid="skill-name" />
      </KbField>
      <KbField v-slot="{ id }" label="说明" hint="可不填;写给以后看到它的人。">
        <KbInput :id="id" v-model="form.description" placeholder="一句话说明它是干什么的" data-testid="skill-description" />
      </KbField>

      <template v-if="form.kind === 'loader-rule'">
        <KbField v-slot="{ id, describedby, invalid }" label="匹配哪些文件" required :error="errors.glob" hint="按项目里的相对路径匹配:* 代表一层里的任意字,** 代表任意多层目录。例如 **/*.proto">
          <KbInput :id="id" v-model="form.glob" class="kb-mono" placeholder="**/*.proto" :aria-describedby="describedby" :aria-invalid="invalid" data-testid="skill-glob" />
        </KbField>
        <KbField label="怎么切成片段" hint="不确定就选「按行窗口」,对任何文本都适用。">
          <KbSelect v-model="form.lang" :options="langOptions" aria-label="分块方式" data-testid="skill-lang" />
        </KbField>
        <KbField label="自动加的标签" hint="回车添加。命中这条规则的文件都会带上这些标签。">
          <KbTagEditor v-model="form.tags" />
        </KbField>
      </template>

      <template v-else-if="form.kind === 'insight-template'">
        <KbField label="哪些项不能空" :error="errors.rules">
          <div class="kb-row" role="group" aria-label="必填项">
            <KbButton
              v-for="option in REQUIRED_OPTIONS"
              :key="option.value"
              size="sm"
              :variant="form.required.includes(option.value) ? 'primary' : 'default'"
              :aria-pressed="form.required.includes(option.value)"
              :data-testid="`skill-required-${option.value}`"
              @click="toggleRequired(option.value)"
            >{{ option.label }}</KbButton>
          </div>
        </KbField>
        <KbField v-slot="{ id }" label="正文最多多少字" hint="可不填 = 不限制。">
          <KbInput :id="id" v-model="bodyLimit" type="number" placeholder="例如 2000" data-testid="skill-body-limit" />
        </KbField>
        <KbField v-slot="{ id }" label="标题最多多少字" hint="可不填 = 不限制。">
          <KbInput :id="id" v-model="titleLimit" type="number" placeholder="例如 40" data-testid="skill-title-limit" />
        </KbField>
      </template>

      <template v-else-if="form.kind === 'prompt'">
        <KbField label="换掉哪个环节的提示词">
          <KbSelect v-model="form.stage" :options="stageOptions" aria-label="覆盖阶段" data-testid="skill-stage" />
        </KbField>
        <KbField v-slot="{ id, describedby, invalid }" label="提示词" required :error="errors.template" hint="整段换掉默认的提示词,所以要把完整的要求写全。同一个环节有多个提示词 skill 时,后面的覆盖前面的。">
          <KbInput :id="id" v-model="form.template" multiline :aria-describedby="describedby" :aria-invalid="invalid" data-testid="skill-template" />
        </KbField>
      </template>

      <div class="kb-row">
        <KbSwitch v-model="form.enabled" label="启用" data-testid="skill-enabled" />
        <span class="kb-hint">关掉就是先留着、不生效。</span>
      </div>
      <p v-if="form.kind === 'loader-rule'" class="kb-hint">新规则只对之后新增或改过的文件生效;已经建好索引、内容没变的文件不会重新切。</p>

      <p v-if="failure" class="kb-st-inline-error" role="alert" data-testid="skill-failure">{{ failure }}</p>
      <div class="kb-row kb-st-dialog-actions">
        <span class="kb-spacer"></span>
        <KbButton @click="emit('close')">取消</KbButton>
        <KbButton variant="primary" :disabled="saving" data-testid="skill-save" @click="save">{{ saving ? '保存中…' : '保存' }}</KbButton>
      </div>
    </div>
  </KbDialog>
</template>

<style>
.kb-st-skillhelp{display:flex;flex-direction:column;gap:var(--gap-sm,8px);padding:var(--gap-sm,8px) var(--gap-md,12px);border:var(--hl) solid var(--b2);border-radius:var(--r2);background:var(--surface-2,transparent)}
.kb-st-skillhelp .btn{align-self:flex-start}
</style>
