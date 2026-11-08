<script setup lang="ts">
// 搜索演练场(搜索演练场设计稿):所有结果、名次、耗时都来自真实的 search_knowledge 响应。
// 左侧是命中卡片,右侧「Explain」面板展示选中命中在各检索阶段的名次与解析结果;
// 阶段分数与分阶段耗时后端不返回,所以不画。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import { KbBadge, KbButton, KbEmpty, KbHBars, KbIcon, KbPager, KbSelect, KbSheet, KbSkeleton, KbSwitch, PHONE_QUERY, isComposing, useMedia } from '@kb-ui/index'
import SearchAdvanced from '@/components/search/SearchAdvanced.vue'
import { callCapability, type SearchHit, type SearchResponse } from '@/api/client'
import { sharedWithMe } from '@/api/share'
import { useSessionStore } from '@/stores/session'
import { failureOf } from '@/utils/loadState'
import { hasLiteralHit, queryTerms, snippetWindow, splitByTerms, type Piece } from '@/utils/queryTerms'
import { hasExtraTimings, timingRows } from '@/utils/searchCharts'
import { DEFAULT_SCOPE, MAX_HITS, MAX_SHARED_HITS, PAGE_SIZES, PREFS_KEY, changedCount, degradedText, rerankParam, hitRoute, hitSource, kindLabel, parseScope, pickScope, readPrefs, scopeOptions, type AnyHit, type SearchPrefs } from '@/utils/search'

const route = useRoute()
const router = useRouter()

const query = ref(typeof route.query.q === 'string' ? route.query.q : '')
// 范围是下拉里选的一个值(见 utils/search 的 parseScope);重排 / 排序依据 / 返回条数是「高级选项」,会记住
// 范围和搜索词一样写在地址里(?scope=):从结果点进文档再「后退」回来,范围不能丢,不然同一个地址会搜出另一批结果
const scopeValue = ref(typeof route.query.scope === 'string' ? route.query.scope : DEFAULT_SCOPE)
const choice = computed(() => parseScope(scopeValue.value))
const prefs = ref<SearchPrefs>(readPrefs(localStorage.getItem(PREFS_KEY)))
watch(prefs, (value) => localStorage.setItem(PREFS_KEY, JSON.stringify(value)), { deep: true })
// 改了高级选项或范围,已经出来的结果要按新设置重搜才对得上(例如「排序依据」:关着的时候后端根本没算,只拨开关页面不会有变化)。
// 还没搜过就不动;正在搜的时候又改了,等这一次结束再按最新设置补一次,不丢也不重叠
let rerunQueued = false
watch([() => prefs.value.rerank, () => prefs.value.explain, scopeValue], () => {
  if (deep.value) return // 深度检索不看这些选项
  // 正在搜(第一次搜索时 searchedQuery 还是空,所以先看 loading)
  if (loading.value) {
    rerunQueued = true
    return
  }
  if (searchedQuery.value) void run(searchedQuery.value)
})
const rerank = computed(() => prefs.value.rerank)
const explain = computed(() => prefs.value.explain)
const onlyInsights = ref(false)
const session = useSessionStore()
const canTune = computed(() => session.has('search.tune'))
const deep = ref(false)
const deepAnswer = ref('')
const advOpen = ref(false)
const phone = useMedia(PHONE_QUERY)
/** 宽屏才放右侧预览:1024–1279 的结果区还要留给正文,硬塞一列会把摘要压成两条 */
const wide = useMedia('(min-width: 1280px)')
/** 有人分享给我的内容有几项(没有就不出现「共享」范围) */
const sharedCount = ref(0)
const loading = ref(false)
const error = ref('')
/** 报错里要不要给「重试」:没开通功能(403)重试也不会变,不给 */
const errorRetry = ref(true)
const response = ref<SearchResponse | null>(null)
const searchedQuery = ref('')
const elapsed = ref(0)
const selected = ref(0)
const feedback = ref<Record<string, boolean>>({})
const projects = ref<string[]>([])
const recent = ref<string[]>(readRecent())
const historyOpen = ref(false)
const activeHistoryIndex = ref(-1)
const searchbarWrap = ref<HTMLElement | null>(null)
let ready = false
/** 边输入边搜(UI-5):停顿一下再发,不抢回车;显式回车会取消等待,不会发出两次 */
const LIVE_DELAY = 280
/** 一个字就搜会边打字边闪结果,至少两个字(中英文都按字符算) */
const LIVE_MIN = 2
let liveTimer = 0
/** 最近一次真正发出去(或即将发出)的全文:防止「run 回写 query」又触发一次监听的循环 */
let lastLive = ''
/** 请求序号:晚到的旧响应不能盖掉新结果;同时负责让「清空输入」取消在途请求 */
let requestSeq = 0
/** 融合参数 RRF 的 k(config.search.rrf_k);读不到就不显示这个控件 */
const rrfK = ref<number | null>(null)
const input = ref<HTMLInputElement | null>(null)

