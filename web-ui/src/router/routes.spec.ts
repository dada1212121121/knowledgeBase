// 路由重组(.4)的守卫:旧地址全部重定向到新地址,并且原样保留 query / hash;
// 导航里的每个地址、标签栏的每个地址都对应一个真实页面,没有悬空。
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

// 页面组件在这里不重要(重定向发生在加载组件之前),用空壳代替,免得把整个应用的页面都拉进 jsdom
vi.mock('@/pages/Login.vue', () => ({ default: { template: '<div />' } }))

import { routes } from './routes'
import { LEGACY_REDIRECTS } from './legacy'
import { PATHS, TAB_PAGES, importBatch, importFile } from './paths'

const Stub = { template: '<div />' }
/** 真实的路由表,只是把懒加载的页面换成空壳(redirect / meta / beforeEnter 原样保留)。 */
const stubbed = routes.map((route) => ('component' in route && route.component ? { ...route, component: Stub } : route))
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes: stubbed })

async function land(from: string) {
  const router = makeRouter()
  await router.push(from)
  return router.currentRoute.value
}

describe('旧地址重定向', () => {
  it.each([
    ['/', '/home'],
    ['/dashboard', '/admin/overview'],
    ['/browser', '/kb'],
    ['/sources', '/import'],
    ['/ingest', '/import/queue'],
    ['/jobs', '/tasks'],
    ['/agent', '/assistant'],
    ['/audit', '/admin/audit'],
    ['/eval', '/admin/eval'],
    ['/projects', '/admin/projects'],
    ['/system', '/admin/system'],
    ['/params', '/admin/params'],
    ['/users', '/admin/users'],
    ['/settings', '/admin/settings'],
    ['/settings/appearance', '/me/appearance'],
  ])('%s → %s', async (from, to) => {
    expect((await land(from)).fullPath).toBe(to)
  })

  it('带 query 和 hash 的旧地址原样带过去(书签、邮件里的链接、AI 助手的引用都靠这个)', async () => {
    expect((await land('/browser?collection=proj_x&item=ins_1&highlight=ck_2#anchor')).fullPath).toBe('/kb?collection=proj_x&item=ins_1&highlight=ck_2#anchor')
    expect((await land('/jobs?job=j1')).fullPath).toBe('/tasks?job=j1')
    expect((await land('/audit?tab=batches&batch=b1')).fullPath).toBe('/admin/audit?tab=batches&batch=b1')
    expect((await land('/ingest?batch=all&filter=failed')).fullPath).toBe('/import/queue?batch=all&filter=failed')
  })

  it('旧的文件时间线、批次详情地址换成新的子路径', async () => {
    expect((await land('/ingest/file/f1?x=1')).fullPath).toBe('/import/files/f1?x=1')
    expect((await land('/ingest/b-123')).fullPath).toBe('/import/batches/b-123')
  })

  it('/settings?tab=appearance 去外观页(不带 tab);其它页签留在系统设置', async () => {
    expect((await land('/settings?tab=appearance')).fullPath).toBe('/me/appearance')
    expect((await land('/settings?tab=backup')).fullPath).toBe('/admin/settings?tab=backup')
    expect((await land('/settings?tab=tokens#x')).fullPath).toBe('/admin/settings?tab=tokens#x')
  })

  it('新的系统设置地址上带 tab=appearance 也去外观页', async () => {
    expect((await land('/admin/settings?tab=appearance')).path).toBe('/me/appearance')
  })

  it('用 replace 重定向:旧地址不留在历史里,「返回」不会又被弹回旧地址', async () => {
    const router = makeRouter()
    await router.push('/home')
    await router.push('/dashboard')
    expect(router.currentRoute.value.fullPath).toBe('/admin/overview')
    router.back()
    // 历史里只有 /home → /admin/overview 两项(旧地址 /dashboard 被替换掉了),返回应回到 /home
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/home'))
  })

  it('表里的每一条旧地址都有测试覆盖到(新增旧地址表项时这里会提醒补)', () => {
    const covered = ['/', '/dashboard', '/browser', '/sources', '/ingest', '/ingest/file/:id', '/ingest/:batch', '/jobs', '/agent', '/audit', '/eval', '/projects', '/system', '/params', '/users', '/settings/appearance']
    expect(LEGACY_REDIRECTS.map((entry) => entry.from).sort()).toEqual(covered.sort())
  })

  it('任何旧地址最终都落在 PATHS 里的页面(或它的子页面)上,不会成环、落空或停在另一个旧地址', async () => {
    const known = new Set<string>(Object.values(PATHS))
    for (const { from } of LEGACY_REDIRECTS) {
      const sample = from.replace(':id', 'x1').replace(':batch', 'b1')
      const landed = await land(sample)
      const isKnown = known.has(landed.path) || landed.path.startsWith('/import/files/') || landed.path.startsWith('/import/batches/')
      expect(isKnown, `${sample} → ${landed.path}`).toBe(true)
      expect(landed.matched.length, sample).toBeGreaterThan(0)
    }
  })
})

describe('新地址', () => {
  it('PATHS 里的每个地址都是真实页面(不是重定向、不是 404)', () => {
    const router = makeRouter()
    for (const [name, path] of Object.entries(PATHS)) {
      const resolved = router.resolve(path)
      expect(resolved.matched.length, name).toBeGreaterThan(0)
      expect(resolved.matched[resolved.matched.length - 1]!.redirect, name).toBeUndefined()
    }
  })

  it('标签栏页面都在 PATHS 里;子页面地址解析正确', () => {
    const router = makeRouter()
    for (const path of TAB_PAGES) expect(Object.values(PATHS)).toContain(path)
    expect(router.resolve(importFile('f 1')).name).toBe('import-file')
    expect(router.resolve(importBatch('b1')).name).toBe('import-batch')
    expect(importFile('a/b')).toBe('/import/files/a%2Fb')
  })

  it('管理页面都在 /admin/ 下;「我的」页面不在', () => {
    const admin = [PATHS.overview, PATHS.users, PATHS.params, PATHS.usage, PATHS.projects, PATHS.system, PATHS.audit, PATHS.eval, PATHS.settings]
    for (const path of admin) expect(path.startsWith('/admin/'), path).toBe(true)
    for (const path of [PATHS.home, PATHS.kb, PATHS.search, PATHS.review, PATHS.import, PATHS.tasks, PATHS.assistant, PATHS.mine, PATHS.me]) expect(path.startsWith('/admin'), path).toBe(false)
  })

  it('导航里的嵌套页面指向存在的父页', () => {
    const real = new Set(routes.map((route) => route.path))
    for (const route of routes) {
      const parent = route.meta?.parent as string | undefined
      if (parent) expect(real.has(parent), `${String(route.path)} 的 parent ${parent}`).toBe(true)
    }
  })

  it('文档工作台只有知识库一个页面', () => {
    expect(routes.filter((route) => route.meta?.chrome === 'workbench').map((route) => route.path)).toEqual([PATHS.kb])
  })
  it('公开分享页 /s/:token 是公开路由(游客不用登录),带令牌参数,没有外壳页面的 chrome 标记', () => {
    const route = routes.find((entry) => entry.path === '/s/:token')
    expect(route).toBeDefined()
    expect(route?.meta?.public).toBe(true)
    expect(route?.meta?.chrome).toBeUndefined()
  })

  it('我的分享在「我的」组下(不是公开路由,要登录)', () => {
    const route = routes.find((entry) => entry.path === PATHS.shares)
    expect(route?.meta?.public).toBeUndefined()
    expect(PATHS.shares.startsWith('/admin')).toBe(false)
  })
})
