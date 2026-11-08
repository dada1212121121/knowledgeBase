// 分享与协作的带状态假后端:在通用 fixture 之上再叠一层,让场景里「点一下 → 数据真的变 → 重读看到新状态」。
//
// 用法(场景里):
//   import { shareFixture } from './share-fixture.mjs'
//   fixture: shareFixture({ grants: [...], links: [...] })      // 返回 installFixture 的 overrides,里面带 __after 钩子
// 每个浏览器上下文调用一次 __after,各自一份状态,设备 × 引擎之间不串。
//
// 形状对照后端:kb-cli/src/{share,link}_backend.rs、kb-web/src/share_public.rs,以及 tests/e2e_{share,links}.rs 的断言。
// 页面里的 fetch 都会被这里拦下;写操作记进 log,场景用 `shareLog(tab)` 读出来断言「发出去的请求对不对」。
import { NOW, gradientPng } from './fixture.mjs'

const DAY = 86_400_000

export const person = (id, name = id, extra = {}) => ({ id: `usr_${id}`, username: id, display_name: name, avatar: null, ...extra })
export const PEOPLE = {
  admin: person('admin', '管理员'),
  zhangsan: person('zhangsan', '张三'),
  lisi: person('lisi', '李四'),
  wangwu: person('wangwu', '王五'),
  bob: person('bob', 'Bob'),
  carol: person('carol', 'Carol'),
}
export const FRIENDS = [PEOPLE.zhangsan, PEOPLE.lisi, PEOPLE.wangwu].map((profile, index) => ({
  ...profile,
  remark: profile.username === 'lisi' ? '老李' : null,
  group_name: null,
  since: NOW - (index + 1) * DAY,
}))

/** 与前端 utils/share.ts 的 targetKey 同一个规则(场景里不引用 TS 源码)。 */
export const keyOf = (target) => [target.kind, target.space_id ?? '', target.collection ?? '', target.path ?? target.id ?? ''].join('|')

const ROLES = ['viewer', 'commenter', 'editor', 'manager', 'owner']

/** 一条链接的完整字段(LinkInfo);测试可以只改要关心的几个。 */
export function makeLink(id, target, extra = {}) {
  return {
    id,
    hint: 'Zp9a',
    title: '',
    bundle: false,
    roots: [target],
    audience: 'logged_in',
    role: 'viewer',
    has_password: false,
    expires_at: null,
    allow_download: true,
    watermark: false,
    allow_reshare: false,
    enabled: true,
    state: 'active',
    views: 0,
    last_view_at: null,
    created_at: NOW - 3 * DAY,
    guest_role: null,
    ...extra,
  }
}

const tokenOf = (seed) => `${seed}AbCdEfGhIjKlMnOpQrSt`.slice(0, 22)

/**
 * @param {object} initial
 *   myRole       我对被分享资源的角色(默认 owner);'editor' 可以用来演示「不能添加协作者」
 *   grants       直接授权 [{ target, user, role, via? }]
 *   inherited    继承来的 [{ user, role, source }](对所有资源都显示)
 *   inheritBroken 已停止继承的资源键数组
 *   links        已有链接 [{ target, link }]
 *   friends      好友(默认 FRIENDS)
 *   directory    能被「完整用户名 / 邮箱」搜到的人(默认 bob、carol)
 *   fail         { 能力名: { status, message, times? } } 让某个能力失败(times 缺省 = 一直失败)
 *   delayMs      每个分享能力的响应延迟(演示加载态)
 *   sharedWithMe / sharedByMe / accessRequests ...
 */
/** 假用户(fixture.mjs 的 adminMe)自己的空间编号 */
const OWN_SPACE = 'sp_primary'

export function shareFixture(initial = {}, base = {}) {
  return { ...base, __after: (context) => installShareApi(context, initial) }
}

