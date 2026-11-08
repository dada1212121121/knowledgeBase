// 响应媒体查询的小工具(组件库自带,不依赖应用层):返回一个随查询结果变化的 ref。
// 初始值同步取 matchMedia(首帧就是对的,不会先按桌面渲染再跳成手机);没有 matchMedia(单测环境)时为 false。
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export function useMedia(query: string): Ref<boolean> {
  const hasApi = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const list = hasApi ? window.matchMedia(query) : null
  const matches = ref(list?.matches === true)
  const update = () => (matches.value = list?.matches === true)
  onMounted(() => {
    update()
    list?.addEventListener?.('change', update)
  })
  onBeforeUnmount(() => list?.removeEventListener?.('change', update))
  return matches
}

/** 手机宽度:与外壳的「标签栏形态」同一条线之下的小屏(<600)。 */
export const PHONE_QUERY = '(max-width: 599px)'

/**
 * 手机且是触屏(<600 且主要输入是手指)。「拍照 / 从相册选」只在这里出现:
 * 电脑小窗口(<600 但用鼠标)没有相册也多半没摄像头,分屏的 iPad 窗口则是触屏,同样该给。
 * 按输入方式 + 可用宽度判断,不看 UA(iOS 和各家内置浏览器的 UA 都不可靠)。
 */
export const TOUCH_PHONE_QUERY = '(max-width: 599px) and (pointer: coarse)'
