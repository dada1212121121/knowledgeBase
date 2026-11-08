<script setup lang="ts">
// 新增 / 编辑一个插件。界面只提交结构化字段和脚本文本,manifest.toml 由服务端生成并校验;
// 所以这里没有"粘贴 TOML",也不会因为手滑把清单写坏。
//   - 声明式部分(include / exclude / 标签 / 优先级)和普通 skill 一样;
//   - 进程钩子是可选的:打开后才会写 [exec],并随插件保存脚本文件;
//   - allow_exec 关闭时仍然可以保存(声明式索引照常生效),但会明确提示进程钩子不会运行。
import { computed, reactive, ref } from 'vue'
import { KbButton, KbDialog, KbField, KbInput, KbSwitch, KbTagEditor, KbTextarea, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import { actionFailure } from '@/utils/actionFailure'
import {
  HOOK_OPTIONS,
  emptyPluginDraft,
  linesText,
  pluginPayload,
  pluginPreset,
  textLines,
  validatePlugin,
  type PluginDraft,
  type PluginErrors,
} from '@/utils/settingsExtras'

const props = defineProps<{
  /** 编辑已有插件:目录名和 get_plugin 取回的内容;不传 = 新建 */
  editing?: { id: string; draft: PluginDraft } | null
  /** skills.allow_exec:关闭时进程钩子不会运行 */
  allowExec: boolean
}>()
const emit = defineEmits<{ close: []; saved: [] }>()

const toast = useToast()
const isEdit = computed(() => !!props.editing)
const form = reactive<PluginDraft>(clone(props.editing?.draft ?? emptyPluginDraft()))
const saving = ref(false)
const failure = ref('')
const tried = ref(false)
const errors = computed<PluginErrors>(() => (tried.value ? validatePlugin(form) : {}))

/** 深拷贝,避免直接改父组件传进来的对象。 */
function clone(draft: PluginDraft): PluginDraft {
  return JSON.parse(JSON.stringify(draft)) as PluginDraft
}

const includeText = computed({ get: () => linesText(form.include), set: (value: string) => { form.include = textLines(value) } })
const excludeText = computed({ get: () => linesText(form.exclude), set: (value: string) => { form.exclude = textLines(value) } })
const projectsText = computed({ get: () => linesText(form.projects), set: (value: string) => { form.projects = textLines(value) } })
const argsText = computed({
  get: () => linesText(form.exec?.args ?? []),
  set: (value: string) => { if (form.exec) form.exec.args = textLines(value) },
})
const sourceMatchText = computed({
  get: () => linesText(form.source?.match ?? []),
  set: (value: string) => { if (form.source) form.source.match = textLines(value) },
})
const priorityText = computed({ get: () => String(form.priority), set: (value: string) => { form.priority = numberOr(value, 0) } })
const timeoutText = computed({ get: () => String(form.exec?.timeout_ms ?? 20000), set: (value: string) => { if (form.exec) form.exec.timeout_ms = numberOr(value, 0) } })
const outputText = computed({ get: () => String(form.exec?.max_output_bytes ?? 16 * 1024 * 1024), set: (value: string) => { if (form.exec) form.exec.max_output_bytes = numberOr(value, 0) } })
const sourcePriorityText = computed({ get: () => String(form.source?.priority ?? 0), set: (value: string) => { if (form.source) form.source.priority = numberOr(value, 0) } })

function numberOr(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toggleExec(on: boolean) {
  form.exec = on
    ? { command: '', args: ['plugin.py'], hooks: ['chunk'], timeout_ms: 20000, max_output_bytes: 16 * 1024 * 1024 }
    : null
  // 关掉进程钩子后来源规则没有执行者;留着只会让保存报“数据源插件需要配置进程命令”。
  if (!on) {
    form.source = null
    form.permissions = { network: false, read_project: false, llm: false }
  }
  failure.value = ''
}
function toggleSource(on: boolean) {
  if (on) {
    form.source = { match: [], kinds: ['web'], priority: 0 }
    // 打开来源规则时顺手勾上 source 钩子,但只有已经开了进程钩子才改;仍在保存时校验。
    if (form.exec && !form.exec.hooks.includes('source')) form.exec.hooks = [...form.exec.hooks, 'source']
  } else {
    form.source = null
    if (form.exec) form.exec.hooks = form.exec.hooks.filter((hook) => hook !== 'source')
  }
}
function toggleHook(hook: string, on: boolean) {
  if (!form.exec) return
  if (on && !form.exec.hooks.includes(hook)) form.exec.hooks = [...form.exec.hooks, hook]
  if (!on) form.exec.hooks = form.exec.hooks.filter((item) => item !== hook)
  if (hook === 'source' && on && !form.source) form.source = { match: [], kinds: ['web'], priority: 0 }
  if (hook === 'source' && !on) form.source = null
}
function addFile() {
  form.files.push({ path: '', content: '' })
}
function removeFile(index: number) {
  form.files.splice(index, 1)
}
async function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement
  for (const file of [...(input.files ?? [])]) {
    if (file.size > 1024 * 1024) {
      failure.value = `${file.name} 超过 1MB,没有加入。`
      continue
    }
    form.files.push({ path: file.name, content: await file.text() })
  }
  input.value = ''
}
function fillExample() {
  Object.assign(form, pluginPreset())
  tried.value = false
  failure.value = ''
}

async function save() {
  tried.value = true
  failure.value = ''
  if (Object.keys(validatePlugin(form)).length) return
  saving.value = true
  try {
    await callCapability('save_plugin', { ...pluginPayload(form, props.editing?.id ?? null), confirm: true })
    toast.push(isEdit.value ? '插件已保存,马上生效。' : '插件已新增,马上生效。')
    emit('saved')
    emit('close')
  } catch (err) {
    failure.value = actionFailure('保存插件', err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <KbDialog :title="isEdit ? `编辑插件 · ${editing!.draft.name}` : '新增插件'" width="780px" @close="emit('close')">
    <div class="kb-stack" data-testid="plugin-dialog">
      <p v-if="!allowExec" class="kb-st-hint-warn" data-testid="plugin-exec-off">
        脚本类开关当前是关闭的:保存后声明式索引仍会生效,但外部进程钩子不会运行。要让插件真正执行,需要管理员在 config.toml 里打开
        <code class="kb-mono kb-st-key">skills.allow_exec</code> 并重启。
      </p>

      <div class="kb-row">
        <KbButton v-if="!isEdit" size="sm" data-testid="plugin-example" @click="fillExample">填入示例</KbButton>
        <span class="kb-spacer"></span>
        <span class="kb-hint">进程钩子只处理 manifest 里 include 命中的文件;失败会自动回退到内置实现。</span>
      </div>

      <KbField v-slot="{ id, describedby, invalid }" label="名称" required :error="errors.name">
        <KbInput :id="id" v-model="form.name" placeholder="例如:vue-sfc" :aria-describedby="describedby" :aria-invalid="invalid" data-testid="plugin-name" />
      </KbField>
      <div class="kb-row kb-st-plugin-two">
        <KbField v-slot="{ id }" label="版本" :error="errors.version" hint="自己维护,重装官方插件时用来比较。">
          <KbInput :id="id" v-model="form.version" placeholder="0.1.0" data-testid="plugin-version" />
        </KbField>
        <KbField v-slot="{ id }" label="优先级" hint="多条规则命中同一文件时,数字大的先执行(-1000 到 1000)。">
          <KbInput :id="id" v-model="priorityText" type="number" data-testid="plugin-priority" />
        </KbField>
      </div>
      <KbField v-slot="{ id }" label="说明" hint="可不填;写给以后看到它的人。">
        <KbInput :id="id" v-model="form.description" placeholder="一句话说明它是干什么的" data-testid="plugin-description" />
      </KbField>

      <h3 class="kb-st-subhead">索引规则</h3>
      <KbField label="处理哪些文件" :error="errors.patterns" hint="一行一条 glob,例如 **/*.vue。只写 exclude 时不会设置语言和标签。">
        <KbTextarea v-model="includeText" :rows="3" mono placeholder="**/*.vue" data-testid="plugin-include" />
      </KbField>
      <KbField label="排除哪些文件" hint="一行一条;常见的 node_modules / dist 建议排除。">
        <KbTextarea v-model="excludeText" :rows="2" mono placeholder="**/node_modules/**" data-testid="plugin-exclude" />
      </KbField>
      <div class="kb-row kb-st-plugin-two">
        <KbField label="只对哪些项目生效" hint="一行一个项目名;不填 = 所有项目。">
          <KbTextarea v-model="projectsText" :rows="2" mono placeholder="proj_demo" data-testid="plugin-projects" />
        </KbField>
        <KbField v-slot="{ id }" label="覆盖语言" hint="可留空;主要用于展示和按语言筛选。">
          <KbInput :id="id" v-model="form.lang" class="kb-mono" placeholder="vue" data-testid="plugin-lang" />
        </KbField>
      </div>
      <KbField label="自动加的标签" hint="回车添加;会合并到命中文件的标签里。">
        <KbTagEditor v-model="form.tags" />
      </KbField>

      <h3 class="kb-st-subhead">进程钩子</h3>
      <div class="kb-row">
        <KbSwitch :model-value="!!form.exec" label="启动外部进程处理(extract / chunk / enrich / source)" data-testid="plugin-exec-toggle" @update:model-value="toggleExec" />
      </div>
      <p v-if="errors.exec" class="kb-st-inline-error" role="alert" data-testid="plugin-exec-error">{{ errors.exec }}</p>

      <template v-if="form.exec">
        <KbField v-slot="{ id }" label="命令" required hint="可以是 PATH 里的命令(如 python3),也可以是插件目录里的相对路径。">
          <KbInput :id="id" v-model="form.exec.command" class="kb-mono" placeholder="python3" data-testid="plugin-command" />
        </KbField>
        <KbField label="参数" hint="一行一个;通常是脚本名和自己需要的模式参数。">
          <KbTextarea v-model="argsText" :rows="2" mono placeholder="plugin.py" data-testid="plugin-args" />
        </KbField>
        <KbField label="实现哪些钩子" required hint="文件级钩子必须同时有 include;抓取来源还要填下面的来源规则。">
          <div class="kb-row kb-st-plugin-hooks" role="group" aria-label="插件钩子">
            <label v-for="hook in HOOK_OPTIONS" :key="hook.value" class="kb-row kb-st-plugin-check">
              <input type="checkbox" :checked="form.exec.hooks.includes(hook.value)" :data-testid="`plugin-hook-${hook.value}`" @change="toggleHook(hook.value, ($event.target as HTMLInputElement).checked)" />
              <span class="kb-hint">{{ hook.label }}</span>
            </label>
          </div>
        </KbField>
        <div class="kb-row kb-st-plugin-two">
          <KbField v-slot="{ id }" label="单次超时(毫秒)" hint="100 到 120000;超时会杀掉进程并回退。">
            <KbInput :id="id" v-model="timeoutText" type="number" data-testid="plugin-timeout" />
          </KbField>
          <KbField v-slot="{ id }" label="响应上限(字节)" hint="1KB 到 16MB;超过会拒绝这次结果。">
            <KbInput :id="id" v-model="outputText" type="number" data-testid="plugin-output" />
          </KbField>
        </div>
        <KbField label="权限声明" hint="v1 只开放联网;项目目录读取与模型调用尚未实现,清单里写 true 会被拒绝。">
          <div class="kb-row kb-st-plugin-hooks">
            <KbSwitch v-model="form.permissions.network" label="需要联网(沙箱放行)" data-testid="plugin-perm-network" />
            <span class="kb-hint">进程默认在 bwrap 沙箱里;不勾联网就完全断网。项目目录与模型接口还没有协议,表单不提供开关。</span>
          </div>
        </KbField>
        <p v-if="errors.permissions" class="kb-st-inline-error" role="alert" data-testid="plugin-permissions-error">{{ errors.permissions }}</p>
      </template>

      <h3 class="kb-st-subhead">来源规则</h3>
      <div class="kb-row">
        <KbSwitch :model-value="!!form.source" label="让这个插件抓取外部来源(Web)" data-testid="plugin-source-toggle" @update:model-value="toggleSource" />
      </div>
      <p v-if="errors.source" class="kb-st-inline-error" role="alert" data-testid="plugin-source-error">{{ errors.source }}</p>
      <template v-if="form.source">
        <KbField label="匹配哪些地址" hint="一行一条地址 glob,例如 https://docs.example.com/**。">
          <KbTextarea v-model="sourceMatchText" :rows="2" mono placeholder="https://docs.example.com/**" data-testid="plugin-source-match" />
        </KbField>
        <KbField v-slot="{ id }" label="来源优先级" hint="多条来源规则命中时数字大的先执行。">
          <KbInput :id="id" v-model="sourcePriorityText" type="number" data-testid="plugin-source-priority" />
        </KbField>
      </template>

      <h3 class="kb-st-subhead">随插件保存的脚本 / 配置文件</h3>
      <p class="kb-hint">只收 UTF-8 文本,单个不超过 1MB、最多 32 个、总量 8MB;路径只能是插件目录内的相对路径,不能是根目录的 manifest.toml。保存时以这里的文件为准,移除的旧文件会从插件目录删掉。</p>
      <p v-if="errors.files" class="kb-st-inline-error" role="alert" data-testid="plugin-files-error">{{ errors.files }}</p>
      <div v-for="(file, index) in form.files" :key="index" class="kb-st-plugin-file">
        <div class="kb-row">
          <KbInput v-model="file.path" class="kb-mono" placeholder="plugin.py" :data-testid="`plugin-file-path-${index}`" />
          <KbButton size="sm" variant="danger" :data-testid="`plugin-file-remove-${index}`" @click="removeFile(index)">移除</KbButton>
        </div>
        <KbTextarea v-model="file.content" :rows="6" mono :data-testid="`plugin-file-content-${index}`" />
      </div>
      <div class="kb-row">
        <KbButton size="sm" data-testid="plugin-add-file" @click="addFile">再加一个文件</KbButton>
        <label class="kb-row kb-hint kb-st-plugin-pick">
          <span>从本机选择文本文件</span>
          <input type="file" multiple accept=".py,.js,.mjs,.ts,.sh,.toml,.json,.txt,.yaml,.yml" data-testid="plugin-pick-files" @change="pickFiles" />
        </label>
      </div>

      <div class="kb-row">
        <KbSwitch v-model="form.enabled" label="启用" data-testid="plugin-enabled" />
        <span class="kb-hint">关掉就是先留着、不生效。</span>
      </div>

      <p v-if="failure" class="kb-st-inline-error" role="alert" data-testid="plugin-failure">{{ failure }}</p>
      <div class="kb-row kb-st-dialog-actions">
        <span class="kb-spacer"></span>
        <KbButton @click="emit('close')">取消</KbButton>
        <KbButton variant="primary" :disabled="saving" data-testid="plugin-save" @click="save">{{ saving ? '保存中…' : '保存插件' }}</KbButton>
      </div>
    </div>
  </KbDialog>
</template>

<style>
.kb-st-plugin-two{display:grid;grid-template-columns:1fr 1fr;gap:var(--gap-md,12px)}
.kb-st-plugin-hooks{flex-wrap:wrap;gap:var(--gap-md,12px)}
.kb-st-plugin-check{gap:6px;cursor:pointer}
.kb-st-plugin-file{display:flex;flex-direction:column;gap:var(--gap-sm,8px);padding:var(--gap-sm,8px);border:var(--hl) solid var(--b2);border-radius:var(--r2)}
.kb-st-plugin-pick{position:relative;overflow:hidden}
.kb-st-plugin-pick input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer}
.kb-st-hint-warn{font-size:var(--text-13);color:var(--status-warning-text);padding:var(--gap-sm,8px) var(--gap-md,12px);border:var(--hl) solid color-mix(in srgb,var(--status-warning) 35%,transparent);border-radius:var(--r2);background:color-mix(in srgb,var(--status-warning) 8%,transparent)}
.kb-st-subhead{font-size:var(--fs-sm,13px);font-weight:600;margin:var(--gap-sm,8px) 0 0}
@media (max-width: 640px){.kb-st-plugin-two{grid-template-columns:1fr}}
</style>
