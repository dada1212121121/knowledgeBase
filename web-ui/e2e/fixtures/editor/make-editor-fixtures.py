#!/usr/bin/env python3
"""生成 的固定性能样本（结果已提交，重新生成才需要依赖）。

5 MB CSV 不在这里生成、也不进仓库：由 e2e/editor-samples-bench.mjs 运行时按同一规则生成到 e2e/out/。

依赖：python3 -m venv /tmp/fx && /tmp/fx/bin/pip install python-docx python-pptx openpyxl pillow
用法：/tmp/fx/bin/python web-ui/e2e/fixtures/editor/make-editor-fixtures.py
"""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image, ImageDraw
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor as PptRGB
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches as PptInches, Pt as PptPt

HERE = Path(__file__).resolve().parent
PARAS = [
    "稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。",
    "倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。",
    "评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题；重排阶段再以交叉编码器对前 20 条精排。",
    "守护进程与 CLI 通过 Unix 域套接字通信；断线后 CLI 自动降级为直读 SQLite，恢复后重新接入队列。",
    "所有解析与排版都在 Worker 中完成，主线程只处理输入、DOM overlay 与工具栏；没有跨线程的大对象拷贝。",
]
TABLE = [["k", "20", "60", "100"], ["nDCG", "0.412", "0.438", "0.431"], ["MRR", "0.381", "0.402", "0.399"]]


def ensure_image(path: Path, width: int = 960, height: int = 540) -> None:
    if path.exists():
        return
    image = Image.new("RGB", (width, height), "#eef1f7")
    draw = ImageDraw.Draw(image)
    for i in range(12):
        x = 40 + i * 74
        draw.rectangle([x, height - 80 - (i * 37) % 300, x + 42, height - 80], fill="#5e6ad2")
    draw.rectangle([40, 40, width - 40, 150], outline="#172033", width=3)
    draw.text((60, 70), "RRF retrieval benchmark 2025", fill="#172033")
    image.save(path, "PNG")


def make_note() -> None:
    import base64

    image_bytes = (HERE / "doc-image.png").read_bytes()
    image_data_uri = "data:image/png;base64," + base64.b64encode(image_bytes).decode()
    chunks = [
        "# 200 KB 性能样本：向量检索与倒排索引\n\n",
        "> 这份文件由脚本生成，只用于编辑器性能基线；内容不含真实业务数据。\n\n",
    ]
    for i in range(1, 61):
        chunks.append(f"## 第 {i} 节 · 混合检索与倒数排名融合\n\n")
        chunks.extend(f"{p}\n\n" for p in PARAS)
        chunks.append("- 稠密 + 稀疏互补\n- RRF 不需要归一化\n- 重排只处理前 20 条\n\n")
        chunks.append("| 指标 | 20 | 60 | 100 |\n|---|---|---|---|\n| nDCG | 0.412 | 0.438 | 0.431 |\n| MRR | 0.381 | 0.402 | 0.399 |\n\n")
        chunks.append(f"```rust\nfn score_{i}(rank: usize, k: f64) -> f64 {{\n    1.0 / (k + rank as f64)\n}}\n```\n\n")
        if i % 10 == 0:
            # 图片用内联 data URI：样本只由静态 dist 提供，不能让基线依赖额外的 fixture 路由
            chunks.append(f"![基准图 {i}]({image_data_uri})\n\n")
    text = "".join(chunks)
    # 控制到约 200 KB：脚本生成后按字节裁到完整段落边界
    while len(text.encode()) < 200 * 1024:
        text += "补充说明：" + "、".join(PARAS) + "\n\n"
    text = text.encode()[: 199 * 1024].decode(errors="ignore").rsplit("\n\n", 1)[0] + "\n"
    (HERE / "note-200k.md").write_text(text, encoding="utf-8")