export async function installShareApi(context, initial = {}) {
  const state = {
    myRole: initial.myRole ?? 'owner',
    grants: structuredClone(initial.grants ?? []),
    inherited: structuredClone(initial.inherited ?? []),
    inheritBroken: new Set(initial.inheritBroken ?? []),
    links: structuredClone(initial.links ?? []),
    friends: structuredClone(initial.friends ?? FRIENDS),
    directory: structuredClone(initial.directory ?? [PEOPLE.bob, PEOPLE.carol]),
    sharedWithMe: structuredClone(initial.sharedWithMe ?? []),
    sharedByMe: structuredClone(initial.sharedByMe ?? []),
    access: structuredClone(initial.accessRequests ?? { to_decide: [], mine: [] }),
    roleOf: structuredClone(initial.roleOf ?? {}),
    // 别人的知识库(带 X-KB-Space 的读写走这里):{ sp_alice: { notes: {id: {...}}, files: {path: {...}}, rows: [...], comments: {source: [...]} } };我的角色按 sharedWithMe 的授权算
    spaces: structuredClone(initial.spaces ?? {}),
    fail: structuredClone(initial.fail ?? {}),
    delayMs: initial.delayMs ?? 0,
    log: [],
    grantsOverride: null,
    counter: 1,
  }
  const me = PEOPLE.admin

  const reply = (route, data, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status < 300 ? { ok: true, data, meta: { took_ms: 1, dry_run: false, batch_id: null, degraded: null, warnings: [] } } : { ok: false, error: data }),
    })
  const error = (route, status, message, code = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_input') =>
    reply(route, { code, message }, status)

  const grantsFor = (target) => state.grants.filter((grant) => keyOf(grant.target) === keyOf(target))
  const nextId = (prefix) => `${prefix}_${state.counter++}`
  const findLink = (id) => state.links.find((entry) => entry.link.id === id)

  /** 管理协作者 / 链接需要「可管理」:不够时和后端一样回 403,并写明角色(kb-core Role::label 的中文) */
  const needManager = () => {
    if (ROLES.indexOf(state.myRole) < ROLES.indexOf('manager')) {
      const label = { viewer: '可查看', commenter: '可评论', editor: '可编辑' }[state.myRole] ?? '可查看'
      throw { status: 403, message: `forbidden: 你对这个内容的权限是「${label}」,需要「可管理」` }
    }
  }

  /** 能力名 → 处理函数(args) → 返回数据,或抛 { status, message } */
  const handlers = {
    grant_list: ({ target }) => (needManager(), {
      target,
      key: `fixture:${keyOf(target)}`,
      my_role: state.myRole,
      owner: me,
      inherit_broken: state.inheritBroken.has(keyOf(target)),
      grants: [
        ...grantsFor(target).map((grant) => ({ user: grant.user, role: grant.role, inherited: false, source: 'insight', via: grant.via ?? 'direct', expires_at: null })),
        ...state.inherited.map((row) => ({ user: row.user, role: row.role, inherited: true, source: row.source, via: 'direct', expires_at: null })),
      ],
    }),
    grant_set: ({ target, user_id, role }) => {
      const user = [...state.friends, ...state.directory].find((entry) => entry.id === user_id)
      if (!user) throw { status: 404, message: 'not found: 没有找到这个用户' }
      if (ROLES.indexOf(role) > Math.min(ROLES.indexOf(state.myRole), ROLES.indexOf('manager'))) throw { status: 403, message: `forbidden: 你最多只能授予「${{ viewer: '可查看', commenter: '可评论', editor: '可编辑', manager: '可管理' }[state.myRole] ?? '可查看'}」` }
      const existing = grantsFor(target).find((grant) => grant.user.id === user_id)
      const previous = existing?.role ?? null
      if (existing) existing.role = role
      else state.grants.push({ target, user, role })
      return { grant: { role }, previous }
    },
    grant_remove: ({ target, user_id }) => {
      const existing = grantsFor(target).find((grant) => grant.user.id === user_id)
      state.grants = state.grants.filter((grant) => grant !== existing)
      return { removed: existing?.role ?? null }
    },
    grant_batch: ({ targets, people }) => {
      let changed = 0
      let removed = 0
      for (const target of targets) {
        for (const person of people) {
          const existing = grantsFor(target).find((grant) => grant.user.id === person.user_id)
          if (!person.role) {
            if (existing) {
              state.grants = state.grants.filter((grant) => grant !== existing)
              removed += 1
            }
            continue
          }
          const user = [...state.friends, ...state.directory].find((entry) => entry.id === person.user_id)
          if (!user) throw { status: 404, message: 'not found: 没有找到这个用户' }
          if (existing) existing.role = person.role
          else state.grants.push({ target, user, role: person.role })
          changed += 1
        }
      }
      return { changed, unchanged: 0, removed }
    },
    set_inherit: ({ target, inherit }) => {
      if (inherit) state.inheritBroken.delete(keyOf(target))
      else state.inheritBroken.add(keyOf(target))
      return { inherit }
    },
    effective_role: ({ target }) => {
      const role = state.roleOf[keyOf(target)] ?? state.myRole
      if (!role) return { role: null, can: null }
      const rank = ROLES.indexOf(role)
      const at = (min) => rank >= ROLES.indexOf(min)
      return {
        role,
        label: role,
        can: { view: true, download: true, comment: at('commenter'), edit: at('editor'), create: at('editor'), history: at('editor'), restore: at('manager'), manage_grants: at('manager'), manage_links: at('manager'), delete: at('manager'), transfer_owner: at('owner') },
      }
    },
    friend_list: () => ({ friends: state.friends }),
    friend_search: ({ query }) => {
      const text = String(query).trim().toLowerCase()
      const found = [...state.friends, ...state.directory].find((entry) => entry.username.toLowerCase() === text || entry.email === text)
      return found ? { user: found, relation: state.friends.some((friend) => friend.id === found.id) ? 'friend' : 'none' } : { user: null, relation: 'none' }
    },

    link_get: ({ target }) => (needManager(), { target, links: state.links.filter((entry) => entry.link.roots.some((root) => keyOf(root) === keyOf(target)) && !entry.link.bundle).map((entry) => entry.link) }),
    link_create: (args) => {
      const roots = args.targets ?? [args.target]
      const link = makeLink(nextId('lnk'), roots[0], {
        bundle: !!args.targets,
        roots,
        title: args.title ?? '',
        audience: args.audience,
        role: args.role,
        has_password: !!args.password,
        expires_at: args.expires_days ? NOW + args.expires_days * DAY : null,
        allow_download: args.allow_download ?? true,
        watermark: args.watermark ?? false,
        hint: 'Zp9a',
        created_at: NOW,
      })
      const token = tokenOf(`tok${state.counter}`)
      state.links.push({ link, token })
      return { link, url: `https://kbase.example.com/s/${token}` }
    },
    link_update: (args) => {
      const entry = findLink(args.id)
      if (!entry || entry.link.state === 'revoked') throw { status: 404, message: 'not found: 没有这个链接' }
      const link = entry.link
      for (const key of ['audience', 'role', 'allow_download', 'watermark', 'enabled', 'title']) if (args[key] !== undefined) link[key] = args[key]
      if (args.password) link.has_password = true
      if (args.clear_password) link.has_password = false
      if (args.expires_days) link.expires_at = NOW + args.expires_days * DAY
      if (args.clear_expiry) link.expires_at = null
      link.state = link.expires_at && link.expires_at <= NOW ? 'expired' : link.enabled ? 'active' : 'closed'
      return { link }
    },
    link_reset: ({ id }) => {
      const entry = findLink(id)
      if (!entry) throw { status: 404, message: 'not found: 没有这个链接' }
      entry.token = tokenOf(`new${state.counter++}`)
      return { link: entry.link, url: `https://kbase.example.com/s/${entry.token}` }
    },
    link_revoke: ({ id }) => {
      const entry = findLink(id)
      if (!entry) throw { status: 404, message: 'not found: 没有这个链接' }
      entry.link.state = 'revoked'
      return { revoked: true }
    },
    link_stats: ({ id }) => {
      const entry = findLink(id)
      return {
        views: entry?.link.views ?? 0,
        last_view_at: entry?.link.last_view_at ?? null,
        visitors: entry?.visitors ?? [{ user: PEOPLE.bob, first_at: NOW - DAY, last_at: NOW - 2 * 60_000, visits: 2 }],
        anonymous_note: '匿名访客只统计次数',
      }
    },
    my_links: () => ({ links: state.links.map((entry) => entry.link).filter((link) => link.state !== 'revoked') }),

    shared_with_me: ({ include_hidden } = {}) => ({ items: state.sharedWithMe.filter((item) => include_hidden || !item.hidden) }),
    hide_share: ({ target, hidden }) => {
      const item = state.sharedWithMe.find((entry) => keyOf(entry.target) === keyOf(target))
      if (item) item.hidden = hidden
      return { hidden }
    },
    shared_by_me: () => ({ items: state.sharedByMe }),
    access_requests: () => state.access,
    access_request: ({ target, role, message }) => {
      state.access.mine.push({ id: nextId('req'), key: keyOf(target), target, title: '', requester: me, role, message: message ?? null, state: 'pending', created_at: NOW, decided_at: null })
      return { status: 'requested', id: `req_${state.counter}` }
    },
    access_decide: ({ id, approve, role }) => {
      const request = state.access.to_decide.find((entry) => entry.id === id)
      if (!request) throw { status: 404, message: 'not found: 没有这条待处理的申请' }
      state.access.to_decide = state.access.to_decide.filter((entry) => entry !== request)
      return { state: approve ? 'approved' : 'rejected', role: role ?? request.role }
    },
  }
  state.handlers = handlers

  /**
   * 带 X-KB-Space 的内容读写:走「对方的知识库」。规则照后端(kb-cli shared_gate.rs):
   * 按「共享给我」的授权算出我对这份内容的角色——没授权 404(和不存在一样)、角色不够 403、
   * 笔记保存要带对的 version(否则 409);文件夹授权的列表要带 path_prefix,只有单个文件的授权列不了目录(404)。
   */
  const space = (sid) => {
    const found = state.spaces[sid]
    if (!found) throw { status: 404, message: 'not found: 没有找到这个内容' }
    return found
  }
  const roleFor = (sid, { id, path, collection }) => {
    let best = -1
    for (const item of (state.grantsOverride ?? state.sharedWithMe).filter((entry) => entry.target.space_id === sid)) {
      const t = item.target
      const covers =
        (t.kind === 'insight' && id && t.id === id) ||
        (t.kind === 'file' && path && t.path === path) ||
        (t.kind === 'dir' && path && (path === t.path || path.startsWith(`${t.path}/`))) ||
        (t.kind === 'collection' && collection && t.collection === collection)
      if (covers) best = Math.max(best, ROLES.indexOf(item.role))
    }
    return best < 0 ? null : ROLES[best]
  }
  const LABEL = { viewer: '可查看', commenter: '可评论', editor: '可编辑', manager: '可管理' }
  /** 我对这份内容至少要有 min,否则 404(完全没有)/ 403(不够) */
  const need = (sid, what, min) => {
    const role = roleFor(sid, what)
    if (!role) throw { status: 404, message: 'not found: 没有找到这个内容' }
    if (ROLES.indexOf(role) < ROLES.indexOf(min)) throw { status: 403, message: `forbidden: 你对这个内容的权限是「${LABEL[role]}」,需要「${LABEL[min]}」` }
  }
  const sourceOf = (source) => (String(source).startsWith('insight:') ? { id: String(source).slice('insight:'.length) } : { path: source })
  const spaceHandlers = {
    get_item: ({ id }, sid) => {
      space(sid)
      need(sid, { id, collection: '_global' }, 'viewer')
      const note = space(sid).notes?.[id]
      if (!note) throw { status: 404, message: 'not found: 没有找到这个内容' }
      // 与后端一致:get_item 不返回乐观锁 version(前端 SharedDoc 的注释里有说明)
      const { version: _version, ...visible } = note
      return { item: { collection: '_global', kind: 'insight', tags: [], updated_at: NOW - 3_600_000, source: `insight:${id}`, id, ...visible }, context: null }
    },
    item_history: ({ id }, sid) => {
      need(sid, { id, collection: '_global' }, 'editor')
      const note = space(sid).notes?.[id]
      return { items: [{ id: `${id}_old`, version: 1, title: '', status: 'superseded' }, { id, version: note?.version ?? 1, title: note?.title ?? '', status: 'active' }] }
    },
    edit_item: ({ id, version, title, body }, sid) => {
      need(sid, { id, collection: '_global' }, 'editor')
      const note = space(sid).notes?.[id]
      if (!note) throw { status: 404, message: 'not found: 没有找到这个内容' }
      if (version !== (note.version ?? 1)) throw { status: 409, message: `version conflict: expected ${version}, got ${note.version ?? 1}` }
      if (title !== undefined) note.title = title
      if (body !== undefined) note.text = body
      note.version = (note.version ?? 1) + 1
      return { id, version: note.version, collection: '_global', job_id: null }
    },
    file_preview: ({ collection, path }, sid) => {
      need(sid, { path, collection }, 'viewer')
      const file = space(sid).files?.[path]
      if (!file) throw { status: 404, message: 'not found: 没有找到这个内容' }
      return { format: path.split('.').pop(), blocks: [], chunks: [], content: file.content, editable: file.editable ?? true }
    },
    file_versions: ({ collection, path }, sid) => {
      need(sid, { path, collection }, 'editor')
      return { versions: [{ id: 'v', version: space(sid).files?.[path]?.version ?? 1, author: null, created_at: NOW, size: 1, preview: '' }] }
    },
    save_file: ({ collection, path, content, expected_version }, sid) => {
      need(sid, { path, collection }, 'editor')
      const file = space(sid).files?.[path]
      if (!file) throw { status: 404, message: 'not found: 没有找到这个内容' }
      if (expected_version !== undefined && expected_version !== (file.version ?? 1)) throw { status: 409, message: `version conflict: expected ${expected_version}, got ${file.version ?? 1}` }
      file.content = content
      file.version = (file.version ?? 1) + 1
      return { version: file.version, embedded: 1, chunks: 1 }
    },
    list_items: ({ collection, path_prefix, page = 1, page_size = 50 }, sid) => {
      need(sid, path_prefix ? { path: path_prefix, collection } : { collection }, 'viewer')
      const rows = (space(sid).rows ?? []).filter((row) => row.collection === collection && (!path_prefix || row.source === path_prefix || row.source.startsWith(`${path_prefix}/`)))
      return { items: rows.slice((page - 1) * page_size, page * page_size), total: rows.length, page, page_size }
    },
    list_annotations: ({ collection, source }, sid) => {
      need(sid, { ...sourceOf(source), collection }, 'viewer')
      return { annotations: space(sid).comments?.[source] ?? [] }
    },
    add_annotation: ({ collection, source, body }, sid, who) => {
      need(sid, { ...sourceOf(source), collection }, 'commenter')
      const found = space(sid)
      found.comments ??= {}
      found.comments[source] ??= []
      found.comments[source].push({ id: nextId('an'), body, author: who ?? PEOPLE.admin.id, created_at: NOW, anchor: null })
      return { id: 'an_new' }
    },
  }
  state.spaceHandlers = spaceHandlers

  const pattern = new RegExp(`/api/v1/capabilities/(${[...Object.keys(handlers), ...Object.keys(spaceHandlers)].join('|')})$`)
  await context.route(pattern, async (route) => {
    const name = new URL(route.request().url()).pathname.match(pattern)?.[1]
    const args = route.request().postDataJSON() ?? {}
    const sid = route.request().headers()['x-kb-space']
    // 这些能力不带 X-KB-Space 时是「我自己的知识库」,交还给通用 fixture
    // 带着「我自己的空间」编号的请求也一样:真后端把它当成自己的知识库(协作握手失败后,前端就是带这个头去探文档还在不在),
    // 不能按「别人的空间」查不到而回 404,否则界面会把一篇存在的笔记说成「不存在或没有权限」并停止重连
    if (name in spaceHandlers && (!sid || (sid === OWN_SPACE && !state.spaces[sid]))) return route.fallback()
    if (sid && name in spaceHandlers) state.log.push({ name, args, space: sid })
    const writes = ['grant_set', 'grant_remove', 'grant_batch', 'set_inherit', 'link_create', 'link_update', 'link_reset', 'link_revoke', 'hide_share', 'access_request', 'access_decide']
    if (writes.includes(name)) state.log.push({ name, args, space: route.request().headers()['x-kb-space'] ?? null })
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
    const forced = state.fail[name]
    if (forced) {
      if (forced.times !== undefined) {
        forced.times -= 1
        if (forced.times <= 0) delete state.fail[name]
      }
      return error(route, forced.status, forced.message)
    }
    try {
      return reply(route, sid && name in spaceHandlers ? spaceHandlers[name](args, sid) : handlers[name](args))
    } catch (thrown) {
      if (thrown && typeof thrown.status === 'number') return error(route, thrown.status, thrown.message)
      throw thrown
    }
  })
  // ---------------------------------------------------------------- 公开分享 /api/v1/share/{token}(游客也能用)
  // initial.publicLinks: { [token]: 配置 };没配置的令牌 = 404 link_not_found。配置:
  //   error { status, code, message }    这个链接固定失败(过期 / 关闭 / 需要登录 …)
  //   password / lockAfter               访问密码;输错 lockAfter(默认 5)次后连输对也回 429 locked
  //   space roots role title bundle      链接指向哪个知识库的哪些根、访问者的角色(游客降级后的)
  //   allow_download watermark visitor owner audience site
  //   ownerAvatar                        分享人的头像文件名(有就能取到图,没有是 404)
  const publicLinks = structuredClone(initial.publicLinks ?? {})
  const pub = { unlocked: new Set(), failures: {} }
  const RANK = (role) => ROLES.indexOf(role)
  const publicInfoOf = (cfg) => ({
    state: 'active',
    requires_password: false,
    site: { name: cfg.site ?? '团队知识库' },
    space_id: cfg.space,
    bundle: !!cfg.bundle,
    title: cfg.title ?? null,
    roots: cfg.roots,
    role: cfg.role ?? 'viewer',
    can: { view: true, comment: RANK(cfg.role ?? 'viewer') >= RANK('commenter'), edit: RANK(cfg.role ?? 'viewer') >= RANK('editor'), download: cfg.allow_download !== false },
    allow_download: cfg.allow_download !== false,
    watermark: cfg.watermark ?? null,
    visitor: cfg.visitor ?? { kind: 'guest', nickname: '访客 3fa9' },
    owner: cfg.owner === null ? null : { id: (cfg.owner ?? PEOPLE.zhangsan).id, display_name: (cfg.owner ?? PEOPLE.zhangsan).display_name, avatar: cfg.ownerAvatar ?? null },
    audience: cfg.audience ?? 'anyone',
  })
  const LINK_CAPS = ['get_item', 'list_items', 'file_preview', 'file_raw', 'list_annotations', 'add_annotation', 'edit_item', 'save_file']
  await context.route(/\/api\/v1\/share\/[A-Za-z0-9_-]+(\/[a-z/_-]*)?(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url())
    const [, token, rest = ''] = url.pathname.match(/\/api\/v1\/share\/([^/]+)(\/.*)?$/) ?? []
    const method = route.request().method()
    const cfg = publicLinks[token]
    const fail = (status, code, message) => reply(route, { code, message }, status)
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
    if (!cfg) return fail(404, 'link_not_found', '链接不存在或已失效')
    if (cfg.error) return fail(cfg.error.status, cfg.error.code, cfg.error.message)
    const locked = !!cfg.password && !pub.unlocked.has(token)
    if (method === 'GET' && rest === '') {
      state.log.push({ name: 'public:info', args: { token }, space: `public:${token}` })
      return reply(route, locked ? { state: 'locked', requires_password: true, site: { name: cfg.site ?? '团队知识库' } } : publicInfoOf(cfg))
    }
    if (method === 'GET' && rest === '/owner-avatar') {
      // 游客没登录:按链接校验;被密码挡住时 401,没有头像时 404,有就给一张图
      state.log.push({ name: 'public:owner-avatar', args: { token, v: url.searchParams.get('v') }, space: `public:${token}` })
      if (locked) return fail(401, 'password_required', '需要先输入访问密码')
      if (!cfg.ownerAvatar) return fail(404, 'not_found', '没有头像')
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-content-type-options': 'nosniff' }, body: gradientPng(64, 'green') })
    }
    if (rest === '/unlock') {
      const body = route.request().postDataJSON() ?? {}
      if (!cfg.password) return reply(route, { unlocked: true })
      if ((pub.failures[token] ?? 0) >= (cfg.lockAfter ?? 5)) return fail(429, 'locked', '输错次数太多,请 10 分钟后再试')
      if (body.password !== cfg.password) {
        pub.failures[token] = (pub.failures[token] ?? 0) + 1
        return fail(401, 'wrong_password', '访问密码不正确')
      }
      pub.unlocked.add(token)
      state.log.push({ name: 'public:unlock', args: { token }, space: `public:${token}` })
      return reply(route, { unlocked: true })
    }
    if (rest === '/guest') {
      const nickname = String((route.request().postDataJSON() ?? {}).nickname ?? '').trim()
      if (!nickname || Array.from(nickname).length > 20 || /[<>]/.test(nickname)) return fail(400, 'invalid_input', 'invalid input: 昵称需要 1–20 个字,不能含 < >')
      cfg.visitor = { ...(cfg.visitor ?? { kind: 'guest' }), nickname }
      state.log.push({ name: 'public:rename', args: { nickname }, space: `public:${token}` })
      return reply(route, { nickname })
    }
    if (locked) return fail(401, 'password_required', '需要先输入访问密码')
    if (rest === '/raw') {
      const path = url.searchParams.get('path') ?? ''
      if (/\.(png|jpe?g|gif|svg)$/i.test(path)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'content-disposition': 'inline' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#dde3ee"/></svg>' })
      if (cfg.allow_download === false) return fail(403, 'download_disabled', '所有者关闭了这个链接的下载')
      return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', headers: { 'content-disposition': 'attachment; filename="file.txt"' }, body: '原件内容' })
    }
    const call = rest.match(/^\/call\/([a-z_]+)$/)
    if (call && method === 'POST') {
      const name = call[1]
      const args = route.request().postDataJSON() ?? {}
      // 白名单之外:通过链接不能做(item_history / file_versions / create_item / delete_item 都不开放,哪怕角色够)
      if (!LINK_CAPS.includes(name)) return fail(403, 'forbidden', 'forbidden: 通过分享链接不能进行这个操作')
      const nick = (cfg.visitor ?? { kind: 'guest', nickname: '访客 3fa9' })
      const who = nick.kind === 'user' ? nick.id : `guest:${nick.nickname}#3fa9c1`
      state.log.push({ name: `public:${name}`, args, space: `public:${token}` })
      state.grantsOverride = (cfg.roots ?? []).map((target) => ({ target, role: cfg.role ?? 'viewer' }))
      try {
        const handler = spaceHandlers[name]
        if (!handler) return reply(route, {})
        return reply(route, handler(args, cfg.space, who))
      } catch (thrown) {
        if (thrown && typeof thrown.status === 'number') return fail(thrown.status, thrown.status === 403 ? 'forbidden' : thrown.status === 409 ? 'conflict' : 'not_found', thrown.message)
        throw thrown
      } finally {
        state.grantsOverride = null
      }
    }
    return route.fallback()
  })

  // 测试钩子:读出写操作的记录
  await context.route('**/api/v1/__fixture/share', (route) => reply(route, { log: state.log }))
  return state
}

/** 场景里读出假后端记下的请求:账号级的写操作 + 所有带 X-KB-Space 的读写,[{ name, args, space }] */
export const shareLog = (tab) => tab.evaluate(() => fetch('/api/v1/__fixture/share').then((response) => response.json())).then((body) => body.data.log)
