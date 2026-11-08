<script setup lang="ts">
// 文档评论:顶层评论 + 回复(只有一层,按时间),共享给我、公开分享页和知识库页的评论栏共用。
// 通过 ShareAccess 调能力,不关心内容从哪来。能评论要「可评论」及以上(游客还要管理员在系统参数里开了游客评论,
// 页面信息里的 can.comment 已经折算好了)。
// 作者名字和头像来自 list_annotations 的 authors 映射;游客作者(`guest:昵称#编号`)不在映射里。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { KbButton, KbEmpty, KbSkeleton, useToast } from '@kb-ui/index'
import CommentComposer from '@/components/comments/CommentComposer.vue'
import CommentItem from '@/components/comments/CommentItem.vue'
import '@/components/comments/comments.css'
import { callCapability } from '@/api/client'
import type { ShareAccess } from '@/api/share'
import { buildThreads, commentCount, filterThreads, resolverName, type CommentAuthors, type CommentFilter, type CommentRecord, type CommentThread } from '@/utils/comments'
import { mergeCandidates, type MentionCandidate } from '@/utils/mentions'
import { quotePreview, type QuoteAnchor } from '@/utils/quoteAnchor'
import { isNoAccess, shareErrorText } from '@/utils/share'

const props = defineProps<{
  access: ShareAccess
  collection: string
  /** 文件用集合内相对路径;笔记用 `insight:<id>` */
  source: string
  /** 我自己的用户 id(登录用户的评论作者就是它,显示成「我」);游客没有 */
  myId?: string | null
  /** 放在知识库页的属性抽屉里:去掉上边框和内边距 */
  panel?: boolean
  /** 从通知点进来时要定位并高亮的评论 id */
  focus?: string | null
  /** 顶层评论的位置锚点(知识库页里锚定到当前选中的块 / 页);回复沿用被回复评论的锚点,不用传 */
  anchor?: () => unknown
  /** 显示「删除」:只在我自己的知识库里(分享给我的、公开链接里的文档后端不开放删除) */
  deletable?: boolean
  /** 正文里选中的一段文字(选区批注):下一条顶层评论会锚定到它;显示在输入框上方,可取消 */
  pendingQuote?: QuoteAnchor | null
  /** 选区批注的摘录现在在正文里找得到的评论 id;传了才会标"原文已改动" */
  locatedIds?: ReadonlySet<string> | null
}>()
const emit = defineEmits<{ posted: []; counted: [total: number]; clearQuote: []; locate: [id: string] }>()

const toast = useToast()
/** 后端 list_annotations 默认最多返回最近 100 条;到这个数说明可能还有更早的 */
const LIST_LIMIT = 100

const status = ref<'loading' | 'ready' | 'error' | 'denied'>('loading')
const errorText = ref('')
const items = ref<CommentRecord[]>([])
const authors = ref<CommentAuthors>({})
/** 发表成功后刷新列表失败:评论其实已经发出去了,别把整个列表换成报错页,在输入框上方提示并给重试 */
const staleText = ref('')
/** 正在写回复的那一串(顶层评论 id;一次只开一个回复框) */
const replying = ref<string | null>(null)
/** 全部 / 只看未解决;已解决的评论串默认折成一行,点开的记在这里 */
const filter = ref<CommentFilter>('all')
const expanded = ref<Set<string>>(new Set())
const resolving = ref<string | null>(null)
const resolveError = ref('')
/** 可 @ 的人:好友 + 这篇文档里出现过的评论者 / 所有者(只是方便输入,不是授权) */
const friends = ref<MentionCandidate[]>([])