def make_xlsx() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "评测汇总"
    ws.merge_cells("A1:E1")
    ws["A1"] = "检索评测 · 5 万格性能样本"
    ws["A1"].font = Font(bold=True, size=14, color="FFFFFF")
    ws["A1"].fill = PatternFill("solid", fgColor="5E6AD2")
    ws["A1"].alignment = Alignment(horizontal="center")
    headers = ["编号", "查询", "命中名次", "耗时(ms)", "是否命中"]
    ws.append(headers)
    for cell in ws[2]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="DDE3F0")
    for i in range(1, 10_000):
        ws.append([f"q{i:05d}", f"UDS 断线怎么降级 {i}", (i % 7) + 1, 40 + (i * 13) % 90, "是" if i % 5 else "否"])
        if i % 500 == 0:
            ws.cell(row=i + 2, column=5).fill = PatternFill("solid", fgColor="F4E7C3")
    ws.freeze_panes = "A3"
    ws.column_dimensions["B"].width = 30
    ws2 = wb.create_sheet("公式与合并")
    ws2["A1"] = "公式样例"
    ws2["A2"] = 2
    ws2["B2"] = 3
    ws2["C2"] = "=A2*B2"
    ws2.merge_cells("A4:C4")
    ws2["A4"] = "合并单元格：中文 / English / 123"
    wb.save(HERE / "sheet-50k.xlsx")


def make_docx() -> None:
    doc = Document()
    section = doc.sections[0]
    section.header.paragraphs[0].text = "knowledgeBase · 性能基线样本"
    section.footer.paragraphs[0].text = "第 20 页合成文档 · 仅用于基准"
    doc.core_properties.title = "20 页 DOCX 性能样本"
    doc.add_heading("20 页 DOCX 性能样本", 0)
    doc.add_heading("混合检索与倒数排名融合", 1)
    for para in PARAS:
        p = doc.add_paragraph(para)
        p.runs[0].font.size = Pt(11)
    doc.add_paragraph("要点一：稠密 + 稀疏互补", style="List Bullet")
    doc.add_paragraph("要点二：RRF 不需要归一化", style="List Bullet")
    run = doc.add_paragraph().add_run("红色强调的一句话。")
    run.font.color.rgb = RGBColor(0xC6, 0x2F, 0x3B)
    run.bold = True
    doc.add_picture(str(HERE / "doc-image.png"), width=Inches(4.2))
    doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    table = doc.add_table(rows=len(TABLE), cols=4)
    table.style = "Light Grid Accent 1"
    for r, row in enumerate(TABLE):
        for c, cell in enumerate(row):
            table.cell(r, c).text = cell
    # 每页放一组固定内容，页尾强制分页，得到 20 个真实页面
    for page in range(2, 21):
        doc.add_page_break()
        doc.add_heading(f"{page}. 章节标题 · Section {page}", 1)
        for para in PARAS:
            p = doc.add_paragraph(f"{para}（第 {page} 页）")
            p.runs[0].font.size = Pt(10.5)
        if page % 3 == 0:
            t = doc.add_table(rows=3, cols=4)
            t.style = "Light Grid Accent 1"
            for r, row in enumerate(TABLE[:3]):
                for c, cell in enumerate(row):
                    t.cell(r, c).text = f"{cell}·{page}"
    doc.save(HERE / "doc-20p.docx")


