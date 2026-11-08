# 办公文档编辑器用的字体

编辑引擎在浏览器里读不到系统字体，排版和画字都要调用方把字体字节交给它。这个目录放的是本站自己提供的那一批字体和加载逻辑；
`dist` 的字体总量有预算（`scripts/dist-report.mjs`，目前 ≤ 12 MB，其中界面字体 4.6 + 幻灯片字形 1.8 + 中文子集 2.2 +
Word 拉丁 2.8 + 公式 / PDF 字体约 0.8），所以**只提供精选的一小组，其余的明说没有，不静默替换**。

| 用途 | 文件 / 模块 | 说明 |
|---|---|---|
| Word 中文（简体 / 日文）与 Word 拉丁 | `gen/docx/*.ttf`（核心字体 + 扩展字形包，`scripts/build-docx-fonts.py` 生成），`docxFontManifest.ts`，`sparseFont.ts`，`docxFonts.ts` | 来源仍是下面两行的字体（Noto Sans SC 2.004 的 GB2312 裁剪版 `NotoSansSC-GB2312-Regular.ttf`，以及上游字体包里的 Carlito / Liberation 六个面）；见「Word 字体：核心 + 扩展」 |
| Word 字体的生成源 | `NotoSansSC-GB2312-Regular.ttf`（Adobe，SIL OFL 1.1，`OFL-NotoSansSC.txt`）；`Carlito-{Regular,Bold}.ttf`（PPT 面也用）；Liberation 在上游字体包 `node_modules/@betteroffice/fonts/assets/` | 这几个文件**不再被应用直接加载**，留在仓库里只是生成脚本和对拍测试的输入。Noto 的裁剪版含 GB2312 的 6763 个汉字 + 假名 + 标点 / 全角 / ASCII；Carlito 度量兼容 Calibri，Liberation 度量兼容 Arial / Times New Roman |
| PowerPoint 排版与画字 | `gen/`（生成物），`pptxFonts.ts`、`glyphFaces.ts` | 见下一节 |

## Word 字体：核心 + 扩展

冷开时（20 Mbps / 70 ms，WASM 下完之后）排版要等 6 个拉丁字体面（1.09 MB）加中文字体（1.19 MB）全部到位，约 1.1 s。
一份文档只用到字体里很小一部分字形，所以每个字体拆成两部分（`python3 scripts/build-docx-fonts.py` 生成，`--verify` 校验）：

- **核心字体** `*-core.ttf`：合法的 TTF。度量表（cmap / hmtx / hhea / OS/2 / GPOS / GSUB / kern）一字节不动，只有「核心字形」有轮廓、其余字形的轮廓是空的。
  所以排版（字宽、字距、行高、连字选择）和完整字体完全一致，差别只在轮廓有没有到位。
  拉丁核心 = ASCII / Latin-1 / Latin Extended-A / 常用标点货币箭头数学符号，加上复合字形的部件和**经 GSUB 能到达的连字 / 替代字形**
  （"ti" 这类连字没有码位，漏了它首屏 "Section" 里会有个洞，逐像素对比发现的，生成脚本用 fonttools 子集化器自己的闭包算）。
  中文核心 = ASCII + 中文标点 / 全角 + 字频最高的 1024 个汉字（字频顺序与幻灯片面共用 `gen/glyphManifest.ts` 的 `HAN_ORDER`）。
- **扩展字形包** `*-ext*.ttf`：不是可用的字体，是 sfnt 容器，只有 `glyf`（字形轮廓原样拼接）和私有表 `KGix`（gid + 字节数）。
  用 `.ttf` 扩展名是为了和字体一样被预压缩、一样计入 dist 字体预算。拉丁每面一个包；中文是「其它」（假名与其它符号）加每 640 个汉字一包。

运行时（`docxFonts.ts` + `sparseFont.ts`）：打开文档时先扫一遍文档包（`engines/docx/fontHints.ts`）得到用到的码位，只下载核心 + 用到的扩展包，
`assembleFont` 把它们拼成完整 TTF 交给引擎；拼出来的每个字形与原字体逐字节相同（`sparseFont.spec.ts` 对着原字体检查）。
首屏之后（编辑会话 1.2 s 后，或只读会话被放开编辑时）`engine.completeFonts` 把字体补成完整的并用 `setFontEnvironment` 重新登记
（和用户改字体族是同一条路径），之后用户打任何字都有字形。打印 / 缩略图 / 导出的会话（`fullFonts: true`）一开始就要完整字体。
扫描失败时取完整字体，不冒险。

许可：Carlito 和 Liberation 带保留字体名，拆分属于修改版本，所以拉丁核心字体改了字体名（KbOffice Latin / Sans / Serif），版权与许可说明（name 表 0 / 13 / 14）原样保留；
Noto Sans SC 沿用原来裁剪版的字体名（它的保留名是 Source）。

## Word 编辑面：提供什么、不提供什么

