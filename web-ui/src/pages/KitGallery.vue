<script setup lang="ts">
// 组件库示例页: 新增组件的活体样例,也是 Playwright 在各设备上验证它们的宿主。
// 不在导航里,不依赖后端数据;改组件时先在这里看一眼桌面 / 手机两种形态。
import { computed, ref } from 'vue'
import {
  KbActionBar,
  KbButton,
  KbChartCard,
  KbDialog,
  KbEmpty,
  KbField,
  KbFunnel,
  KbGauge,
  KbHeatGrid,
  KbInput,
  KbLineChart,
  KbPageHeader,
  KbResponsiveTable,
  KbSheet,
  KbSkeleton,
  KbTabs,
  type RtColumn,
} from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'

const columns: RtColumn[] = [
  { key: 'name', label: '名称', mobile: 'primary' },
  { key: 'owner', label: '所有者' },
  { key: 'updated', label: '更新于' },
  { key: 'size', label: '大小', align: 'right' },
  { key: 'path', label: '路径', mobile: 'hidden', clip: true },
]
const rows = [
  { id: 'd1', name: '部署清单', owner: '林一', updated: '今天 14:20', size: '2 KB', path: '运维/部署/清单.md' },
  { id: 'd2', name: '会议纪要模板', owner: '张三', updated: '昨天', size: '1 KB', path: '模板/会议纪要.md' },
  { id: 'd3', name: '检索调优记录', owner: '林一', updated: '周一', size: '8 KB', path: '检索/调优.md' },
  { id: 'd4', name: '接口约定', owner: '李四', updated: '10-19', size: '5 KB', path: '接口/约定.md' },
  { id: 'd5', name: '一个名字特别特别特别特别长的文档用来检查手机上的折行与省略', owner: '王五', updated: '10-18', size: '12 KB', path: '杂项/很长很长很长很长很长很长很长很长/文档.md' },
]
/* ---- 监控图表:假数据只用来看形状和动效 ---- */
const chartRange = ref('24h')
const chartState = ref<'ready' | 'loading' | 'empty' | 'error'>('ready')
const chartStates = [
  { value: 'ready', label: '正常' },
  { value: 'loading', label: '加载中' },
  { value: 'empty', label: '空' },
  { value: 'error', label: '出错' },
]
const chartRanges = [
  { value: '1h', label: '1 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
]
const wave = (base: number, amp: number, phase: number) => Array.from({ length: 24 }, (_, hour) => Math.max(0, Math.round(base + amp * Math.sin((hour + phase) / 3.2))))
const hours = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`)
const throughput = [
  { name: '完成', values: wave(180, 90, 0) },
  { name: '失败', values: wave(6, 5, 4) },
  { name: '取消', values: wave(3, 2, 9) },
]
const cpu = [{ name: '处理器', values: wave(42, 30, 2).map((value) => value / 100) }]
const heatRows = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const heatCols = Array.from({ length: 24 }, (_, hour) => String(hour))
const heat = heatRows.map((_, row) => heatCols.map((__, col) => (col >= 9 && col <= 18 && row < 5 ? Math.round(40 + 60 * Math.abs(Math.sin((col + row) / 2))) : col > 6 && col < 22 ? Math.round(10 * Math.abs(Math.cos(col + row))) : 0)))
const funnel = [
  { name: '排队', value: 1280 },
  { name: '解析', value: 1210 },
  { name: '向量化', value: 1150 },
  { name: '完成', value: 1098 },
  { name: '失败', value: 42, tone: 'danger' as const },
  { name: '跳过', value: 70, tone: 'muted' as const },
]
const selected = ref<string[]>([])
const removed = ref<string[]>([])
const visibleRows = computed(() => rows.filter((row) => !removed.value.includes(row.id)))
function removeSelected() {
  removed.value = [...removed.value, ...selected.value]
  selected.value = []
}

const tabs = ['概览', '用户', '角色', '邀请码', '审计', '设置', '备份'].map((label, index) => ({ value: `t${index}`, label }))
const tab = ref('t0')
const narrowTab = ref('t0')

const email = ref('')
const nickname = ref('林一')
const saved = ref('林一')
const dirty = computed(() => nickname.value !== saved.value)
const emailError = computed(() => (email.value && !/^\S+@\S+\.\S+$/.test(email.value) ? '邮箱格式不对,请检查 @ 和域名' : ''))
function save() {
  saved.value = nickname.value
}

const sheetOpen = ref(false)
const dialogOpen = ref(false)
</script>

<template>
  <AppShell>
    <template #breadcrumb><b>组件库</b></template>
    <div class="kb-kit" data-testid="kit">
      <KbPageHeader title="组件库" description="统一外壳之上的页面骨架、响应式表格、表单、弹层、空状态、骨架屏和可滑动标签页。">
        <template #breadcrumb>开发 / 组件库</template>
        <template #actions>
          <KbButton @click="sheetOpen = true">打开底部弹层</KbButton>
          <KbButton variant="primary" @click="dialogOpen = true">打开对话框</KbButton>
        </template>
      </KbPageHeader>

      <section class="card kb-kit-block">
        <div class="ch">响应式表格</div>
        <div class="kb-kit-pad kb-kit-stack">
          <p class="m">桌面是表格,手机自动变成卡片;勾选(手机上点「选择」或长按)后底部出现批量条。</p>
          <KbResponsiveTable v-model:selected="selected" :columns="columns" :rows="visibleRows" selectable clickable empty="所有文档都被删光了">
            <template #cell-name="{ row }"><b>{{ row.name }}</b></template>
            <template #row-actions="{ row }"><KbButton size="sm" :aria-label="`更多操作:${row.name}`">⋯</KbButton></template>
            <template #batch><KbButton size="sm" variant="danger" data-testid="kit-delete" @click="removeSelected">删除</KbButton></template>
          </KbResponsiveTable>
        </div>
      </section>

      <section class="card kb-kit-block" data-testid="kit-charts">
        <div class="ch">监控图表</div>
        <div class="kb-kit-pad kb-kit-stack">
          <p class="m">图表卡骨架(标题、结论、范围切换、三种状态)、渐变 / 堆叠面积、实时点、环形仪表、热力矩阵、漏斗。切到「减少动画」后全部直接到位。</p>
          <KbTabs v-model="chartState" :tabs="chartStates" />
          <div class="kb-kit-charts">
            <KbChartCard v-model:range="chartRange" title="任务吞吐" headline="近 24 小时完成 4,224 个,失败 0" :ranges="chartRanges" :state="chartState" empty-text="还没有任务,有了之后这里会显示吞吐" error-text="读取任务统计失败" @retry="chartState = 'ready'">
              <KbLineChart :labels="hours" :series="throughput" label="任务吞吐" area="stacked" :height="200" />
              <template #footer>每小时一个点 · 悬停看每一层和合计</template>
            </KbChartCard>
            <KbChartCard title="处理器使用率" headline="现在 42%,过去 24 小时峰值 72%" :state="chartState">
              <KbLineChart :labels="hours" :series="cpu" label="处理器使用率" area live :height="200" :floor="0" :ceil="1" :format="(value: number) => `${Math.round(value * 100)}%`" />
            </KbChartCard>
          </div>
          <div class="kb-kit-gauges">
            <KbGauge :value="0.34" label="处理器使用率" caption="16 核" />
            <KbGauge :value="0.84" label="内存使用率" text="52 GB" caption="共 62 GB" />
            <KbGauge :value="0.93" label="磁盘使用率" caption="剩 41 GB" />
            <KbGauge :value="0.5" label="配额占比" :size="88" :warn="null" :danger="null" />
          </div>
          <div class="kb-kit-charts">
            <KbChartCard title="接口调用时段" headline="工作日 9–18 点最忙" :state="chartState"><KbHeatGrid :rows="heatRows" :cols="heatCols" :values="heat" label="接口调用时段" /></KbChartCard>
            <KbChartCard title="导入流水线" headline="近 24 小时 1,280 个文件进入,1,098 个完成" :state="chartState"><KbFunnel :stages="funnel" label="导入流水线" /></KbChartCard>
          </div>
        </div>
      </section>

      <section class="card kb-kit-block">
        <div class="ch">可滑动标签页</div>
        <div class="kb-kit-pad kb-kit-stack">
          <p class="m">放不下时可以横向滑动,两端有渐隐提示;下面一排最多直接显示 5 个,其余进「更多」。</p>
          <div class="kb-kit-narrow" data-testid="kit-narrow-tabs"><KbTabs v-model="narrowTab" :tabs="tabs" /></div>
          <KbTabs v-model="tab" :tabs="tabs" :max-visible="5" />
          <div class="m">当前:{{ tabs.find((item) => item.value === tab)?.label }}</div>
        </div>
      </section>

      <section class="card kb-kit-block">
        <div class="ch">表单字段与操作条</div>
        <div class="kb-kit-pad kb-kit-form">
          <KbField label="昵称" hint="显示在顶栏的头像菜单里" required v-slot="{ id, describedby }">
            <KbInput :id="id" v-model="nickname" :aria-describedby="describedby" />
          </KbField>
          <KbField label="邮箱" :error="emailError" hint="用于找回密码" layout="inline" v-slot="{ id, describedby, invalid }">
            <KbInput :id="id" v-model="email" type="email" inputmode="email" :aria-describedby="describedby" :aria-invalid="invalid" />
          </KbField>
          <KbActionBar :dirty="dirty">
            <KbButton :disabled="!dirty" @click="nickname = saved">还原</KbButton>
            <KbButton variant="primary" :disabled="!dirty" data-testid="kit-save" @click="save">保存</KbButton>
          </KbActionBar>
        </div>
      </section>

      <section class="kb-grid kb-grid-3">
        <div class="card kb-kit-block"><div class="ch">空状态</div><KbEmpty title="还没有笔记" description="新建第一篇笔记,或导入已有文件。"><template #action><KbButton variant="primary">新建笔记</KbButton></template></KbEmpty></div>
        <div class="card kb-kit-block"><div class="ch">空状态 · 紧凑</div><KbEmpty size="sm" icon="inbox" title="收件箱是空的" /></div>
        <div class="card kb-kit-block"><div class="ch">骨架屏</div><div class="kb-kit-pad kb-kit-stack"><KbSkeleton variant="card" :lines="2" /><KbSkeleton variant="list" :lines="2" /><KbSkeleton variant="table" :lines="2" /></div></div>
      </section>
    </div>

    <KbSheet v-if="sheetOpen" title="筛选" @close="sheetOpen = false">
      <div class="kb-stack">
        <KbField label="关键词" v-slot="{ id }"><KbInput :id="id" model-value="" placeholder="输入关键词" /></KbField>
        <p class="m">向下拖动顶部把手可以关闭。</p>
      </div>
      <template #footer><KbButton @click="sheetOpen = false">取消</KbButton><KbButton variant="primary" @click="sheetOpen = false">应用</KbButton></template>
    </KbSheet>
    <KbDialog v-if="dialogOpen" title="对话框" @close="dialogOpen = false">
      <p>桌面上居中显示,手机上自动变成贴底的弹层。</p>
      <template #footer><KbButton variant="primary" @click="dialogOpen = false">知道了</KbButton></template>
    </KbDialog>
  </AppShell>
</template>

<style scoped>
.kb-kit { display: flex; flex-direction: column; gap: var(--gap); width: 100%; max-width: 1280px; margin: 0 auto; min-width: 0; }
.kb-kit-block { min-width: 0; }
.kb-kit-pad { padding: var(--card-pad); min-width: 0; }
.kb-kit-stack { display: flex; flex-direction: column; gap: var(--gap); }
.kb-kit-form { display: flex; flex-direction: column; gap: var(--gap); max-width: 720px; }
.kb-kit-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: var(--gap); min-width: 0; }
.kb-kit-gauges { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gap-lg, 24px); }
.kb-kit-narrow { width: 260px; max-width: 100%; border: var(--hl) dashed var(--b2); border-radius: var(--r2); }
</style>
