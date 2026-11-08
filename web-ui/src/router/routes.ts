// 路由表(.4 重组):「我的」(所有用户)与「管理」两组。
// 旧地址见 legacy.ts。地址常量见 paths.ts。
import type { RouteLocationNormalized, RouteRecordRaw } from 'vue-router'
import Login from '@/pages/Login.vue'
import { legacyRoutes } from './legacy'
import { PATHS } from './paths'

export const routes: RouteRecordRaw[] = [
  // 旧地址 → 新地址(含 / → 首页)
  ...legacyRoutes,

  // ---- 公开页面 ----
  { path: '/login', name: 'login', component: Login, meta: { public: true, title: '登录' } },
  { path: '/register', name: 'register', component: () => import('@/pages/Register.vue'), meta: { public: true, title: '注册' } },
  { path: '/forgot', name: 'forgot', component: () => import('@/pages/Forgot.vue'), meta: { public: true, title: '找回密码' } },
  // 公开分享页:游客也能打开,不用统一外壳,令牌在地址里(服务端对 /s/ 加了 noindex 和 no-referrer)
  // 服务不可用(维护中 / 出错 / 连不上 / 设备离线):登录检查连不上服务时守卫带来这里,恢复后自动回到原页面
  { path: '/unavailable', name: 'unavailable', component: () => import('@/pages/Unavailable.vue'), meta: { public: true, title: '服务暂时不可用' } },
  { path: '/s/:token', name: 'public-share', component: () => import('@/pages/PublicShare.vue'), meta: { public: true, title: '分享' } },

  // ---- 我的 ----
  { path: PATHS.home, name: 'home', component: () => import('@/pages/Home.vue'), meta: { title: '首页' } },
  {
    path: PATHS.kb,
    name: 'kb',
    component: () => import('@/pages/Browser.vue'),
    // chrome: 文档工作台自带顶栏,全局顶栏让位
    meta: { title: '知识库', chrome: 'workbench' },
  },
  { path: PATHS.search, name: 'search', component: () => import('@/pages/Search.vue'), meta: { title: '搜索' } },
  { path: PATHS.shares, name: 'shares', component: () => import('@/pages/Shares.vue'), meta: { title: '我的分享' } },
  { path: PATHS.trash, name: 'trash', component: () => import('@/pages/Trash.vue'), meta: { title: '回收站' } },
  { path: PATHS.review, name: 'review', component: () => import('@/pages/Review.vue'), meta: { title: '审核收件箱' } },
  { path: PATHS.import, name: 'import', component: () => import('@/pages/Import.vue'), meta: { title: '导入' } },
  {
    path: PATHS.importQueue,
    name: 'import-queue',
    // 旧的「解析队列」地址:数据源和队列合成一页后,它和 /import 是同一页(落在「导入记录」页签),旧书签 / 通知里的链接照常能用
    component: () => import('@/pages/Import.vue'),
    meta: { title: '导入记录', group: PATHS.import, parent: PATHS.import },
  },
  {
    path: `${PATHS.import}/files/:id`,
    name: 'import-file',
    component: () => import('@/pages/IngestFile.vue'),
    meta: { title: '文件时间线', group: PATHS.import, parent: PATHS.importQueue },
  },
  {
    path: `${PATHS.import}/batches/:batch`,
    name: 'import-batch',
    component: () => import('@/pages/IngestBatch.vue'),
    meta: { title: '批次详情', group: PATHS.import, parent: PATHS.importQueue },
  },
  { path: PATHS.tasks, name: 'tasks', component: () => import('@/pages/Jobs.vue'), meta: { title: '任务' } },
  // 好友(功能点 collab.friends):没开通时页面自己显示「没有开通」,不在路由层拦(后端对每个能力照样检查)
  { path: PATHS.friends, name: 'friends', component: () => import('@/pages/Friends.vue'), meta: { title: '好友' } },
  { path: PATHS.assistant, name: 'assistant', component: () => import('@/pages/Agent.vue'), meta: { title: 'AI 助手' } },
  { path: PATHS.mine, name: 'mine', component: () => import('@/pages/Mine.vue'), meta: { title: '我的' } },
  { path: PATHS.me, name: 'me', component: () => import('@/pages/Me.vue'), meta: { title: '个人设置' } },
  {
    path: PATHS.appearance,
    name: 'appearance',
    component: () => import('@/pages/Appearance.vue'),
    meta: { title: '外观', group: PATHS.me, parent: PATHS.mine },
  },

  // 使用指南:所有登录用户可看,不挂功能点;入口在头像菜单、「我的」页和命令面板
  { path: PATHS.guide, name: 'guide', component: () => import('@/pages/Guide.vue'), meta: { title: '使用指南' } },

  // ---- 开发:组件库示例(不在导航里) ----
  { path: '/dev/kit', name: 'kit', component: () => import('@/pages/KitGallery.vue'), meta: { title: '组件库', parent: PATHS.mine } },

  // ---- 管理(入口按功能点显示,后端对每个能力照样检查) ----
  { path: PATHS.overview, name: 'overview', component: () => import('@/pages/Dashboard.vue'), meta: { title: '系统概览' } },
  { path: PATHS.users, name: 'users', component: () => import('@/pages/Users.vue'), meta: { title: '用户与权限' } },
  { path: PATHS.params, name: 'params', component: () => import('@/pages/SystemParams.vue'), meta: { title: '系统参数' } },
  { path: PATHS.usage, name: 'usage', component: () => import('@/pages/StorageUsage.vue'), meta: { title: '存储与用量' } },
  { path: PATHS.projects, name: 'projects', component: () => import('@/pages/Projects.vue'), meta: { title: '项目与集合' } },
  { path: PATHS.system, name: 'system', component: () => import('@/pages/SystemStatus.vue'), meta: { title: '系统状态' } },
  // 「审计 / 批次」与「任务」共用一个页面组件,靠路径区分当前页签
  { path: PATHS.audit, name: 'audit', component: () => import('@/pages/Jobs.vue'), meta: { title: '审计 / 批次' } },
  { path: PATHS.eval, name: 'eval', component: () => import('@/pages/Eval.vue'), meta: { title: '评测' } },
  {
    path: PATHS.settings,
    name: 'settings',
    component: () => import('@/pages/Settings.vue'),
    meta: { title: '系统设置' },
    // 旧链接 …?tab=appearance 直接去外观页(外观不再是设置里的一个页签)
    beforeEnter: (to: RouteLocationNormalized) => (to.query.tab === 'appearance' ? { path: PATHS.appearance, query: {}, replace: true } : true),
  },
  // ---- 兜底:任何认不出的地址都是 404(放在最后;旧地址的重定向在最前面,先匹配) ----
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/pages/NotFound.vue'), meta: { title: '找不到页面' } },
]
