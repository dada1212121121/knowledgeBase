// 中文输入法（设计规范）:组字过程中(compositionstart 到 compositionend)按回车是「选词上屏」,不是「提交」。
// 搜索、发送、保存、命令面板执行都不能在这时触发。
//   - 标准写法是 event.isComposing;
//   - Safari 在 compositionend 之后紧跟的那一个 keydown 里 isComposing 已是 false,但 keyCode 仍是 229——也要拦。
export function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}