def make_pptx() -> None:
    prs = Presentation()
    prs.slide_width, prs.slide_height = PptInches(13.333), PptInches(7.5)
    layout = prs.slide_layouts[5]
    for n in range(1, 31):
        slide = prs.slides.add_slide(layout)
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = PptRGB(0x17, 0x1B, 0x28) if n % 4 else PptRGB(0xF4, 0xF5, 0xFA)
        fg = PptRGB(0xE7, 0xE8, 0xF0) if n % 4 else PptRGB(0x17, 0x1B, 0x28)
        slide.shapes.title.text = f"{n}. 产品路线图与检索质量"
        slide.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = fg
        slide.shapes.title.text_frame.paragraphs[0].runs[0].font.size = PptPt(38)
        box = slide.shapes.add_textbox(PptInches(0.9), PptInches(2.2), PptInches(11.5), PptInches(3.4)).text_frame
        bullets = [
            "批次 1 · PDF / Office / HTML / 邮件",
            "批次 2 · OCR / 音视频转写",
            "批次 3 · Notebook / 导出包",
            f"第 {n} 页：稠密向量 + BM25 互补",
        ]
        for i, text in enumerate(bullets):
            p = box.paragraphs[0] if i == 0 else box.add_paragraph()
            p.text = f"• {text}"
            p.runs[0].font.size = PptPt(22)
            p.runs[0].font.color.rgb = fg
        if n % 6 == 0:
            slide.shapes.add_picture(str(HERE / "doc-image.png"), PptInches(8.4), PptInches(4.4), width=PptInches(3.6))
        if n == 5:
            chart_data = CategoryChartData()
            chart_data.categories = ["20", "60", "100"]
            chart_data.add_series("nDCG", (0.412, 0.438, 0.431))
            slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, PptInches(7.2), PptInches(2.0), PptInches(5.4), PptInches(3.6), chart_data)
        slide.notes_slide.notes_text_frame.text = "先讲批次 1 的收益：覆盖 90% 的日常资料。"
    prs.save(HERE / "deck-30p.pptx")


def make_pptx_latin() -> None:
    """纯拉丁文字的 8 页 deck：用来证明只读预览不会下载中文字体。"""
    prs = Presentation()
    prs.slide_width, prs.slide_height = PptInches(13.333), PptInches(7.5)
    layout = prs.slide_layouts[5]
    for n in range(1, 9):
        slide = prs.slides.add_slide(layout)
        slide.shapes.title.text = f"Quarterly review {n}"
        box = slide.shapes.add_textbox(PptInches(0.9), PptInches(2.0), PptInches(11.5), PptInches(2.6)).text_frame
        for i, text in enumerate(["Revenue grew 12% year over year", "Latency dropped from 36 ms to 15 ms", f"Slide {n}: hybrid retrieval keeps recall high"]):
            p = box.paragraphs[0] if i == 0 else box.add_paragraph()
            p.text = f"- {text}"
            p.runs[0].font.size = PptPt(24)
        if n == 3:
            rows = slide.shapes.add_table(3, 3, PptInches(0.9), PptInches(4.8), PptInches(8), PptInches(1.8)).table
            for r in range(3):
                for c in range(3):
                    rows.cell(r, c).text = f"R{r + 1}C{c + 1}"
        if n == 4:
            slide.shapes.add_picture(str(HERE / "doc-image.png"), PptInches(8.4), PptInches(4.4), width=PptInches(3.6))
        slide.notes_slide.notes_text_frame.text = f"Speaker note for slide {n}."
    prs.save(HERE / "deck-latin-8p.pptx")


def make_docx_latin() -> None:
    """纯英文三段小文档：引擎只对单向拉丁文段落下发回显上下文，输入延迟门禁需要它。

    不用 python-docx：要的是最小、固定、可逐字节复现的包。
    """
    import zipfile

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    texts = [
        "Hello world. This is a plain English paragraph for echo testing.",
        "Second paragraph with more words to type into.",
        "Third paragraph.",
    ]
    paragraphs = "".join(f'<w:p><w:r><w:t xml:space="preserve">{t}</w:t></w:r></w:p>' for t in texts)
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        f"{paragraphs}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(HERE / "doc-latin.docx", "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", rels)
        package.writestr("word/document.xml", document)


