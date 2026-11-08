<script setup lang="ts">
import { localeDateTime } from '@/utils/time'
// 一条评论(顶层或回复):头像、名字、时间、正文。作者的名字和头像来自 list_annotations 的 authors 映射
// (评论者没有权限单独查别人的资料),游客作者不在映射里,画「访客 昵称」和首字母。
// 正文只当纯文本渲染(v-for 片段,不用 v-html):评论是别人写的,不能被当成 HTML。
import { computed } from 'vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { authorView, type CommentAuthors, type CommentRecord } from '@/utils/comments'
import { anchorText } from '@/utils/files'
import { bodySegments } from '@/utils/mentions'
import { quotePreview } from '@/utils/quoteAnchor'
import { relativeTime } from '@/utils/share'

const props = defineProps<{
  comment: CommentRecord
  authors?: CommentAuthors
  myId?: string | null
  /** 能不能加载头像图片:匿名访客没有登录,头像接口会回 401,这时只画首字母 */
  avatars?: boolean
  reply?: boolean
  /** 选区批注的摘录现在还找不找得到:true 找到,false 原文改动后找不到,不传 = 不知道(分享页等没有正文的地方) */
  located?: boolean
}>()
const emit = defineEmits<{ locate: [id: string] }>()

/** 选区批注的摘录;其它锚点(页 / 单元格 / 时间…)仍是一个位置标签 */
const quote = computed(() => {
  const anchor = props.comment.anchor
  return anchor?.kind === 'quote' && typeof anchor.text === 'string' ? quotePreview(anchor.text, 80) : ''
})
const anchorLabel = computed(() => (props.comment.anchor && !quote.value ? anchorText(props.comment.anchor) || '锚定' : ''))
// 正文里的 @用户名 单独高亮;只看写法,不看这个人存不存在、有没有被通知(否则高亮与否会暴露谁有账号)
const segments = computed(() => bodySegments(props.comment.body))
const view = computed(() => authorView(props.comment.author, props.authors, props.myId))
// 时间戳异常(缺字段、非数字)时不能让整条评论渲染崩掉:退化成不带 datetime / title 的纯文字
const when = computed(() => (Number.isFinite(props.comment.created_at) ? new Date(props.comment.created_at) : null))
const fullTime = computed(() => (when.value ? localeDateTime(props.comment.created_at, { hour12: false }) : ''))
</script>

<template>
  <div class="kb-cmt-item" :class="{ 'is-reply': reply }" :data-comment-id="comment.id" data-testid="comment">
    <UserAvatar :user-id="view.userId ?? view.name" :name="view.name" :file="avatars === false ? null : view.avatar" :guest="view.kind === 'guest'" :size="reply ? 24 : 28" />
    <div class="kb-cmt-main">
      <div class="kb-cmt-head">
        <b class="kb-cmt-name" data-testid="comment-author">{{ view.name }}</b>
        <span v-if="anchorLabel" class="kb-cmt-anchor" data-testid="comment-anchor">{{ anchorLabel }}</span>
        <time class="kb-cmt-time" :datetime="when?.toISOString()" :title="fullTime">{{ relativeTime(comment.created_at) }}</time>
      </div>
      <component
        :is="located === false || reply ? 'div' : 'button'"
        v-if="quote && !reply"
        class="kb-cmt-quote"
        :class="{ 'is-lost': located === false }"
        :type="located === false ? undefined : 'button'"
        :title="located === false ? '正文里这段话被改动了,找不到原来的位置' : '定位到正文里的这段话'"
        data-testid="comment-quote"
        @click="located !== false && emit('locate', comment.id)"
      >
        <span class="kb-cmt-quote-text">{{ quote }}</span>
        <span v-if="located === false" class="kb-cmt-quote-lost" data-testid="comment-quote-lost">原文已改动</span>
      </component>
      <p class="kb-cmt-body"><template v-for="(segment, at) in segments" :key="at"><span v-if="segment.mention" class="kb-cmt-mention" data-testid="comment-mention">{{ segment.text }}</span><template v-else>{{ segment.text }}</template></template></p>
      <slot />
    </div>
  </div>
</template>
