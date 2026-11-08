// 语雀式文档编辑器用到的纯函数:字数 / 阅读时长、目录、本地草稿。单测见 docText.spec.ts。

/** 字数:中日韩字符逐字计,其余按单词计(与语雀、飞书的口径一致);Markdown 标记不计。 */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|`[\]()-]/g, ' ')
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  const words = text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9]+(?:['.][A-Za-z0-9]+)*/g)?.length ?? 0
  return cjk + words
}

/**
 * 正文第一个非空行是不是一个和页面标题一样的一级标题(`# 标题`)。
 * 导入的文档和不少笔记正文第一行就是同名的 `# 标题`,读页面时标题就出现两遍(页头一遍、正文一遍),手机上白占约 70px。
 * 只做"相同才算":文字比较忽略大小写、全角 / 半角空格和行内格式符号;二级标题、普通段落、列表同名都不算;
 * 只看第一个非空行(前面的 YAML 头 `---` 不算正文,先跳过);标题或正文是空的不算重复。
 */
export function repeatsTitle(title: string, markdown: string): boolean {
  const normalize = (text: string) =>
    text
      .replace(/[`*_~]/g, '')
      .replace(/[\s\u3000]+/g, ' ')
      .trim()
      .toLowerCase()
  const wanted = normalize(title)
  if (!wanted) return false
  let lines = markdown.split('\n')
  // YAML 头:开头第一个非空行是 ---,一直到下一个 --- 为止都不是正文
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first >= 0 && lines[first]!.trim() === '---') {
    const close = lines.findIndex((line, at) => at > first && line.trim() === '---')
    if (close > first) lines = lines.slice(close + 1)
  }
  const line = lines.find((item) => item.trim() !== '')
  if (line === undefined) return false
  const match = /^#[ \t\u3000]+(.*?)[ \t]*#*[ \t]*$/.exec(line.trim())
  if (!match) return false
  return normalize(match[1]!) === wanted
}

/** 标题比较用的规范化：去掉行内格式符、全角半角统一（「（初版）」和「(初版)」算同一个）、空白压成一个、忽略大小写 */
function normalizeTitle(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 两个标题是不是同一个（规则见 normalizeTitle）；空标题和谁都不相同 */
export function sameTitle(a: string, b: string): boolean {
  const left = normalizeTitle(a)
  return left !== '' && left === normalizeTitle(b)
}

/**
 * 正文开头的一级标题（去掉了行内格式符）；没有返回 null。
 * 「开头」指：跳过 YAML 头、空行、空的标题行（只有 # 号）和开头的引用 / 提示块（`>` 开头的行）之后的第一行。
 * 提示块常被放在文档最前面当说明（`> [!TIP]`），它下面那个 `# 标题` 仍然是这篇文档的标题。
 */
export function leadingHeading(markdown: string): string | null {
  let lines = markdown.split('\n')
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first >= 0 && lines[first]!.trim() === '---') {
    const close = lines.findIndex((line, at) => at > first && line.trim() === '---')
    if (close > first) lines = lines.slice(close + 1)
  }
  // 空的标题行（只有 # 号、没有文字）也跳过：编辑器里误按出来的空标题会被存成一行 `#`，
  // 它不是文档标题，挡在真正的标题前面会让「已保存的正文」和「编辑器里的实时正文」得出不同的结论，页面标题就会先出现、后消失
  const line = lines.find((item) => item.trim() !== '' && !item.trimStart().startsWith('>') && !/^#{1,6}[ \t\u3000]*$/.test(item.trim()))
  if (line === undefined) return null
  const match = /^#[ \t\u3000]+(.*?)[ \t]*#*[ \t]*$/.exec(line.trim())
  if (!match) return null
  const text = match[1]!.replace(/[`*_~]/g, '').trim()
  return text || null
}

/** 阅读时长(分钟):中文 400 字 / 分钟,至少 1 分钟。 */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 400))
}

export interface OutlineItem {
  level: number
  text: string
  /** 在文档里第几个标题(和 DOM 里 h1–h6 的顺序一致) */
  index: number
}

/** 目录只收 h1–h4;只有一个一级标题时把它当文档标题,不进目录。 */
export function buildOutline(headings: { level: number; text: string }[]): OutlineItem[] {
  const items = headings.map((heading, index) => ({ ...heading, text: heading.text.trim(), index })).filter((item) => item.level <= 4 && item.text)
  const h1 = items.filter((item) => item.level === 1)
  return h1.length === 1 && items.length > 1 ? items.filter((item) => item.level !== 1) : items
}

/** 目录缩进:以文档里出现的最小级别为 0。 */
export function outlineDepth(items: OutlineItem[]): (item: OutlineItem) => number {
  const min = Math.min(...items.map((item) => item.level), 6)
  return (item) => item.level - min
}

/* ---------------- 本地草稿:编辑中的内容实时存到 localStorage,刷新 / 断网 / 误关标签页不丢 ---------------- */

export interface Draft {
  title: string
  body: string
  /** 草稿基于的服务器内容(用来判断草稿是不是已经过时) */
  base: string
  /** 草稿基于的标题;老草稿没有这一项,按「没变」处理 */
  baseTitle?: string
  /** 标题和正文之外的附加内容(标签、种类),调用方自己序列化成字符串;比较时只看字符串是否相同 */
  extra?: string
  baseExtra?: string
  /**
   * 多人编辑专用:正文里有没同步到房间的本地修改(离线或只读期间改的)。
   * 多人编辑时正文以服务端房间为准,所以只有它为 true 时 body 才有意义;
   * 否则 body 是空串,不然别人改过之后,这份旧草稿会被当成「和服务器不一致」而反复提示。
   */
  unsynced?: boolean
  /**
   * 多人编辑专用:正文改了还没落地(没点「保存」),本机留的这一份只是**镜子**,用来刷新后接着看、
   * 以及提示「草稿已自动保存」;权威仍然是服务端房间。它不会在单人模式下被当成正文放回去。
   */
  room?: boolean
  savedAt: number
}

/** 草稿保留多久:超过就当没有。新建了一半的东西放一个月还没回来接着写,多半是不要了。 */
const DRAFT_TTL_MS = 30 * 24 * 3600 * 1000

const PREFIX = 'kb.draft.'
const MAX_DRAFTS = 30

export function draftKey(id: string): string {
  return `${PREFIX}${id}`
}

/**
 * 草稿键按账号隔离:同一台电脑上换账号登录,看不到上一个人没写完的内容(新建笔记的键只有集合名,不隔离就会串)。
 * 没登录信息时用 anon,保证有值。
 */
export function scopedDraftId(userId: string | null | undefined, id: string): string {
  return `${userId || 'anon'}:${id}`
}

/** 存草稿。返回是否真的存进去了:存满 / 隐私模式会失败,调用方据此决定还要不要拦「离开前确认」。 */
export function saveDraft(id: string, draft: Omit<Draft, 'savedAt'>, now = Date.now()): boolean {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify({ ...draft, savedAt: now }))
    pruneDrafts()
    return true
  } catch {
    return false
  }
}

export function loadDraft(id: string, now = Date.now()): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(id))
    if (!raw) return null
    const value = JSON.parse(raw) as Draft
    if (typeof value.body !== 'string' || typeof value.savedAt !== 'number') return null
    if (now - value.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(draftKey(id))
      return null
    }
    return value
  } catch {
    return null
  }
}

export function clearDraft(id: string): void {
  try {
    localStorage.removeItem(draftKey(id))
  } catch {
    /* 同上 */
  }
}

/** 服务器上现在的这份内容;`extra` 不用的调用方不传。 */
export interface DraftServer {
  title: string
  body: string
  extra?: string
}

/** 草稿与当前服务器内容不同、且确实有改动时才值得提示恢复。正文比较忽略末尾空白:编辑器序列化会多一个换行。 */
export function draftWorthRestoring(draft: Draft | null, server: DraftServer): boolean {
  if (!draft) return false
  const extraChanged = draft.extra !== undefined && server.extra !== undefined && draft.extra !== server.extra
  const bodyChanged = draftCarriesBody(draft) && draft.body.trimEnd() !== server.body.trimEnd()
  return bodyChanged || draft.title !== server.title || extraChanged
}

/**
 * 草稿带不带正文。多人编辑里「已同步」的草稿(unsynced === false)正文存的是空串——正文本来就在房间里,
 * 这里的空串不是「用户把正文删光了」。在任何模式下都不能把它当正文放回去,否则换成单人模式打开同一篇,
 * 编辑器会被清空,再点「完成」就把空正文存上去了。
 */
export function draftCarriesBody(draft: Draft): boolean {
  return draft.unsynced !== false
}

/** 草稿的标题 / 附加内容,是不是在服务器现在这一版上改的(老草稿没记录的项当作没变)。 */
function sameFieldsBase(draft: Draft, server: DraftServer): boolean {
  if (draft.baseTitle !== undefined && draft.baseTitle !== server.title) return false
  if (draft.baseExtra !== undefined && server.extra !== undefined && draft.baseExtra !== server.extra) return false
  return true
}

/**
 * 草稿怎么恢复:
 * - none:没有草稿,或和服务器上的一样,不用恢复;
 * - silent:草稿是在**现在这份服务器内容**上改的(base 一致),直接放回编辑器,不打扰;
 * - ask:服务器上的内容在草稿之后变过(别人改了 / 自己在别处保存过),静默覆盖会丢掉那些改动,必须让人选。
 * `allowSilent=false` 用于多人编辑的文档:正文以房间为准,不允许把本地正文静默写回。
 */
export function restoreMode(draft: Draft | null, server: DraftServer, allowSilent = true): 'none' | 'silent' | 'ask' {
  if (!draft || !draftWorthRestoring(draft, server)) return 'none'
  // 不带正文的草稿(多人编辑已同步)不关心正文有没有变过:它只管标题 / 标签
  const sameBody = !draftCarriesBody(draft) || draft.base.trimEnd() === server.body.trimEnd()
  return allowSilent && sameBody && sameFieldsBase(draft, server) ? 'silent' : 'ask'
}

/**
 * 多人编辑文档的草稿只管两样:
 * - 标题 / 附加内容(标签):不在 Yjs 里,和单人编辑一样处理(base 一致才静默放回);
 * - 正文:只有 `unsynced` 的才有意义,而且永远不静默写回(见 restoreMode),由界面让人选「复制出来」还是丢弃。
 */
export function collabDraftFields(draft: Draft | null, server: DraftServer): { fields: 'none' | 'silent' | 'ask'; bodyUnsynced: boolean } {
  if (!draft) return { fields: 'none', bodyUnsynced: false }
  const changed = draft.title !== server.title || (draft.extra !== undefined && server.extra !== undefined && draft.extra !== server.extra)
  const fields = !changed ? 'none' : sameFieldsBase(draft, server) ? 'silent' : 'ask'
  return { fields, bodyUnsynced: draft.unsynced === true && draft.body.trim() !== '' }
}

/**
 * 打开文档时:有没有值得直接回到编辑的草稿。
 * 单人编辑:要能静默放回;多人编辑:标题 / 标签能静默放回,或者有没同步的正文。
 * 服务器内容在草稿之后变过(ask)不算:不把人强行拖进编辑态,等他自己点「编辑」时再问。
 */
export function hasResumableDraft(id: string, server: DraftServer, collab = false): boolean {
  const draft = loadDraft(id)
  if (!collab) return restoreMode(draft, server) === 'silent'
  const parts = collabDraftFields(draft, server)
  if (parts.bodyUnsynced || parts.fields === 'silent') return true
  // 正文改了还没落地:本机有一份镜子,进编辑接着看(房间里有同样一份)
  return !!draft && draft.room === true && draft.base.trimEnd() === server.body.trimEnd() && draft.body.trimEnd() !== server.body.trimEnd()
}

/** 只保留最近的 MAX_DRAFTS 份,防止 localStorage 被旧草稿占满。 */
function pruneDrafts(): void {
  const entries: { key: string; at: number }[] = []
  for (let at = 0; at < localStorage.length; at += 1) {
    const key = localStorage.key(at)
    if (!key?.startsWith(PREFIX)) continue
    try {
      entries.push({ key, at: (JSON.parse(localStorage.getItem(key) ?? '{}') as Draft).savedAt ?? 0 })
    } catch {
      entries.push({ key, at: 0 })
    }
  }
  entries.sort((left, right) => right.at - left.at)
  for (const entry of entries.slice(MAX_DRAFTS)) localStorage.removeItem(entry.key)
}
