# 编辑器扩展(API v1)

编辑器扩展让管理员往知识库的编辑器里加东西:自己的命令、工具栏按钮、斜杠菜单项、侧边面板、状态栏项、新文件格式的读写、新格式的显示方式,以及对选中文字调用的 AI 工具。

**编辑器自己的功能也是用同一套扩展接口做的**(各内容面的工具栏、导出、评论、AI 改写、字数……),见下面「内置功能也是扩展」。所以这里写的每一类注册点都是真实在用的,不是另一套只给第三方的简化版。

- **谁能用**:扩展放在服务器本地的一个目录里,只有管理员(能改系统参数的账号)的浏览器会加载它们。
- **API 版本**:`api_version = 1`。新增可选字段不升版本;破坏性变更才升到 2(见「版本与兼容」)。
- **示例**:`web-ui/examples/editor-word-count/` 是一个能直接用的完整扩展(字数统计,可独立安装 / 卸载,见下面「安装」与「卸载」);`web-ui/examples/editor-todo-format/` 演示注册一种新文件格式(`.kbtodo`,Codec + 内容面,见「注册一种新格式」)。下面每个小节的代码也都是可复制的,并且由测试 `web-ui/src/editor/extensions/docs.spec.ts` 真的跑过。

## 先读这一段:信任模型

扩展是 JavaScript,**在管理员的浏览器页面里运行,和页面本身同权限**:它能做页面能做的一切,包括调用知识库的所有接口。所以:

1. 只加载**管理员自己放进本地目录**的扩展(`[editor] extensions_dir`),没有在线市场,也不从网上下载。
2. 开关 `[editor] extensions` **默认关**,而且只能在 `config.toml` 里改(设置页里没有这个开关)。
3. 清单和脚本的接口只给管理员:普通用户请求得到 403,他们的编辑器里不会出现任何扩展。
4. 「权限」(下面的权限表)是**协作式的 API 闸门**,不是安全沙箱。它保证:扩展通过宿主 API 做的每一件事都有声明、`document.write` 有用户确认、越权调用会抛错——这能挡住写错的扩展和误操作。它**挡不住故意作恶的脚本**(脚本和页面在同一个 JS 环境里,可以绕开宿主 API 直接调浏览器接口)。**只安装你读过代码、信得过的扩展。**

## 安装

1. 在 `config.toml` 里打开开关(热更新,不用重启守护进程):

   ```toml
   [editor]
   extensions = true
   # extensions_dir = "/opt/kb-extensions"   # 可选;缺省是 <KB_HOME>/editor-extensions
   ```

   `extensions_dir` 写绝对路径,或相对 `KB_HOME` 的路径(不能含 `..`)。

2. 一个扩展一个目录,**目录名必须等于清单里的 `id`**:

   ```text
   <KB_HOME>/editor-extensions/
   └── kb.word-count/
       ├── manifest.toml      # 清单(必需)
       ├── index.js           # 入口脚本(清单的 entry,缺省 index.js)
       └── style.css          # 可选:其它 .js / .css / .json / .svg 文件
   ```

   把仓库里的示例装上:`cp -r web-ui/examples/editor-word-count ~/.kb/editor-extensions/kb.word-count`。

3. 刷新管理端页面,打开任意一份文档。工具栏上会出现扩展的按钮,操作区会出现面板开关。

### 卸载

删掉扩展目录(`rm -r ~/.kb/editor-extensions/kb.word-count`),或者把 `[editor] extensions` 改回 `false`。已经打开的页面收到配置热更新通知后,这个扩展的工具栏按钮、面板开关、已展开的面板、命令会立刻消失,编辑器自己的功能不受影响;没收到通知时刷新页面即可。再放回目录又会装上,重复安装不会出现两个按钮。

这几件事(装上、运行、卸载、反复装卸、卸载后内置功能不受影响)由 `web-ui/src/editor/host/editorHost.builtin.spec.ts` 在真实的 `EditorHost` 上用示例的真实 `index.js` 验证过,没有给 Host 加过任何针对示例的代码;`web-ui/e2e/editor-extensions.mjs` 在真实构建和站点 CSP 下再跑一遍。

改了 `config.toml` 的 `[editor]` 之后,已经打开的页面会跟着变(开关关掉时已加载的扩展立刻撤掉;这个通知只推给能看系统状态的管理员);改了扩展自己的文件需要**刷新页面**,并且最好同时升一下清单里的 `version`(浏览器按「地址 + 版本号」缓存脚本模块,版本不变时刷新才能保证拿到新代码)。

扩展目录本身可以是符号链接(方便把开发中的目录链进来);目录**里面**的符号链接一律不会被下发。

## manifest.toml

```toml
id = "kb.word-count"            # 必需。小写字母、数字、"." 和 "-";不能以分隔符开头或结尾;最长 64
name = "字数统计"                # 必需。1~80 个字符
version = "1.0.0"               # 必需。semver(1.2.3、1.0.0-beta.1)
api_version = 1                 # 必需。这个编辑器支持 1;写 2 会被拒绝并提示升级编辑器
description = "……"              # 可选,≤500 字
entry = "index.js"              # 可选,缺省 index.js;扩展目录内的 .js 文件
permissions = ["document.read", "ui"] # 可选,缺省为空(最小权限)

[[contributes.commands]]        # 声明会注册的命令
id = "kb.word-count.show"
title = "字数统计"
```