/** 搜索框里的前缀:`#insight`(类型)、`@knowledgeBase`(项目)显示成前置的小标签,其余原样留在文本里 */
const KIND_ALIAS = new Set(['insight', 'code', 'doc'])
const prefixChips = computed(() => {
  const chips: { key: string; label: string }[] = []
  for (const word of query.value.split(/\s+/)) {
    if (/^#\S+$/.test(word)) chips.push({ key: word, label: word })
    else if (/^@\S+$/.test(word)) chips.push({ key: word, label: word })
    else if (/^kind:(insight|code|doc)$/i.test(word)) chips.push({ key: word, label: `#${word.slice(5).toLowerCase()}` })
  }
  return chips
})
/** 去掉 chips 对应的词后,输入框里剩下的"正文" */
const plainText = computed(() =>
  query.value
    .split(/\s+/)
    .filter((word) => word && !prefixChips.value.some((chip) => chip.key === word))
    .join(' '),
)
void KIND_ALIAS
function setPlain(value: string) {
  const prefixes = query.value.split(/\s+/).filter((word) => prefixChips.value.some((chip) => chip.key === word))
  query.value = [...prefixes, value].filter((part) => part !== '').join(' ')
}
function removeChip(key: string) {
  query.value = query.value.split(/\s+/).filter((word) => word !== key).join(' ')
  input.value?.focus()
}

/** 「范围」只有一个下拉:当前项目 / 指定项目 / 全部集合 / _global,有人分享内容给我时再加两项共享范围 */
const scopeAll = computed(() => scopeOptions(projects.value, sharedCount.value))
/** 高级选项折叠起来时,在按钮上提示「这里有改动」 */
const advChanged = computed(() => changedCount(prefs.value))

function readRecent(): string[] {
  try {
    return (JSON.parse(localStorage.getItem('kb.search.recent') ?? '[]') as string[]).slice(0, 8)
  } catch {
    return []
  }
}
function remember(text: string) {
  recent.value = [text, ...recent.value.filter((item) => item !== text)].slice(0, 8)
  localStorage.setItem('kb.search.recent', JSON.stringify(recent.value))
}
function removeRecent(text: string) {
  recent.value = recent.value.filter((item) => item !== text)
  localStorage.setItem('kb.search.recent', JSON.stringify(recent.value))
  if (!recent.value.length) {
    historyOpen.value = false
    activeHistoryIndex.value = -1
  } else if (activeHistoryIndex.value >= recent.value.length) {
    activeHistoryIndex.value = recent.value.length - 1
  }
}
function clearRecent() {
  recent.value = []
  localStorage.removeItem('kb.search.recent')
  historyOpen.value = false
  activeHistoryIndex.value = -1
}
function pickHistory(text: string) {
  query.value = text
  historyOpen.value = false
  activeHistoryIndex.value = -1
  void run(text)
}
function onInputClick() {
  if (recent.value.length) {
    historyOpen.value = true
    activeHistoryIndex.value = -1
  }
}
function onInputKeydown(event: KeyboardEvent) {
  if (isComposing(event)) {
    if (event.key === 'Enter') event.preventDefault()
    return
  }
  if (!historyOpen.value || !recent.value.length) {
    if (event.key === 'ArrowDown' && recent.value.length) {
      historyOpen.value = true
      activeHistoryIndex.value = 0
      event.preventDefault()
    }
    return
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeHistoryIndex.value = (activeHistoryIndex.value + 1) % recent.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeHistoryIndex.value =
      activeHistoryIndex.value <= 0 ? recent.value.length - 1 : activeHistoryIndex.value - 1
  } else if (event.key === 'Enter') {
    if (activeHistoryIndex.value >= 0 && activeHistoryIndex.value < recent.value.length) {
      event.preventDefault()
      pickHistory(recent.value[activeHistoryIndex.value])
    } else {
      historyOpen.value = false
    }
  } else if (event.key === 'Escape') {
    event.preventDefault()
    historyOpen.value = false
    activeHistoryIndex.value = -1
  }
}
function onClickOutside(event: MouseEvent) {
  const target = event.target as Node | null
  if (searchbarWrap.value && !searchbarWrap.value.contains(target)) {
    historyOpen.value = false
    activeHistoryIndex.value = -1
  }
}

/** 查询里要高亮的词(中文按词切、去过滤前缀和虚词,见 utils/queryTerms) */
const terms = computed(() => queryTerms(searchedQuery.value))
/** 摘要:围着第一个命中截,再按词切成"命中 / 没命中"的片段 */
function parts(text: string): Piece[] {
  return splitByTerms(snippetWindow(text, terms.value), terms.value)
}
/** 这条结果里没有任何一处出现查询词(纯语义相似):没有可高亮的地方,界面标一句,不让人以为高亮坏了 */
function semanticOnly(hit: SearchHit): boolean {
  return !hasLiteralHit([hit.title, hit.symbol, hit.source, hit.snippet], terms.value)
}
/** 标题 / 来源也高亮命中的词(不截取) */
function titleParts(text: string): Piece[] {
  return splitByTerms(text, terms.value)
}

/** 这次搜到的全部结果(最多 MAX_HITS 条);翻页只是在这批里切片,不重搜 */
const allHits = computed(() => response.value?.hits ?? [])
const page = ref(1)
const pageSize = computed(() => prefs.value.pageSize)
const pageStart = computed(() => (page.value - 1) * pageSize.value)
/** 当前页的结果。`selected` 和名次都是在全部结果里的位置,不是页内位置 */
const hits = computed(() => allHits.value.slice(pageStart.value, pageStart.value + pageSize.value))
/** 结果被服务器的上限截断了:到上限条数,说明后面可能还有 */
const capped = computed(() => allHits.value.length >= (choice.value.kind === 'shared' ? MAX_SHARED_HITS : MAX_HITS))
const degraded = computed(() => degradedText(response.value?.degraded))
// 换每页条数:回到第一页,选中项落在第一条
watch(pageSize, () => {
  page.value = 1
  selected.value = 0
})
function goPage(next: number) {
  page.value = next
  selected.value = (next - 1) * pageSize.value
  void nextTick(() => document.querySelector('.kb-hits')?.scrollIntoView?.({ block: 'start' }))
}
/** 过滤条件标签:后端解析出的 filters(key=value)+ 实际检索的范围;都是响应里的真实内容 */
const filterChips = computed(() => {
  const parsed = (response.value?.query_parsed ?? {}) as { filters?: Record<string, unknown> }
  const list = Object.entries(parsed.filters ?? {})
    .filter(([, value]) => value !== null && value !== '' && typeof value !== 'object')
    .map(([key, value]) => `${key}=${String(value)}`)
  for (const name of response.value?.scope ?? []) if (!list.some((chip) => chip.endsWith(`=${name}`))) list.push(`scope=${name}`)
  return list
})
/** 链路一行:返回条数是真实的;rerank 是否参与取决于开关(召回 / 融合的候选数后端不返回,不写) */
const chainLine = computed(() => `${rerank.value ? '融合 → rerank → ' : '融合 → '}返回 ${allHits.value.length}`)
const current = computed<SearchHit | null>(() => allHits.value[selected.value] ?? null)
const where = (hit: SearchHit) => {
  const base = hit.kind === 'insight' ? hit.collection : `${hit.collection} · ${hit.source}`
  return hit.start_line ? `${base}:${hit.start_line}` : base
}
const stages = (hit: SearchHit, index: number) => {
  const info = hit.explain
  // 名次与原始分数都来自后端 explain(explain 打开时后端会额外跑一次纯全文 / 纯向量检索)
  const list: { name: string; rank: number | null; score?: string; lead: boolean }[] = []
  const fmt = (value?: number | null) => (value == null ? undefined : value.toFixed(3))
  if (info?.fts_rank != null) {
    list.push({ name: 'BM25', rank: info.fts_rank, score: fmt(info.fts_score), lead: info.fts_rank === 1 })
  }
  if (info?.vector_rank != null) {
    list.push({ name: '向量', rank: info.vector_rank, score: fmt(info.vector_score), lead: info.vector_rank === 1 })
  }
  if (info?.fused_rank != null) {
    list.push({ name: 'RRF', rank: info.fused_rank, lead: info.fused_rank === 1 })
  }
  list.push({ name: response.value?.reranked ? '重排' : '最终', rank: index + 1, score: hit.score.toFixed(3), lead: index === 0 })
  return list
}
/** Explain 面板里的耗时条(后端在 explain 打开时采集;没有就不显示)。 */
const timings = computed(() => timingRows(response.value?.timings))
// 灰色的两项是 explain 额外多跑的两趟,不能和主链路的几项加起来当总耗时,有耗时才需要说明
const extraNote = computed(() => (hasExtraTimings(timings.value) ? '灰色的两项是查看排序依据时额外多跑的两趟(有多个集合会累加),不计入上面几项的总耗时。' : ''))

/** 得分构成:RRF 公式 / rerank / 最终分(设计稿的 Explain 面板同款)。 */
const scoreLines = computed(() => {
  const hit = current.value
  const info = hit?.explain
  if (!hit || !info) return []
  const k = rrfK.value ?? 60
  const lines: string[] = []
  // 后端算的是跨 collection 的加权 RRF:`Σ weight / (k + store_rank)`,一条命中通常只有一项。
  // 表内的 BM25 + 向量融合在 LanceDB 内部完成,所以这里只展示后端真正算的那一项。
  if (info.store_rank != null && info.fused_score != null) {
    const weight = info.fused_weight ?? 1
    lines.push(
      `rrf    = ${weight} × 1/(${k}+${info.store_rank}) = ${info.fused_score.toFixed(4)}`,
    )
  }
  if (info.rerank_rank != null) {
    lines.push(`rerank = ${hit.score.toFixed(3)}  (Δrank ${(info.store_rank ?? info.rerank_rank) - info.rerank_rank})`)
  }
  lines.push(`final  = ${hit.score.toFixed(3)}`)
  return lines
})
/** Explain 面板里的名次条:名次越靠前条越长(以返回条数为 100%) */
const rankWidth = (rank: number | null) => {
  const span = Math.max(allHits.value.length, 10)
  return rank == null ? 0 : Math.max(4, Math.round(((span - rank + 1) / span) * 100))
}

/** 清掉结果区(输入被清空 / 不到最小长度时):同时让在途请求作废,别让旧结果过一会儿又冒出来 */
function clearLive() {
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = 0
  }
  lastLive = ''
  requestSeq += 1
  rerunQueued = false
  loading.value = false
  response.value = null
  deepAnswer.value = ''
  searchedQuery.value = ''
  error.value = ''
  elapsed.value = 0
  selected.value = 0
  page.value = 1
  // 输入清空后地址也跟着回到「没有搜索词」,否则刷新 / 后退还会带回一个已经不在输入框里的旧词
  void router.replace({ query: {} })
}

