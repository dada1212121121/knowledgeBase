// 编辑器扩展 e2e 的夹具数据:把仓库里真实的示例扩展装进假后端。
//
// manifest 用 Rust 解析器产出的快照(crates/kb-web/tests/fixtures/editor-word-count.manifest.json,
// 后端测试守着它和 manifest.toml 一致),脚本用 examples/ 里真实的 index.js——
// 页面拿到的就是管理员把示例目录复制进 editor-extensions/ 之后后端会返回的东西。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FILES, fileItem } from './fixture.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const REPO = resolve(ROOT, '..')

/** 一个扩展在清单接口里的条目(后端形状:id / dir / manifest / error)。 */
export function listed(manifest) {
  return { id: manifest.id, dir: manifest.id, manifest, error: null }
}

/** 字数统计示例:{ listed, files }。 */
export function wordCountExample() {
  const manifest = JSON.parse(readFileSync(resolve(REPO, 'crates/kb-web/tests/fixtures/editor-word-count.manifest.json'), 'utf8'))
  return {
    listed: listed(manifest),
    files: { 'kb.word-count/index.js': readFileSync(resolve(ROOT, 'examples/editor-word-count/index.js'), 'utf8') },
  }
}

/** 造一个后端形状的清单(规范化后的 JSON,键名与 manifest.toml 一致)。 */
export function manifestJson(id, extra = {}) {
  return {
    id,
    name: extra.name ?? `扩展 ${id}`,
    version: '1.0.0',
    api_version: 1,
    description: null,
    entry: 'index.js',
    permissions: extra.permissions ?? [],
    contributes: { commands: [], toolbar: [], slash: [], panels: [], codecs: [], surfaces: [], ai_tools: [], ...extra.contributes },
  }
}

/** 待办清单示例的磁盘文件（规范格式：两个空格缩进、结尾有换行）。 */
export const TODO_FILE = '{\n  "title": "周五发布",\n  "items": [\n    {\n      "text": "冻结版本",\n      "done": true\n    },\n    {\n      "text": "写发布说明",\n      "done": false\n    }\n  ]\n}\n'
export const TODO_PATH = 'docs/周五发布.kbtodo'

/** 待办清单示例(editor-todo-format):清单用后端解析器的快照,脚本用 examples/ 里真实的 index.js。 */
export function todoFormatExample() {
  const manifest = JSON.parse(readFileSync(resolve(REPO, 'crates/kb-web/tests/fixtures/editor-todo-format.manifest.json'), 'utf8'))
  return {
    listed: listed(manifest),
    files: { 'kb.todo-format/index.js': readFileSync(resolve(ROOT, 'examples/editor-todo-format/index.js'), 'utf8') },
  }
}

/**
 * 把 .kbtodo 文件登记进假后端的文件表(文件浏览页 `?item=file_todo` 打开它)。
 * 每个场景开头调用一次,把正文重置回规范内容——假后端的 save_file 会把保存的正文写回这里,模拟「保存后重新打开」。
 */
export function registerTodoFile(content = TODO_FILE) {
  FILES.file_todo = {
    item: fileItem('file_todo', TODO_PATH, ['待办']),
    preview: { format: 'kbtodo', editable: true, extractor: 'text/plain', content, blocks: [], chunks: [] },
  }
  return FILES.file_todo
}
