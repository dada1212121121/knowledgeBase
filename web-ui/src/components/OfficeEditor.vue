<script setup lang="ts">
// 办公文档在线编辑(Excel、PowerPoint、Word):在页面里直接改,保存时新内容替换原文件,旧内容进版本历史。
// 编辑器本体是统一外壳(`src/editor/`)里的 Excel 网格 / Word 画布 / 幻灯片三个内容面;本组件只管外面这一圈:
// 编辑权、协同准备、无损预检的结论展示、保存通道和关闭。(起旧的 React 编辑岛已删除。)
//
// 为什么 Word / PowerPoint 打开后先做一次「不改直接保存」:编辑引擎是浏览器里的第三方代码,有的文档它写回去会变样
// (页眉页脚被重写、图片丢了…)。把没改过的文档重新保存一遍交给服务端和原件比,
// 无损才放开编辑;不无损就退回只读,并说清楚哪里会变,由用户决定还要不要改。
// 真正保存时服务端还会再检查一次整个包是否完整(`FileEditService::replace_bytes`),这里的检查只是提前告诉用户。
//
// 多人实时协同:打开时先问服务端能不能协同。能的话从房间底稿打开、连上房间,大家的修改实时互见,
// 文件由服务端副本自动落地(不用点保存);不能(协同服务没装、文件太大、系统参数关了)就退回下面的单人编辑。
//
// 编辑权(`kb-service/src/edit/lock.rs`,只用于单人编辑):打开时先申请这份文件的编辑权,拿到才能改;别人(包括自己的另一个窗口)
// 持有着就只读,并告诉用户是谁、多久之前还有动静,可以重新检查或明确接手。拿到之后每隔 ttl/3 秒报一次心跳,
// 标签页隐藏时停、回来立刻补一次;超过 ttl 没有心跳编辑权自动失效,不会留下一把永远打不开的锁。
// 编辑权被别人接手后这个窗口退回只读,保存会被服务端拒绝。
import { computed, createApp, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { KbBadge, KbButton, KbSkeleton, useToast } from '@kb-ui/index'
import { callCapability } from '@/api/client'
import {
  OfficeEditError,
  acquireLock,
  fetchOfficeBase,
  fetchOfficeSeed,
  newSessionId,
  officeCollabUrl,
  prepareOfficeSession,
  releaseLock,
  roundtripCheck,
  type LockResult,
  type OfficeSession,
  type RoundtripReport,
} from '@/api/officeEdit'
import { docKey } from '@/collab/resourceKey'
import { useSessionStore } from '@/stores/session'
import { officeKindOf, type OfficeCollabStatus } from '@/utils/officeKind'
import { collabLimitReason, createXlsxCollabOptions, OFFICE_COLLAB_MAX_BYTES } from '@/editor/surfaces/grid/xlsx-collab'
import type { XlsxCollabOptions } from '@/editor/engines/xlsx'
import type { CollabStatusSource } from '@/editor/types'
import { createDocxCollabOptions, type DocxSurfaceCollab } from '@/editor/surfaces/page/edit/docx-collab'
import { PAGE_EDIT_PROFILE } from '@/editor/extensions/builtin/page.ext'
import { defaultRoundtripCache, PROBE_MARKER, roundtripVerdict } from '@/editor/codecs/docxRoundtrip'
// 不 import 引擎的小模块：只负责把 WASM 下载提前发出去
import { prefetchDocxWasm } from '@/editor/engines/docxWasm'
import type { DocxEditVerdict } from '@/editor/codecs/docxInventory'
import { failureOf } from '@/utils/loadState'

const props = defineProps<{
  collection: string
  path: string
  /** 别人分享给我的文件:对方的知识库 id。只走多人协同(编辑权、替换文件这些单人编辑的接口只在自己的知识库里) */
  spaceId?: string
}>()
const emit = defineEmits<{ saved: []; close: [] }>()

type Phase = 'loading' | 'checking' | 'editing' | 'readonly' | 'refused'
const toast = useToast()
/** 编辑器外壳的挂载点 */
const nativeHost = ref<HTMLElement | null>(null)
/** 外壳的 Vue 应用（xlsx / docx / pptx 共用，整个文件只有 mountNativeApp 一处创建） */
let nativeApp: ReturnType<typeof createApp> | null = null
/** pptx 原生编辑：引擎后端与可变的打开请求（「仍然编辑」靠改它的 readonly 放开，不用重开引擎） */
let pptxBackend: import('@/editor/surfaces/slide/types').SlideEditBackend | null = null
let pptxRequest: { readonly: boolean } | null = null
/** docx 原生编辑：可变的打开请求、编辑面实例（检查通过后靠它们放开只读，不用重开引擎）、当前这次挂载的代数与探针的取消器 */
let docxRequest: { readonly: boolean } | null = null
let docxSurface: { setReadonly(value: boolean): void } | null = null
let docxGeneration = 0
let docxCheckAbort: AbortController | null = null
/** 引擎崩溃后抢救出来的恢复副本（下载链接） */
const recovery = ref<{ url: string; name: string } | null>(null)
/**
 * 画面已经出来、正在后台做无损预检（pptx：不改直接保存；docx：隔离会话里的探针编辑）：这段时间引擎是只读的，检查通过才放开。
 * 为什么不用遮罩挡着等：docx 冷开时探针要再起一个引擎会话、再下载保存用的两个 WASM、再上传给服务端比对，
 * 实测占了冷开 9.9 s 里的 8 s 以上（瀑布图），而人们这段时间本来就可以先看文档。
 */
const checkingInPlace = ref(false)
/** 原生协同需要同时给引擎（transport）和宿主（状态条 / 保存入口） */
interface NativeCollab {
  /** 表格的协同选项（xlsx 内容面用） */
  xlsx?: XlsxCollabOptions
  /** Word 的协同选项（docx 内容面用） */
  docx?: DocxSurfaceCollab
  url: string
  userName: string
  initialUpdate?: Uint8Array
  /**
   * 房间状态来源（连接中 / 同步中 / 已同步 / 离线 / 已结束）：交给宿主的状态栏。
   * 没有它，宿主只能按「有协同配置」写死「正在连接协同…」，xlsx 连上之后状态栏还是这句。
   */
  status?: CollabStatusSource
}
/**
 * 服务端说能协同、xlsx 却超过上限(比如上限刚下调):按单人编辑处理,并把原因说准。
 * 只有 xlsx 有这个上限(见 `XLSX_COLLAB_MAX_BYTES`),docx / pptx 不进这个判断。
 */
function oversizedXlsx(prepared: OfficeSession): boolean {
  return kind.value === 'xlsx' && (prepared.size ?? 0) > OFFICE_COLLAB_MAX_BYTES
}

/** 服务端允许的单次替换上限，保存前本地先挡一次，避免白传几十兆 */
const maxReplaceBytes = ref(64 * 1024 * 1024)
const phase = ref<Phase>('loading')
const error = ref('')
const report = ref<RoundtripReport | null>(null)
/** Word 编辑的打开前判定（探针编辑 + 服务端比较 + 内容清点）；PowerPoint 与协同准备用 report */
const verdict = ref<DocxEditVerdict | null>(null)
const dirty = ref(false)
/** 保存后需要提醒用户的事(比如文件里少了部件) */
const notice = ref('')
/** 打开(或上次保存)时原件的哈希:保存时带回去,文件在这之后被别人改过会被拒绝 */
const baseSha = ref('')
const account = useSessionStore()

/** 协同模式:服务端的准备结果、连接状态与在线的人;为空 = 单人编辑 */
const collab = ref<OfficeSession | null>(null)
const collabStatus = ref<OfficeCollabStatus>({ status: 'connecting', synced: false, peers: [] })
/** 单人编辑的原因(协同服务没装、文件太大……):告诉用户为什么不能和别人一起改 */
const singleReason = ref('')
/** 服务端把连接关了(权限收回、房间关了)的原因 */
const collabClosed = ref('')
const ownSpace = computed(() => account.user?.space_id ?? null)
/** 打开的是别人知识库里的文件 */
const shared = computed(() => !!props.spaceId && props.spaceId !== ownSpace.value)
const docRef = computed(() => {
  const spaceId = props.spaceId ?? ownSpace.value
  return spaceId ? docKey(spaceId, props.collection, { file: props.path }) : null
})

/** 这个编辑器窗口的编号:同一个编号再次申请编辑权就是心跳 */
const session = newSessionId()
/** none 还没申请 / held 这个窗口持有 / other 别人持有(只读)/ lost 持有过但被接手或失效了(只读) */
type LockState = 'none' | 'held' | 'other' | 'lost'
const lockState = ref<LockState>('none')
/** 谁持有着(「某某」/「你在另一个窗口里」)与最近一次心跳距今几秒 */
const holderName = ref('')
const holderIdle = ref(0)
const confirmingTakeover = ref(false)
/** 连着两次心跳失败:提醒用户和服务器断了联系 */
const offline = ref(false)
let ttlSecs = 45
let beatTimer: ReturnType<typeof setInterval> | null = null
let beatFailures = 0

const fileName = computed(() => props.path.split('/').pop() || props.path)
const kind = computed(() => officeKindOf(props.path) ?? 'xlsx')
const kindName = computed(() => ({ pptx: 'PowerPoint', docx: 'Word', xlsx: 'Excel' })[kind.value])

/** 无损检查没过时,把「会变什么」说给人听 */
const concern = computed(() => {
  const v = verdict.value
  if (v && v.editable !== 'yes') {
    if (!v.valid) return `这份文档被编辑器重新保存后不是完整的文件(${v.reason ?? '原因不明'}),不能在线编辑。`
    if (v.editable === 'no') return `编辑器保存时会丢掉文档里的内容(${v.losses.slice(0, 3).join(';')}),所以这份文档不能在线编辑。请下载后用 Word 修改。`
    return `文字内容不会变,但编辑器会改写一些格式细节(涉及 ${v.rewritten.slice(0, 4).join('、')})。原文件会作为旧版本保留,随时可以恢复。`
  }
  const r = report.value
  if (!r || r.lossless) return ''
  if (!r.valid) return `这份文档被编辑器重新保存后不是完整的文件(${r.reason ?? '原因不明'}),不能在线编辑。`
  const parts = [...r.changed_parts, ...r.removed_parts].slice(0, 4).join('、')
  if (!r.text_equal) return `编辑器重新保存后文字内容和原文件对不上(涉及 ${parts}),不能在线编辑。`
  return `文字内容不会变,但编辑器会改写一些格式细节(涉及 ${parts})。原文件会作为旧版本保留,随时可以恢复。`
})
/** 文字没变、只是格式细节会变:允许用户自己决定要不要继续改(编辑权不在自己手里时不给) */
const canForce = computed(() =>
  collab.value
    ? phase.value === 'readonly' && !!collab.value.forceable && !collab.value.room_writable
    : phase.value === 'readonly' && lockState.value === 'held' && (verdict.value ? verdict.value.editable === 'force' : !!report.value && !report.value.lossless && report.value.valid && report.value.text_equal),
)
/** 协同的状态条文字 */
const collabText = computed(() => {
  if (!collab.value) return ''
  const status = collabStatus.value
  const others = status.peers.length
  const link = status.status === 'connected' ? (status.synced ? '已同步' : '同步中…') : status.status === 'connecting' ? '连接中…' : '离线,修改会在连上后同步'
  return `多人协同 · ${link}${others ? ` · 另有 ${others} 人在编辑:${status.peers.slice(0, 3).join('、')}${others > 3 ? ' 等' : ''}` : ''}`
})

function bail(message: string) {
  error.value = message
  phase.value = 'refused'
}

/** 谁持有着的说法:同一个账号在另一个窗口 / 设备上,界面说「你在另一个窗口里」 */
function describeHolder(result: LockResult): string {
  if (!result.holder) return '别人'
  return result.same_user ? '你在另一个窗口里' : result.holder.actor
}

function stopBeat() {
  if (beatTimer) clearInterval(beatTimer)
  beatTimer = null
}

function startBeat() {
  stopBeat()
  beatTimer = setInterval(() => void beat(), Math.max(5, Math.floor(ttlSecs / 3)) * 1000)
}

/** 编辑权被别人接手了(或失效后又被别人拿走):退回只读,保存会被服务端拒绝 */
function markLost(result?: LockResult) {
  stopBeat()
  lockState.value = 'lost'
  holderName.value = result ? describeHolder(result) : ''
  phase.value = 'readonly'
}

/** 心跳:同一个窗口编号再申请一次。拿不回来就是被别人接手了 */
async function beat() {
  if (lockState.value !== 'held') return
  try {
    const result = await acquireLock(props.collection, props.path, session)
    beatFailures = 0
    offline.value = false
    if (!result.held) markLost(result)
  } catch {
    beatFailures += 1
    if (beatFailures >= 2) offline.value = true
  }
}

/** 标签页隐藏时不发心跳(省请求);回来立刻补一次并继续 */
function onVisibility() {
  if (lockState.value !== 'held') return
  if (document.hidden) {
    stopBeat()
  } else {
    void beat()
    startBeat()
  }
}

/** 关页面 / 刷新时尽力交还编辑权;发不出去也没关系,45 秒后自己失效 */
function onPageHide() {
  if (lockState.value === 'held') void releaseLock(props.collection, props.path, session)
}

/**
 * pptx 原生编辑的预热：编辑器代码块、引擎、字体和服务端往返并行进行。
 * 打开要依次问文件信息 / 协同准备 / 编辑权 / 原件字节，每个往返都是等待时间，正好拿来下载和解析这些东西。
 */
function warmNativePptx() {
  if (kind.value !== 'pptx') return
  void Promise.all([
    import('@/editor/host/EditorHost.vue'),
    import('@/editor/engines/pptxEdit').then((module) => module.warmPptxEdit()),
    import('@/editor/surfaces/slide/edit-surface'),
    import('@/editor/codecs/pptx'),
  ]).catch(() => undefined)
}

/**
 * docx 原生编辑的预热：和 pptx 同理，打开要依次问文件信息 / 协同准备 / 编辑权 / 原件字节，每个往返都是等待时间，
 * 正好拿来下载引擎 WASM、取编辑面代码块、建 Worker。悬停「在线编辑」时已经开始的话这里是空操作（都有幂等保护）。
 * 只在已经点开在线编辑之后才做——打开 Word 只读预览时不会下引擎。
 */
function warmNativeDocx() {
  if (kind.value !== 'docx') return
  prefetchDocxWasm()
  void Promise.all([
    import('@/editor/host/EditorHost.vue'),
    import('@/editor/engines/docx').then((module) => module.prefetchDocxEngine()),
    import('@/editor/surfaces/page/edit/docxEditSurface'),
    import('@/editor/codecs/docx'),
  ]).catch(() => undefined)
}

async function open(takeOver = false) {
  warmNativePptx()
  warmNativeDocx()
  // 重试时上一次可能已经挂了一半
  stopBeat()
  nativeApp?.unmount()
  nativeApp = null
  pptxBackend = null
  pptxRequest = null
  docxRequest = null
  docxSurface = null
  docxGeneration += 1
  docxCheckAbort?.abort()
  docxCheckAbort = null
  checkingInPlace.value = false
  if (recovery.value) URL.revokeObjectURL(recovery.value.url)
  recovery.value = null
  lockState.value = 'none'
  collab.value = null
  singleReason.value = ''
  collabClosed.value = ''
  confirmingTakeover.value = false
  offline.value = false
  beatFailures = 0
  dirty.value = false
  notice.value = ''
  report.value = null
  verdict.value = null
  phase.value = 'loading'
  error.value = ''
  try {
    // 别人分享给我的文件:能不能改、是不是上传的文件,都由对方知识库里的协同准备来判断
    if (shared.value && docRef.value) {
      const prepared = await prepareOfficeSession(docRef.value, takeOver)
      if (prepared.mode === 'collab') {
        // 服务端说能协同、文件却超过上限(比如上限刚下调):不能悄悄进房间,把准确原因说出来
        if (oversizedXlsx(prepared)) return bail(collabLimitReason(prepared.size ?? 0, prepared.reason))
        return openCollab(prepared)
      }
      return bail(`${prepared.reason || '这份文档现在不能多人协同'}。别人分享给你的文档只能在多人协同模式下在线编辑,可以下载后修改。`)
    }
    const info = await callCapability<{ sha256: string; origin: string; max_replace_bytes: number }>('file_info', {
      collection: props.collection,
      path: props.path,
    })
    if (info.max_replace_bytes > 0) maxReplaceBytes.value = info.max_replace_bytes
    if (info.origin !== 'upload') {
      return bail('这个文件在项目目录里,由代码仓库管理,不能在页面里直接改它。可以下载后修改,再作为新文件上传。')
    }
    // 多人协同:能的话走协同,不用编辑权
    if (docRef.value) {
      const prepared = await prepareOfficeSession(docRef.value, takeOver).catch(() => null)
      if (prepared?.mode === 'collab' && !oversizedXlsx(prepared)) return openCollab(prepared)
      // 超过协同上限:单人编辑,但把「为什么不是多人协同」说准(别让人以为协同坏了)
      singleReason.value =
        prepared?.mode === 'collab' ? collabLimitReason(prepared.size ?? 0, prepared.reason) : (prepared?.reason ?? '')
    }
    // 单人编辑:先申请编辑权,拿不到(别人在编辑)就只读查看
    const lock = await acquireLock(props.collection, props.path, session, takeOver)
    ttlSecs = lock.ttl_secs
    if (lock.held) {
      lockState.value = 'held'
      if (!document.hidden) startBeat()
    } else {
      lockState.value = 'other'
      holderName.value = describeHolder(lock)
      holderIdle.value = lock.holder?.idle_secs ?? 0
    }
    // 先取哈希再取字节:两次之间文件被改了,保存时会因为哈希对不上被拒绝,不会悄悄覆盖别人的修改
    baseSha.value = info.sha256
    const query = new URLSearchParams({ collection: props.collection, path: props.path })
    const response = await fetch(`/api/v1/raw?${query.toString()}`, { credentials: 'same-origin' })
    if (!response.ok) return bail(`读取文件失败(HTTP ${response.status})`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    // Word 先做打开前的无损判定（探针编辑），按结论决定可编辑 / 只读；Excel 直接挂载（服务端替换文件时还会整包检查一次）
    if (kind.value === 'docx' && lockState.value === 'held') await openNativeDocx(bytes)
    else await mountNative(bytes, lockState.value !== 'held')
  } catch (err) {
    bail(failureOf(err, '打开文档').message)
  }
}

/** 把外壳宿主挂到编辑容器里（xlsx / docx / pptx 共用，整个文件只有这一处创建 Vue 应用） */
function mountNativeApp(render: () => ReturnType<typeof h>) {
  if (!nativeHost.value) return
  nativeApp = createApp({ render })
  nativeApp.mount(nativeHost.value)
}

/**
 * Excel / Word 编辑面：直接用引擎编辑会话打开同一份字节，保存仍走 replace + 编辑权。
 *
 * Excel 这里不重复做无损预检：替换接口内部有 `office_check::validate`，失败会带着原因拒绝，
 * 不在输入路径上加一次大文件往返；Word 的预检见 openNativeDocx，PowerPoint 的见 mountNativePptx。
 */
/** 编辑面打开的那份字节：「仍然编辑」要用它重挂 */
let nativeBytes: Uint8Array | null = null
const roundtripCache = defaultRoundtripCache()

/**
 * Word 的无损判定：在隔离的临时会话里对文档做一次真实的探针编辑并保存，
 * 交给服务端比较、本地清点内容，按结论决定怎么挂编辑面（细节见 codecs/docxRoundtrip.ts）。
 *
 * 命中本机缓存（同一份原件 + 同一版引擎）：不起临时会话、也不上传，按结论直接挂载，和以前一样。
 * 没命中：**先以只读挂载**，画面马上出来，检查在编辑引擎就绪之后后台做，通过才放开编辑——
 * 和 PowerPoint 同一个套路（mountNativePptx）。以前这里是「先检查、检查完才挂载」：探针要再起一个引擎会话，
 * 保存时再下载 1.7 MB 的解析 / 打包 WASM、上传、等服务端比对，冷开 9.9 s 里 8 s 以上花在这条串行链上。
 * 只读是引擎层的（会话创建时 readOnly=true，改字命令会被引擎拒绝），不是只靠界面挡着，所以检查期间不可能改到文档。
 */
async function openNativeDocx(bytes: Uint8Array) {
  const known = baseSha.value ? roundtripCache.get(baseSha.value) : null
  if (known) {
    verdict.value = known
    await mountNative(bytes, known.editable !== 'yes')
    return
  }
  checkingInPlace.value = true
  await mountNative(bytes, true, undefined, { checkAfterOpen: true })
}

/**
 * 编辑引擎就绪后后台做无损检查，按结论放开编辑或保持只读。
 * `generation` 防止过期：期间用户关了编辑器、重新打开、点了「仍然编辑」重挂，旧的检查结果一律作废。
 */
async function runDocxCheck(bytes: Uint8Array, generation: number) {
  if (generation !== docxGeneration || verdict.value) return
  const abort = new AbortController()
  docxCheckAbort = abort
  try {
    const { probeDocxSave } = await import('@/editor/engines/docx')
    const result = await roundtripVerdict({
      sha256: baseSha.value,
      original: bytes,
      cache: roundtripCache,
      probe: (original) => probeDocxSave(original, PROBE_MARKER, abort.signal),
      check: (resaved) => roundtripCheck(props.collection, props.path, resaved),
    })
    if (generation !== docxGeneration) return
    verdict.value = result.verdict
    // 只有 yes 才放开编辑；force 要用户点「仍然编辑」；no 永远只读
    if (result.verdict.editable === 'yes' && docxSurface && docxRequest) {
      docxSurface.setReadonly(false)
      docxRequest.readonly = false
      phase.value = 'editing'
    } else {
      phase.value = 'readonly'
    }
  } catch (err) {
    if (generation !== docxGeneration || abort.signal.aborted) return
    // 检查本身失败（网络断了、探针被引擎拒绝）：读不出来不能当没问题——保持只读，让用户至少能看
    notice.value = `没能完成"能否无损编辑"的检查(${failureOf(err, '检查').message}),这次先只读打开。`
    phase.value = 'readonly'
  } finally {
    if (generation === docxGeneration) checkingInPlace.value = false
    if (docxCheckAbort === abort) docxCheckAbort = null
  }
}

async function mountNative(bytes: Uint8Array, readonly: boolean, collabJoin?: NativeCollab, options: { checkAfterOpen?: boolean } = {}) {
  if (!nativeHost.value) return
  // PowerPoint 有自己的挂载流程（先读后检、协同后端分开加载），不走下面 xlsx / docx 共用的整包保存宿主
  if (kind.value === 'pptx') return mountNativePptx(bytes, readonly)
  nativeBytes = bytes
  // 重挂前先拆掉上一个宿主；上一次挂载留下的无损检查随之作废
  nativeApp?.unmount()
  nativeApp = null
  docxGeneration += 1
  const generation = docxGeneration
  docxSurface = null
  phase.value = 'checking'
  try {
    const isDocx = kind.value === 'docx'
    // 内容面与保存通道按格式懒加载：Excel 不下载 Word 的编辑代码，反之亦然
    const [{ default: EditorHost }, makeSurface, makeTransport] = await Promise.all([
      import('@/editor/host/EditorHost.vue'),
      isDocx
        ? import('@/editor/surfaces/page/edit/docxEditSurface').then((module) => () => module.createDocxEditSurface({
            fileName: fileName.value,
            user: account.user?.display_name || account.user?.username || '我',
            ...(collabJoin?.docx ? { collab: collabJoin.docx } : {}),
            // 编辑引擎就绪（第一帧出来）之后才起无损检查：检查要再开一个引擎会话，不能和首屏抢带宽 / CPU
            ...(options.checkAfterOpen ? { onEngineReady: () => void runDocxCheck(bytes, generation) } : {}),
          }))
        : import('@/editor/surfaces/grid/xlsxSurface').then((module) => () => module.createXlsxEditSurface(collabJoin?.xlsx)),
      isDocx
        ? import('@/editor/codecs/docx').then((module) => module.createDocxSaveTransport)
        : import('@/editor/codecs/xlsx').then((module) => module.createXlsxSaveTransport),
    ])
    if (!nativeHost.value) return
    // 响应式的打开请求：无损检查通过后只要改它的 readonly（同时放开编辑面），Host 的工具栏 / 保存入口就跟着放开
    const request = reactive({
      fileId: `${props.collection}:${props.path}`,
      collection: props.collection,
      path: props.path,
      format: kind.value,
      source: { kind: 'bytes' as const, name: fileName.value, bytes },
      readonly,
      revision: 0,
      permissions: { read: true, write: true, comment: false, ai: false, export: false },
      // 协同房间由服务端落地：告诉 Host 不要显示手动保存，也不要把它当普通脏文档
      ...(collabJoin
        ? {
            collab: {
              url: collabJoin.url,
              userName: collabJoin.userName,
              initialUpdate: collabJoin.initialUpdate,
            },
            ...(collabJoin.status ? { collabStatus: collabJoin.status } : {}),
          }
        : {}),
    })
    if (isDocx) docxRequest = request
    // 保存通道：协同不提交整份字节；单人编辑只要持有编辑权就建好——检查期间虽然是只读，检查通过后要能直接保存
    // （只读时 Host 自己不会触发保存）
    const saveable = !collabJoin && (options.checkAfterOpen ? lockState.value === 'held' : !readonly)
    mountNativeApp(() =>
        h(EditorHost, {
          request,
          transport: !saveable
            ? undefined
            : makeTransport({
                collection: props.collection,
                path: props.path,
                expectedSha256: () => baseSha.value,
                sessionId: session,
                maxBytes: maxReplaceBytes.value,
                label: fileName.value,
              }),
          loadSurface: async (surfaceKind: string, format?: string) => {
            if (surfaceKind === 'page' && format === 'docx') {
              const surface = makeSurface()
              docxSurface = surface
              return surface
            }
            return surfaceKind === 'grid' && format === 'xlsx' ? makeSurface() : null
          },
          // Word 编辑面自带格式 / 表格 / 插入工具栏（内置扩展 kb.builtin.page 的 edit 方案）；Excel 沿用缺省方案
          ...(isDocx ? { toolbarProfile: PAGE_EDIT_PROFILE } : {}),
          // 外层工具条已有「Excel 在线编辑 · 完成」，页头也有文件名：Chrome 再显示一遍就是同一屏两个「完成」
          chromeTitle: false,
          chromeClose: false,
          onSaved: (_revision: number, sha256: string, partsRemoved?: string[]) => {
            phase.value = 'editing'
            onShellSaved(sha256, partsRemoved)
          },
          // 让外层「不保存,关闭」按钮在编辑时也准确
          onDirty: (value: boolean) => {
            dirty.value = value
          },
          onClose: () => emit('close'),
          onError: (err: Error) => {
            error.value = `编辑器出错:${err.message}`
            // 引擎都没打开成，后台检查不会再有结果：别让界面一直停在「正在检查」
            if (checkingInPlace.value && generation === docxGeneration && !verdict.value) {
              checkingInPlace.value = false
              phase.value = 'readonly'
            }
          },
        }),
    )
    // 检查还在后台跑：保持「正在检查」，结论回来再放开 / 说明原因
    if (options.checkAfterOpen) return
    phase.value = readonly ? 'readonly' : 'editing'
  } catch (err) {
    bail(failureOf(err, '打开文档').message)
  }
}


/** 多人协同加入参数（pptx 原生协同） */
interface PptxCollabJoin {
  url: string
  userName: string
  onStatus: (status: OfficeCollabStatus) => void
  onClosed: (code: number, reason: string) => void
}

/**
 * PowerPoint 原生编辑；带 `join` 时是多人协同：幻灯片编辑面 + 整包保存。
 *
 * 先打开引擎并做一次「不改直接保存」，交给服务端和原件比：无损才放开编辑，不无损就只读并说清楚哪里会变，
 * 由用户决定要不要「仍然编辑」——和旧岛的保护完全一致。真正保存时服务端还会再整包检查一次（`replace_bytes`）。
 */
async function mountNativePptx(bytes: Uint8Array, readonly: boolean, join?: PptxCollabJoin) {
  if (!nativeHost.value) return
  phase.value = 'checking'
  let backend: import('@/editor/surfaces/slide/types').SlideEditBackend | null = null
  try {
    const [{ default: EditorHost }, { openPptxEdit }, { createPptxEditSurface }, { createPptxSaveTransport }] = await Promise.all([
      import('@/editor/host/EditorHost.vue'),
      import('@/editor/engines/pptxEdit'),
      import('@/editor/surfaces/slide/edit-surface'),
      import('@/editor/codecs/pptx'),
    ])
    if (join) {
      // 协同：连房间；文件由服务端副本落地，没有本地保存，也不做无损预检（服务端准备房间时已经检查过）
      // 协同才需要的模块（引擎协同子包、房间传输）到这里才加载：单人编辑少两个请求，慢网络下热开少一个往返
      const [{ openPptxCollab }, { openOfficeRoomTransport, createRoomStatusFeed }] = await Promise.all([
        import('@/editor/engines/pptxCollab'),
        import('@/editor/collab/OfficeTransport'),
      ])
      const room = createRoomStatusFeed(!readonly)
      const transport = openOfficeRoomTransport(join.url, (code, reason) => {
        join.onClosed(code, reason)
        // 服务端主动结束（权限收回 / 房间关了）：状态栏写「协同已结束」，不要停在「离线」
        if (code >= 4000 || code === 1000) room.close()
      })
      backend = await openPptxCollab(bytes, {
        transport,
        user: { name: join.userName },
        readonly,
        onStatus: (status) => {
          join.onStatus(status)
          room.update(status.status, status.synced)
        },
      })
      if (!nativeHost.value) {
        void Promise.resolve(backend.dispose()).catch(() => undefined)
        return
      }
      const joined = backend
      const roomRequest = reactive({
        fileId: `${props.collection}:${props.path}`,
        collection: props.collection,
        path: props.path,
        format: 'pptx',
        source: { kind: 'bytes' as const, name: fileName.value, bytes },
        readonly,
        revision: 0,
        permissions: { read: true, write: true, comment: false, ai: false, export: false },
        collab: { url: join.url, userName: join.userName },
        collabStatus: room.source,
      })
      pptxBackend = joined
      pptxRequest = roomRequest
      joined.onFailure((failure) => void rescue(failure))
      mountNativeApp(() =>
        h(EditorHost, {
          request: roomRequest,
          loadSurface: async (surfaceKind: string) => (surfaceKind === 'slide' ? createPptxEditSurface(joined, true) : null),
          chromeTitle: false,
          chromeClose: false,
          onClose: () => emit('close'),
          onError: (err: Error) => {
            error.value = `编辑器出错：${err.message}`
          },
        }),
      )
      return
    }
    // 先以只读打开：画面马上出来，无损预检在后台做（上传 + 服务端比对在慢网络下要一两秒，不该挡住"看见文档"）
    backend = await openPptxEdit(bytes, { readonly: true })
    if (!nativeHost.value) {
      void Promise.resolve(backend.dispose()).catch(() => undefined)
      return
    }
    const opened = backend
    const request = reactive({
      fileId: `${props.collection}:${props.path}`,
      collection: props.collection,
      path: props.path,
      format: 'pptx',
      source: { kind: 'bytes' as const, name: fileName.value, bytes },
      readonly: true,
      revision: 0,
      permissions: { read: true, write: true, comment: false, ai: false, export: false },
    })
    pptxBackend = opened
    pptxRequest = request
    opened.onFailure((failure) => void rescue(failure))
    mountNativeApp(() =>
        h(EditorHost, {
          request,
          transport: createPptxSaveTransport({
            collection: props.collection,
            path: props.path,
            expectedSha256: () => baseSha.value,
            sessionId: session,
            maxBytes: maxReplaceBytes.value,
            label: fileName.value,
          }),
          loadSurface: async (surfaceKind: string) => (surfaceKind === 'slide' ? createPptxEditSurface(opened) : null),
          chromeTitle: false,
          chromeClose: false,
          onSaved: (_revision: number, sha256: string, partsRemoved?: string[]) => onShellSaved(sha256, partsRemoved),
          onDirty: (value: boolean) => {
            dirty.value = value
          },
          onClose: () => emit('close'),
          onError: (err: Error) => {
            error.value = `编辑器出错：${err.message}`
          },
        }),
    )
    if (readonly) {
      phase.value = 'readonly'
      return
    }
    checkingInPlace.value = true
    phase.value = 'checking'
    try {
      const checked = await roundtripCheck(props.collection, props.path, await opened.save())
      if (pptxBackend !== opened) return
      report.value = checked
      if (checked.lossless) {
        opened.setReadonly(false)
        request.readonly = false
        phase.value = 'editing'
      } else {
        phase.value = 'readonly'
      }
    } catch (err) {
      if (pptxBackend !== opened) return
      // 检查没做成（网络 / 服务端）：保持只读并说明，不能在没验证的情况下放开编辑
      error.value = `无法确认这份文档能否无损编辑，已保持只读：${failureOf(err, '检查').message}`
      phase.value = 'readonly'
    } finally {
      checkingInPlace.value = false
    }
  } catch (err) {
    checkingInPlace.value = false
    if (backend) void Promise.resolve(backend.dispose()).catch(() => undefined)
    bail(failureOf(err, '打开文档').message)
  }
}

/** 引擎会话崩溃：抢救一份恢复副本给用户下载，不丢稿 */
async function rescue(failure: Error) {
  const bytes = await pptxBackend?.recover()
  if (bytes?.byteLength) {
    const { rememberRecovery } = await import('@/editor/recovery')
    const name = `${fileName.value.replace(/\.pptx$/i, '')}（恢复副本）.pptx`
    void rememberRecovery(`${props.collection}:${props.path}`, bytes)
    if (recovery.value) URL.revokeObjectURL(recovery.value.url)
    recovery.value = { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })), name }
  }
  // 放在最后写：外壳自己也会因为同一个故障报一条通用错误，这条带恢复指引的要盖在它上面
  error.value = `编辑引擎出错了：${failure.message}。修改已经停止${recovery.value ? '，已保存一份恢复副本，请先下载' : ''}。`
}
/** 协同模式:从房间底稿打开(浏览器缓存里有就不再下载),连上房间。 */
async function openCollab(prepared: OfficeSession) {
  const doc = docRef.value
  if (!doc || !prepared.base_sha) return
  collab.value = prepared
  collabClosed.value = ''
  report.value = prepared.report && !prepared.lossless ? { ...prepared.report, lossless: false, text_equal: !!prepared.forceable } : null
  const [bytes, initialUpdate] = await Promise.all([
    fetchOfficeBase(doc, prepared.base_sha),
    kind.value === 'docx' ? fetchOfficeSeed(doc) : Promise.resolve(undefined),
  ])
  const userName = account.user?.display_name || account.user?.username || '我'
  const alertClosed = (code: number, reason: string) => {
    if (code >= 4000 || code === 1000) collabClosed.value = reason || '连接被关闭了'
  }
  // Excel 已迁到原生网格：同一份底稿字节 + Yrs 副本即可汇合，AI / 另一浏览器都走同一个房间
  if (kind.value === 'xlsx') {
    if (!nativeHost.value) return
    // 房间状态来源与 pptx 同一套（协同房间传输模块只在协同时才下载）：引擎的连接状态翻成状态栏的房间状态
    const { createRoomStatusFeed } = await import('@/editor/collab/OfficeTransport')
    if (!nativeHost.value) return
    const room = createRoomStatusFeed(!!prepared.writable)
    const options = createXlsxCollabOptions({
      url: officeCollabUrl(doc),
      userName,
      initialUpdate,
      onStatus: (status) => {
        collabStatus.value = {
          status: status.status,
          synced: status.synced,
          peers: status.peers.map((peer) => peer.name),
        }
        room.update(status.status, status.synced)
      },
      onClosed: (code, reason) => {
        alertClosed(code, reason)
        // 服务端主动结束（权限收回 / 房间关了）：状态栏写「协同已结束」，不要停在「离线」
        if (code >= 4000 || code === 1000) room.close()
      },
    })
    await mountNative(bytes, !prepared.writable, {
      xlsx: options,
      url: officeCollabUrl(doc),
      userName,
      initialUpdate,
      status: room.source,
    })
    phase.value = prepared.writable ? 'editing' : 'readonly'
    return
  }
  // PowerPoint 协同：幻灯片编辑面直连房间，AI / 另一浏览器走同一个房间
  if (kind.value === 'pptx') {
    if (!nativeHost.value) return
    await mountNativePptx(bytes, !prepared.writable, {
      url: officeCollabUrl(doc),
      userName,
      onStatus: (status) => (collabStatus.value = status),
      onClosed: alertClosed,
    })
    phase.value = prepared.writable ? 'editing' : 'readonly'
    return
  }
  // Word 原生编辑面：同一份底稿字节 + 服务端发的初始状态，经传输和房间同步；只读连接能看到别人的修改和光标
  if (kind.value === 'docx') {
    if (!nativeHost.value) return
    // 房间状态来源与 xlsx / pptx 同一套：不给宿主它，状态栏会一直停在「正在连接协同…」（修 xlsx 时发现的同一个问题）
    const { createRoomStatusFeed } = await import('@/editor/collab/OfficeTransport')
    if (!nativeHost.value) return
    const room = createRoomStatusFeed(!!prepared.writable)
    const docxOptions = createDocxCollabOptions({
      url: officeCollabUrl(doc),
      userName,
      initialUpdate,
      writable: prepared.writable === true,
      onStatus: (status) => {
        collabStatus.value = { status: status.status, synced: status.synced, peers: status.peers.map((peer) => peer.name) }
        room.update(status.status, status.synced)
      },
      onClosed: (code, reason) => {
        alertClosed(code, reason)
        // 服务端主动结束（权限收回 / 房间关了）：状态栏写「协同已结束」，不要停在「离线」
        if (code >= 4000 || code === 1000) room.close()
      },
    })
    await mountNative(bytes, !prepared.writable, { docx: docxOptions, url: officeCollabUrl(doc), userName, initialUpdate, status: room.source })
    phase.value = prepared.writable ? 'editing' : 'readonly'
    return
  }
}

