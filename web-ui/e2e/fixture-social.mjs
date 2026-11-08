// 好友与通知的**有状态**假后端,给 Playwright 场景用。
//
// 形状照后端的真实响应写(crates/kb-cli/src/social_backend.rs、tests/e2e_social.rs),行为也照搬后端刻意设计的几处:
//   - 找不到 / 对方不允许被搜到 / 对方拉黑了我:friend_search 的结果完全一样({user:null});
//   - 对方拉黑了我时,friend_request 表面成功({status:'requested'}),但什么都不会发生;
//   - 对方先向我申请过,我再申请 = 直接成为好友;
//   - 每分钟最多搜 10 次,超出返回 503「搜索太频繁了,请一分钟后再试」。
// 用法:installFixture(context, { __social: { …种子… } });测试里读 /api/v1/__fixture/social 看后端收到了哪些写操作。
// 为什么单独一个文件:fixture.mjs 是共享文件,只做追加式的小改动(import + 几行钩子)。

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 后端 kind::ALL 的顺序和 kind::email_by_default 的默认值 */
const KINDS = ['friend_request', 'friend_result', 'share_received', 'access_request', 'access_result', 'comment_reply', 'mention', 'collaborator_removed', 'link_expiring', 'announcement']
const DEFAULT_EMAIL_PREFS = Object.fromEntries(KINDS.map((kind) => [kind, ['friend_request', 'share_received', 'access_request', 'access_result', 'mention'].includes(kind)]))

/** 一个人的公开资料(后端 PublicProfile)。 */
export const profile = (username, displayName, avatar = null) => ({ id: `usr_${username}`, username, display_name: displayName, avatar })

/**
 * 造一份假后端。`seed` 全部可选:
 *   me            当前用户 id(默认 usr_admin)
 *   friends       [{ ...profile, remark, group_name, since }]
 *   incoming      收到的申请:{ id, from: profile, message, created_at, expires_at, stale?: true }
 *                 stale = 这条申请其实已经在别处被处理过,处理它会得到 404「没有这条好友申请」
 *   outgoing      发出的申请:{ id, to: profile, message, created_at, expires_at }
 *   failRequests  friend_requests 返回 500(验证申请页的「报错 + 重试」)
 *   blocked       我拉黑的人:{ user: profile, since }
 *   privacy       隐私设置(默认:邮箱搜不到、用户名搜得到、谁都能分享给我)
 *   failBlocks / failPrivacy / failPrivacySave  对应能力返回 500
 *   prefs         通知邮件开关(默认值同后端 kind::email_by_default);mailAvailable 站点有没有配好发信(默认配好了)
 *   failPrefs / failPrefsSave  notification_prefs 读取 / 保存返回 500
 *   directory     能被搜到的人:{ profile, email?, searchable?: true, blockedMe?: false, rejectedRecently?: false }
 *   failList      friend_list 返回 500(验证「报错 + 重试」)
 *   forbidden     所有好友能力返回 403(验证「没有开通」)
 *   delayMs       friend_list 延迟这么久才返回(验证「加载中」)
 */