/**
 * 搜索。`live` 是边输入边搜:不记历史、不要求用户按回车;地址照样用 replace 更新,
 * 这样从结果点进文档再后退,范围和搜索词都还在(和手动搜索同一条恢复路径)。
 * 并发用序号保护:快速改词时只认最后一次响应,旧请求的错误也不弹。
 */
async function run(text = query.value, options: { live?: boolean } = {}) {
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = 0
  }
  historyOpen.value = false
  activeHistoryIndex.value = -1
  const trimmed = text.trim()
  if (!trimmed) return
  query.value = trimmed
  lastLive = trimmed
  const seq = ++requestSeq
  loading.value = true
  error.value = ''
  deepAnswer.value = ''
  const started = performance.now()
  const effective = onlyInsights.value && !/kind:/i.test(trimmed) ? `${trimmed} kind:insight` : trimmed
  try {
    if (deep.value) {
      const result = await callCapability<{ answer: string; rounds: number; trace: { title?: string }[] }>('deep_search', {
        question: trimmed,
        ...(choice.value.kind === 'mine' && choice.value.project ? { project: choice.value.project } : {}),
      })
      if (seq !== requestSeq) return
      deepAnswer.value = `${result.answer}\n\n（${result.rounds} 轮）`
      response.value = null
      searchedQuery.value = trimmed
      elapsed.value = Math.max(1, Math.round(performance.now() - started))
      remember(trimmed)
      return
    }
    let next: SearchResponse
    if (choice.value.kind === 'shared') {
      // 在别人分享给我的内容里搜(可连同我自己的一起);后端逐条重新算过我的权限,命中里带分享人和我的角色。
      // 共享检索没有重排 / 排序依据这些选项,命中也没有 explain
      const shared = await callCapability<{ hits: AnyHit[] }>('search_shared', { query: effective, scope: choice.value.include, k: MAX_SHARED_HITS })
      next = { hits: shared.hits ?? [], scope: [], query_parsed: {}, degraded: null }
    } else {
      next = await callCapability<SearchResponse>('search_knowledge', {
        query: effective,
        k: MAX_HITS,
        ...rerankParam(prefs.value),
        explain: prefs.value.explain,
        ...(choice.value.scope !== 'auto' ? { scope: choice.value.scope } : {}),
        ...(choice.value.project ? { project: choice.value.project } : {}),
      })
    }
    if (seq !== requestSeq) return
    response.value = next
    searchedQuery.value = trimmed
    elapsed.value = Math.max(1, Math.round(performance.now() - started))
    selected.value = 0
    page.value = 1
    // 边输入边搜不写历史:历史只记用户明确提交过的词,否则每打一个字都会多一条
    if (!options.live) remember(trimmed)
    void router.replace({ query: { q: trimmed, ...(scopeValue.value !== DEFAULT_SCOPE ? { scope: scopeValue.value } : {}) } })
  } catch (err) {
    if (seq !== requestSeq) return
    // 服务端的原话常是英文前缀(internal: …),按全站统一的写法换成「发生了什么 + 怎么办」
    const failure = failureOf(err, '搜索')
    error.value = failure.message
    errorRetry.value = failure === null ? false : failure.phase === 'error'
    response.value = null
  } finally {
    if (seq === requestSeq) {
      loading.value = false
      if (rerunQueued) {
        rerunQueued = false
        if (!deep.value) void run(searchedQuery.value || trimmed)
      }
    }
  }
}