/** 协同模式下「仍然编辑」:告诉服务端确认了,房间放开编辑,重新打开 */
async function forceCollab() {
  if (!collab.value?.forceable) return
  await open(true)
}

/** 文字没变、只是格式细节会变:用户明确要继续时放开编辑 */
function forceEdit() {
  if (!canForce.value) return
  if (pptxBackend && pptxRequest) {
    // 原生 pptx：引擎早已打开，放开只读标志即可（会话读的是同一个响应式请求对象）
    pptxBackend.setReadonly(false)
    pptxRequest.readonly = false
    phase.value = 'editing'
    return
  }
  if (nativeApp && nativeBytes) {
    // Word 宿主：用户确认后重挂成可编辑（只读是会话创建时定下的）
    const bytes = nativeBytes
    phase.value = 'checking'
    void mountNative(bytes, false)
  }
}

/**
 * 外壳保存成功后的善后：换上新哈希（下一次保存要带它，文件在这之后被别人改过会被服务端拒绝）、清脏标记，
 * 文件里少了部件时提醒用户（常见原因是编辑器清理了没人引用的图片；保存之前的内容在版本历史里可以恢复）。
 */
function onShellSaved(sha256: string, partsRemoved?: string[]) {
  if (sha256) baseSha.value = sha256
  dirty.value = false
  const removed = partsRemoved ?? []
  notice.value = removed.length
    ? `保存后文件里少了 ${removed.length} 个部件(${removed.slice(0, 3).join('、')}${removed.length > 3 ? ' 等' : ''})。通常是编辑器清理了没人引用的图片之类;如果和你预期的不一样,保存之前的内容在版本历史里,可以恢复。`
    : ''
  emit('saved')
}

