<script setup lang="ts">
// 分享面板 · 协作者页（设计规范）:给指定的人授权。
//   - 单个资源:grant_set / grant_remove / set_inherit,列表含「继承自某文件夹」的来源;
//   - 多选(目录和文件混选):grant_batch 一次写到每一项,列表合并各项,角色不一致显示「各项不同」。
// 四种状态都在这里:加载(骨架)、空(还没有协作者)、报错(可重试)、无权限(只有「可管理」的人能看和改协作者)。
import { computed, onMounted, ref, watch } from 'vue'
import { KbButton, KbEmpty, KbInput, KbSelect, KbSkeleton, KbSwitch, useConfirm, useToast } from '@kb-ui/index'
import UserAvatar from '@/components/UserAvatar.vue'
import './share.css'
import {
  friendList,
  friendSearch,
  grantBatch,
  grantList,
  grantRemove,
  grantSet,
  setInherit,
  type FriendRow,
  type GrantList,
  type GrantRole,
  type PublicProfile,
  type ShareTarget,
} from '@/api/share'
import { useSessionStore } from '@/stores/session'
import {
  canStopInherit,
  dateText,
  filterFriends,
  grantableRoles,
  isFolderLike,
  isNoAccess,
  joinedViaLink,
  mergeGrants,
  personName,
  roleLabel,
  roleOptions,
  roleRank,
  shareErrorText,
  sortGrantRows,
  sourceLabel,
  targetKey,
  targetKindLabel,
  targetName,
  type MergedGrant,
} from '@/utils/share'

const props = defineProps<{ targets: ShareTarget[]; titles?: Record<string, string> }>()
const emit = defineEmits<{ changed: [] }>()

const toast = useToast()
const confirmer = useConfirm()
const session = useSessionStore()

const multi = computed(() => props.targets.length > 1)
/** 多选时最多逐项查多少个现有协作者(再多就只提示,不为 500 项各发一次请求) */
const LIST_LIMIT = 30

type Status = 'loading' | 'ready' | 'error' | 'denied'
const status = ref<Status>('loading')
const errorText = ref('')
/** 无权限时给人看的话:403 的服务端原话带着具体原因(「你的角色是…,需要…」);404 只是「没找到」,不如统一说明 */
const deniedText = ref('')
const single = ref<GrantList | null>(null)
const merged = ref<MergedGrant[]>([])
/** 多选时每一项上我的角色里最低的那个:能授予的上限由它决定 */
const lowestRole = ref<string | null>(null)
const listed = ref(0)
const friends = ref<FriendRow[]>([])

const myRole = computed(() => (multi.value ? lowestRole.value : (single.value?.my_role ?? null)))
/** 超出逐项查询上限时拿不到角色,先给全部四档,真正的上限由后端把关(报「你最多只能授予…」) */
const roles = computed(() => (multi.value && listed.value < props.targets.length ? grantableRoles('owner') : grantableRoles(myRole.value)))
const roleChoices = computed(() => roleOptions(roles.value))
const unlisted = computed(() => multi.value && listed.value < props.targets.length)

async function load() {
  status.value = 'loading'
  errorText.value = ''
  try {
    if (!multi.value) {
      single.value = await grantList(props.targets[0]!)
    } else {
      const shown = props.targets.slice(0, LIST_LIMIT)
      const lists: GrantList[] = []
      // 分批并发:一次最多 6 个请求
      for (let at = 0; at < shown.length; at += 6) {
        lists.push(...(await Promise.all(shown.slice(at, at + 6).map((target) => grantList(target)))))
      }
      listed.value = lists.length
      merged.value = mergeGrants(lists)
      lowestRole.value = lists.reduce<string | null>((lowest, list) => (lowest === null || roleRank(list.my_role) < roleRank(lowest) ? list.my_role : lowest), null)
    }
    status.value = 'ready'
  } catch (err) {
    errorText.value = shareErrorText(err, '协作者名单没有加载出来。检查网络后重试。')
    deniedText.value = (err as { status?: number }).status === 403 ? errorText.value : ''
    status.value = isNoAccess(err) ? 'denied' : 'error'
  }
}