// 边输入边搜:停顿 280ms 再发;回车 / 点搜索会立刻取消这个计时器,不会重复请求。
// 深度检索不走自动:它要跑多轮模型,应该由用户明确提交。
watch(query, () => {
  if (!ready) return
  const text = query.value.trim()
  if (text === lastLive) return
  // 词一变,在途的旧请求立刻作废:别让上一轮的结果在 280ms 的等待里先闪一下
  requestSeq += 1
  if (liveTimer) {
    clearTimeout(liveTimer)
    liveTimer = 0
  }
  if (!text || [...text].length < LIVE_MIN) {
    clearLive()
    return
  }
  if (deep.value) return
  liveTimer = window.setTimeout(() => {
    liveTimer = 0
    void run(query.value, { live: true })
  }, LIVE_DELAY)
})

// 打开深度检索时取消还在等的自动搜索:它要跑多轮模型,不能替用户自动提交
watch(deep, (on) => {
  if (!on || !liveTimer) return
  clearTimeout(liveTimer)
  liveTimer = 0
})

function openHit(hit: SearchHit) {
  const target = hitRoute(hit as AnyHit)
  // 把查询带到文档页:打开后整篇文档里命中的词都高亮(`hq` 只用来高亮,不参与任何检索或过滤)
  const query = searchedQuery.value.trim().slice(0, 200)
  void router.push(query ? { ...target, query: { ...target.query, hq: query } } : target)
}
async function rate(hit: SearchHit, useful: boolean) {
  try {
    await callCapability('kb_feedback', { query: searchedQuery.value, item_id: hit.id, useful })
    feedback.value = { ...feedback.value, [hit.id]: useful }
  } catch (err) {
    const failure = failureOf(err, '提交反馈')
    error.value = failure.message
    errorRetry.value = failure === null ? false : failure.phase === 'error'
  }
}

