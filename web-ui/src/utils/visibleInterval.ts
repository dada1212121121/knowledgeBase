// 只在页面可见时才跑的定时器。
//
// 外壳每 15 秒发 5 个请求、会话每 20 秒一个、版本检查和通知各每分钟一个,标签页切到后台也照发,
// 一个没人看的标签页每分钟约 25 个请求。这里把「后台就跳过」收成一处:
// - 页面隐藏时,到点的那一拍直接跳过(定时器本身还在,但什么都不做);
// - 回到前台时,如果距离上次执行已经过了一个周期,立刻补一次,不用再等下一拍,看到的数据不会是旧的。
//
// 返回停止函数;调用方负责在卸载时调用(组件里放进 onUnmounted)。

export interface VisibleIntervalOptions {
  /** 注册时先执行一次。 */
  immediate?: boolean
}

export function visibleInterval(run: () => void, ms: number, options: VisibleIntervalOptions = {}): () => void {
  let last = Date.now()
  const fire = () => {
    last = Date.now()
    run()
  }
  const timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') fire()
  }, ms)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && Date.now() - last >= ms) fire()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (options.immediate) fire()
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