let loadSeq = 0
async function load(quiet = false) {
  const seq = ++loadSeq
  if (!quiet) status.value = 'loading'
  try {
    const result = await props.access.call<{ annotations?: CommentRecord[]; authors?: CommentAuthors }>('list_annotations', { collection: props.collection, source: props.source })
    // 切换文档时旧请求晚到,不能覆盖新文档的评论
    if (seq !== loadSeq) return
    items.value = result.annotations ?? []
    authors.value = result.authors ?? {}
    staleText.value = ''
    status.value = 'ready'
    emit('counted', commentCount(allThreads.value))
  } catch (err) {
    if (seq !== loadSeq) return
    if (quiet && status.value === 'ready') {
      staleText.value = shareErrorText(err, '评论列表没有刷新成功。')
      return
    }
    // 后端对没权限的文档回 403 / 404:单独一种状态,不要说成「网络问题」让人反复重试
    if (isNoAccess(err)) {
      status.value = 'denied'
      return
    }
    errorText.value = shareErrorText(err, '评论没有加载出来。检查网络后重试。')
    status.value = 'error'
  }
}
onMounted(() => {
  void load()
  void loadFriends()
})

async function loadFriends() {
  // 游客不能 @ 人;没开通好友功能 / 请求失败就只用评论里出现过的人,不打扰评论本身
  if (props.access.guest || !props.access.can.comment) return
  try {
    const result = await callCapability<{ friends?: { id: string; username: string; display_name?: string; avatar?: string | null; remark?: string | null }[] }>('friend_list', {})
    friends.value = (result.friends ?? []).map((friend) => ({
      id: friend.id,
      username: friend.username,
      display_name: friend.display_name ?? friend.username,
      avatar: friend.avatar ?? null,
      source: 'friend' as const,
      remark: friend.remark ?? null,
    }))
  } catch {
    friends.value = []
  }
}
const candidates = computed<MentionCandidate[]>(() => {
  if (props.access.guest) return []
  const seen: MentionCandidate[] = Object.values(authors.value)
    .filter((profile) => profile.username && profile.id !== props.myId)
    .map((profile) => ({ id: profile.id, username: profile.username!, display_name: profile.display_name ?? profile.username!, avatar: profile.avatar ?? null, source: 'commenter' as const }))
  return mergeCandidates([seen, friends.value], props.myId)
})
watch(() => [props.collection, props.source], () => {
  replying.value = null
  void load()
})

const allThreads = computed<CommentThread[]>(() => buildThreads(items.value))
const threads = computed<CommentThread[]>(() => filterThreads(allThreads.value, filter.value))
const hasResolved = computed(() => allThreads.value.some((thread) => thread.resolved))
const canResolve = computed(() => props.access.can.comment && !props.access.guest)
const isOpen = (thread: CommentThread) => !thread.resolved || expanded.value.has(thread.id) || thread.id === props.focus
const total = computed(() => commentCount(allThreads.value))
const truncated = computed(() => items.value.length >= LIST_LIMIT)

async function post(body: string, mentions: string[], parentId?: string) {
  // 选中了正文里的一段文字:这条评论锚定到它;否则用调用方给的位置(页 / 块…)
  const anchor = parentId ? null : (props.pendingQuote ?? props.anchor?.() ?? null)
  await props.access.call('add_annotation', {
    collection: props.collection,
    source: props.source,
    body,
    ...(anchor ? { anchor } : {}),
    ...(parentId ? { parent_id: parentId } : {}),
    ...(mentions.length ? { mentions } : {}),
  })
  toast.push(parentId ? '回复已发出' : '评论已发出')
  if (parentId) replying.value = null
  else if (props.pendingQuote) emit('clearQuote')
  emit('posted')
  await load(true)
}
const sendTop = (body: string, mentions: string[]) => post(body, mentions)
const sendReply = (thread: CommentThread) => (body: string, mentions: string[]) => post(body, mentions, thread.root?.id ?? thread.replies[0]?.parent_id ?? undefined)

const deleting = ref<string | null>(null)
async function remove(comment: CommentRecord) {
  if (deleting.value) return
  deleting.value = comment.id
  resolveError.value = ''
  try {
    await props.access.call('delete_annotation', { id: comment.id })
    // 正文里的批注高亮跟着评论列表走：删掉的评论不能还留着高亮
    emit('posted')
    await load(true)
  } catch (err) {
    resolveError.value = shareErrorText(err, '没有删掉,请稍后再试。')
  } finally {
    deleting.value = null
  }
}

