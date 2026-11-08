<script setup lang="ts">
// ⌘K 命令面板(命令面板设计稿 设计稿):跳转 + 操作 + 笔记检索。
// 输入 `>` 只看操作、`#` 搜笔记、`@` 看项目;↑↓ 选择,Enter 执行,Esc 关闭。
// 每条命令可以带 feature:账号没有这个功能点(含 AI 总开关关闭)就不列出,免得点进去是「没有开通」的页面。
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import KbIcon from './KbIcon.vue'
import { isComposing } from '../composables/ime'
import { PHONE_QUERY, useMedia } from '../composables/useMedia'
import type { IconName } from './icons'
import type { PaletteCall, PaletteItem, PalettePaths } from './palette'

interface Command {
  id: string
  label: string
  icon: IconName
  hint?: string
  /** 额外的搜索关键词(中英文都行) */
  keywords?: string
  /** 需要的功能点;账号没有就不显示 */
  feature?: string
  section: string
  run: () => void | Promise<void>
}

// 上下文(由外壳传入,面板本身不依赖应用层 store):审核收件箱的待审数、浏览器当前所在集合
// has:判断功能点(外壳传 session.has);默认全都有,单独使用 / 单测时不用管
// extraCommands:当前页面能执行的命令(编辑器动作,由外壳注入);admin:管理动作默认只在管理员列表里露出
const props = withDefaults(defineProps<{ call: PaletteCall; paths: PalettePaths; drafts?: number; collection?: string; project?: string; has?: (feature: string) => boolean; extraCommands?: Command[]; admin?: boolean }>(), {
  drafts: 0,
  collection: '',
  project: '',
  has: () => true,
  extraCommands: () => [],
  admin: false,
})
/** 「当前项目」:外壳按正在浏览的集合 / 最近索引过的项目算好传进来;没有就退回项目列表第一个 */
const currentProject = computed(() => props.project || projects.value[0]?.name || '')
const emit = defineEmits<{ close: [] }>()
const router = useRouter()
// 手机:没有键盘,不显示快捷键提示;面板铺满屏幕,要有一个看得见的关闭按钮
const phone = useMedia(PHONE_QUERY)
const query = ref('')
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
/** 打开面板之前焦点所在的元素,关闭后还给它 */
let opener: HTMLElement | null = null
const insights = ref<PaletteItem[]>([])
const projects = ref<{ name: string; slug: string }[]>([])

const go = (path: string) => () => {
  void router.push(path)
  emit('close')
}