/** 「/」聚焦搜索框;结果里 ↑↓ 切换选中 */
/** 自己会响应 Enter 的元素:全局的「Enter 打开选中结果」不能抢它们的按键 */
const INTERACTIVE = 'button, a[href], summary, [role=button], [role=switch], [role=tab], [role=menuitem], [role=checkbox]'
function onKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  // 带 Shift 的斜杠是「?」(快捷键表),不是聚焦搜索框
  if (event.key === '/' && !event.shiftKey && !typing && !event.metaKey && !event.ctrlKey) {
    event.preventDefault()
    input.value?.focus()
    onInputClick()
  } else if (!typing && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && allHits.value.length) {
    event.preventDefault()
    selected.value = Math.min(allHits.value.length - 1, Math.max(0, selected.value + (event.key === 'ArrowDown' ? 1 : -1)))
    page.value = Math.floor(selected.value / pageSize.value) + 1
  } else if (!typing && event.key === 'Enter' && current.value && !target?.closest(INTERACTIVE)) {
    // 焦点在按钮 / 链接上时,Enter 是它自己的点击(例如「高级选项」),不能再顺手打开选中的结果
    openHit(current.value)
  }
}
watch(selected, async () => {
  await nextTick()
  document.querySelector('.kb-hit.is-selected')?.scrollIntoView?.({ block: 'nearest' })
})

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('mousedown', onClickOutside)
  const [listed, config] = await Promise.all([
    callCapability<{ projects: { project: { name: string } }[] }>('list_projects').catch(() => null),
    callCapability<{ search?: { rrf_k?: number } }>('get_config').catch(() => null),
  ])
  projects.value = listed?.projects.map((item) => item.project.name) ?? []
  rrfK.value = config?.search?.rrf_k ?? null
  // 有没有人分享内容给我:决定要不要给「共享」范围。取不到就当没有,不挡住搜索
  sharedCount.value = ((await sharedWithMe(false).catch(() => null))?.items ?? []).filter((item) => !item.hidden).length
  scopeValue.value = pickScope(scopeValue.value, scopeAll.value)
  if (query.value) await run()
  else input.value?.focus()
  await nextTick()
  ready = true
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('mousedown', onClickOutside)
  if (liveTimer) clearTimeout(liveTimer)
})
</script>

