// 单测环境默认「减少动效」:数字滚动直接显示目标值,测试读到的就是真实值,不用等动画。
// 不能靠 <html data-motion="reduce">:外观模块(useAppearance)在被导入时会按用户设置改写这个属性,
// 页面测试一导入 @kb-ui/index 就把它改回去了。所以直接替换 motionAllowed。
// 专门测动效的用例在自己的 beforeEach 里设 globalThis.__KB_MOTION__ = true,afterEach 里设回 false。
import { vi } from 'vitest'

vi.mock('../packages/kb-ui/src/motion/useMotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/kb-ui/src/motion/useMotion')>()
  return { ...actual, motionAllowed: () => (globalThis as { __KB_MOTION__?: boolean }).__KB_MOTION__ === true }
})