const commands = computed<Command[]>(() => {
  // 默认只列 3 条跳转(与设计稿一致),其余在输入时出现
  const jumps: Command[] = [
    { id: 'search', label: '搜索', icon: 'search', hint: 'G S', section: '跳转', run: go(props.paths.search), keywords: '搜索演练场 search', feature: 'search.basic' },
    { id: 'review', label: props.drafts > 0 ? `审核收件箱 · ${props.drafts} 条待审` : '审核收件箱', icon: 'inbox', hint: 'G R', section: '跳转', run: go(props.paths.review), feature: 'ai.extract' },
    { id: 'browser', label: props.collection ? `知识库 · ${props.collection}` : '知识库', icon: 'database', section: '跳转', run: go(props.paths.kb), keywords: '浏览器 browser' },
  ]
  // 普通用户最常用的是写东西:新建笔记放在操作区第一条,不和重建索引这类运维动作混在一起
  const actions: Command[] = [
    {
      id: 'new-note',
      label: '新建笔记',
      icon: 'plus',
      section: '操作',
      feature: 'docs.notes',
      keywords: 'new note 新建 笔记 写',
      run: () => {
        void router.push({ path: props.paths.kb, query: { new: '1' } })
        emit('close')
      },
    },
  ]
  // 管理 / 运维动作:普通用户的默认列表里不出现(仍然可以用关键词搜到,功能点也照旧检查);
  // 管理员默认能看到,但排在新标签后面,不抢「新建笔记」的位置
  const adminActions: Command[] = [
    {
      id: 'reindex',
      label: `重建索引:${currentProject.value || '当前项目'}…`,
      icon: 'refresh',
      section: '管理',
      feature: 'sources.local',
      run: async () => {
        const name = currentProject.value
        if (name) await props.call('reindex_project', { project: name, mode: 'full' })
        emit('close')
      },
    },
    // 「运行评测集」「生成访问令牌」只是跳到对应的页面,不会直接执行,所以标题按实话写;
    // 原来的「运行一次进化」只是跳到审核收件箱(上面已有这一项),写成动作是夸大,且「进化」已不是界面用语,去掉
    {
      id: 'eval',
      label: '打开评测页',
      icon: 'chart',
      section: '管理',
      run: go(props.paths.eval),
      keywords: 'eval 评测 黄金集 运行评测',
      feature: 'search.tune',
    },
    {
      id: 'token',
      label: '管理访问令牌',
      icon: 'tag',
      section: '管理',
      // 访问令牌在「个人设置」里(原来跳到管理员才能进的系统设置)
      run: go(props.paths.me),
      keywords: 'mcp token 令牌 访问令牌 密钥',
      feature: 'api.tokens',
    },
  ]
  // 默认列表保持设计稿的三项跳转;这些「冷门页面」只在输入关键词时才出现(命令面板的常规做法,也不改变设计稿画面)
  const rare: Command[] = [
    { id: 'system', label: '系统状态', icon: 'chart', section: '跳转', run: go(props.paths.system), keywords: 'system status 状态 资源 组件 网络 日志 监控', feature: 'sys.ops' },
    { id: 'appearance', label: '外观设置', icon: 'settings', section: '跳转', run: go(props.paths.appearance), keywords: 'appearance theme 主题 外观 深色 浅色' },
    { id: 'guide', label: '使用指南', icon: 'book', section: '跳转', run: go(props.paths.guide), keywords: 'guide help manual 帮助 教程 指南 文档 令牌 mcp 下载' },
    { id: 'projects', label: '项目与集合', icon: 'folder', section: '跳转', run: go(props.paths.projects), keywords: 'projects collections 项目 集合 迁移', feature: 'sources.local' },
    { id: 'sources', label: '导入', icon: 'upload', section: '跳转', run: go(props.paths.import), keywords: 'sources upload import 数据源 上传 导入', feature: 'docs.upload' },
    { id: 'audit', label: '审计 / 批次', icon: 'doc', section: '跳转', run: go(props.paths.audit), keywords: 'audit batch 审计 批次 撤销', feature: 'sys.ops' },
  ]
  return [...jumps, ...props.extraCommands, ...actions, ...adminActions, ...rare].filter((command) => !command.feature || props.has(command.feature))
})
/** 只在有搜索词时才参与匹配的命令 */
const RARE = new Set(['system', 'appearance', 'projects', 'sources', 'audit'])

