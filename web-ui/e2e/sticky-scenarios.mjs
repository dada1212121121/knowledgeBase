// 筛选条 / 页签条 / 搜索条滚动时不跟着滚走:滚动区滚到下面以后,这根条的顶边仍然贴着滚动区的顶边。
// 回归自真机反馈:筛选区、工具区随内容一起滚走,往下翻几屏就找不到筛选了。由 viewer-shots.mjs 引入。
//
// 判据是「滚动之后,条的顶边 − 滚动区顶边 ≈ 0」,而不是「条没动」:条原本就离滚动区顶部有一段距离(页头、说明文字),
// 钉住以后会从那个位置上移到贴顶。同时要求页面真的滚动过(否则这条断言空转,什么也没证明)。

import { ingestStory } from './fixture.mjs'

const PAGES = {
  'sticky-search': {
    route: '/search?q=uds',
    ready: '.kb-hit',
    // 手机上只钉搜索框那一行(整张卡片太高);≥640 钉整张卡片
    pick: (width) => (width < 640 ? '.kb-search-row' : '.kb-search-top'),
    sizes: ['390x844', '844x390'],
  },
  'sticky-review': { route: '/review', ready: '.kb-rv-bar', pick: () => '.kb-rv-bar', sizes: ['390x844'] },
  'sticky-import': { route: '/import', ready: '[data-testid=import]', fixture: ingestStory, pick: () => '.kb-imp .kb-sticky', sizes: ['390x844'] },
  'sticky-users': { route: '/admin/users', ready: '.kb-ut-tabs', pick: () => '.kb-ut-tabs', sizes: ['390x844'] },
  'sticky-usage': { route: '/admin/usage', ready: '[data-testid=usage-tabs]', pick: () => '[data-testid=usage-tabs]', sizes: ['390x844'] },
  'sticky-system': { route: '/admin/system', ready: '[data-testid=status-tabs]', pick: () => '[data-testid=status-tabs]', sizes: ['390x844'] },
}

async function check(tab, page) {
  const result = await tab.evaluate((pickSource) => {
    const pick = new Function(`return (${pickSource})`)()
    const bar = document.querySelector(pick(window.innerWidth))
    if (!bar) return { missing: true }
    // 条所在的滚动区:往上找第一个真的能滚的祖先
    let scroller = bar.parentElement
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 40)) scroller = scroller.parentElement
    if (!scroller) return { noScroller: true }
    const before = bar.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    // 滚到底:条原本离顶边多远不一定,滚到底才保证它有机会贴上顶边;滚不到那么远说明夹具数据太短,下面报告
    scroller.scrollTop = scroller.scrollHeight
    const scrolled = scroller.scrollTop
    const after = bar.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    return { before: Math.round(before), after: Math.round(after), scrolled: Math.round(scrolled), reachable: scrolled + 1 >= before }
  }, page.pick.toString())
  if (result.missing) return ['找不到要钉住的那根条']
  if (result.noScroller) return ['页面没有可以滚动的区域,这条断言没有证明任何事(夹具数据不够长?)']
  const issues = []
  if (!result.reachable) return [`页面只能滚 ${result.scrolled}px,到不了条原来的位置(${result.before}px),这条断言证明不了什么:夹具数据太短`]
  if (result.scrolled < 60) issues.push(`只滚了 ${result.scrolled}px,太短,证明不了条会不会跟着滚走`)
  // 允许 1.5px 的取整误差;钉住时应当紧贴滚动区顶边
  if (Math.abs(result.after) > 1.5) issues.push(`滚动 ${result.scrolled}px 后条离滚动区顶边 ${result.after}px(应贴顶 ≈0;滚动前是 ${result.before}px):条跟着内容滚走了`)
  return issues
}

export const STICKY_SCENARIOS = Object.fromEntries(
  Object.entries(PAGES).map(([name, page]) => [
    name,
    { route: page.route, ready: page.ready, sizes: page.sizes, ...(page.fixture ? { fixture: page.fixture } : {}), settle: 500, assert: (tab) => check(tab, page) },
  ]),
)