/** 有没保存的改动时,关标签页 / 刷新前让浏览器提醒一下 */
function warnBeforeLeaving(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
  // 协同模式:修改实时发给服务端;只有断着线、还没同步上时离开才可能丢
  if (collab.value && collabStatus.value.status !== 'connected') event.preventDefault()
}

onMounted(() => {
  window.addEventListener('beforeunload', warnBeforeLeaving)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)
  void open()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnBeforeLeaving)
  window.removeEventListener('pagehide', onPageHide)
  document.removeEventListener('visibilitychange', onVisibility)
  stopBeat()
  // 关掉编辑器就交还编辑权,别人马上能编辑
  if (lockState.value === 'held') void releaseLock(props.collection, props.path, session)
  // 协同必须在这里卸载：EditorHost -> Surface -> 工作簿 destroy -> 断开房间
  nativeApp?.unmount()
  nativeApp = null
  // 后台的无损检查跟着停：探针的临时引擎会话取消，迟到的结论也不能再去动已经销毁的编辑面
  docxGeneration += 1
  docxCheckAbort?.abort()
  docxCheckAbort = null
  docxSurface = null
  docxRequest = null
})

defineExpose({ dirty })
</script>

<template>
  <div class="kb-office" data-testid="office-editor">
    <div class="kb-office-bar">
      <KbBadge tone="neutral" title="在页面里直接改;保存后原文件被替换,旧内容留在版本历史里">{{ kindName }} 在线编辑</KbBadge>
      <span v-if="collab && phase !== 'loading'" class="kb-office-note" data-testid="office-collab-status">{{ collabText }}</span>
      <span v-if="phase === 'loading'" class="kb-office-note">正在打开…</span>
      <span v-else-if="phase === 'checking'" class="kb-office-note" data-testid="office-checking">正在检查这份文档能否无损编辑…</span>
      <span v-else-if="phase === 'readonly'" class="kb-office-note" data-testid="office-readonly">只读</span>
      <span v-else-if="dirty" class="kb-office-note" data-testid="office-dirty">有未保存的改动</span>
      <span class="kb-office-spacer" />
      <button v-if="canForce" type="button" class="btn sm" data-testid="office-force" @click="collab ? forceCollab() : forceEdit()">仍然编辑</button>
      <button type="button" class="btn sm" data-testid="office-close" @click="emit('close')">{{ dirty ? '不保存,关闭' : '完成' }}</button>
    </div>

    <div v-if="error" class="kb-error" role="alert" data-testid="office-error">{{ error }}</div>
    <div v-if="collabClosed" class="kb-error kb-office-lost" role="alert" data-testid="office-collab-closed">
      <span>{{ collabClosed }}</span>
      <button type="button" class="btn sm" @click="open()">重新打开</button>
    </div>
    <!-- 为什么只读：无损检查的结论（会丢内容 / 会改写别的部件）。没有这一行用户只看到「只读」，不知道原因 -->
    <div v-if="concern && phase === 'readonly' && lockState === 'held'" class="kb-office-concern" role="status" data-testid="office-concern">{{ concern }}</div>
    <div v-if="singleReason" class="kb-office-concern" role="status" data-testid="office-single-reason">这份文档现在只能一个人编辑:{{ singleReason }}</div>
    <div v-if="lockState === 'other'" class="kb-office-concern" role="status" data-testid="office-locked">
      <span>{{ holderName }}正在编辑这份文档(最近 {{ holderIdle }} 秒前还有动静),你现在只能查看。</span>
      <button type="button" class="btn sm" data-testid="office-recheck" @click="open()">重新检查</button>
      <button v-if="!confirmingTakeover" type="button" class="btn sm" data-testid="office-takeover" @click="confirmingTakeover = true">接手编辑</button>
      <template v-else>
        <span>接手后对方没保存的改动会丢,确定吗?</span>
        <button type="button" class="btn sm pri" data-testid="office-takeover-confirm" @click="open(true)">确定接手</button>
        <button type="button" class="btn sm" @click="confirmingTakeover = false">取消</button>
      </template>
    </div>
    <div v-if="lockState === 'lost'" class="kb-error kb-office-lost" role="alert" data-testid="office-lost">
      <span>{{ holderName ? `${holderName}接手了这份文档的编辑` : '这个窗口的编辑权已经失效' }},这个窗口现在只读,没保存的改动不会被保存。需要的内容请先复制出来,再重新打开。</span>
      <button type="button" class="btn sm" data-testid="office-reopen" @click="open()">重新打开</button>
    </div>
    <div v-if="offline && lockState === 'held'" class="kb-office-concern" role="status" data-testid="office-offline">和服务器联系不上了。超过 {{ ttlSecs }} 秒联系不上,编辑权会自动失效,到时候别人可以接手;网络恢复后会自动续上。</div>
    <div v-if="concern" class="kb-office-concern" role="status" data-testid="office-concern">{{ concern }}</div>
    <div v-if="notice" class="kb-office-concern" role="status" data-testid="office-notice">{{ notice }}</div>
    <div v-if="recovery" class="kb-office-concern" role="alert" data-testid="office-recovery">
      <span>已保存一份恢复副本，请下载后再重新打开这份文档。</span>
      <a class="btn sm pri" :href="recovery.url" :download="recovery.name" data-testid="office-recovery-download">下载恢复副本</a>
    </div>
    <KbButton v-if="phase === 'refused'" size="sm" variant="primary" @click="open">重试</KbButton>

    <div class="kb-office-stage">
      <!-- 外壳自带 Chrome、保存与快捷键 -->
      <div ref="nativeHost" class="kb-office-host kb-office-native" data-testid="office-native-host" />
      <!-- 检查完成之前盖住,免得用户在还不能编辑时就动手 -->
      <div v-if="phase === 'loading' || (phase === 'checking' && !checkingInPlace)" class="kb-office-veil" data-testid="office-veil"><KbSkeleton variant="card" :lines="4" /></div>
    </div>
  </div>
</template>

<style>
.kb-office {
  flex: 1;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r2);
  overflow: hidden;
}
.kb-office-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: var(--hl) solid var(--b);
}
.kb-office-note {
  color: var(--m);
  font-size: calc(12px * var(--fs));
  white-space: nowrap;
}
.kb-office-spacer {
  flex: 1;
}
.kb-office-concern,
.kb-office-lost {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.kb-office-concern {
  padding: 8px 10px;
  color: var(--t);
  background: var(--acbg);
  font-size: calc(13px * var(--fs));
}
.kb-office-stage {
  position: relative;
  flex: 1;
  min-height: 0;
}
.kb-office-host {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.kb-office-veil {
  position: absolute;
  inset: 0;
  padding: 16px;
  background: var(--surface-1);
}
</style>
