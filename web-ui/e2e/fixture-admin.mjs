// 管理端的接口夹具:存储与用量、AI 额度排行、我的用量、分享治理。
// 单独一个文件,由 fixture.mjs 用 Object.assign 并进 dynamicResponses,减少和别的页面夹具的合并冲突。
// 数值都是虚构的;名字里故意放了很长的昵称、已被删除的账号,用来检查窄屏上的折行与省略。

// 与 fixture.mjs 的 NOW 相同(2026-10-20 16:42 UTC);不直接 import,避免循环引用
const NOW = Date.UTC(2026, 9, 20, 16, 42, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const GB = 1024 ** 3
const MB = 1024 ** 2

const storageRow = (id, username, displayName, parts, limitGb, measuredAgo = 5 * MINUTE) => {
  const [meta, sources, uploads, vectors, workspace] = parts
  return {
    space_id: `sp_${id}`,
    owner_id: `usr_${id}`,
    username,
    display_name: displayName,
    sources_bytes: Math.round(sources),
    uploads_bytes: Math.round(uploads),
    vectors_bytes: Math.round(vectors),
    meta_bytes: Math.round(meta),
    workspace_bytes: Math.round(workspace),
    total_bytes: Math.round(meta + sources + uploads + vectors + workspace),
    measured_at: NOW - measuredAgo,
    limit_bytes: limitGb * GB,
  }
}

/** 存储排行:有接近上限的、已超额的、不限额的、账号已删除的、昵称特别长的。 */
export const storageTop = [
  storageRow('zs', 'zhangsan', '张三', [3 * GB, 70 * GB, 0, 38 * GB, 1 * GB], 100, 2 * MINUTE),
  storageRow('ly', 'linyi', '林一', [2 * GB, 52 * GB, 0.4 * GB, 41 * GB, 1 * GB], 100, 3 * MINUTE),
  storageRow('ww', 'wangwu', '王五', [6 * GB, 200 * GB, 0, 190 * GB, 4 * GB], 0, 8 * MINUTE),
  storageRow('al', 'alice', 'Alice', [0.6 * GB, 6.8 * GB, 0, 4.9 * GB, 0], 100, 1 * HOUR),
  storageRow('bo', 'bob', 'Bob', [20 * MB, 800 * MB, 0, 400 * MB, 0], 5, 3 * HOUR),
  storageRow('gone', null, null, [10 * MB, 90 * MB, 0, 50 * MB, 0], 100, 2 * DAY),
  storageRow('long', 'long_name_user', '一个名字特别特别特别特别长的用户用来检查手机上的折行与省略', [5 * MB, 20 * MB, 0, 10 * MB, 0], 100, 9 * MINUTE),
]

export const storageOverviewFixture = {
  disk: { free_gb: 200, reserve_gb: 30, paused: false, warn: false },
  totals: {
    measured_spaces: storageTop.length,
    // 比榜单多:演示「只列出占用最多的 N 个」的提示
    total_spaces: 128,
    total_bytes: storageTop.reduce((sum, row) => sum + row.total_bytes, 0),
    vectors_bytes: storageTop.reduce((sum, row) => sum + row.vectors_bytes, 0),
    oldest_measured_at: NOW - 2 * DAY,
  },
  top: storageTop,
}

/** AI 额度排行(某一天):有超额的、接近的、不限额的、账号被删的。 */
const llmRow = (id, username, displayName, calls, input, output, limit) => ({
  user_id: `usr_${id}`,
  username,
  display_name: displayName,
  calls,
  input_tokens: input,
  output_tokens: output,
  tokens: input + output,
  limit,
})
export const llmRanking = [
  llmRow('zs', 'zhangsan', '张三', 88, 180_000, 42_000, 200_000),
  llmRow('ly', 'linyi', '林一', 41, 150_000, 38_000, 200_000),
  llmRow('ww', 'wangwu', '王五', 300, 900_000, 450_000, 0),
  llmRow('al', 'alice', 'Alice', 12, 52_000, 16_000, 200_000),
  llmRow('gone', null, null, 3, 1_200, 300, 200_000),
]
export const llmUsageFixture = (day) => ({
  day,
  total_tokens: llmRanking.reduce((sum, row) => sum + row.tokens, 0),
  ranking: llmRanking,
})

/** 我的用量:普通用户的样子(没超额)。 */
export const myUsageFixture = {
  storage: {
    sources_bytes: 6.8 * GB,
    uploads_bytes: 0,
    vectors_bytes: 4.9 * GB,
    meta_bytes: 0.6 * GB,
    workspace_bytes: 120 * MB,
    total_bytes: Math.round(6.8 * GB + 4.9 * GB + 0.6 * GB + 120 * MB),
    limit_bytes: 100 * GB,
  },
  ai: { day: '2026-10-20', tokens_today: 68_000, limit: 200_000 },
}

const link = (id, kind, audience, role, state, views, extra = {}) => ({
  id: `lnk_${id}`,
  hint: id.slice(-4).padStart(4, 'x'),
  kind,
  audience,
  role,
  has_password: false,
  state,
  views,
  last_view_at: views ? NOW - 3 * HOUR : null,
  created_at: NOW - 6 * DAY,
  creator: { id: 'usr_al', username: 'alice', display_name: 'Alice', avatar: null },
  owner: { id: 'usr_al', username: 'alice', display_name: 'Alice', avatar: null },
  ...extra,
})
const person = (id, username, displayName) => ({ id: `usr_${id}`, username, display_name: displayName, avatar: null })

export const shareLinks = [
  link('aa11', 'insight', 'anyone', 'viewer', 'active', 1204),
  link('bb22', 'dir', 'anyone', 'editor', 'active', 37, { has_password: true, owner: person('zs', 'zhangsan', '张三'), creator: person('zs', 'zhangsan', '张三') }),
  link('cc33', 'collection', 'logged_in', 'commenter', 'active', 5, { owner: person('ly', 'linyi', '林一'), creator: person('ly', 'linyi', '林一') }),
  link('dd44', 'file', 'anyone', 'viewer', 'expired', 88, { owner: person('ly', 'linyi', '林一'), creator: person('bo', 'bob', 'Bob') }),
  link('ee55', 'bundle', 'collaborators', 'viewer', 'closed', 0, { owner: person('bo', 'bob', 'Bob'), creator: person('bo', 'bob', 'Bob') }),
  link('ff66', 'insight', 'anyone', 'viewer', 'revoked', 9, { owner: null, creator: null }),
  link('gg77', 'file', 'anyone', 'viewer', 'active', 2, { owner: person('long', 'long_name_user', '一个名字特别特别特别特别长的用户用来检查手机上的折行与省略'), creator: person('long', 'long_name_user', '一个名字特别特别特别特别长的用户用来检查手机上的折行与省略') }),
]

/** 要看请求参数的能力,并进 fixture.mjs 的 dynamicResponses。 */
export const adminResponses = {
  storage_overview: () => storageOverviewFixture,
  llm_usage_overview: (args) => (args?.day && args.day !== '2026-10-20' ? { day: args.day, total_tokens: 0, ranking: [] } : llmUsageFixture(args?.day ?? '2026-10-20')),
  usage_mine: () => myUsageFixture,
  share_admin_list: (args) => {
    const size = Number(args?.page_size ?? 50)
    const page = Number(args?.page ?? 1)
    return { links: shareLinks.slice((page - 1) * size, page * size), total: shareLinks.length, page, page_size: size }
  },
  share_admin_revoke: (args) => ({ revoked: shareLinks.some((item) => item.id === args?.id) }),
}