### 贡献必须先声明

扩展在 `activate` 里注册的每一样东西,都要先在清单的 `[[contributes.*]]` 里声明,并且**id 必须以扩展 id + `.` 开头**(例如扩展 `kb.word-count` 的命令叫 `kb.word-count.show`)。没声明就注册会抛错。这样做是为了:

- 第三方扩展不可能覆盖内置命令(`mark.toggle`、`search.open` 这类名字没有扩展 id 前缀);
- 管理员看清单就知道一个扩展会往编辑器里加什么;
- Codec 和内容面要接管哪些扩展名,在清单里一目了然。

| 声明项 | 字段 | 对应的注册方法 |
| --- | --- | --- |
| `[[contributes.commands]]` | `id`、`title` | `registerCommand` |
| `[[contributes.toolbar]]` | `id` | `registerToolbarItem`、`registerStatusItem`(状态栏项和工具栏按钮一样是「加进编辑器外壳的条目」,共用这一类声明) |
| `[[contributes.slash]]` | `id` | `registerSlashItem` |
| `[[contributes.panels]]` | `id`、`title`、可选 `icon`(≤8 字符) | `registerPanel` |
| `[[contributes.codecs]]` | `id`、`extensions`(1~8 个小写字母数字扩展名,不带点) | `registerCodec` |
| `[[contributes.surfaces]]` | `id`、`extensions` | `registerSurface` |
| `[[contributes.ai_tools]]` | `id`、`title` | `registerAITool` |

清单里没认识的键会被忽略(为了新增可选字段不必升版本)。写错了键名不会报错,但对应功能不会生效——排错时先看下面「排错」里的清单接口。

## 权限

权限在清单的 `permissions` 里声明。**没声明的权限,对应的 API 调用会抛 `PermissionDeniedError`**(不是返回 `undefined`),错误信息里写明缺哪一项。

| 权限 | 解锁什么 | 说明 |
| --- | --- | --- |
| `document.read` | `document.read()`、`document.onChange()`;AI 工具读选区;Codec 的 `decode`;内容面 | 读当前打开的文档(协同编辑时读到的是大家正在改的版本) |
| `document.write` | `document.replaceSelection()`、`document.insertText()`;Codec 的 `encode`;内容面里改文档 | **声明之外还要用户确认**:第三方扩展第一次真正写文档时弹出确认框,允许后同一页面会话内不再问;拒绝也会记住(不会反复追问);文档只读时直接拒绝,不弹框 |
| `clipboard` | `clipboard.writeText()`、`clipboard.readText()` | 浏览器剪贴板 |
| `network` | `fetch()` | 受限:只允许 `https://` 地址和本扩展自己目录下的文件;访问外部地址不带 cookie,一律不跟随重定向。**默认关闭** |
| `ai` | `registerAITool()` | AI 工具运行时还需要 `document.read`(读选区);接受建议写回文档还需要 `document.write` |
| `ui` | `registerToolbarItem()`、`registerSlashItem()`、`registerPanel()`、`registerStatusItem()`、`registerSurface()`、`notify()` | 往界面里加东西 |

另有组合要求:`registerCodec` 需要 `document.read` + `document.write`;`registerSurface` 需要 `ui` + `document.read`。

内置扩展(随应用打包、进程内运行)不需要用户确认写权限,也不受「先声明、带前缀」的限制,还多一条宿主页面通道(`api.page`,见「内置功能也是扩展」);第三方扩展没有这条通道。

## 写一个扩展

入口脚本是一个**纯 ES 模块**,默认导出一个带 `activate` 的对象。不需要构建工具,也不要 `import` 任何东西(浏览器里没有可 import 的编辑器模块):

```js
export default {
  activate(ctx) {
    // 在这里注册命令、按钮、面板……
  },
  deactivate() {
    // 可选:卸载前收尾。此时 ctx 已失效。
  },
}
```

`ctx`(`ExtensionContext`)是按清单权限裁剪过的:

```ts
interface ExtensionContext {
  readonly manifest: ExtensionManifest
  readonly document: DocumentApi        // read() / onChange(fn) / replaceSelection(text) / insertText(text)
  readonly clipboard: ClipboardApi      // writeText(text) / readText()
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
  notify(message: string, tone?: 'success' | 'warning' | 'danger'): void
  registerCommand(id: string, handler: (args, api: HostApi) => void | Promise<void>): Disposable
  registerToolbarItem(spec: ToolbarItemSpec): Disposable
  registerSlashItem(spec: SlashItemSpec): Disposable
  registerPanel(spec: PanelSpec): Disposable
  registerStatusItem(spec: StatusItemSpec): StatusItemHandle   // 比 Disposable 多一个 refresh()
  registerCodec(spec: CodecSpec): Disposable
  registerSurface(spec: SurfaceSpec): Disposable
  registerAITool(spec: AIToolSpec): Disposable
  readonly subscriptions: { add(disposable: Disposable | (() => void)): void }
}
```

命令处理器、面板、AI 工具拿到的 `api`(`HostApi`)是同样的 `manifest` / `document` / `clipboard` / `fetch` / `notify`,但**绑定在触发它的那个编辑器上**——同时打开多个文档时不会串。`activate` 里直接用 `ctx.document` 则跟随「当前活动的编辑器」。