const filtered = computed(() => {
  const raw = query.value.trim()
  const mode = raw.startsWith('>') ? 'action' : raw.startsWith('#') ? 'insight' : raw.startsWith('@') ? 'project' : 'all'
  const text = raw.replace(/^[>#@]/, '').trim().toLowerCase()
  if (mode === 'insight') {
    return insights.value
      .filter((item) => !text || (item.title ?? item.source).toLowerCase().includes(text))
      .slice(0, 8)
      .map<Command>((item) => ({
        id: `insight-${item.id}`,
        label: item.title ?? item.source,
        icon: 'doc',
        section: '笔记',
        run: () => {
          void router.push({ path: props.paths.kb, query: { collection: item.collection, item: item.id } })
          emit('close')
        },
      }))
  }
  if (mode === 'project') {
    return projects.value
      .filter((project) => !text || project.name.toLowerCase().includes(text))
      .map<Command>((project) => ({
        id: `project-${project.slug}`,
        label: project.name,
        icon: 'folder',
        section: '项目',
        run: () => {
          void router.push({ path: props.paths.kb, query: { collection: `proj_${project.slug}` } })
          emit('close')
        },
      }))
  }
  const matched = commands.value.filter((command) => {
    // `>` 是显式要「动作」:普通操作、编辑器命令、管理动作都算;`#` / `@` 是另外两种检索模式
    if (mode === 'action' && !['操作', '编辑器', '管理'].includes(command.section)) return false
    // 管理动作不在普通用户的默认列表里;管理员也排在新标签与常用操作之后。输入关键词时仍可搜到
    if (!text && command.section === '管理' && !props.admin) return false
    if (!text) return !RARE.has(command.id)
    return `${command.label} ${command.keywords ?? ''}`.toLowerCase().includes(text)
  })
  // 空查询时把最近的 insight 也列出来(设计稿的第三组)
  if (mode === 'all' && !text) {
    matched.push(
      ...insights.value.slice(0, 2).map<Command>((item) => ({
        id: `insight-${item.id}`,
        label: item.title ?? item.source,
        icon: 'doc',
        section: '笔记',
        run: () => {
          void router.push({ path: props.paths.kb, query: { collection: item.collection, item: item.id } })
          emit('close')
        },
      })),
    )
  }
  return matched
})

const sections = computed(() => {
  const map = new Map<string, { command: Command; index: number }[]>()
  filtered.value.forEach((command, index) => {
    const list = map.get(command.section) ?? []
    list.push({ command, index })
    map.set(command.section, list)
  })
  return [...map.entries()]
})

function move(delta: number) {
  if (!filtered.value.length) return
  active.value = (active.value + delta + filtered.value.length) % filtered.value.length
  // 列表最高 384px 会滚动:用方向键走到看不见的行时要跟着滚过去
  void nextTick(() => document.getElementById(`kb-pal-opt-${active.value}`)?.scrollIntoView?.({ block: 'nearest' }))
}

async function runActive() {
  const command = filtered.value[active.value]
  if (!command) return
  await command.run()
}

function onKeydown(event: KeyboardEvent) {
  // 面板是模态的:Tab 不能跑到后面的页面上。能聚焦的只有输入框(手机上还有关闭按钮),在它们之间循环
  if (event.key === 'Tab') {
    const stops: HTMLElement[] = []
    if (input.value) stops.push(input.value)
    if (closeButton.value) stops.push(closeButton.value)
    if (!stops.length) return
    event.preventDefault()
    const index = stops.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index + 1) % stops.length
    stops[next]?.focus()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
    return
  }
  if (event.key === 'Enter' && !isComposing(event)) {
    event.preventDefault()
    void runActive()
  }
}

onMounted(async () => {
  opener = document.activeElement as HTMLElement | null
  await nextTick()
  input.value?.focus()
  window.addEventListener('keydown', onKeydown)
  try {
    const [listed, items] = await Promise.all([
      props.call<{ projects: { project: { name: string; slug: string } }[] }>('list_projects'),
      props.call<{ items: PaletteItem[] }>('list_items', { kind: 'insight', collection: '_global' }).catch(
        () => ({ items: [] as PaletteItem[] }),
      ),
    ])
    // list_projects 的每一项是 { project, collection, rows },项目名在 project 里(此前直接读 .name 得到 undefined)
    projects.value = listed.projects.map((item) => ({ name: item.project.name, slug: item.project.slug }))
    insights.value = items.items
  } catch {
    // 没有数据时只显示跳转与操作
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  // 关掉后焦点回到打开它的按钮 / 页面,键盘用户不用从头 Tab
  opener?.focus?.({ preventScroll: true })
})
</script>

<template>
  <div class="kb-pal-wrap">
    <div
      class="pal-ov"
      style="position: fixed; inset: 0; background: rgba(var(--shade), 0.55); backdrop-filter: blur(1.5px); -webkit-backdrop-filter: blur(1.5px); z-index: var(--z-palette-scrim, 50)"
      @click="emit('close')"
    ></div>
    <div
      class="card pal"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      style="
        position: fixed;
        left: 50%;
        margin-left: -320px;
        top: 130px;
        width: 640px;
        background: var(--surface-3);
        border-color: var(--border-default);
        box-shadow: var(--sh3);
        z-index: var(--z-palette, 51);
      "
    >
      <div
        class="row pal-head"
        style="height: 52px; padding: 0 16px; border-bottom: 1px solid var(--border-subtle); font-size: calc(15px * var(--fs))"
      >
        <span class="tag ac">kb</span>
        <span class="row pal-field" :class="{ 'is-phone': phone }" style="gap: 2px">
          <input
            ref="input"
            v-model="query"
            class="pal-input"
            role="combobox"
            aria-label="命令面板"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="kb-pal-list"
            :aria-activedescendant="filtered.length ? `kb-pal-opt-${active}` : undefined"
            placeholder="输入命令、页面名,或 > # @ 前缀…"
            style="border: 0; outline: none; background: transparent; color: var(--text-primary); font: inherit; width: 100%; min-width: 0"
            @input="active = 0"
          />
        </span>
        <span class="m pal-hint" style="margin-left: auto; font-size: calc(12px * var(--fs))">
          输入 &gt; 运行命令 · # 搜笔记 · @ 项目
        </span>
        <button v-if="phone" ref="closeButton" type="button" class="btn sm pal-close" aria-label="关闭命令面板" data-testid="palette-close" style="margin-left: auto" @click="emit('close')">取消</button>
      </div>
      <div id="kb-pal-list" class="pal-list" role="listbox" aria-label="命令" style="padding-bottom: 6px; max-height: 384px; overflow: auto">
        <template v-for="[section, items] in sections" :key="section">
          <div class="sec" style="padding: 10px 14px 4px">{{ section }}</div>
          <div
            v-for="entry in items"
            :id="`kb-pal-opt-${entry.index}`"
            :key="entry.command.id"
            class="ni"
            role="option"
            :aria-selected="entry.index === active"
            :class="{ on: entry.index === active }"
            :style="{ height: '36px', margin: '0 6px', padding: '0 10px', '--i': Math.min(entry.index, 12) }"
            @mouseenter="active = entry.index"
            @click="entry.command.run()"
          >
            <KbIcon :name="entry.command.icon" />
            <span class="lbl2">{{ entry.command.label }}</span>
            <span class="cnt">
              <span v-if="entry.command.hint && !phone" class="kbd" style="margin-left: 3px">{{
                entry.command.hint
              }}</span>
            </span>
          </div>
        </template>
        <div v-if="!filtered.length" class="m" style="padding: 14px">没有匹配的命令</div>
      </div>
      <!-- 底部快捷键提示条(设计稿 有):只列真正支持的键;⌘↵「在新面板打开」没实现,不写进来 -->
      <div
        class="row m pal-foot"
        style="height: 34px; padding: 0 14px; border-top: 1px solid var(--border-subtle); gap: 14px; font-size: calc(11.5px * var(--fs))"
      >
        <span class="row" style="gap: 4px"><span class="kbd">↑↓</span> 选择</span>
        <span class="row" style="gap: 4px"><span class="kbd">↵</span> 打开</span>
        <span class="row" style="gap: 4px"><span class="kbd">esc</span> 关闭</span>
      </div>
    </div>
  </div>
</template>

<style>
.pal-input::placeholder {
  color: var(--text-quaternary);
}
/* 输入框的外层:桌面上基准宽 320px,放不下就收窄;手机上占满剩下的宽度,右边留给「取消」 */
.pal-field {
  flex: 0 1 320px;
  min-width: 0;
}
.pal-field.is-phone {
  flex: 1 1 auto;
}
</style>
