# 字数统计(编辑器扩展示例)

纯 ES 模块,不依赖任何构建。统计正文的汉字数、英文词数、段落数和字符数:

- 工具栏「Σ 字数统计」:点一下用提示告诉你全文(和选中部分)的统计;
- 操作区的「Σ 字数统计」面板开关:展开后随输入实时更新,收起时清理订阅;
- 只申请了 `document.read` 和 `ui`:只读文档,不会(也不能)修改它。

## 安装

```bash
# 1. config.toml 里打开开关(热更新,不用重启):
#      [editor]
#      extensions = true
# 2. 目录名必须等于清单里的 id
cp -r web-ui/examples/editor-word-count ~/.kb/editor-extensions/kb.word-count
# 3. 刷新管理端页面(只有管理员的浏览器会加载扩展),打开任意文档
```

## 卸载

```bash
rm -r ~/.kb/editor-extensions/kb.word-count     # 或者把 [editor] extensions 改回 false
```

已经打开的页面会跟着变:按钮、面板开关、已展开的面板、命令一起消失,编辑器自己的功能不受影响;没收到热更新通知时刷新页面。
可以反复装卸,重复安装不会出现两个按钮。

## 怎么验证它没有改过编辑器本身

- `src/editor/host/editorHost.builtin.spec.ts`:在真实的 `EditorHost` + 文本面上,用这里真实的 `index.js` 和 `manifest.toml` 走加载器安装,
  断言按钮和面板开关出现、面板里的统计随输入变化、卸载后全部消失、反复装卸不重复;
- `src/editor/extensions/examples.spec.ts`:注册表层面的注册 / 运行 / 卸载与权限拒绝;
- `e2e/editor-extensions.mjs`:真实构建、真实站点 CSP 下同源 `import()` 它的入口脚本。

完整的扩展写法见 `docs/EDITOR_EXTENSIONS.md`。