完整的类型在 `web-ui/src/editor/extensions/api.ts`。用 TypeScript 写(仓库内的内置扩展)时从 `@/editor/api` 导入类型和 `defineExtension`,例子见 `web-ui/src/editor/extensions/examples/typed.ts`。

所有 `register*` 返回 `Disposable`(可重复 `dispose()`);扩展卸载时注册的一切都会被自动撤销,放进 `ctx.subscriptions` 的订阅也一样。

### 文档 API

| 方法 | 权限 | 行为 |
| --- | --- | --- |
| `document.read()` | `document.read` | 返回 `{ text, selection, format, kind, readonly }`;`selection` 没有选区时是空串 |
| `document.onChange(listener)` | `document.read` | 正文变化时调用(宿主已防抖约 150 ms);回调里再 `read()` 取最新内容。返回 `Disposable` |
| `document.replaceSelection(text)` | `document.write` + 用户确认 | 用 `text` 替换选区;**没有选区时抛错**(不猜光标) |
| `document.insertText(text)` | `document.write` + 用户确认 | 在光标处插入;有选区时和键盘输入一样替换选区 |

写入和用户自己输入一样进撤销历史和版本记录。文档只读(账号没有写权限、只读分享等)时写入直接抛 `PermissionDeniedError`,不弹确认框。

## 八类贡献,各一个例子

每个例子是一对:`toml` 清单 + `js` 入口脚本。可以直接保存成 `manifest.toml` 和 `index.js` 放进一个以 id 命名的目录。八类是:命令、工具栏按钮、斜杠菜单项、面板、状态栏项、Codec、内容面、AI 工具(另有剪贴板和联网两个权限的例子)。

### 命令(registerCommand)

命令是扩展里可被调用的一段代码。工具栏按钮、斜杠菜单项触发的都是命令。`args` 来自按钮声明的 `args`;`api.notify` 给用户一条不打断编辑的提示。

```toml example=command
id = "kb.hello"
name = "打招呼"
version = "1.0.0"
api_version = 1
permissions = ["ui"]

[[contributes.commands]]
id = "kb.hello.say"
title = "打招呼"
```

```js example=command
export default {
  activate(ctx) {
    ctx.registerCommand('kb.hello.say', (args, api) => {
      api.notify(`你好,${args?.name ?? '世界'}`)
    })
  },
}
```

### 工具栏按钮(registerToolbarItem,需要 `ui`)

按钮点击后执行**同一个扩展里声明的**命令(扩展不能借按钮触发内置命令)。`group` 指定放进哪个分组——内置分组有 `marks`、`blocks`、`lists`、`insert`、`view`;不写就放进最后新建的「扩展」分组。`kinds` 限定在哪些内容面显示(缺省全部),`write: true` 表示命令会改文档,只读时按钮不显示。

其余可选字段(都不升 `api_version`;编辑器自己的工具栏就是用它们写的):

| 字段 | 作用 |
| --- | --- |
| `formats` | 只在这些文件格式(小写扩展名,不带点)显示,如 CSV 的行操作 `formats: ['csv', 'tsv']`;缺省不限格式。要求了格式、而宿主不知道当前格式时按钮不出现 |
| `profile` | 同一内容面有多套工具栏时的方案名(Word 的只读预览是缺省的 `default`,画布编辑是 `edit`)。不写 = 所有方案里都显示 |
| `placement` | `toolbar`(缺省,格式工具栏)或 `bar`(顶栏右侧操作区,带文字的小按钮,和面板开关、撤销 / 保存同一排) |
| `capability` | `ai` / `comment` / `export`:嵌入编辑器的页面接入了这项能力才显示 |
| `compact` | `hide`:手机上外壳压成一行时不显示 |
| `check` | 高亮判定:`{ kind: 'toggle', name }` 开关类,`mark` / `block` / `list` / `value` 由内容面上报的格式状态决定 |
| `choices` | 带选项的按钮(字号、颜色、表格大小):点开列出选项,选中某项时用该项的 `args` 执行 `command` |
| `children` | 下拉按钮:自己不执行命令,点开列出子动作。只支持一层;子项的 `command` 同样必须是本扩展声明的命令;不能和 `choices` 同时用 |
| `keywords` / `shortcut` / `description` | 检索关键词 / 快捷键提示(只显示,不绑定按键)/ 比 `label` 更完整的悬停说明 |

同一个 `id` 可以为**互不重叠**的范围(内容面 / 格式 / 方案 / 放置位置)各注册一次,范围重叠才算冲突——编辑器内置的「查找」就是在文本、代码、PDF、表格、Word 上各注册了一次。

```toml example=toolbar
id = "kb.bar"
name = "字符数"
version = "1.0.0"
api_version = 1
permissions = ["document.read", "ui"]

[[contributes.commands]]
id = "kb.bar.count"
title = "统计字符数"

[[contributes.toolbar]]
id = "kb.bar.button"
```

```js example=toolbar
export default {
  activate(ctx) {
    ctx.registerCommand('kb.bar.count', async (_args, api) => {
      const doc = await api.document.read()
      api.notify(`共 ${doc.text.length} 个字符`)
    })
    ctx.registerToolbarItem({
      id: 'kb.bar.button',
      label: '字符数',
      icon: '#',
      command: 'kb.bar.count',
      group: 'view',
    })
  },
}
```

### 斜杠菜单项(registerSlashItem,需要 `ui`)