async function loadFriends() {
  try {
    friends.value = (await friendList()).friends
  } catch {
    // 好友只是「点一下就能选」的捷径;取不到时仍可输入完整用户名 / 邮箱
    friends.value = []
  }
}

onMounted(() => {
  void load()
  void loadFriends()
})
watch(
  () => props.targets.map((target) => JSON.stringify(target)).join('|'),
  () => void load(),
)

// ---------------------------------------------------------------- 添加协作者

const query = ref('')
const newRole = ref<GrantRole>('viewer')
const picked = ref<PublicProfile | null>(null)
/** 选中时的称呼:好友用我给他起的备注(和下面好友捷径上看到的一致) */
const pickedLabel = ref('')
const addError = ref('')
const searching = ref(false)
const adding = ref(false)

// 重新输入时旧的报错就不再适用
watch(query, () => (addError.value = ''))

watch(roles, (list) => {
  if (!list.includes(newRole.value)) newRole.value = list[0] ?? 'viewer'
})

/** 已经是协作者(直接授权)或就是我自己的人,不再出现在好友捷径里 */
const takenIds = computed(() => {
  const ids = new Set<string>([session.user?.id ?? ''])
  for (const row of single.value?.grants ?? []) if (!row.inherited) ids.add(row.user.id)
  for (const row of merged.value) ids.add(row.user.id)
  if (single.value?.owner) ids.add(single.value.owner.id)
  return ids
})
const suggestions = computed(() => filterFriends(friends.value, query.value, 6).filter((friend) => !takenIds.value.has(friend.id)))

function pick(profile: PublicProfile, remark?: string | null) {
  picked.value = profile
  pickedLabel.value = personName(profile, remark)
  query.value = ''
  addError.value = ''
}

/** 回车 / 「查找」:输入的是完整用户名或邮箱,先在好友里精确匹配,没有再去服务端找(不支持模糊搜索) */
async function lookup() {
  const text = query.value.trim()
  if (!text || searching.value) return
  addError.value = ''
  const exact = friends.value.find((friend) => friend.username.toLowerCase() === text.toLowerCase())
  if (exact) {
    pick(exact, exact.remark)
    return
  }
  searching.value = true
  try {
    const found = await friendSearch(text)
    if (!found.user) {
      addError.value = '没有找到这个用户。请输入对方完整的用户名或邮箱;对方也可能没有开放搜索。'
    } else if (found.user.id === session.user?.id) {
      addError.value = '不能分享给自己。'
    } else {
      pick(found.user)
    }
  } catch (err) {
    addError.value = shareErrorText(err, '查找没有成功,请稍后再试。')
  } finally {
    searching.value = false
  }
}

async function addPerson() {
  const person = picked.value
  if (!person || adding.value) return
  adding.value = true
  addError.value = ''
  try {
    if (multi.value) await grantBatch(props.targets, [{ user_id: person.id, role: newRole.value }])
    else await grantSet(props.targets[0]!, person.id, newRole.value)
    toast.push(`已分享给 ${pickedLabel.value}(${roleLabel(newRole.value)})`)
    picked.value = null
    emit('changed')
    await load()
  } catch (err) {
    addError.value = shareErrorText(err)
  } finally {
    adding.value = false
  }
}

// ---------------------------------------------------------------- 改角色 / 移除 / 继承

const busyId = ref('')

async function changeRole(user: PublicProfile, role: GrantRole) {
  busyId.value = user.id
  try {
    if (multi.value) await grantBatch(props.targets, [{ user_id: user.id, role }])
    else await grantSet(props.targets[0]!, user.id, role)
    toast.push(`${personName(user)} 现在是「${roleLabel(role)}」`)
    emit('changed')
  } catch (err) {
    toast.push(shareErrorText(err), 'danger')
  } finally {
    busyId.value = ''
    // 不管成败都重读:界面始终显示服务器上的真实状态
    await load()
  }
}

