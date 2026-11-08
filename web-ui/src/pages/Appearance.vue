<script setup lang="ts">
// 设置 · 外观(外观设置设计稿): 页面只组合组件与 token，不自带单页硬编码样式块。
import { PATHS } from '@/router/paths'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore, type SidebarState, type UiDensity } from '@/stores/ui'
import { useSessionStore } from '@/stores/session'
import AppShell from '@/layouts/AppShell.vue'
import {
  KbAppearancePreview,
  KbLayoutPicto,
  KbSegmented,
  KbSegmentedX,
  KbSettingsLayout,
  KbSwatch,
  KbSwitch,
  KbThemeCard,
  useAppearance,
} from '@kb-ui/index'

const router = useRouter()
const appearance = useAppearance()
// 这两项跟着账号走(存在服务端用户偏好里,换设备也一样);其余外观项仍是本机设置
const ui = useUiStore()
const listDensityOptions = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
]
const sidebarOptions = [
  { value: 'auto', label: '自动' },
  { value: 'expanded', label: '展开' },
  { value: 'rail', label: '图标栏' },
  { value: 'hidden', label: '隐藏' },
]
const sidebarChoice = computed({
  get: () => ui.sidebar ?? 'auto',
  set: (value: string) => (value === 'auto' ? ui.resetSidebar() : ui.setSidebar(value as SidebarState)),
})
const listDensity = computed({
  get: () => ui.density,
  set: (value: string) => {
    ui.setDensity(value as UiDensity)
    // 联动旧版界面间距:保持全站视觉节奏一致
    if (value === 'compact') {
      appearance.density = 'compact'
    } else if (value === 'comfortable') {
      appearance.density = 'comfortable'
    }
  },
})

const themes = [
  { value: 'system', label: '跟随系统', tone: 'split' },
  { value: 'dark', label: '暗夜', tone: 'dark' },
  { value: 'oled', label: '纯黑 OLED', tone: 'dark' },
  { value: 'slate', label: '深海石墨', tone: 'dark' },
  { value: 'light', label: '浅色', tone: 'light' },
  { value: 'paper', label: '暖纸', tone: 'light' },
] as const

const accents = [
  { value: 'indigo', label: '靛蓝' },
  { value: 'blue', label: '蓝' },
  { value: 'violet', label: '紫' },
  { value: 'teal', label: '青' },
  { value: 'green', label: '绿' },
  { value: 'amber', label: '琥珀' },
  { value: 'orange', label: '橙' },
  { value: 'rose', label: '玫红' },
] as const

const layouts = [
  { value: 'sidebar', label: '侧边栏', kind: 'sidebar' },
  { value: 'rail', label: '图标栏', kind: 'rail' },
  { value: 'topnav', label: '顶部导航', kind: 'topnav' },
] as const

const widths = [
  { value: 'fluid', label: '自适应宽度', kind: 'fluid' },
  { value: 'centered', label: '居中 1180', kind: 'centered' },
] as const

const densityOptions = [
  { value: 'compact', label: '紧凑' },
  { value: 'default', label: '默认' },
  { value: 'comfortable', label: '宽松' },
]
const radiusOptions = [
  { value: 'sharp', label: '直角', radiusIcon: '0' },
  { value: 'default', label: '默认', radiusIcon: '3px 0 0 0' },
  { value: 'round', label: '圆润', radiusIcon: '7px 0 0 0' },
]
const fontOptions = [
  { value: 's', label: '小' },
  { value: 'm', label: '中' },
  { value: 'l', label: '大' },
]
const motionOptions = [
  { value: 'mac', label: 'macOS' },
  { value: 'crisp', label: '简洁' },
  { value: 'lively', label: '灵动' },
  { value: 'reduce', label: '减少' },
]

const themeLabel = computed(() => themes.find((theme) => theme.value === appearance.theme)?.label ?? '暗夜')
const accentLabel = computed(() => accents.find((accent) => accent.value === appearance.accent)?.label ?? '靛蓝')
const densityLabel = computed(() => densityOptions.find((d) => d.value === appearance.density)?.label ?? '默认')

// 左侧「系统设置」页签只给管理员:普通用户点进去只会看到「没有开通」,个人外观页也不该混进系统设置。
// AI 总开关关掉后,「模型」「ACP 接入」两项(都是 AI 相关)同样不出现。
const session = useSessionStore()
const showSettingsNav = computed(() => session.isAdmin)
const AI_NAV = new Set(['模型', 'ACP 接入'])
const settingsNav = computed(() =>
  ['常规', '外观', '存储与索引', '模型', '检索调权', 'Skills', '组件', 'MCP 接入', 'ACP 接入', '访问令牌', '备份', '关于'].filter(
    (item) => session.aiEnabled || !AI_NAV.has(item),
  ),
)

const tabSlugMap: Record<string, string> = {
  常规: 'general',
  外观: 'appearance',
  存储与索引: 'storage',
  模型: 'model',
  检索调权: 'tuning',
  Skills: 'skills',
  组件: 'components',
  'MCP 接入': 'mcp',
  'ACP 接入': 'acp',
  访问令牌: 'tokens',
  备份: 'backup',
  关于: 'about',
}

function onSelectNav(item: string) {
  if (item === '外观') return
  void router.push({ path: PATHS.settings, query: { tab: tabSlugMap[item] ?? 'general' } })
}

