<script setup lang="ts">
// 我的分享（设计规范）:我分享出去的文档 / 文件夹 / 集合,和我创建的分享链接,集中管理。
// 多选后可以批量:添加协作者、生成合集链接、改某个人的角色、移除某个人;链接可以批量关闭 / 删除。
// 四种状态:加载骨架、空(给下一步)、报错可重试、没有 collab.share 功能(直接访问时显示未开通)。
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  KbBadge,
  KbButton,
  KbEmpty,
  KbPageHeader,
  KbResponsiveTable,
  KbSkeleton,
  KbTabs,
  useConfirm,
  useToast,
  type RtColumn,
  type TabItem,
} from '@kb-ui/index'
import AppShell from '@/layouts/AppShell.vue'
import AccessRequestList from '@/components/share/AccessRequestList.vue'
import BatchPersonDialog from '@/components/share/BatchPersonDialog.vue'
import SharePanel from '@/components/share/SharePanel.vue'
import ShareFeatureOff from '@/components/share/ShareFeatureOff.vue'
import { linkRevoke, linkUpdate, myLinks, sharedByMe, type LinkInfo, type SharedByMeItem, type ShareTarget } from '@/api/share'
import { useFeature } from '@/composables/useFeature'
import { PATHS } from '@/router/paths'
import { AUDIENCE_LABEL, expiryText, granteeSummary, linkStateOf, relativeTime, roleLabel, shareErrorText, targetKey, targetKindLabel, targetName } from '@/utils/share'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const confirmer = useConfirm()
const enabled = useFeature('collab.share')

type Tab = 'items' | 'links' | 'requests'
// ?tab=requests 是通知(有人申请访问我的文档)点进来的深链
const tab = ref<Tab>(route.query.tab === 'links' || route.query.tab === 'requests' ? route.query.tab : 'items')
/** 等我处理的访问申请数(页签上的数字;由列表组件报上来) */
const pendingRequests = ref<number | undefined>(undefined)
watch(tab, (value) => void router.replace({ query: { ...route.query, tab: value === 'items' ? undefined : value } }))

// ---------------------------------------------------------------- 数据
type Phase = 'loading' | 'ready' | 'error'
const items = ref<SharedByMeItem[]>([])
const links = ref<LinkInfo[]>([])
const itemsPhase = ref<Phase>('loading')
const linksPhase = ref<Phase>('loading')
const itemsError = ref('')
const linksError = ref('')

async function loadItems() {
  if (itemsPhase.value !== 'ready') itemsPhase.value = 'loading'
  try {
    items.value = (await sharedByMe()).items ?? []
    itemsPhase.value = 'ready'
  } catch (err) {
    itemsError.value = shareErrorText(err, '分享出去的内容没有加载出来。检查网络后重试。')
    itemsPhase.value = 'error'
  }
}
async function loadLinks() {
  if (linksPhase.value !== 'ready') linksPhase.value = 'loading'
  try {
    links.value = ((await myLinks()).links ?? []).filter((link) => link.state !== 'revoked')
    linksPhase.value = 'ready'
  } catch (err) {
    linksError.value = shareErrorText(err, '分享链接没有加载出来。检查网络后重试。')
    linksPhase.value = 'error'
  }
}
const reload = () => Promise.all([loadItems(), loadLinks()])
onMounted(() => {
  if (enabled.value) void reload()
})

// ---------------------------------------------------------------- 表格
const itemColumns: RtColumn[] = [
  { key: 'title', label: '名称', mobile: 'primary' },
  { key: 'grantees', label: '协作者', mobile: 'meta' },
  { key: 'inherit', label: '继承', mobile: 'meta' },
]
const linkColumns: RtColumn[] = [
  { key: 'title', label: '名称', mobile: 'primary' },
  { key: 'audience', label: '谁能访问', mobile: 'meta' },
  { key: 'state', label: '状态', mobile: 'meta' },
  { key: 'views', label: '访问', mobile: 'meta' },
  { key: 'expires', label: '有效期', mobile: 'hidden' },
]

interface ItemRow extends Record<string, unknown> {
  id: string
  title: string
  kind: string
  grantees: string
  inherit: string
  raw: SharedByMeItem
}
interface LinkRow extends Record<string, unknown> {
  id: string
  title: string
  kind: string
  audience: string
  views: string
  expires: string
  raw: LinkInfo
}
const itemRows = computed<ItemRow[]>(() =>
  items.value.map((item) => ({
    id: item.key,
    title: targetName(item.target, item.title),
    kind: targetKindLabel(item.target),
    grantees: item.grantees.length ? granteeSummary(item) : '还没有协作者',
    inherit: item.inherit_broken ? '不继承上级' : '继承上级',
    raw: item,
  })),
)
const linkRows = computed<LinkRow[]>(() =>
  links.value.map((link) => ({
    id: link.id,
    title: link.title || (link.roots[0] ? targetName(link.roots[0]) : '分享链接'),
    kind: link.bundle ? `合集 · ${link.roots.length} 项` : link.roots[0] ? targetKindLabel(link.roots[0]) : '链接',
    audience: link.audience === 'collaborators' ? AUDIENCE_LABEL.collaborators : `${AUDIENCE_LABEL[link.audience]} · ${roleLabel(link.role)}`,
    views: link.views ? `${link.views} 次${link.last_view_at ? `,${relativeTime(link.last_view_at)}` : ''}` : '还没有人打开',
    expires: expiryText(link.expires_at),
    raw: link,
  })),
)