上游字体包 `@betteroffice/fonts` 默认整包提供 80 个拉丁字体（14.7 MB）并按需再装 5 个完整 CJK OTF（33.2 MB），全进 `dist` 会让字体总量到 57 MB。
本站只用它的「族名 → 度量兼容字体」解析函数（`vite.config.ts` 的 `kb-prune-betteroffice-fonts` 在构建时清空它的资源表，字节由 `docxFonts.ts` 从上面精选的文件里取，
上游的字节长度校验照做）。结果：

- **有**：简体 / 日文汉字与假名（含宋体、黑体、微软雅黑、楷体、仿宋、MS 明朝 … 这些族名，统一画成黑体子集：字宽一致、字形不同）；
  Calibri / Arial / Times New Roman 的常规与粗体。
- **斜体 / 粗斜体**：用同族的正体 / 粗体顶上（字宽接近，字形不倾斜）。`fontReport` 会提示「的斜体没有对应字体」。
- **整个族没有**：Cambria、Courier New、Consolas、Georgia、Segoe UI、Verdana … 当作缺失，`fontReport` 提示「这里没有这些字体，改用 … 显示，换行和分页可能与 Word 不同」。
- **整个文字区域没有**：繁体中文（GB2312 之外的汉字）、韩文、阿拉伯文、希伯来文。这些字在编辑区里画不出来（显示成空框，文件内容不受影响），`fontReport` 会点名提示。

要补字体：往 `scripts/build-docx-fonts.py` 的 `LATIN_FACES` 里加（必须是上游清单里的文件），重新生成，`npm run build && node scripts/dist-report.mjs` 看预算；预算不够就先想清楚要拿什么换。

## 重新生成中文裁剪版

需要 `pip install fonttools brotli`；`SOURCE` 是完整的 Noto Sans SC Regular：

```bash
python3 scripts/subset-cjk-font.py "$SOURCE" web-ui/src/editor/engines/fonts/NotoSansSC-GB2312-Regular.ttf
```

GB2312 之外的生僻字（如「镕」「喆」）画不出来。要补的话换成 GBK 范围的裁剪版（约 7.4 MB），但会让字体预算超标。

## 幻灯片面用的按需字体（`gen/`，生成物）

PowerPoint 的幻灯片面（只读 / 在线编辑 / 协同）不再一次性下载上面那几个完整字体，改成两条各取所需（`scripts/build-office-fonts.py` 生成，提交进仓库）：

| 用途 | 文件 | 说明 |
|---|---|---|
| 引擎排版 | `gen/metrics-latin-{regular,bold}.ttf`、`gen/metrics-cjk.ttf` | 字形轮廓清空，保留字宽 / 字距表（GPOS）/ 纵向度量；合计约 56 KB（brotli）。排版结果与完整字体逐页一致（`src/editor/engines/pptxFonts.parity.spec.ts`） |
| 浏览器画字 | `gen/latin-core-*.woff2`、`gen/latin-ext-*.woff2` | 拉丁常用字符（打开就取）/ 完整 Carlito（文档里有希腊、西里尔、越南文等才取） |
| | `gen/cjk-han-NN.woff2` | 汉字按字频排队：第 0 片是最常用的 1024 个，其后每 128 个一片，共 46 片；文档里用到哪些字就取哪些片 |
| | `gen/cjk-sym.woff2`、`gen/cjk-kana.woff2` | 中文标点 / 全角、假名 |
| 清单 | `gen/glyphManifest.ts` | 字频顺序和各片的 unicode-range |

加载逻辑在 `glyphFaces.ts`。每个 FontFace 的 unicode-range 只含该片实际带有的字；与别的字体重叠的码位只有弯引号 / 省略号（中文标点片要比拉丁核心片后登记，有中文的文档里它们用中文字体画，与原来一致），单测守着这一点。

重新生成（需要 `pip install fonttools brotli`；`--freq` 是 jieba 的 `dict.txt`，用来按字频给汉字排序；改了上面的源字体或切法才需要重新生成）：

```bash
python3 scripts/build-office-fonts.py --freq /path/to/jieba/dict.txt
python3 scripts/build-office-fonts.py --check      # 只校验已提交的清单与字体一致
```

**许可**：Carlito 带保留字体名 "Carlito"（OFL 第 3 条），裁剪属于修改版本，所以 `gen/` 里由 Carlito 派生的字体（`metrics-latin-*`、`latin-*`）都改名为 "KbOffice Latin"，版权与许可说明（name 表 0 / 13 / 14）原样保留，许可文本见 `OFL-Carlito.txt`。Noto Sans SC 派生的片沿用原来 GB2312 裁剪版的字体名。`Carlito-Regular.ttf`、`Carlito-Bold.ttf` 与 `NotoSansSC-GB2312-Regular.ttf` 在这里只作为 `scripts/build-office-fonts.py` 的生成源和 `pptxFonts.parity.spec.ts` 的对照字体，不再被页面引用（Word 的中文字体用 `NotoSansSC-GB2312-Regular.ttf`，拉丁字体来自上游字体包）。

不在 GB2312 里的生僻字没有字形片：和原来一样画不出来，由浏览器的系统字体兜底。