在笔记的空行里输入 `/` 弹出的菜单。缺省只出现在文本面(`kinds` 缺省 `['text']`);斜杠项一定会改文档,所以只读时不出现。下面的例子在光标处插入一行签名,所以还需要 `document.write`(第一次插入时用户会被问一次)。

```toml example=slash
id = "kb.sign"
name = "签名"
version = "1.0.0"
api_version = 1
permissions = ["document.write", "ui"]

[[contributes.commands]]
id = "kb.sign.insert"
title = "插入签名"

[[contributes.slash]]
id = "kb.sign.slash"
```

```js example=slash
export default {
  activate(ctx) {
    ctx.registerCommand('kb.sign.insert', (_args, api) => api.document.insertText('—— 来自知识库'))
    ctx.registerSlashItem({
      id: 'kb.sign.slash',
      label: '签名',
      command: 'kb.sign.insert',
      keywords: ['sign', 'qianming'],
    })
  },
}
```

### 面板(registerPanel,需要 `ui`)

面板在编辑器顶栏下面展开,工具栏操作区有开关按钮。`mount(el, api)` 往 `el` 里画 DOM,可以返回清理函数——面板被收起、扩展被卸载或编辑器关闭时调用。`api` 绑定在这个面板所在的编辑器上。

```toml example=panel
id = "kb.stats"
name = "行数面板"
version = "1.0.0"
api_version = 1
permissions = ["document.read", "ui"]

[[contributes.panels]]
id = "kb.stats.panel"
title = "行数"
icon = "≡"
```

```js example=panel
export default {
  activate(ctx) {
    ctx.registerPanel({
      id: 'kb.stats.panel',
      title: '行数',
      icon: '≡',
      mount(el, api) {
        const label = document.createElement('p')
        el.append(label)
        const refresh = async () => {
          const { text } = await api.document.read()
          label.textContent = `共 ${text.split('\n').length} 行`
        }
        const subscription = api.document.onChange(refresh)
        void refresh()
        return () => {
          subscription.dispose()
          label.remove()
        }
      },
    })
  },
}
```

### 状态栏项(registerStatusItem,需要 `ui`)

往外壳里加一小段文字:`area: 'status'`(缺省)放在底部状态栏,`area: 'chrome'` 放在顶栏操作区。`text(state)` 每次返回要显示的文字,返回空串表示这一刻不显示;`state` 是只读快照:`{ kind, format, words, unitLabel, readonly, dirty, phase }`(`words` / `unitLabel` 是内容面上报的计数,文本面是字数,表格是「格」,PDF 是「页」)。宿主在计数、状态变化后会重新求值;扩展自己的数据变了就调用返回句柄的 `refresh()`。`text` 抛错只会让这一项不显示,不影响别的。`kinds` 限定内容面(缺省全部)。编辑器自己的字数就是这样做的(`kb.builtin.stats`)。状态栏项在清单里用 `[[contributes.toolbar]]` 声明。

```toml example=status
id = "kb.fmt"
name = "格式提示"
version = "1.0.0"
api_version = 1
permissions = ["ui"]

[[contributes.toolbar]]
id = "kb.fmt.item"
```

```js example=status
export default {
  activate(ctx) {
    ctx.registerStatusItem({
      id: 'kb.fmt.item',
      area: 'status',
      title: '当前文件格式',
      text: (state) => (state.readonly ? '' : `格式 ${state.format}`),
    })
  },
}
```

### Codec(registerCodec,需要 `document.read` + `document.write`)

Codec 教编辑器读写一种它不认识的文件格式:`decode` 把文件字节翻译成可编辑的文本,`encode` 在保存时翻译回字节。**只能接管宿主不认识的扩展名**——`md`、`csv`、`pdf`、`docx` 等内置格式永远优先,注册会失败。Codec 解码出的文本默认交给代码内容面(`surface: 'code'`)显示和编辑;`encode` 会写回文件,所以第一次保存时要用户确认。

```toml example=codec
id = "kb.rot13"
name = "ROT13 文件"
version = "1.0.0"
api_version = 1
permissions = ["document.read", "document.write"]

[[contributes.codecs]]
id = "kb.rot13.codec"
extensions = ["rot13"]
```

```js example=codec
const rot13 = (text) =>
  text.replace(/[a-z]/gi, (ch) => {
    const base = ch <= 'Z' ? 65 : 97
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base)
  })

export default {
  activate(ctx) {
    ctx.registerCodec({
      id: 'kb.rot13.codec',
      decode: (bytes, { name }) => ({ kind: 'text', text: rot13(new TextDecoder().decode(bytes)), name }),
      encode: (source) => new TextEncoder().encode(rot13(source.kind === 'text' ? source.text : '')),
    })
  },
}
```

### 内容面(registerSurface,需要 `ui` + `document.read`)

内容面决定一种格式怎么显示。它的类型叫 `ext:<贡献 id>`,实现 `mount / unmount / resize / focus / setReadonly / command / query / capture / restore` 九个方法(见 `web-ui/src/editor/types.ts` 的 `Surface`)。`mount(el, ctx)` 的 `ctx.document.payload` 是文件内容(`{ kind: 'text', text }` 或 `{ kind: 'bytes', bytes }`)。扩展内容面拿到的会话是受限的:读安全的命令放行,改文档的命令需要 `document.write` 和用户确认。同一个扩展名可以同时有 Codec 和内容面:Codec 负责字节 ↔ 文本,内容面负责显示。文件浏览页怎么用它们、保存时有哪些规则,见下面「注册一种新格式」。