<template>
  <AppShell rail>
    <template #breadcrumb><b>搜索</b></template>

    <div class="card kb-search-top">
      <form class="row kb-search-row" role="search" @submit.prevent="run()">
        <div ref="searchbarWrap" class="kb-searchbar-wrap">
          <label class="inp kb-searchbar" :class="{ 'is-focus': true }">
            <button v-for="chip in prefixChips" :key="chip.key" type="button" class="tag ac kb-chip" :title="`移除 ${chip.label}`" @click.prevent="removeChip(chip.key)">{{ chip.label }}</button>
            <input
              ref="input"
              :value="plainText"
              class="kb-searchbar-input"
              type="text"
              enterkeyhint="search"
              autocomplete="off"
              spellcheck="false"
              :placeholder="prefixChips.length ? '' : phone ? '输入问题或关键词' : '输入问题或关键词,例如:双哈希增量索引 kind:doc'"
              aria-label="搜索"
              @click="onInputClick"
              @input="setPlain(($event.target as HTMLInputElement).value)"
              @keydown="onInputKeydown"
            />
            <span class="m kb-searchbar-hint">前缀: <span class="mono">#类型 @项目 /路径 kind:</span></span>
          </label>

          <!-- 搜索历史下拉面板 -->
          <div
            v-if="historyOpen && recent.length"
            class="kb-search-history-panel"
            role="listbox"
            aria-label="搜索历史"
            data-testid="search-history-panel"
          >
            <div class="kb-history-head">
              <span class="kb-history-title">搜索历史</span>
              <button
                type="button"
                class="kb-history-clear"
                title="清空全部历史记录"
                data-testid="search-history-clear"
                @mousedown.prevent="clearRecent"
              >
                清空
              </button>
            </div>
            <div class="kb-history-list">
              <div
                v-for="(item, index) in recent"
                :key="item"
                class="kb-history-item"
                :class="{ 'is-active': activeHistoryIndex === index }"
                role="option"
                :aria-selected="activeHistoryIndex === index"
                data-testid="search-history-item"
                @mousedown.prevent="pickHistory(item)"
                @mouseenter="activeHistoryIndex = index"
              >
                <KbIcon name="clock" :size="14" class="kb-history-icon" />
                <span class="kb-history-text">{{ item }}</span>
                <button
                  type="button"
                  class="kb-history-del"
                  title="删除此条记录"
                  aria-label="删除"
                  data-testid="search-history-del"
                  @mousedown.stop.prevent="removeRecent(item)"
                >
                  <KbIcon name="close" :size="12" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <button type="submit" class="btn pri kb-search-go" :disabled="loading || !query.trim()">{{ loading ? '检索中…' : phone ? '搜索' : '搜索 ↵' }}</button>
      </form>

      <p v-if="deepAnswer" class="kb-hint kb-deep-answer">{{ deepAnswer }}</p>
      <div class="row kb-search-options" data-testid="search-options">
        <label class="row m">范围 <KbSelect v-model="scopeValue" :options="scopeAll" size="sm" aria-label="范围" data-testid="search-scope" /></label>
        <KbSwitch v-model="onlyInsights" label="只看笔记" />
        <KbSwitch v-if="session.has('search.deep')" v-model="deep" label="深度检索" />
        <KbButton size="sm" class="kb-adv-toggle" :aria-expanded="advOpen" aria-controls="search-adv" data-testid="search-adv-toggle" @click="advOpen = !advOpen">
          高级选项<KbBadge v-if="advChanged" tone="accent" class="kb-adv-n">{{ advChanged }}</KbBadge>
        </KbButton>
        <span v-if="response" class="m mono kb-spacer kb-search-stat">{{ allHits.length }}{{ capped ? '+' : '' }} 条 · {{ elapsed }} ms</span>
      </div>
      <!-- 高级选项:桌面内联展开,手机放进底部弹层(同一份内容) -->
      <div v-if="advOpen && !phone" id="search-adv" class="kb-search-adv"><SearchAdvanced v-model="prefs" :rrf-k="canTune ? rrfK : null" /></div>
    </div>
    <KbSheet v-if="advOpen && phone" title="高级选项" @close="advOpen = false">
      <SearchAdvanced v-model="prefs" :rrf-k="canTune ? rrfK : null" />
      <template #footer><KbButton variant="primary" @click="advOpen = false">完成</KbButton></template>
    </KbSheet>

    <div v-if="error" class="card kb-error kb-card-body kb-search-err" role="alert" data-testid="search-error">
      <span>{{ error }}</span>
      <KbButton v-if="errorRetry" size="sm" :disabled="loading" @click="run()">重试</KbButton>
    </div>
    <div v-if="degraded" class="card kb-card-body kb-degraded" :class="`is-${degraded.tone}`" role="status" data-testid="search-degraded">{{ degraded.text }}</div>

    <div v-if="response" class="kb-search-grid" :class="{ 'has-explain': explain && !!current, 'has-preview': wide && !!current && !explain }">
      <div class="kb-hits" role="list">
        <article
          v-for="(hit, at) in hits"
          :key="hit.id"
          class="card kb-hit"
          :class="{ 'is-selected': pageStart + at === selected }"
          role="listitem"
          tabindex="0"
          @click="selected = pageStart + at"
          @dblclick="openHit(hit)"
          @keydown.enter="openHit(hit)"
        >
          <div class="row kb-hit-head">
            <span class="kb-hit-rank mono kb-lead">{{ pageStart + at + 1 }}</span>
            <b class="kb-hit-title"><template v-for="(piece, i) in titleParts(hit.title ?? hit.symbol ?? hit.source)" :key="i"><mark v-if="piece.hit" class="hl">{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></b>
            <span class="kb-spacer kb-hit-tags">
              <KbBadge data-testid="hit-kind">{{ kindLabel(hit.kind) }}</KbBadge>
              <KbBadge :tone="hitSource(hit as AnyHit).mine ? 'neutral' : 'accent'" data-testid="hit-source">{{ hitSource(hit as AnyHit).label }}<template v-if="hitSource(hit as AnyHit).role"> · {{ hitSource(hit as AnyHit).role }}</template></KbBadge>
              <!-- 纯语义命中只是没有字面高亮,不是高亮坏了:一枚短标签说清楚,长句放到 title 里(UI-5) -->
              <KbBadge v-if="semanticOnly(hit)" class="kb-hit-semantic" data-testid="hit-semantic" title="这段内容里没有出现你搜的词,是按意思匹配到的" aria-label="语义匹配:这段内容里没有出现你搜的词,是按意思匹配到的">语义匹配</KbBadge>
              <span v-if="explain" class="mono m kb-hit-id">{{ hit.id }}</span>
            </span>
          </div>
          <div class="m mono kb-hit-where">{{ where(hit) }}</div>
          <p class="kb-hit-snippet">
            <template v-for="(piece, i) in parts(hit.snippet)" :key="i"><mark v-if="piece.hit" class="hl">{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template>
          </p>
          <div class="row kb-stg">
            <template v-if="explain && hit.explain">
              <div v-for="stage in stages(hit, pageStart + at)" :key="stage.name" class="kb-stg-cell">
                <div class="m kb-stg-name">{{ stage.name }}</div>
                <div class="mono"><span :class="stage.lead ? 'kb-lead' : 't2'">#{{ stage.rank }}</span>{{ stage.score ? ' ' : '' }}<span v-if="stage.score" class="m">{{ stage.score }}</span></div>
              </div>
            </template>
            <span class="kb-spacer row kb-hit-actions">
              <!-- 有用 / 无用改成图标按钮:文字按钮太宽,把「打开」挤到下一行;触屏上仍然 44px 可点(见样式) -->
              <template v-if="hitSource(hit as AnyHit).mine">
                <button type="button" class="btn sm kb-hit-rate" :class="{ 'is-good': feedback[hit.id] === true }" :aria-pressed="feedback[hit.id] === true" :aria-label="feedback[hit.id] === true ? '已标记有用' : '标记有用'" :title="feedback[hit.id] === true ? '已标记有用' : '这条结果有用'" data-testid="hit-useful" @click.stop="rate(hit, true)"><KbIcon name="thumbUp" :size="13" /></button>
                <button type="button" class="btn sm kb-hit-rate" :class="{ 'is-bad': feedback[hit.id] === false }" :aria-pressed="feedback[hit.id] === false" :aria-label="feedback[hit.id] === false ? '已标记无用' : '标记无用'" :title="feedback[hit.id] === false ? '已标记无用' : '这条结果没用'" data-testid="hit-useless" @click.stop="rate(hit, false)"><KbIcon name="thumbDown" :size="13" /></button>
              </template>
              <button type="button" class="btn sm" data-testid="hit-open" @click.stop="openHit(hit)">打开</button>
            </span>
          </div>
        </article>
        <KbPager
          v-if="allHits.length > PAGE_SIZES[0]"
          class="kb-search-pager"
          data-testid="search-pager"
          :total="allHits.length"
          :page="page"
          :page-size="pageSize"
          :sizes="[...PAGE_SIZES]"
          @update:page="goPage"
          @update:page-size="prefs = { ...prefs, pageSize: $event }"
        />
        <p v-if="capped" class="m kb-hint kb-search-capped" data-testid="search-capped">最多显示最相关的 {{ allHits.length }} 条;没找到想要的,换个说法,或者在搜索词里加上 kind: / path: 之类的前缀缩小范围。</p>
        <KbEmpty v-if="!allHits.length" icon="search" title="没有找到相关内容" description="换个说法,或把范围切到「全部集合」再试" data-testid="search-none" />
      </div>

      <aside v-if="explain && current" class="card kb-explain" aria-label="Explain">
        <div class="ch">Explain · #{{ selected + 1 }}<div class="r mono m">{{ elapsed }} ms</div></div>
        <div class="kb-explain-body">
          <div v-if="timings.length" class="kb-timing" data-testid="explain-timings">
            <KbHBars :rows="timings" label="各阶段耗时" :format="(value: number) => `${value.toFixed(1)} ms`" :note="extraNote" />
          </div>
          <template v-if="scoreLines.length">
            <div class="lbl">得分构成</div>
            <pre class="code kb-score-formula">{{ scoreLines.join('\n') }}</pre>
          </template>
          <div class="lbl">过滤</div>
          <div class="row kb-chips">
            <span v-for="chip in filterChips" :key="chip" class="tag mono">{{ chip }}</span>
          </div>
          <div class="m kb-small kb-chain-line">{{ chainLine }}</div>
          <template v-if="current.explain?.window">
            <div class="lbl">上下文窗口</div>
            <div class="mono m">{{ current.explain.window.path }}:{{ current.explain.window.start_line }}–{{ current.explain.window.end_line }}</div>
          </template>
        </div>
      </aside>

      <!-- 宽屏右侧预览(UI-5):结果列表只给标题 + 一两行摘要,想看完整片段不用先点开;
           和 Explain 二选一(Explain 是调试视图,优先),点了哪条就预览哪条 -->
      <aside v-else-if="wide && current" class="card kb-preview" aria-label="结果预览" data-testid="search-preview">
        <div class="ch">预览 · #{{ selected + 1 }}<div class="r m mono">{{ kindLabel(current.kind) }}</div></div>
        <div class="kb-preview-body">
          <b class="kb-preview-title"><template v-for="(piece, i) in titleParts(current.title ?? current.symbol ?? current.source)" :key="i"><mark v-if="piece.hit" class="hl">{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></b>
          <div class="m mono kb-preview-where">{{ where(current) }}</div>
          <p class="kb-preview-snippet"><template v-for="(piece, i) in parts(current.snippet)" :key="i"><mark v-if="piece.hit" class="hl">{{ piece.text }}</mark><template v-else>{{ piece.text }}</template></template></p>
          <KbButton size="sm" variant="primary" @click="openHit(current)">打开这条</KbButton>
        </div>
      </aside>
    </div>

    <KbSkeleton v-else-if="loading && !error" variant="list" :lines="4" class="kb-search-wait" data-testid="search-loading" />
    <div v-else-if="!loading && !error" class="kb-search-start">
      <KbEmpty icon="search" title="还没有搜索" description="输入问题后回车;kind: / path: / tag: / status: / lang: 前缀可缩小范围" />
      <div v-if="recent.length" class="kb-recent-list">
        <div class="lbl">最近检索</div>
        <button v-for="text in recent" :key="text" type="button" class="ni kb-recent-q" @click="run(text)"><KbIcon name="clock" :size="14" />{{ text }}</button>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
/* 命中卡片头:标题可以折行,类型 / 来源标签靠右,窄屏上换到标题下面 */
.kb-hit-head { flex-wrap: wrap; row-gap: var(--sp-1); }
/* 卡片里的长路径 / 长标识符(没有空格可折行)不能把卡片撑出屏幕:整张卡片和每一行都允许在任意位置折行 */
.kb-hit { min-width: 0; overflow-wrap: anywhere; }
.kb-hit-title { min-width: 0; overflow-wrap: anywhere; }
.kb-hit-where, .kb-hit-snippet { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.kb-hit-semantic { white-space: nowrap; }
.kb-hit-tags { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-left: auto; padding-left: var(--sp-2); }
.kb-hit-id { font-size: var(--text-12); }
/* 反馈按钮只放图标:桌面上压低存在感、悬停或键盘聚焦时亮起来,把宽度让给「打开」 */
.kb-hit-actions .btn { min-width: 2rem; padding-inline: var(--sp-1); }
.kb-hit-rate { color: var(--m); opacity: 0.55; }
.kb-hit:hover .kb-hit-rate,
.kb-hit:focus-within .kb-hit-rate,
.kb-hit-rate.is-good,
.kb-hit-rate.is-bad { opacity: 1; }
/* 触屏没有悬停:一直显示,可点区域仍然 44px */
@media (max-width: 599px), (pointer: coarse) {
  .kb-hit-actions .btn { min-width: 44px; }
  .kb-hit-rate { opacity: 1; }
}

/* 宽屏右侧预览 */
.kb-preview { position: sticky; top: 0; overflow: hidden; }
.kb-preview-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--card-py) var(--card-px); }
.kb-preview-title { overflow-wrap: anywhere; line-height: 1.45; }
.kb-preview-where { overflow-wrap: anywhere; }
.kb-preview-snippet { margin: 0; color: var(--t2); line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 360px; overflow: auto; }
.kb-adv-n { margin-left: var(--sp-2); }
/* 桌面上内联展开的高级选项 */
.kb-search-adv { margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: var(--hl) solid var(--b); max-width: 32rem; }
.kb-search-err { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.kb-search-wait { margin-top: var(--sp-3); }

/* 搜索框与下拉历史面板 */
.kb-searchbar-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
.kb-searchbar-wrap .kb-searchbar {
  width: 100%;
}
.kb-search-history-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--surface-3);
  border: var(--hl) solid var(--b2);
  border-radius: var(--r3);
  box-shadow: 0 12px 32px -8px rgba(var(--shade), 0.5), 0 2px 6px rgba(var(--shade), 0.2);
  padding: 6px;
  overflow: hidden;
}
[data-tone=light] .kb-search-history-panel {
  background: var(--surface-2);
}
.kb-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 6px;
  font-size: calc(12px * var(--fs));
  color: var(--m);
  border-bottom: var(--hl) solid var(--b2);
}
.kb-history-title {
  font-weight: 500;
}
.kb-history-clear {
  background: transparent;
  border: 0;
  padding: 0 4px;
  color: var(--m);
  font: inherit;
  font-size: calc(12px * var(--fs));
  cursor: pointer;
  border-radius: var(--r1);
  transition: color var(--dur-fast) var(--ease-out);
}
.kb-history-clear:hover {
  color: var(--t);
  text-decoration: underline;
}
.kb-history-list {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}
.kb-history-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 8px;
  border-radius: var(--r2);
  cursor: pointer;
  color: var(--t2);
  font-size: calc(13px * var(--fs));
  transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  user-select: none;
}
.kb-history-item:hover,
.kb-history-item.is-active {
  background: rgba(var(--ink), 0.07);
  color: var(--t);
}
.kb-history-icon {
  color: var(--m);
  flex-shrink: 0;
}
.kb-history-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-history-del {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--r1);
  background: transparent;
  color: var(--m);
  cursor: pointer;
  opacity: 0.6;
  flex-shrink: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.kb-history-del:hover {
  opacity: 1;
  color: var(--t);
  background: rgba(var(--ink), 0.1);
}
</style>