async function removePerson(user: PublicProfile) {
  if (multi.value) {
    const ok = await confirmer.ask({
      title: `从选中的 ${props.targets.length} 项里移除 ${personName(user)}?`,
      message: '他会立刻失去通过这些项得到的权限(通过别的方式得到的不受影响)。',
      confirmText: '移除',
      tone: 'danger',
    })
    if (!ok) return
  }
  busyId.value = user.id
  try {
    if (multi.value) await grantBatch(props.targets, [{ user_id: user.id }])
    else await grantRemove(props.targets[0]!, user.id)
    toast.push(`已移除 ${personName(user)}`)
    emit('changed')
  } catch (err) {
    toast.push(shareErrorText(err), 'danger')
  } finally {
    busyId.value = ''
    await load()
  }
}

const inheritBusy = ref(false)
/** 「不继承上级协作者」开关:开 = 只认这一层自己的授权 */
async function toggleInherit(stop: boolean) {
  const target = props.targets[0]!
  inheritBusy.value = true
  try {
    await setInherit(target, !stop)
    toast.push(stop ? '已停止继承:现在只有这里单独添加的人能访问' : '已恢复继承上级的协作者')
    emit('changed')
  } catch (err) {
    toast.push(shareErrorText(err), 'danger')
  } finally {
    inheritBusy.value = false
    await load()
  }
}

// ---------------------------------------------------------------- 展示

const rows = computed(() => sortGrantRows(single.value?.grants ?? []))
const owner = computed(() => single.value?.owner ?? null)
const isEmpty = computed(() => (multi.value ? merged.value.length === 0 : rows.value.length === 0))
const showInherit = computed(() => !multi.value && canStopInherit(props.targets[0]!))
const allFolderLike = computed(() => props.targets.every(isFolderLike))
const someFolderLike = computed(() => props.targets.some(isFolderLike))
const selectedKinds = computed(() => {
  const counts = new Map<string, number>()
  for (const target of props.targets) counts.set(targetKindLabel(target), (counts.get(targetKindLabel(target)) ?? 0) + 1)
  return [...counts.entries()].map(([label, count]) => `${count} 个${label}`).join('、')
})
const previewNames = computed(() => props.targets.slice(0, 3).map((target) => targetName(target, props.titles?.[targetKey(target)])))

/** 角色下拉能改的:这个人现有角色不高于我能授予的上限(高于上限的只读显示,真要改得找比我高的人) */
const rowEditable = (role: string) => roles.value.includes(role as GrantRole)
</script>

