// 国际化:默认中文,英文作为回退(§)。
import { createI18n } from 'vue-i18n'

export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en',
  messages: {
    'zh-CN': {
      login: {
        welcome: '欢迎回来',
        hint: '登录以管理知识库、审核候选笔记与 MCP 接入',
        username: '用户名',
        password: '密码',
        forgot: '忘记密码？',
        keep: '保持登录 7 天',
        submit: '登录',
        running: 'kbd 运行中',
        tagline: '让 AI 记住每一次踩坑与决策',
        featureSearch: '混合检索',
        featureSearchDesc: 'BM25 + 向量 + rerank',
        featureEvolve: '自动进化',
        featureEvolveDesc: '从提交中提炼经验',
        featureMcp: 'MCP 原生',
        featureMcpDesc: 'Kiro · Claude · Codex',
        docs: '文档',
        footer: '源码公开 · 非商业许可 · 本地优先',
      },
    },
    en: {
      login: {
        welcome: 'Welcome back',
        hint: 'Sign in to manage the knowledge base, drafts and MCP access',
        username: 'Username',
        password: 'Password',
        forgot: 'Forgot password?',
        keep: 'Keep me signed in for 7 days',
        submit: 'Sign in',
        running: 'kbd running',
        tagline: 'So your AI remembers every pitfall and decision',
        featureSearch: 'Hybrid search',
        featureSearchDesc: 'BM25 + vectors + rerank',
        featureEvolve: 'Self-evolving',
        featureEvolveDesc: 'Distills lessons from commits',
        featureMcp: 'MCP native',
        featureMcpDesc: 'Kiro · Claude · Codex',
        docs: 'Docs',
        footer: 'Source-available · noncommercial · local-first',
      },
    },
  },
})