const itemSelection = ref<string[]>([])
const linkSelection = ref<string[]>([])
const selectedItems = computed(() => items.value.filter((item) => itemSelection.value.includes(item.key)))
const selectedLinks = computed(() => links.value.filter((link) => linkSelection.value.includes(link.id)))
// 列表重读后丢掉已经不存在的选中项
watch(items, (list) => (itemSelection.value = itemSelection.value.filter((key) => list.some((item) => item.key === key))))
watch(links, (list) => (linkSelection.value = linkSelection.value.filter((id) => list.some((link) => link.id === id))))

const tabs = computed<TabItem[]>(() => [
  { value: 'items', label: '分享出去的', count: itemsPhase.value === 'ready' ? items.value.length : undefined },
  { value: 'links', label: '分享链接', count: linksPhase.value === 'ready' ? links.value.length : undefined },
  { value: 'requests', label: '访问申请', count: pendingRequests.value || undefined },
])

// ---------------------------------------------------------------- 打开分享面板 / 批量对话框
const panel = ref<{ targets: ShareTarget[]; titles: Record<string, string>; tab: 'people' | 'link'; link?: LinkInfo } | null>(null)
function manageItem(item: SharedByMeItem) {
  panel.value = { targets: [item.target], titles: { [targetKey(item.target)]: item.title }, tab: 'people' }
}
function manageSelected(which: 'people' | 'link') {
  const picked = selectedItems.value
  if (!picked.length) return
  panel.value = { targets: picked.map((item) => item.target), titles: Object.fromEntries(picked.map((item) => [targetKey(item.target), item.title])), tab: which }
}
function manageLink(link: LinkInfo) {
  panel.value = { targets: link.roots, titles: {}, tab: 'link', link }
}
function closePanel() {
  panel.value = null
  void reload()
}
const dialog = ref<'role' | 'remove' | null>(null)
function dialogDone() {
  itemSelection.value = []
  void loadItems()
}

// ---------------------------------------------------------------- 链接的批量操作
/** 逐条请求;部分失败如实说,不整体报成功也不整体报失败 */
async function runOnLinks(targets: LinkInfo[], action: (link: LinkInfo) => Promise<unknown>, done: (count: number) => string) {
  const results = await Promise.allSettled(targets.map(action))
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length) {
    const reason = (failed[0] as PromiseRejectedResult).reason
    toast.push(`${targets.length - failed.length} 条已处理,${failed.length} 条没有成功:${shareErrorText(reason)}`, 'danger')
  } else {
    toast.push(done(targets.length))
  }
  linkSelection.value = []
  await loadLinks()
}
async function closeLinks() {
  const open = selectedLinks.value.filter((link) => link.enabled)
  if (!open.length) {
    toast.push('选中的链接都已经是关闭的')
    return
  }
  const ok = await confirmer.ask({
    title: `关闭 ${open.length} 条分享链接?`,
    message: '关闭后这些地址暂时打不开;链接的设置会保留,随时可以在「管理」里重新打开。',
    confirmText: '关闭链接',
    tone: 'danger',
  })
  if (ok) await runOnLinks(open, (link) => linkUpdate({ id: link.id, enabled: false }), (count) => `已关闭 ${count} 条链接`)
}
async function deleteLinks() {
  const picked = selectedLinks.value
  if (!picked.length) return
  const ok = await confirmer.ask({
    title: `删除 ${picked.length} 条分享链接?`,
    message: '删除后这些地址永久失效,不能恢复。已经通过它们加入的协作者不受影响。想以后还能打开,请改用「关闭链接」。',
    confirmText: '删除链接',
    tone: 'danger',
  })
  if (ok) await runOnLinks(picked, (link) => linkRevoke(link.id), (count) => `已删除 ${count} 条链接`)
}
</script>