<template>
  <div class="kb-share-people" data-testid="share-people">
    <!-- 加载 -->
    <KbSkeleton v-if="status === 'loading'" variant="list" :lines="3" />

    <!-- 无权限 -->
    <KbEmpty
      v-else-if="status === 'denied'"
      icon="lock"
      title="你没有权限管理这里的分享"
      :description="deniedText || '只有所有者和「可管理」的人能添加或移除协作者。可以联系所有者,请他给你更高的权限。'"
      size="sm"
      data-testid="share-denied"
    />

    <!-- 报错 -->
    <KbEmpty v-else-if="status === 'error'" icon="failed" title="协作者名单没有加载出来" :description="errorText" size="sm" data-testid="share-error">
      <template #action><KbButton size="sm" @click="load">重试</KbButton></template>
    </KbEmpty>

    <template v-else>
      <!-- 多选:列出选了什么,并把「目录 = 以后新增的也可见」说清楚 -->
      <div v-if="multi" class="kb-share-selected" data-testid="share-selected">
        <b>已选 {{ targets.length }} 项</b>
        <span class="kb-share-sub">{{ selectedKinds }}</span>
        <span class="kb-share-sub kb-share-names">{{ previewNames.join('、') }}{{ targets.length > 3 ? ' 等' : '' }}</span>
      </div>

      <!-- 添加协作者 -->
      <p v-if="!roles.length" class="kb-share-note" data-testid="share-no-grant">你的角色不能添加协作者:最多授予与自己相同的角色,需要「可管理」。</p>
      <form v-else class="kb-share-add" @submit.prevent="picked ? addPerson() : lookup()">
        <div class="kb-share-add-row">
          <div class="kb-share-add-input">
            <KbInput
              v-model="query"
              placeholder="输入用户名或邮箱,或从好友中选择"
              aria-label="添加协作者:对方的完整用户名或邮箱"
              autocomplete="off"
              autocapitalize="off"
              enterkeyhint="search"
              data-testid="share-add-input"
            />
          </div>
          <KbSelect v-model="newRole" :options="roleChoices" aria-label="授予的角色" data-testid="share-add-role" />
          <KbButton v-if="picked" variant="primary" :disabled="adding" data-testid="share-add-submit" @click="addPerson">添加</KbButton>
          <KbButton v-else :disabled="!query.trim() || searching" data-testid="share-lookup" @click="lookup">查找</KbButton>
        </div>
        <div v-if="picked" class="kb-share-picked" data-testid="share-picked">
          <UserAvatar :user-id="picked.id" :name="pickedLabel" :file="picked.avatar" :size="24" />
          <span>将分享给 <b>{{ pickedLabel }}</b>(@{{ picked.username }}),角色「{{ roleLabel(newRole) }}」</span>
          <button type="button" class="kb-share-link" @click="picked = null">换一个人</button>
        </div>
        <div v-else-if="suggestions.length" class="kb-share-chips" role="list" aria-label="好友,点一下选中">
          <button v-for="friend in suggestions" :key="friend.id" type="button" class="kb-share-chip" role="listitem" :data-testid="`share-friend-${friend.username}`" @click="pick(friend, friend.remark)">
            <UserAvatar :user-id="friend.id" :name="personName(friend, friend.remark)" :file="friend.avatar" :size="20" />
            {{ personName(friend, friend.remark) }}
          </button>
        </div>
        <p v-if="addError" class="kb-share-error" role="alert" data-testid="share-add-error">{{ addError }}</p>
      </form>

      <p v-if="someFolderLike" class="kb-share-note" data-testid="share-folder-note">
        <template v-if="multi && !allFolderLike">分享文件夹 / 集合:以后在里面新建的文档对方自动可见;只分享其中的文件,以后新增的不会自动可见。</template>
        <template v-else-if="allFolderLike">分享{{ multi ? '文件夹 / 集合' : targetKindLabel(targets[0]!) }}后,以后在里面新建的文档对方自动可见。</template>
      </p>
      <p v-else-if="multi" class="kb-share-note">只分享选中的文件,以后新增的文件不会自动可见。</p>
      <p v-if="unlisted" class="kb-share-note" data-testid="share-unlisted">
        选得比较多,下面只列出前 {{ LIST_LIMIT }} 项上已有的协作者。你填的人会写到全部 {{ targets.length }} 项上,不动别的人。
      </p>

      <!-- 协作者列表 -->
      <ul class="kb-share-list" aria-label="协作者">
        <li v-if="owner && !multi" class="kb-share-row" data-testid="share-owner">
          <UserAvatar :user-id="owner.id" :name="personName(owner)" :file="owner.avatar" :size="32" />
          <div class="kb-share-who">
            <b>{{ personName(owner) }}<template v-if="owner.id === session.user?.id">(你)</template></b>
            <small>@{{ owner.username }}</small>
          </div>
          <span class="kb-share-fixed">所有者</span>
        </li>

        <template v-if="multi">
          <li v-for="row in merged" :key="row.user.id" class="kb-share-row" :data-testid="`share-row-${row.user.username}`">
            <UserAvatar :user-id="row.user.id" :name="personName(row.user)" :file="row.user.avatar" :size="32" />
            <div class="kb-share-who">
              <b>{{ personName(row.user) }}</b>
              <small>@{{ row.user.username }} · 在 {{ row.count }} / {{ listed }} 项上</small>
            </div>
            <KbSelect
              :model-value="row.role === 'mixed' ? '' : row.role"
              :options="roleChoices"
              :display="row.role === 'mixed' ? '各项不同' : undefined"
              size="sm"
              plain
              align="end"
              :aria-label="`${personName(row.user)} 的角色`"
              @update:model-value="(value) => changeRole(row.user, value as GrantRole)"
            />
            <button type="button" class="kb-icon-btn" :aria-label="`移除 ${personName(row.user)}`" :disabled="busyId === row.user.id" @click="removePerson(row.user)">✕</button>
          </li>
        </template>

        <template v-else>
          <li v-for="row in rows" :key="`${row.user.id}-${row.source}`" class="kb-share-row" :data-testid="`share-row-${row.user.username}`">
            <UserAvatar :user-id="row.user.id" :name="personName(row.user)" :file="row.user.avatar" :size="32" />
            <div class="kb-share-who">
              <b>
                {{ personName(row.user) }}
                <span v-if="row.inherited" class="kb-share-tag" data-testid="share-inherited">继承自 {{ sourceLabel(row.source) }}</span>
                <span v-else-if="joinedViaLink(row)" class="kb-share-tag">通过链接加入</span>
              </b>
              <small>@{{ row.user.username }}<template v-if="row.expires_at"> · 到期 {{ dateText(row.expires_at) }}</template></small>
            </div>
            <KbSelect
              v-if="!row.inherited && rowEditable(row.role)"
              :model-value="row.role"
              :options="roleChoices"
              size="sm"
              plain
              align="end"
              :aria-label="`${personName(row.user)} 的角色`"
              @update:model-value="(value) => changeRole(row.user, value as GrantRole)"
            />
            <span v-else class="kb-share-fixed" :title="row.inherited ? '来自上级的权限在这里不能单独降低,要到上级里改' : '角色高于你能授予的上限'">{{ roleLabel(row.role) }}</span>
            <button v-if="!row.inherited" type="button" class="kb-icon-btn" :aria-label="`移除 ${personName(row.user)}`" :disabled="busyId === row.user.id" @click="removePerson(row.user)">✕</button>
            <span v-else class="kb-share-icon-gap" aria-hidden="true"></span>
          </li>
        </template>
      </ul>

      <!-- 空 -->
      <KbEmpty
        v-if="isEmpty"
        icon="users"
        :title="multi ? '选中的这些项还没有协作者' : '还没有协作者'"
        description="在上面输入对方的用户名或邮箱,或者点一位好友,选好角色后添加。"
        size="sm"
        data-testid="share-empty"
      />
      <p v-else-if="!multi && rows.some((row) => row.inherited)" class="kb-share-hint">来自上级文件夹的权限在这里不能单独降低,要到文件夹里改。</p>

      <!-- 停止继承(只有单个文件夹 / 文档) -->
      <div v-if="showInherit && single" class="kb-share-opt" data-testid="share-inherit">
        <div class="kb-share-opt-text">
          <b>不继承上级的协作者</b>
          <small>打开后,只有在这里单独添加的人能访问;上级文件夹的协作者看不到它。</small>
        </div>
        <KbSwitch :model-value="single.inherit_broken" :disabled="inheritBusy" aria-label="不继承上级的协作者" @update:model-value="toggleInherit" />
      </div>
    </template>
  </div>
