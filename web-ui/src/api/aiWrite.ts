// 编辑器里的 AI 写作(UI-3):调服务端 `ai_write`(无状态、不改数据),拿回结果文字交给编辑器预览。
// 编辑器不 import 网络层,由页面把这个函数作为 aiWrite 传给 EditorHost。
import { callCapability } from './client'
import type { AiWriteRequest } from '@/editor/types'

export async function aiWrite(request: AiWriteRequest): Promise<string> {
  const reply = await callCapability<{ text?: string }>('ai_write', {
    action: request.action,
    text: request.text,
    context: request.context,
    ...(request.instruction ? { instruction: request.instruction } : {}),
  })
  return typeof reply.text === 'string' ? reply.text : ''
}