def make_docx_table() -> None:
    """含 2×3 表格的小文档：表格命令（Tab 导航、多格选择、合并、删行列）要在"载入文档里的表格"上验证——
    引擎对载入表格的单元格用结构化 id（body:t0:r1c0:p0），新插入的表格没有，导航类命令只认前者。
    手写 XML 而不用 python-docx，保证包最小且可逐字节复现。
    """
    import zipfile

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )

    def para(text: str) -> str:
        return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"

    def cell(text: str) -> str:
        return f'<w:tc><w:tcPr><w:tcW w:w="3120" w:type="dxa"/></w:tcPr>{para(text)}</w:tc>'

    border = lambda name: f'<w:{name} w:val="single" w:sz="4" w:color="000000"/>'  # noqa: E731
    borders = "".join(border(name) for name in ("top", "left", "bottom", "right", "insideH", "insideV"))
    rows = "".join("<w:tr>" + "".join(cell(f"cell{r}{c}") for c in range(3)) + "</w:tr>" for r in range(2))
    table = (
        f'<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
        '<w:tblGrid><w:gridCol w:w="3120"/><w:gridCol w:w="3120"/><w:gridCol w:w="3120"/></w:tblGrid>'
        f"{rows}</w:tbl>"
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        f'{para("Intro paragraph before the table.")}{table}{para("After the table.")}'
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(HERE / "doc-table.docx", "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", rels)
        package.writestr("word/document.xml", document)


def make_docx_footer() -> None:
    """带页脚页码域的小文档： 提到的 WPS 页码域场景——页脚里是「第 { PAGE } 页 共 { NUMPAGES } 页」，
    域用 fldChar 复杂域写法（begin / instrText / separate / 缓存文字 / end），WPS 与 Word 都这么写。
    编辑器保存后页脚的文字和域不能丢；做不到就必须只读（由 docx-footer 场景验证）。
    手写 XML，保证包最小且可逐字节复现。
    """
    import zipfile

    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
        "</Relationships>"
    )

    def field(instruction: str, cached: str) -> str:
        return (
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            f'<w:r><w:instrText xml:space="preserve"> {instruction} </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            f"<w:r><w:t>{cached}</w:t></w:r>"
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        )

    footer = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f"<w:ftr {ns}>"
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
        "<w:r><w:t>第 </w:t></w:r>" + field("PAGE", "1") + "<w:r><w:t> 页 共 </w:t></w:r>" + field("NUMPAGES", "1") + "<w:r><w:t> 页</w:t></w:r>"
        "</w:p></w:ftr>"
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f"<w:document {ns}><w:body>"
        "<w:p><w:r><w:t>Body paragraph with a footer page number.</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>"
        '<w:sectPr><w:footerReference w:type="default" r:id="rId10"/><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(HERE / "doc-footer.docx", "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", rels)
        package.writestr("word/document.xml", document)
        package.writestr("word/_rels/document.xml.rels", doc_rels)
        package.writestr("word/footer1.xml", footer)