</template>

<style>
.kb-share-people { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
.kb-share-selected { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-2) var(--sp-3); border-radius: var(--r2); background: rgb(var(--ink), 0.04); min-width: 0; }
.kb-share-names { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-share-add { display: flex; flex-direction: column; gap: var(--sp-2); }
.kb-share-add-row { display: flex; gap: var(--sp-2); align-items: center; min-width: 0; }
.kb-share-add-input { flex: 1; min-width: 0; }
.kb-share-add-input .kb-input { width: 100%; }
.kb-share-picked { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--text-13); color: var(--text-secondary); flex-wrap: wrap; }
.kb-share-picked b { color: var(--text-primary); font-weight: var(--fw-medium); }
.kb-share-chips { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.kb-share-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 3px 12px 3px 4px; border: var(--hl) solid var(--border-default); border-radius: var(--r-pill); background: var(--surface-2); color: var(--text-primary); font: inherit; font-size: var(--text-13); cursor: pointer; max-width: 100%; }
.kb-share-chip:hover { background: rgb(var(--ink), 0.06); }
.kb-share-chip:focus-visible { outline: none; box-shadow: var(--accent-ring); }
.kb-share-people .kb-share-opt { padding-top: var(--sp-3); border-top: var(--hl) solid var(--border-subtle); }
@media (max-width: 599px) {
  .kb-share-add-row { flex-wrap: wrap; }
  .kb-share-add-input { flex-basis: 100%; }
}
@media (pointer: coarse) {
  .kb-share-chip { min-height: 44px; }
}
</style>