async function toggleResolved(thread: CommentThread) {
  const root = thread.root
  if (!root || resolving.value) return
  resolving.value = thread.id
  resolveError.value = ''
  try {
    await props.access.call('resolve_annotation', { collection: props.collection, source: props.source, id: root.id, resolved: !thread.resolved })
    // 已解决的批注在正文里淡化成虚线：让上层重新取评论列表，高亮才跟着变
    emit('posted')
    await load(true)
    // 刚标成已解决的串折起来;重新打开的串本来就是展开的
    expanded.value.delete(thread.id)
  } catch (err) {
    resolveError.value = shareErrorText(err, '没有改成功,请稍后再试。')
  } finally {
    resolving.value = null
  }
}
function toggleExpanded(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

// 从通知点进来:滚到那条评论并高亮
watch(
  () => [props.focus, status.value, items.value.length] as const,
  async ([target, state]) => {
    if (!target || state !== 'ready') return
    await nextTick()
    // 不用 CSS.escape(旧浏览器 / 测试环境没有):按属性值逐个比
    ;[...document.querySelectorAll<HTMLElement>('[data-comment-id]')].find((el) => el.dataset.commentId === target)?.scrollIntoView?.({ block: 'center' })
  },
  { immediate: true },
)

const avatars = computed(() => !props.access.guest)
/** 选区批注的摘录还在不在正文里:没传 locatedIds(分享页等没有正文的地方)就不下结论 */
function locatedOf(comment: CommentRecord): boolean | undefined {
  if (comment.anchor?.kind !== 'quote' || !props.locatedIds) return undefined
  return props.locatedIds.has(comment.id)
}
</script>

<template>
  <section class="kb-cmt" :class="{ 'is-panel': panel }" aria-label="评论" data-testid="doc-comments">
    <h3 v-if="!panel" class="kb-cmt-title">评论<span v-if="status === 'ready' && total" class="kb-cmt-count">{{ total }}</span></h3>

    <KbSkeleton v-if="status === 'loading'" variant="list" :lines="2" />
    <KbEmpty v-else-if="status === 'denied'" icon="lock" title="没有权限查看评论" description="你对这篇文档的权限可能刚刚变了。请联系所有者或可管理的人。" size="sm" data-testid="comments-denied" />
    <KbEmpty v-else-if="status === 'error'" icon="failed" title="评论没有加载出来" :description="errorText" size="sm" data-testid="comments-error">
      <template #action><KbButton size="sm" @click="load()">重试</KbButton></template>
    </KbEmpty>
    <template v-else>
      <div v-if="hasResolved" class="kb-cmt-filter" role="group" aria-label="筛选评论" data-testid="comment-filter">
        <KbButton size="sm" :variant="filter === 'all' ? 'primary' : 'default'" :aria-pressed="filter === 'all'" data-testid="filter-all" @click="filter = 'all'">全部</KbButton>
        <KbButton size="sm" :variant="filter === 'open' ? 'primary' : 'default'" :aria-pressed="filter === 'open'" data-testid="filter-open" @click="filter = 'open'">未解决</KbButton>
      </div>
      <ul v-if="threads.length" class="kb-cmt-list" data-testid="comment-threads">
        <li v-for="thread in threads" :key="thread.id" class="kb-cmt-thread" :class="{ 'is-resolved': thread.resolved, 'is-target': thread.id === focus || thread.replies.some((reply) => reply.id === focus) }" data-testid="comment-thread" :data-resolved="thread.resolved">
          <template v-if="!isOpen(thread)">
            <div class="kb-cmt-resolved" data-testid="thread-collapsed">
              <span>已解决<template v-if="resolverName(thread.root?.resolved_by, authors, myId)"> · {{ resolverName(thread.root?.resolved_by, authors, myId) }}</template> · {{ thread.replies.length + 1 }} 条</span>
              <button type="button" class="kb-cmt-act" data-testid="thread-expand" @click="toggleExpanded(thread.id)">展开</button>
            </div>
          </template>
          <template v-else>
          <CommentItem v-if="thread.root" :comment="thread.root" :authors="authors" :my-id="myId" :avatars="avatars" :located="locatedOf(thread.root)" @locate="emit('locate', $event)">
            <button v-if="deletable" type="button" class="kb-cmt-act" :disabled="deleting === thread.root.id" data-testid="comment-delete" @click="remove(thread.root)">删除</button>
          </CommentItem>
          <p v-else class="kb-cmt-orphan" data-testid="comment-orphan">这些回复所属的评论比较早,没有显示在这里。</p>
          <ul v-if="thread.replies.length" class="kb-cmt-replies" data-testid="comment-replies">
            <li v-for="reply in thread.replies" :key="reply.id">
              <CommentItem :comment="reply" :authors="authors" :my-id="myId" :avatars="avatars" reply>
                <button v-if="deletable" type="button" class="kb-cmt-act" :disabled="deleting === reply.id" data-testid="comment-delete" @click="remove(reply)">删除</button>
              </CommentItem>
            </li>
          </ul>
          <template v-if="access.can.comment">
            <CommentComposer
              v-if="replying === thread.id"
              :send="sendReply(thread)"
              :candidates="candidates"
              name="reply"
              label="回复评论"
              submit-text="发送回复"
              autofocus
              cancelable
              @cancel="replying = null"
            />
            <div v-else class="kb-cmt-tools">
              <button type="button" class="kb-cmt-act" data-testid="reply-open" aria-label="回复这串评论" @click="replying = thread.id">回复</button>
              <button v-if="canResolve && thread.root" type="button" class="kb-cmt-act" :disabled="resolving === thread.id" :data-testid="thread.resolved ? 'thread-reopen' : 'thread-resolve'" @click="toggleResolved(thread)">{{ thread.resolved ? '重新打开' : '标记已解决' }}</button>
              <button v-if="thread.resolved" type="button" class="kb-cmt-act" data-testid="thread-collapse" @click="toggleExpanded(thread.id)">收起</button>
            </div>
          </template>
          </template>
        </li>
      </ul>
      <p v-else class="kb-cmt-empty" data-testid="comments-empty">{{ access.can.comment ? '还没有评论。写下第一条吧。' : '还没有评论。' }}</p>
      <p v-if="truncated" class="kb-cmt-hint" data-testid="comments-truncated">评论很多,这里只显示最近的 {{ LIST_LIMIT }} 条。</p>

      <p v-if="staleText" class="kb-cmt-error" role="alert" data-testid="comments-stale">
        评论已发出,但列表没有刷新:{{ staleText }}
        <button type="button" class="kb-cmt-act" @click="load(true)">重新加载</button>
      </p>
      <p v-if="resolveError" class="kb-cmt-error" role="alert" data-testid="resolve-error">{{ resolveError }}</p>
      <div v-if="pendingQuote && access.can.comment" class="kb-cmt-pending" data-testid="pending-quote">
        <div class="kb-cmt-pending-body">
          <span class="kb-cmt-pending-label">评论这段话</span>
          <span class="kb-cmt-pending-text">{{ quotePreview(pendingQuote.text, 120) }}</span>
        </div>
        <button type="button" class="kb-cmt-act" aria-label="取消,不针对这段话" data-testid="pending-quote-clear" @click="emit('clearQuote')">取消</button>
      </div>
      <CommentComposer v-if="access.can.comment" :send="sendTop" :candidates="candidates" name="comment" label="写评论" submit-text="发表评论" />
      <p v-else class="kb-cmt-hint">你现在的权限不能评论。</p>
    </template>
  </section>
</template>