export function createSocial(seed = {}, now = Date.now()) {
  const state = {
    me: seed.me ?? 'usr_admin',
    friends: structuredClone(seed.friends ?? []),
    directory: structuredClone(seed.directory ?? []),
    incoming: structuredClone(seed.incoming ?? []),
    outgoing: structuredClone(seed.outgoing ?? []),
    failRequests: seed.failRequests === true,
    blocked: structuredClone(seed.blocked ?? []),
    privacy: { searchable_by_email: false, searchable_by_username: true, share_from: 'everyone', ...(seed.privacy ?? {}) },
    failBlocks: seed.failBlocks === true,
    failPrivacy: seed.failPrivacy === true,
    failPrivacySave: seed.failPrivacySave === true,
    prefs: { ...DEFAULT_EMAIL_PREFS, ...(seed.prefs ?? {}) },
    mailAvailable: seed.mailAvailable !== false,
    failPrefs: seed.failPrefs === true,
    failPrefsSave: seed.failPrefsSave === true,
    searches: 0,
    failList: seed.failList === true,
    forbidden: seed.forbidden === true,
    delayMs: seed.delayMs ?? 0,
  }
  /** 后端收到的写操作,按顺序;场景用它断言「真的发给服务端了」。 */
  const log = []
  let counter = 0
  const fail = (status, code, message) => ({ error: { status, code, message } })
  const find = (id) => state.directory.find((entry) => entry.profile.id === id)
  const addFriend = (who) => state.friends.push({ ...who, remark: null, group_name: null, since: now })
  const isFriend = (id) => state.friends.some((item) => item.id === id)
  const iBlocked = (id) => state.blocked.some((item) => item.user.id === id)

  const handlers = {
    friend_list: () => ({ data: { friends: state.friends } }),

    friend_search: ({ query }) => {
      state.searches += 1
      if (state.searches > 10) return fail(503, 'unavailable', 'unavailable: 搜索太频繁了,请一分钟后再试')
      const needle = String(query ?? '').trim().toLowerCase()
      const hit = state.directory.find((entry) =>
        needle.includes('@') ? entry.email?.toLowerCase() === needle : entry.profile.username.toLowerCase() === needle,
      )
      const friend = hit && isFriend(hit.profile.id)
      // 与后端一致:搜不到、不允许被搜到、拉黑了我 —— 一律 {user:null}(好友之间不受搜索隐私限制)
      if (!hit || hit.blockedMe || iBlocked(hit.profile.id) || (hit.searchable === false && !friend)) return { data: { user: null, relation: 'none' } }
      const relation = friend
        ? 'friend'
        : state.outgoing.some((item) => item.to.id === hit.profile.id)
          ? 'pending_out'
          : state.incoming.some((item) => item.from.id === hit.profile.id)
            ? 'pending_in'
            : 'none'
      return { data: { user: hit.profile, relation } }
    },

    friend_request: ({ user_id, message }) => {
      log.push({ name: 'friend_request', args: { user_id, ...(message ? { message } : {}) } })
      const target = find(user_id) ?? (state.incoming.find((item) => item.from.id === user_id) && { profile: state.incoming.find((item) => item.from.id === user_id).from })
      if (!target) return fail(404, 'not_found', 'not found: 没有找到这个用户')
      if (iBlocked(user_id)) return fail(400, 'invalid_input', 'invalid input: 你已经拉黑了这个用户,先取消拉黑再申请')
      if (target.rejectedRecently) return fail(403, 'forbidden', 'forbidden: 你刚刚向这位用户申请过,请 24 小时后再试')
      // 对方拉黑了我:表面成功,什么都不发生
      if (target.blockedMe) return { data: { status: 'requested' } }
      if (isFriend(user_id)) return { data: { status: 'already_friends' } }
      if (state.outgoing.some((item) => item.to.id === user_id)) return { data: { status: 'already_pending' } }
      // 对方先向我申请过:我再申请 = 直接成为好友
      const theirs = state.incoming.find((item) => item.from.id === user_id)
      if (theirs) {
        state.incoming = state.incoming.filter((item) => item !== theirs)
        addFriend(theirs.from)
        return { data: { status: 'friends' } }
      }
      state.outgoing.push({ id: `frq_${++counter}`, to: target.profile, message: message ?? null, created_at: now, expires_at: now + 7 * DAY })
      return { data: { status: 'requested' } }
    },

    friend_requests: () => (state.failRequests ? fail(500, 'internal', 'internal: sqlite busy') : { data: { incoming: state.incoming.map(({ stale, ...row }) => row), outgoing: state.outgoing } }),

    friend_decide: ({ id, decision }) => {
      log.push({ name: 'friend_decide', args: { id, decision } })
      const request = state.incoming.find((item) => item.id === id)
      if (!request || request.stale) {
        // 已经在别处处理过 / 过期:后端当作没有这条申请
        state.incoming = state.incoming.filter((item) => item.id !== id)
        return fail(404, 'not_found', 'not found: 没有这条好友申请')
      }
      state.incoming = state.incoming.filter((item) => item !== request)
      if (decision === 'accept') addFriend(request.from)
      return { data: { state: { accept: 'accepted', reject: 'rejected', ignore: 'ignored' }[decision] } }
    },

    block: ({ user_id }) => {
      log.push({ name: 'block', args: { user_id } })
      const known = state.friends.find((item) => item.id === user_id) ?? state.incoming.find((item) => item.from.id === user_id)?.from ?? find(user_id)?.profile
      if (!known) return fail(404, 'not_found', 'not found: 没有找到这个用户')
      const { id, username, display_name, avatar } = known
      state.friends = state.friends.filter((item) => item.id !== user_id)
      state.incoming = state.incoming.filter((item) => item.from.id !== user_id)
      state.outgoing = state.outgoing.filter((item) => item.to.id !== user_id)
      if (!iBlocked(user_id)) state.blocked.unshift({ user: { id, username, display_name, avatar: avatar ?? null }, since: now })
      return { data: { blocked: true } }
    },

    unblock: ({ user_id }) => {
      log.push({ name: 'unblock', args: { user_id } })
      const before = state.blocked.length
      state.blocked = state.blocked.filter((item) => item.user.id !== user_id)
      return { data: { unblocked: state.blocked.length < before } }
    },

    block_list: () => (state.failBlocks ? fail(500, 'internal', 'internal: sqlite busy') : { data: { blocked: state.blocked } }),

    privacy_get: () => (state.failPrivacy ? fail(500, 'internal', 'internal: sqlite busy') : { data: { privacy: state.privacy } }),

    set_privacy: (patch) => {
      log.push({ name: 'set_privacy', args: patch })
      if (state.failPrivacySave) return fail(500, 'internal', 'internal: sqlite busy')
      if (patch.share_from !== undefined && !['everyone', 'friends'].includes(patch.share_from)) return fail(400, 'invalid_input', 'invalid input: share_from 只能是 everyone / friends')
      state.privacy = { ...state.privacy, ...patch }
      return { data: { privacy: state.privacy } }
    },

    notification_prefs: ({ email }) => {
      if (email) {
        log.push({ name: 'notification_prefs', args: { email } })
        if (state.failPrefsSave) return fail(500, 'internal', 'internal: sqlite busy')
        const bad = Object.keys(email).find((kind) => !KINDS.includes(kind))
        if (bad) return fail(400, 'invalid_input', `invalid input: 未知的通知种类 ${bad}`)
        state.prefs = { ...state.prefs, ...email }
      } else if (state.failPrefs) {
        return fail(500, 'internal', 'internal: sqlite busy')
      }
      return { data: { email: state.prefs, kinds: KINDS, mail_available: state.mailAvailable } }
    },

    friend_update: ({ friend_id, remark, group_name }) => {
      log.push({ name: 'friend_update', args: { friend_id, remark, group_name } })
      const friend = state.friends.find((item) => item.id === friend_id)
      if (!friend) return fail(404, 'not_found', 'not found: 他不是你的好友')
      if (remark !== undefined) friend.remark = remark
      if (group_name !== undefined) friend.group_name = group_name
      return { data: { updated: true } }
    },

    friend_remove: ({ user_id }) => {
      log.push({ name: 'friend_remove', args: { user_id } })
      const before = state.friends.length
      state.friends = state.friends.filter((item) => item.id !== user_id)
      return { data: { removed: state.friends.length < before } }
    },
  }

  return {
    state,
    log,
    /** 返回 undefined 表示这个能力不归社交假后端管(交回 fixture 的默认处理)。 */
    handle(name, args) {
      const handler = handlers[name]
      if (!handler) return undefined
      if (state.forbidden) return fail(403, 'forbidden', 'forbidden: 你的账号没有开通这个功能')
      if (name === 'friend_list' && state.failList) return fail(500, 'internal', 'internal: sqlite busy')
      return handler(args ?? {})
    },
    delay: () => state.delayMs,
  }
}