def make_docx_fonts() -> None:
    """用了站点没有的字体（Verdana / Consolas）的小文档：缺失字体提示的 e2e 用它。

    同一份文档里还放了有度量兼容替代的 Calibri 和中文宋体——它们不该被报成缺失，防止提示变成对所有文档的噪音。
    """
    import zipfile

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )

    def run(font: str, text: str) -> str:
        fonts = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{font}" w:cs="{font}"/>'
        return f'<w:p><w:r><w:rPr>{fonts}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

    paragraphs = "".join(
        [
            run("Calibri", "Calibri paragraph has a metric-compatible substitute."),
            run("Verdana", "Verdana paragraph has no substitute on this site."),
            run("Consolas", "Consolas paragraph has no substitute either."),
            run("宋体", "宋体段落用思源黑体子集近似显示。"),
        ]
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        f"{paragraphs}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(HERE / "doc-fonts.docx", "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", rels)
        package.writestr("word/document.xml", document)


def make_docx_inline_image() -> None:
    """只含一张内嵌 PNG 的最小文档：验证编辑画布真的把文件里的图片画出来。

    为什么要有它： 的"插入图片"只验证保存后的 XML，从未验证画布上看得见——结果有一段时间图片位置一直是空白，
    根因是页面 CSP 缺 connect-src，引擎在 Worker 里 fetch("data:image/…") 解码图片被拦（版面照常排，像素没有）。
    图片用 doc-image.png（960×540，色块 + 文字，墨量很高），所以"画布上有图"的判据不会和正文文字混淆。
    """
    import zipfile

    image = (HERE / "doc-image.png").read_bytes()
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
        "</Relationships>"
    )
    # 6.0 × 3.375 英寸 = 5486400 × 3086100 EMU（16:9，和 960×540 同比例）
    drawing = (
        '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="5486400" cy="3086100"/>'
        '<wp:docPr id="1" name="内嵌图片 1"/>'
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="rId6"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="3086100"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
        "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>'
        '<w:p><w:r><w:t>Image above this line.</w:t></w:r></w:p>'
        f"<w:p>{drawing}</w:p>"
        '<w:p><w:r><w:t>Caption below the image.</w:t></w:r></w:p>'
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(HERE / "doc-inline-image.docx", "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", rels)
        package.writestr("word/document.xml", document)
        package.writestr("word/_rels/document.xml.rels", doc_rels)
        package.writestr("word/media/image1.png", image)


def make_docx_shapes() -> None:
    """含 Word 形状的最小文档：一个带文字的椭圆，按 Word 的写法 mc:AlternateContent 双份（Choice + VML Fallback）。

    为什么要有它：docx-preview（轻只读）渲染的是 VML Fallback。Word 在里面写 `fillcolor="#4f81bd [3204]"`
    （颜色后面带样式索引，不是合法颜色），而且把文字框 foreignObject 放进了 <ellipse> 里——两处都让形状整个看不见。
    这份夹具和真实的「营养系统流程图」同构（结构从实物对照而来），但不带任何业务内容，可以放进仓库。
    """
    import zipfile

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )

    def oval(index: int, text: str, top_pt: float) -> str:
        style = (
            "position:absolute;left:0;text-align:left;margin-left:60pt;"
            f"margin-top:{top_pt}pt;width:120pt;height:48pt;z-index:{251680000 + index};visibility:visible;"
            "mso-position-horizontal:absolute;mso-position-horizontal-relative:text;"
            "mso-position-vertical:absolute;mso-position-vertical-relative:text;v-text-anchor:middle"
        )
        txbx = f'<w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p></w:txbxContent>'
        choice = (
            '<mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" '
            'relativeHeight="251687936" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
            '<wp:positionH relativeFrom="column"><wp:posOffset>762000</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>{int(top_pt * 12700)}</wp:posOffset></wp:positionV>'
            '<wp:extent cx="1524000" cy="609600"/><wp:wrapNone/>'
            f'<wp:docPr id="{index}" name="椭圆 {index}"/><wp:cNvGraphicFramePr/>'
            '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/>'
            '<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1524000" cy="609600"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></wps:spPr>'
            f'<wps:txbx>{txbx}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>'
        )
        fallback = (
            f'<mc:Fallback><w:pict><v:oval id="椭圆 {index}" style="{style}" fillcolor="#4f81bd [3204]" '
            f'strokecolor="#243f60 [1604]" strokeweight="2pt"><v:textbox>{txbx}</v:textbox></v:oval></w:pict></mc:Fallback>'
        )
        return f"<w:r><mc:AlternateContent>{choice}{fallback}</mc:AlternateContent></w:r>"

    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
        'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" mc:Ignorable="">'
        '<w:body>'
        f'<w:p>{oval(1, "住院", 40)}{oval(2, "开立医嘱", 120)}<w:r><w:t>Flow chart below.</w:t></w:r></w:p>'
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    with zipfile.ZipFile(HERE / "doc-shapes.docx", "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", content_types)
        package.writestr("_rels/.rels", rels)
        package.writestr("word/document.xml", document)


if __name__ == "__main__":
    ensure_image(HERE / "doc-image.png")
    make_note()
    make_xlsx()
    make_docx()
    make_docx_latin()
    make_docx_table()
    make_docx_footer()
    make_docx_fonts()
    make_docx_inline_image()
    make_docx_shapes()
    make_pptx()
    make_pptx_latin()
    for name in ("note-200k.md", "sheet-50k.xlsx", "doc-20p.docx", "doc-latin.docx", "deck-30p.pptx", "deck-latin-8p.pptx", "doc-image.png"):
        print(f"{name:20s} {(HERE / name).stat().st_size:>10,d} B")
