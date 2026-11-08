// 三种格式的引擎,统一成同一个小接口;每种格式第一次用到才加载它的 WASM(docx 引擎最重,只用 xlsx 时不加载)。
import { readFile } from 'node:fs/promises'

const loading = new Map()

async function wasmBytes(specifier, relative) {
  const entry = new URL(import.meta.resolve(specifier))
  return readFile(new URL(relative, entry))
}

function once(name, load) {
  if (!loading.has(name)) loading.set(name, load())
  return loading.get(name)
}

const loaders = {
  xlsx: () =>
    once('xlsx', async () => {
      const engine = await import('@betteroffice/xlsx')
      await engine.initWasm(await wasmBytes('@betteroffice/xlsx', './generated/xlsx_wasm_bg.wasm'))
      return engine
    }),
  pptx: () =>
    once('pptx', async () => {
      const engine = await import('@betteroffice/pptx')
      await engine.initWasm(await wasmBytes('@betteroffice/pptx', './generated/pptx_wasm_bg.wasm'))
      return engine
    }),
  docx: () => once('docx', async () => import('@betteroffice/docx/yrs')),
}

/** 已经加载了哪些格式(监控用)。 */
export function loadedFormats() {
  return [...loading.keys()]
}

/**
 * 打开一份文件,得到服务端副本。
 * - xlsx / pptx:从同一份字节打开,各端初始状态天然相同(与 clientId 无关),所以浏览器只要原字节,不要初始状态;
 * - docx:每次打开会生成新的身份,浏览器必须拿服务端的状态(`seed()`);`generation` 由底稿哈希决定,
 *   图片用 `mediaTokens` 指向包里的部件,不进状态(否则一份带截图的手册状态有几十 MB)。
 */
export async function openReplica(format, bytes, { clientId, generation }) {
  if (format === 'xlsx') {
    const engine = await loaders.xlsx()
    const handle = engine.openWorkbook(bytes, { collaborative: true, clientId })
    return {
      format,
      handle,
      stateVector: () => handle.encodeStateVector(),
      diff: (sv) => handle.encodeStateAsUpdate(sv),
      apply: (update) => handle.applyUpdate(update),
      save: async () => handle.save(),
      seed: () => null,
      dispose: () => handle.dispose?.(),
    }
  }
  if (format === 'pptx') {
    const engine = await loaders.pptx()
    const handle = engine.openPresentation(bytes, { clientId })
    return {
      format,
      handle,
      stateVector: () => handle.encodeStateVector(),
      diff: (sv) => handle.encodeStateAsUpdate(sv),
      apply: (update) => handle.applyUpdate(update),
      save: async () => handle.save(),
      seed: () => null,
      dispose: () => handle.dispose?.(),
    }
  }
  if (format === 'docx') {
    const engine = await loaders.docx()
    const session = await engine.createYrsSession({ clientId })
    session.seedFromDocx(bytes, { generation, mediaTokens: true })
    return {
      format,
      handle: session,
      stateVector: () => session.encodeStateVector(),
      diff: (sv) => session.encodeStateAsUpdate(sv),
      apply: (update) => session.applyUpdate(update),
      save: async () => (await engine.saveYrsDocx(session)).bytes,
      seed: () => session.encodeState(),
      dispose: () => session.destroy?.(),
    }
  }
  throw new Error(`不支持的格式:${format}`)
}