<template>
  <AppShell>
    <div class="kb-shares" data-testid="shares-page">
      <KbPageHeader title="我的分享" description="你分享出去的文档、文件夹和链接都在这里,别人的访问申请也在这里处理。选中几项可以一起改协作者,或者生成一个合集链接。" />

      <ShareFeatureOff v-if="!enabled" what="管理分享" />

      <template v-else>
        <KbTabs :model-value="tab" :tabs="tabs" @update:model-value="(value: string) => (tab = value as Tab)" />

        <!-- ============ 分享出去的 ============ -->
        <section v-show="tab === 'items'" class="kb-shares-pane" data-testid="shares-items">
          <KbSkeleton v-if="itemsPhase === 'loading'" variant="table" :lines="4" />
          <KbEmpty v-else-if="itemsPhase === 'error'" icon="failed" title="分享出去的内容没有加载出来" :description="itemsError" data-testid="shares-items-error">
            <template #action><KbButton size="sm" @click="loadItems">重试</KbButton></template>
          </KbEmpty>
          <KbResponsiveTable
            v-else
            v-model:selected="itemSelection"
            :columns="itemColumns"
            :rows="itemRows"
            selectable
            clickable
            @row-click="(row: ItemRow) => manageItem(row.raw)"
          >
            <template #empty>
              <KbEmpty icon="share" title="你还没有分享过内容" description="在知识库里打开一篇文档,点右上角的「分享」,把它分享给好友或生成链接。" data-testid="shares-items-empty">
                <template #action><RouterLink class="btn pri" :to="PATHS.kb">去知识库</RouterLink></template>
              </KbEmpty>
            </template>
            <template #cell-title="{ row }">
              <span class="kb-shares-name"><b>{{ (row as ItemRow).title }}</b> <KbBadge tone="neutral">{{ (row as ItemRow).kind }}</KbBadge></span>
            </template>
            <template #row-actions="{ row }">
              <KbButton size="sm" :aria-label="`管理分享:${(row as ItemRow).title}`" @click="manageItem((row as ItemRow).raw)">管理</KbButton>
            </template>
            <template #batch>
              <KbButton size="sm" variant="primary" data-testid="shares-add" @click="manageSelected('people')">添加协作者</KbButton>
              <KbButton v-if="selectedItems.length > 1" size="sm" data-testid="shares-bundle" @click="manageSelected('link')">合集链接</KbButton>
              <KbButton size="sm" data-testid="shares-role" @click="dialog = 'role'">改角色</KbButton>
              <KbButton size="sm" variant="danger" data-testid="shares-remove" @click="dialog = 'remove'">移除协作者</KbButton>
            </template>
          </KbResponsiveTable>
        </section>

        <!-- ============ 分享链接 ============ -->
        <section v-show="tab === 'links'" class="kb-shares-pane" data-testid="shares-links">
          <KbSkeleton v-if="linksPhase === 'loading'" variant="table" :lines="4" />
          <KbEmpty v-else-if="linksPhase === 'error'" icon="failed" title="分享链接没有加载出来" :description="linksError" data-testid="shares-links-error">
            <template #action><KbButton size="sm" @click="loadLinks">重试</KbButton></template>
          </KbEmpty>
          <template v-else>
            <KbResponsiveTable
              v-model:selected="linkSelection"
              :columns="linkColumns"
              :rows="linkRows"
              selectable
              clickable
              @row-click="(row: LinkRow) => manageLink(row.raw)"
            >
              <template #empty>
                <KbEmpty icon="link" title="你还没有创建过分享链接" description="在文档的分享面板里切到「链接分享」就能创建;选中多项还可以生成一个合集链接。" data-testid="shares-links-empty">
                  <template #action><RouterLink class="btn pri" :to="PATHS.kb">去知识库</RouterLink></template>
                </KbEmpty>
              </template>
              <template #cell-title="{ row }">
                <span class="kb-shares-name"><b>{{ (row as LinkRow).title }}</b> <KbBadge tone="neutral">{{ (row as LinkRow).kind }}</KbBadge></span>
              </template>
              <template #cell-state="{ row }">
                <KbBadge :tone="linkStateOf((row as LinkRow).raw.state).tone">{{ linkStateOf((row as LinkRow).raw.state).text }}</KbBadge>
                <KbBadge v-if="(row as LinkRow).raw.has_password" tone="neutral">有密码</KbBadge>
              </template>
              <template #row-actions="{ row }">
                <KbButton size="sm" :aria-label="`管理链接:${(row as LinkRow).title}`" @click="manageLink((row as LinkRow).raw)">管理</KbButton>
              </template>
              <template #batch>
                <KbButton size="sm" data-testid="links-close" @click="closeLinks">关闭链接</KbButton>
                <KbButton size="sm" variant="danger" data-testid="links-delete" @click="deleteLinks">删除链接</KbButton>
              </template>
            </KbResponsiveTable>
            <p v-if="links.length" class="kb-shares-hint">为了安全,完整的链接地址只在创建或重置时显示一次。需要新地址,点「管理」后「重置链接」(旧地址会立刻失效)。</p>
          </template>
        </section>

        <!-- ============ 访问申请 ============ -->
        <section v-show="tab === 'requests'" class="kb-shares-pane" data-testid="shares-requests">
          <AccessRequestList @count="(pending: number) => (pendingRequests = pending)" />
        </section>
      </template>
    </div>

    <SharePanel v-if="panel" :targets="panel.targets" :titles="panel.titles" :initial-tab="panel.tab" :link="panel.link" @close="closePanel" @changed="reload" />
    <BatchPersonDialog v-if="dialog" :mode="dialog" :items="selectedItems" @close="dialog = null" @done="dialogDone" />
  </AppShell>
</template>

<style>
.kb-shares { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; max-width: 1280px; width: 100%; margin: 0 auto; }
.kb-shares-pane { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-shares-name { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; min-width: 0; overflow-wrap: anywhere; }
.kb-shares-name b { font-weight: var(--fw-medium); }
.kb-shares-hint { margin: 0; color: var(--text-tertiary); font-size: var(--text-12); line-height: var(--lh-body); }
</style>