```toml example=surface
id = "kb.lines"
name = "逐行列表"
version = "1.0.0"
api_version = 1
permissions = ["ui", "document.read"]

[[contributes.surfaces]]
id = "kb.lines.surface"
extensions = ["lines"]
```

```js example=surface
export default {
  activate(ctx) {
    ctx.registerSurface({
      id: 'kb.lines.surface',
      create() {
        let list = null
        return {
          async mount(el, surfaceCtx) {
            const source = surfaceCtx.document.payload
            const text = source.kind === 'text' ? source.text : new TextDecoder().decode(source.bytes)
            list = document.createElement('ul')
            for (const line of text.split('\n')) {
              const item = document.createElement('li')
              item.textContent = line
              list.append(item)
            }
            el.append(list)
          },
          unmount() {
            list?.remove()
            list = null
          },
          resize() {},
          focus() {},
          setReadonly() {},
          async command() {
            return { ok: false, reason: 'readonly_surface' }
          },
          async query() {
            return null
          },
          capture() {
            return { kind: 'ext:kb.lines.surface' }
          },
          restore() {},
        }
      },
    })
  },
}
```

### AI 工具(registerAITool,需要 `ai`)

AI 工具出现在顶栏「AI」菜单里。用户选中一段文字后点工具,宿主调用 `run(input, api)`,`input` 是 `{ text, format, kind }`(`text` 是选区);返回值**一律作为「建议」展示**,不会自己改文档——用户点「接受」才写回,写回走 `document.replaceSelection`(所以需要 `document.write` 和用户确认),并且要求选区在此期间没有变。运行需要 `ai` + `document.read`。文档没有 AI 权限时工具不显示。

```toml example=ai
id = "kb.shout"
name = "大声说"
version = "1.0.0"
api_version = 1
permissions = ["ai", "document.read", "document.write"]

[[contributes.ai_tools]]
id = "kb.shout.upper"
title = "转大写"
```

```js example=ai
export default {
  activate(ctx) {
    ctx.registerAITool({
      id: 'kb.shout.upper',
      title: '转大写',
      description: '把选中的英文转成大写',
      run: async (input) => ({ text: input.text.toUpperCase(), note: '只转英文字母' }),
    })
  },
}
```

### 剪贴板(`clipboard`)

```toml example=clipboard
id = "kb.copy"
name = "复制选区"
version = "1.0.0"
api_version = 1
permissions = ["clipboard", "document.read", "ui"]

[[contributes.commands]]
id = "kb.copy.selection"
title = "复制选区"
```

```js example=clipboard
export default {
  activate(ctx) {
    ctx.registerCommand('kb.copy.selection', async (_args, api) => {
      const { selection } = await api.document.read()
      await api.clipboard.writeText(selection)
      api.notify('已复制选区')
    })
  },
}
```

### 联网(`network`,默认关闭)

`api.fetch` 只放行 `https://` 地址(以及本扩展自己目录下的文件 `/api/v1/editor/extensions/<id>/…`),访问外部地址不带 cookie、一律不跟随重定向。访问本站的其它接口、`http://`、`data:` 都会抛 `PermissionDeniedError`。

```toml example=network
id = "kb.fetch"
name = "取数据"
version = "1.0.0"
api_version = 1
permissions = ["network", "ui"]

[[contributes.commands]]
id = "kb.fetch.now"
title = "取数据"
```

```js example=network
export default {
  activate(ctx) {
    ctx.registerCommand('kb.fetch.now', async (_args, api) => {
      const response = await api.fetch('https://api.example.com/v1/status')
      api.notify(`状态:${(await response.json()).status}`)
    })
  },
}
```

## 注册一种新格式

Codec 与内容面合起来就是「一种新文件格式」:不改 `EditorHost`、不改任何页面,装上扩展后,知识库的**文件浏览页**里打开这种扩展名的文件就会用你的内容面显示,有权限时还能改、能存。完整的可运行例子是 `web-ui/examples/editor-todo-format/`(`.kbtodo`:磁盘上是 JSON,Codec 把它翻译成「待办清单」文本,内容面把清单画成可勾选的列表;可独立安装 / 卸载,见它的 `README.md`)。

清单里把同一个扩展名同时声明给 Codec 和内容面,Codec 的 `surface` 指向自己的内容面:

```toml
id = "kb.todo-format"
name = "待办清单格式"
version = "1.0.0"
api_version = 1
# Codec 要读字节、保存时写回(document.read + document.write);内容面要画界面(ui)
permissions = ["document.read", "document.write", "ui"]

[[contributes.codecs]]
id = "kb.todo-format.codec"
extensions = ["kbtodo"]

[[contributes.surfaces]]
id = "kb.todo-format.surface"
extensions = ["kbtodo"]
```

```js
export default {
  activate(ctx) {
    ctx.registerCodec({
      id: 'kb.todo-format.codec',
      surface: 'ext:kb.todo-format.surface',
      decode: (bytes, { name }) => ({ kind: 'text', text: toChecklist(parseTodoJson(new TextDecoder().decode(bytes))), name }),
      encode: (source) => new TextEncoder().encode(toTodoJson(fromChecklist(source.text))),
    })
    ctx.registerSurface({ id: 'kb.todo-format.surface', create: createSurface })
  },
}
```

