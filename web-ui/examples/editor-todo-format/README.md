# 待办清单格式(editor-todo-format)

编辑器扩展示例:**注册一种新文件格式**。装上后,知识库的文件浏览页里打开 `.kbtodo` 文件,会看到一个可勾选的待办清单,
改完点「保存」写回原文件(和文本文件同一条保存通道、同样的版本冲突检查)。

- **Codec**(`kb.todo-format.codec`):磁盘上的 `.kbtodo` 是 JSON(`{ "title": …, "items": [{ "text": …, "done": … }] }`,两个空格缩进、结尾有换行);
  编辑器里是清单文本(`# 标题` 加每行 `[ ] 文字` / `[x] 文字`)。解码遇到不合法的 JSON、带换行的条目会报错而不是悄悄丢数据;
  编码遇到认不出的行同样报错,保存被取消、原文件不动。
- **内容面**(`kb.todo-format.surface`):把清单画成复选框列表,可改字、增删条目;有编辑权限且文件可编辑时能改,否则只读。
- **权限**:`document.read` + `document.write`(Codec 必须同时有;**第一次保存会弹确认**,拒绝则保存失败)+ `ui`(内容面)。
  不申请联网、剪贴板、AI。

## 安装

```bash
# 1. config.toml 里打开开关(热更新,不用重启):
#      [editor]
#      extensions = true
# 2. 目录名必须等于清单里的 id
cp -r web-ui/examples/editor-todo-format ~/.kb/editor-extensions/kb.todo-format
# 3. 刷新管理端页面(只有管理员的浏览器会加载扩展),上传或打开一个 .kbtodo 文件
printf '{\n  "title": "周五发布",\n  "items": [\n    { "text": "冻结版本", "done": true },\n    { "text": "写发布说明", "done": false }\n  ]\n}\n' > demo.kbtodo
```

## 卸载

```bash
rm -r ~/.kb/editor-extensions/kb.todo-format     # 或者把 [editor] extensions 改回 false
```

卸载后同一个文件回到原来的显示(代码视图 / 下载),文件内容不受影响。可以反复装卸。

## 只有管理员、只认不内置的扩展名

扩展只在管理员的浏览器里加载;普通用户打开 `.kbtodo` 看到的仍是原来的代码视图。
`md`、`csv`、`pdf`、`docx` 等内置格式永远优先,Codec / 内容面注册它们会失败。

完整的扩展写法见 `docs/EDITOR_EXTENSIONS.md`。
