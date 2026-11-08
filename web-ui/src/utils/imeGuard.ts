// 中文输入法(IME)组字守卫(设计规范)。
//
// 组字过程中(compositionstart → compositionend)的按键是输入法的:
//   回车 = 把拼音 / 选中的候选上屏,方向键 = 在候选词里移动,Esc = 取消组字,空格 / Tab 也是选词。
// 编辑器里的斜杠菜单、`[[` 选择器、查找框、聊天框的 `@` 面板如果把这些键当成自己的命令,
// 就会在用户打拼音时执行菜单项、关掉面板、移走高亮。规则只有一条:组字期间这些键归输入法,
// 组字结束(compositionend)之后才按最终文本判断。
//
// 两层:
//   - menuKeyOf:无状态,只看这一次按键事件(event.isComposing 或 keyCode 229,项目通用的 isComposing),
//     给「面板的键盘导航」用,返回这个键在面板里的含义,输入法占着就返回 null;
//   - createImeGuard:有状态,记着 compositionstart / compositionend,给「整个编辑器」用——
//     有的浏览器 / 输入法在组字中发出的 keydown 不带 isComposing,只能靠自己记的状态判断;
//     Safari 的 compositionend 先于上屏用的那个回车,回车的 isComposing 已经是 false,
//     所以 compositionend 之后一个很短的窗口里,回车和 keyCode 229 的按键仍然算输入法的。
import { isComposing } from '@kb-ui/index'

/** 输入法会用到的键:选词 / 上屏 / 取消。字母、退格不在此列(普通按键照常处理)。 */
export const IME_OWNED_KEYS: readonly string[] = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']

/** compositionend 之后多久内的回车 / 229 按键仍算输入法的(Safari 上屏回车晚于 compositionend 到达,通常是同一帧)。 */
export const IME_GRACE_MS = 50

type KeyLike = Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>

export interface ImeGuard {
  /** 正处于 compositionstart 与 compositionend 之间 */
  readonly composing: boolean
  start(): void
  end(): void
  /**
   * 这一次 keydown 是不是输入法交互的一部分(菜单、快捷转换、发送、确认都该让路)。
   * 不筛键名:Chrome 在组字中给的 key 常常是 "Process",macOS / Safari 给真实键名,调用方按 IME_OWNED_KEYS 再筛。
   */
  owns(event: KeyLike): boolean
}

export function createImeGuard(now: () => number = () => Date.now()): ImeGuard {
  let composing = false
  let endedAt = Number.NEGATIVE_INFINITY
  return {
    get composing() {
      return composing
    },
    start() {
      composing = true
    },
    end() {
      composing = false
      endedAt = now()
    },
    owns(event) {
      if (composing || event.isComposing) return true
      // compositionend 刚过:Safari 上屏用的回车会晚到,isComposing 已是 false,但 keyCode 仍是 229
      const justEnded = now() - endedAt < IME_GRACE_MS
      return justEnded && (event.key === 'Enter' || event.keyCode === 229)
    },
  }
}

/** 面板键盘导航里一个键的含义 */
export type MenuKey = 'next' | 'prev' | 'confirm' | 'cancel'

/**
 * 候选面板(`@` 引用、命令菜单、笔记选择器)里这个键是什么意思;输入法占着就返回 null,调用方什么都不做,也不要 preventDefault。
 * 带 Shift 的回车是换行,不是确认。
 */
export function menuKeyOf(event: KeyLike & Pick<KeyboardEvent, 'shiftKey'>): MenuKey | null {
  if (isComposing(event as KeyboardEvent)) return null
  switch (event.key) {
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'prev'
    case 'Enter':
      return event.shiftKey ? null : 'confirm'
    case 'Escape':
      return 'cancel'
    default:
      return null
  }
}