内容面在 `mount` 里读 `ctx.document.payload`(Codec 解码后的 `{ kind: 'text', text }`),用 `ctx.session.setSnapshotProvider(() => ({ kind: 'text', text, name }))` 告诉宿主「保存时要写的当前内容」,改动时调 `ctx.onDirtyChange(true)`,把 Ctrl/⌘+S 交回 `ctx.onSaveRequest()`;`query({ type: 'text' })` 返回当前文本。完整写法看示例的 `index.js`。

### 文件浏览页怎么用它

- **只问内置不认识的扩展名**:`pdf`、`docx`、`md`、`csv`、`json`、`rs` 等页面自己认得的格式永远优先,扩展不能接管(注册会失败)。页面对不认得的扩展名才去问扩展注册表。
- **只在管理员的浏览器里**:要有「系统参数」功能点、`[editor] extensions = true`,且扩展已加载。其它账号连清单都不请求(请求了也是 403),文件照旧按原来的方式显示;扩展没装、开关关着、被撤掉,同样回到原来的显示(代码视图 / 嗅探 / 下载)。开关在页面打开期间被改,页面会跟着切换。
- **阅读**:用统一外壳**只读**打开。后端给了文本原文(≤ 512 KB 的 UTF-8)就用它,有 Codec 时先经 `decode`;没有文本原文(二进制、太大)就取原件字节。原件读不到时退回检索用的文字层并说明原因。
- **编辑与保存**:文件可编辑(后端读到了整份 UTF-8 文本)、页面不是只读时,文件页的「编辑」按钮照常出现,走和文本文件**同一条**保存通道和版本冲突检查(别人在你之后保存过,这次保存会被拒绝,改动留在编辑器里)。保存时 Codec 的 `encode` 把编辑中的文本翻译回字节,**第一次保存要用户确认**(`document.write`),拒绝则这次保存失败、保存通道一次都不会被调用。
- **编码结果必须是 UTF-8 文本**:文件页的保存通道存的是文本。`encode` 产出的字节不是合法 UTF-8 时保存会被拒绝并说明原因,原文件不动;`decode` / `encode` 抛错(格式不对、内容认不出)同样是保存失败而不是悄悄写坏。要存二进制格式请换用别的入口,这个入口不支持。
- **不连多人编辑房间**:房间里存的是文件原文,而扩展内容面编辑的是 Codec 解码后的文本,两者对不上,所以这类文件不进协同房间;多人同时改靠保存时的版本检查。
- **没有 Codec、只有内容面**也可以:内容面拿到的就是文件原文(`{ kind: 'text', text }`,没有文本原文时是 `{ kind: 'bytes', bytes }`),保存的是内容面快照给出的文本。

这条路径由 `web-ui/src/components/FileViewer.extension.spec.ts`(查看器)、`web-ui/src/editor/host/editorHost.todoformat.spec.ts`(外壳里打开 / 改 / 存 / 拒绝写权限)和 `web-ui/e2e/editor-extensions.mjs` 里的 `todo-format-*` 场景(真实构建 + 站点 CSP:开启 → 打开 → 改一处 → 保存 → 重新打开内容正确;关开关回到回退;非管理员 403 回到回退且不报错)守着。

## 内置功能也是扩展

编辑器自己的功能没有走后门:各内容面的工具栏、斜杠菜单、导出、评论、AI 改写、字数,都是**随应用打包的内置扩展**,经和第三方完全相同的 `register*` 接口放进同一个注册表。`EditorHost` / `EditorChrome` / `EditorStatus` 只从注册表读贡献、渲染、把命令转出去,不认识任何一个具体按钮,也不含格式逻辑——把某个内置扩展卸掉,对应入口就从界面上消失(测试里正是这样验证的)。

内置扩展与第三方扩展的区别只有这几点:

- 随应用打包、进程内同步启动(`registry.installBuiltin`),不从扩展目录加载,也不需要管理员开 `[editor] extensions`;
- 不需要在清单里声明贡献,也不受「id 带扩展前缀」的限制(按钮 id 和命令名要与快捷键、测试选择器认的原名一致,如 `bold`、`search.open`);
- 写文档不需要用户确认;
- 多一条**宿主页面通道** `api.page.emit('export' | 'comment' | 'ai', payload)`:导出、评论、AI 面板是嵌入编辑器的页面(笔记页、文件页)的事,内置命令把事件交给页面,Host 补上页面要的数据(当前正文、选区与锚点)后抛出 `export` / `comment` / `ai` 事件。第三方的 `api.page` 恒为 `undefined`;`AIToolSpec.target: 'page'`(结果交给页面的 AI 面板、不显示「建议」条)同样只有内置扩展能用。

### 内置扩展一览

源码都在 `web-ui/src/editor/extensions/builtin/`,按这个顺序安装(`builtin/index.ts`;顺序决定工具栏里的先后,文本面的格式分组必须先于它的「视图」分组)。工具栏 / 斜杠菜单的**数据**仍然集中写在 `builtin/text.ts`(`TEXT_TOOLBAR`、`CODE_TOOLBAR`、`PAGE_EDIT_TOOLBAR`、`CONTRIBUTIONS` 等,一份声明三处使用),`*.ext.ts` 只负责把它们逐项注册——往那些常量里加新的分组或动作,不用改注册代码。