function resetDefaults() {
  appearance.theme = 'dark'
  appearance.accent = 'indigo'
  appearance.layout = 'sidebar'
  appearance.width = 'fluid'
  appearance.density = 'default'
  appearance.radius = 'default'
  appearance.font = 'm'
  appearance.motion = 'mac'
}
</script>

<template>
  <AppShell :bare="true">
    <template #breadcrumb>
      <!-- 普通用户的上一级是「个人设置」;「设置」(系统设置)只有管理员有 -->
      <span>{{ showSettingsNav ? '设置' : '个人设置' }}</span>/<b>外观</b>
    </template>

    <KbSettingsLayout
      :items="showSettingsNav ? settingsNav : []"
      active="外观"
      :flush="true"
      @select="onSelectNav"
    >
      <div class="ap" style="padding: 20px 24px" style-allow="外观主内容容器水平与垂直边距">
        <div class="ap-main">
          <div>
            <div class="kb-page-title">外观</div>
            <div class="m" style="margin-top: 2px" style-allow="副标间距">主题、强调色与布局只影响本账户；偏好保存在本机并同步到服务器。</div>
          </div>

          <section>
            <div class="ap-h">
              <b>主题</b><span>选择“跟随系统”时随 macOS / Windows 深浅色切换</span>
            </div>
            <div class="thc">
              <KbThemeCard
                v-for="theme in themes"
                :key="theme.value"
                :label="theme.label"
                :theme="theme.value"
                :tone="theme.tone"
                :accent="appearance.accent"
                :active="appearance.theme === theme.value"
                @select="appearance.theme = theme.value"
              />
            </div>
          </section>

          <section>
            <div class="ap-h">
              <b>强调色</b><span>用于主按钮、选中态、焦点环与图表主色</span>
              <span class="r aa">按钮文字对比度 <b>4.7 : 1 · AA</b></span>
            </div>
            <div class="sws">
              <KbSwatch
                v-for="accent in accents"
                :key="accent.value"
                :color="accent.value"
                :label="accent.label"
                :active="appearance.accent === accent.value"
                @select="appearance.accent = accent.value"
              />
              <span class="sw8 swc" title="自定义"></span>
              <span class="hex"><i></i>#0EA5E9</span> <!-- tokens-allow 自定义取色指示值 -->
            </div>
          </section>

          <section class="ap-pair">
            <div>
              <div class="ap-h"><b>导航布局</b></div>
              <div class="lays">
                <KbLayoutPicto
                  v-for="layout in layouts"
                  :key="layout.value"
                  :label="layout.label"
                  :kind="layout.kind"
                  :active="appearance.layout === layout.value"
                  @select="appearance.layout = layout.value"
                />
              </div>
            </div>
            <div>
              <div class="ap-h"><b>内容宽度</b></div>
              <div class="lays">
                <KbLayoutPicto
                  v-for="width in widths"
                  :key="width.value"
                  :label="width.label"
                  :kind="width.kind"
                  :active="appearance.width === width.value"
                  @select="appearance.width = width.value"
                />
              </div>
            </div>
          </section>

          <section>
            <div class="ap-h"><b>界面</b></div>
            <div class="card" style="padding: 0 16px" style-allow="选项集合卡片水平边距">
              <div class="opt">
                <span class="k">列表密度</span>
                <span class="d">列表行高 · 舒适 48 / 紧凑 36px,跟着账号走</span>
                <KbSegmented v-model="listDensity" :options="listDensityOptions" data-testid="list-density" />
              </div>
              <div class="opt">
                <span class="k">侧栏</span>
                <span class="d">默认状态 · 自动按屏幕宽度,也可以固定;⌘B 随时切换</span>
                <KbSegmented v-model="sidebarChoice" :options="sidebarOptions" data-testid="sidebar-choice" />
              </div>
              <div class="opt">
                <span class="k">界面间距</span>
                <span class="d">旧版页面的行高与留白 · 28 / 32 / 40px</span>
                <KbSegmentedX v-model="appearance.density" :options="densityOptions" axis="density" />
              </div>
              <div class="opt">
                <span class="k">圆角</span>
                <span class="d">控件与卡片圆角比例</span>
                <KbSegmentedX v-model="appearance.radius" :options="radiusOptions" axis="radius" />
              </div>
              <div class="opt">
                <span class="k">字号</span>
                <span class="d">界面基准字号 12 / 13 / 14px</span>
                <KbSegmentedX v-model="appearance.font" :options="fontOptions" axis="font" />
              </div>
              <div class="opt">
                <span class="k">动效</span>
                <span class="d">弹簧曲线与过渡强度</span>
                <KbSegmentedX v-model="appearance.motion" :options="motionOptions" axis="motion" />
              </div>
              <div class="opt">
                <span class="k">减少动效</span>
                <span class="d">跟随系统“减少动态效果”设置</span>
                <KbSwitch
                  aria-label="减少动效"
                  :model-value="appearance.motion === 'reduce'"
                  @update:model-value="(value: boolean) => (appearance.motion = value ? 'reduce' : 'mac')"
                />
              </div>
            </div>
          </section>
        </div>

        <KbAppearancePreview
          :theme-text="themeLabel"
          :accent-text="accentLabel"
          :density-text="densityLabel"
          @reset="resetDefaults"
        />
      </div>
    </KbSettingsLayout>
  </AppShell>
</template>
