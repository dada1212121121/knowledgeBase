// 注册 service worker。
//
// 只在生产构建注册:开发服务器上的资源没有内容哈希,缓存优先会让人一直看到旧代码。
// 不支持(非安全上下文、老浏览器)或注册失败都安静跳过——PWA 是增强,不是前提。
export function registerServiceWorker(options: { enabled?: boolean } = {}): Promise<ServiceWorkerRegistration | null> {
  const enabled = options.enabled ?? import.meta.env.PROD
  if (!enabled || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(resolve)
        .catch(() => resolve(null))
    }
    // 等页面加载完再注册,不和首屏抢带宽
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  })
}