| 扩展 id | 贡献 | 原来写死在哪里 |
| --- | --- | --- |
| `kb.builtin.text` | 文本面(笔记 / Markdown)的段落、格式、列表、插入工具栏,以及斜杠菜单的全部条目 | `EditorHost` 经 `contributionFor('text')` 直接取用静态常量 |
| `kb.builtin.view` | 文本面的「查找替换」「源码」「大纲」三个视图按钮 | 同上( 先迁了这一个) |
| `kb.builtin.code` | 代码面:查找替换、换行、全选、聚焦编辑区 | `CODE_TOOLBAR` 静态常量 |
| `kb.builtin.pdf` | PDF:查找 | `FIND_ONLY_TOOLBAR` 静态常量 |
| `kb.builtin.grid` | 表格:查找;CSV / TSV 的「行」操作(`formats: ['csv', 'tsv']`) | `FIND_ONLY_TOOLBAR` + `CSV_ROW_TOOLBAR`,`contributionFor('grid', format)` 按格式挑 |
| `kb.builtin.page` | Word:只读预览的查找 / 大纲 / 缩略图 / 高保真查看(`default` 方案),画布编辑的文字 / 段落 / 列表 / 插入 / 表格 / 视图 / 缩略图(`edit` 方案) | `PAGE_TOOLBAR` + `PAGE_READ_VIEW_EXTRA`(`page.thumbs`、`page.hifi`);编辑方案由 `OfficeEditor` 把整份 `PAGE_EDIT_CONTRIBUTION` 当 `contribution` 传给 Host,现在页面只传 `toolbarProfile="edit"`,再加 `PAGE_EDIT_VIEW_EXTRA`(`page.thumbs`)。两个新按钮都不是 `write` 动作,命令由内容面执行(`view.toggleThumbs` / `view.hifi`),按钮高亮来自内容面上报的开关 `thumbs` / `hifi` |
| `kb.builtin.slide` | 演示文稿的工具栏(PPTX 编辑落地后随 `CONTRIBUTIONS.slide` 自动注册;现在没有内置数据,什么也不注册) | 无 |
| `kb.builtin.export` | 顶栏操作区的「导出」按钮(`placement: 'bar'`、`capability: 'export'`)和命令 `export.open` | `EditorChrome` 模板里的「导出」按钮 + `emit('export')` |
| `kb.builtin.comment` | 顶栏操作区的「评论」按钮(`capability: 'comment'`)和命令 `comment.open` | `EditorChrome` 模板里的「评论」按钮 + `emit('comment')` |
| `kb.builtin.ai` | 三个 AI 工具:润色 / 总结 / 翻译选中(`target: 'page'`,页面接入 AI 能力才出现),与第三方 AI 工具同在顶栏「AI」菜单 | `EditorChrome` 里写死的 `AI_ACTIONS` 菜单 + `emit('ai')` |
| `kb.builtin.stats` | 两个状态栏项 `count`:顶栏(任何内容面,缺省单位「字」)和底部状态栏(有单位用单位,没有则只有文本面显示「N 字」) | `EditorChrome` 的 `countText`、`EditorStatus` 的 `countText` |

Host 里与这些入口有关的只剩两件通用的事:**按页面声明的能力过滤**(`capabilities.export` 等,没接入的能力入口不显示,避免死按钮),以及**转发**(命令交给注册表,页面事件抛给页面)。

### 写一个内置扩展

内置扩展用 TypeScript 写,除 `@/editor/api` 外只多用一个 `builtin/register.ts`(`builtinManifest`、`registerToolbarGroups`、`registerSlashActions`)。下面是 `export.ext.ts` 去掉文件头注释后的全部内容(一个命令加一个顶栏按钮),由 `docs.spec.ts` 核对它与源码逐字一致:

```ts source=builtin/export.ext.ts
import { defineExtension } from '../../api'
import { builtinManifest, type BuiltinExtension } from './register'

export const BUILTIN_EXPORT_ID = 'kb.builtin.export'

export const BUILTIN_EXPORT: BuiltinExtension = {
  manifest: builtinManifest({ id: BUILTIN_EXPORT_ID, name: '导出', description: '把当前正文交给页面导出为 Markdown', permissions: ['ui'] }),
  extension: defineExtension({
    activate(ctx) {
      ctx.registerCommand('export.open', (_args, api) => api.page?.emit('export'))
      ctx.registerToolbarItem({
        id: 'export',
        label: '导出',
        description: '导出 Markdown',
        command: 'export.open',
        placement: 'bar',
        capability: 'export',
        compact: 'hide',
      })
    },
  }),
}
```

新增一个内置扩展:写 `builtin/xxx.ext.ts`,在 `builtin/index.ts` 的 `BUILTIN_EXTENSIONS` 里按期望的先后顺序加一项。`docs.spec.ts` 会核对上面这张表和 `BUILTIN_EXTENSIONS` 一一对应,漏写了会变红。

## 已知限制(v1)

- **新格式的页面入口只覆盖文件浏览页(阅读、编辑)和文件查看器(只读)**:凡是把文件交给 `EditorHost` 的页面,宿主不认识的扩展名都会去问扩展的 Codec / 内容面;文件浏览页对不认得的扩展名也会问(见「注册一种新格式」)。文件页的保存通道只存 UTF-8 文本且不超过 512 KB,所以二进制格式的 Codec 在文件页只能阅读、不能保存。
- **扩展只在管理员的浏览器里加载**:普通用户的编辑器里没有任何扩展(清单接口对他们返回 403)。
- **斜杠菜单只有文本面(笔记 / Markdown)有**:`kinds` 写别的内容面也不会出现斜杠项。
- **不能自带大块资源**:单个文件上限 8 MB,只下发 `.js` / `.css` / `.json` / `.svg`。
- **没有界面里的扩展管理页**:安装 / 卸载就是放进 / 移出目录(或关掉开关),页面会跟着更新。

