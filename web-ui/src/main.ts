// 应用入口。
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/inter'
import '@fontsource-variable/noto-sans-sc'
import '@kb-ui/index'
import './styles/app.css'
import App from './App.vue'
import { router } from './router'
import { i18n } from './i18n'
import { registerServiceWorker } from './pwa/register'
import { installAuthGate } from './api/authGate'
import { PATHS } from './router/paths'
import { useSessionStore } from './stores/session'

const pinia = createPinia()
createApp(App).use(pinia).use(router).use(i18n).mount('#app')

// 站点要求管理员开启两步验证、而当前账号还没开:任何接口都会被拒(403 totp_setup_required)。
// 记下标记(路由守卫据此拦住其它页面)并把用户带到个人设置的两步验证区,在那里解释原因。
installAuthGate(() => {
  useSessionStore(pinia).needsTotpSetup = true
  const here = router.currentRoute.value
  if (here.path !== PATHS.me && !here.meta.public) void router.replace({ path: PATHS.me, query: { need: 'totp' } })
})

// 可安装的 Web App:只在生产构建里注册 service worker(开发服务器的资源没有内容哈希)
void registerServiceWorker()