## 版本与兼容

- **`api_version`** 是整数,当前为 `1`。清单写了更大的值,这个编辑器会拒绝加载并说明「需要更新版本的编辑器扩展 API」。
- **新增可选字段不升版本**:清单和各 `*Spec` 以后加的可选字段,`api_version = 1` 的扩展照常工作;旧编辑器读到不认识的清单键会忽略它。
- **破坏性变更升到 2**:删字段、改语义、改权限含义。升级后 1 和 2 会并存一段时间。
- **扩展自己的 `version`** 是 semver,只用于显示和缓存:同一个 `id` 的 `version` 变了,页面(刷新后或收到配置更新通知后)会重新加载入口脚本并替换旧的。
- **只能用公开 API**:扩展不能 import `web-ui/src/editor/internal/*` 或编辑器的任何内部模块。仓库里的示例受 eslint `no-restricted-imports` 约束(只能 import `@/editor/api`),并有测试守着。内部模块随时可以重构,公开 API 才是契约。

## 后端接口(排错时有用)

两个接口都只对管理员开放(浏览器会话、admin key 或本机 socket;API 令牌不行),未登录返回 401,非管理员返回 403。

- `GET /api/v1/editor/extensions`:
  `{ ok: true, data: { enabled, dir, extensions: [{ id, dir, manifest, error }] } }`。
  `enabled` 是 `[editor] extensions` 的当前值,关着时 `extensions` 恒为空且没有 `dir`;`manifest` 是后端校验通过的清单(JSON,键名与 TOML 一致),有问题时为 `null`,`error` 里写原因。
- `GET /api/v1/editor/extensions/{id}/{文件}`:下发扩展目录里的静态文件,只认 `.js`、`.css`、`.json`、`.svg`(`manifest.toml` 本身不下发)。`Content-Type` 按类型给,`Cache-Control: no-cache`;SVG 带 `Content-Security-Policy: sandbox`。路径每一段只能含字母、数字、`.`、`_`、`-` 且不以 `.` 开头;扩展目录**里面**的符号链接一律拒绝(403);单个文件不超过 8 MB。

站点的 CSP(`script-src 'self'`)**没有为扩展放宽**:入口脚本由浏览器同源 `import()` 加载。如果你在反向代理上另外加了 CSP,要保证它不会拦截同源脚本。

## 排错

| 现象 | 原因与办法 |
| --- | --- |
| 编辑器里没有任何扩展 | 1) `config.toml` 里 `[editor] extensions = true` 了吗;2) 当前账号是不是管理员(能改系统参数);3) 扩展目录在不在(`GET /api/v1/editor/extensions` 返回的 `dir` 就是服务器实际在找的目录);4) 刷新页面 |
| 清单接口里这个扩展 `error` 不为空 | 按 `error` 说的改:缺 `manifest.toml`、字段不合法、`api_version` 太大、目录名与 `id` 不一致、入口文件不存在 |
| 控制台:`编辑器扩展 xxx 未能加载` | 入口脚本语法错误 / 没有默认导出带 `activate` 的对象 / `activate` 抛错。错误原因跟在后面 |
| `PermissionDeniedError: 扩展 xxx 没有「yyy」权限` | 在 `manifest.toml` 的 `permissions` 里加上 `yyy`,升一下 `version`,刷新页面 |
| `注册了命令「…」,但 manifest.toml 的 [[contributes.commands]] 里没有声明它` | 先在清单里声明,id 以 `扩展 id.` 开头 |
| `.xx 是内置支持的格式,扩展不能接管它` | 换一个宿主不认识的扩展名 |
| `.xx 已经被别的扩展接管` | 同一个扩展名只能有一个 Codec、一个内容面;先卸载另一个 |
| 装好了,但文件浏览页里这种扩展名的文件还是普通代码视图 | 1) 账号是不是管理员、`[editor] extensions = true` 了吗,清单接口里这个扩展 `error` 是否为空;2) 扩展名是不是页面自己认得的(`md`、`json`、`rs`…永远用内置显示,扩展不能接管);3) 清单里 Codec / 内容面的 `extensions` 写对了吗(小写、不带点);4) 刷新页面 |
| 保存时提示「编码出来的内容不是 UTF-8 文本」 | 文件页只能存文本文件:让 `encode` 返回 UTF-8 编码的字节,或不要在文件页编辑这种格式 |
| 写文档没有反应 / 提示「没有得到允许」 | 第一次写入时的确认框选了「不允许」;这个选择在本页面会话里一直有效,刷新页面后会重新问 |
| 提示「文档当前是只读的」 | 文档没有写权限(只读分享、他人正在编辑等),扩展写不了 |
| 改了 `index.js` 刷新后没变化 | 浏览器按「地址 + 版本号」缓存脚本;同时升一下清单里的 `version` |
| 管理员关了 `extensions` 但扩展还在 | 页面收到配置热更新通知后会立刻撤掉;没收到(WebSocket 断了、账号看不到系统事件)刷新页面即可 |
