#!/usr/bin/env python3
"""生成查看器截图用的真实样本文件(pdf / docx / pptx / xlsx)。

依赖(只在重新生成时需要,生成结果已提交):
  python3 -m venv /tmp/fx && /tmp/fx/bin/pip install reportlab python-docx python-pptx openpyxl
用法:/tmp/fx/bin/python e2e/fixtures/make-fixtures.py
"""
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
FONT = os.environ.get("KB_CJK_TTF", "")  # 可选:内嵌的中文 TTF;不给就只用 reportlab 自带的非内嵌 CID 字体

TITLE = "向量检索综述 2025"
PARAS = [
    "稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。",
    "倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。重排阶段再以交叉编码器对前 20 条精排。",
    "评测采用 nDCG@10 与 MRR 两个指标，黄金集为 20 条人工标注的单点定位题。",
]
TABLE = [["k", "20", "60", "100"], ["nDCG", "0.412", "0.438", "0.431"], ["MRR", "0.381", "0.402", "0.399"]]


def make_pdf():
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    font = "STSong-Light"
    if FONT and Path(FONT).exists():
        from reportlab.pdfbase.ttfonts import TTFont

        pdfmetrics.registerFont(TTFont("CJK", FONT))
        font = "CJK"
    c = canvas.Canvas(str(HERE / "sample.pdf"), pagesize=A4)
    c.setTitle(TITLE)
    width, height = A4
    for page in range(1, 9):
        c.setFont(font, 20)
        c.drawString(56, height - 80, f"{page}. 混合检索与倒数排名融合" if page == 1 else f"{page}. 章节标题 · Section {page}")
        c.setFont(font, 11)
        y = height - 120
        for para in PARAS:
            for i in range(0, len(para), 34):
                c.drawString(56, y, para[i : i + 34])
                y -= 18
            y -= 8
        if page == 1:
            # 表格 + 色块,让缩放时能看出矢量/位图清晰度
            c.setFillColor(colors.HexColor("#5e6ad2"))
            c.rect(56, y - 70, 160, 60, fill=1, stroke=0)
            c.setFillColor(colors.white)
            c.setFont(font, 12)
            c.drawString(66, y - 45, "RRF = Σ 1/(k+rank)")
            c.setFillColor(colors.black)
            y -= 100
            for row in TABLE:
                x = 56
                for cell in row:
                    c.drawString(x, y, cell)
                    x += 90
                y -= 18
        c.setFont("Helvetica", 9)
        c.drawString(width / 2 - 10, 36, f"- {page} -")
        c.showPage()
    c.save()


def make_docx():
    from docx import Document
    from docx.shared import Pt, RGBColor

    doc = Document()
    doc.core_properties.title = TITLE
    doc.add_heading(TITLE, 0)
    doc.add_heading("3.2 混合检索与倒数排名融合", 1)
    for para in PARAS:
        p = doc.add_paragraph(para)
        p.runs[0].font.size = Pt(11)
    doc.add_paragraph("要点一:稠密 + 稀疏互补", style="List Bullet")
    doc.add_paragraph("要点二:RRF 不需要归一化", style="List Bullet")
    run = doc.add_paragraph().add_run("红色强调的一句话。")
    run.font.color.rgb = RGBColor(0xC6, 0x2F, 0x3B)
    run.bold = True
    table = doc.add_table(rows=len(TABLE), cols=4)
    table.style = "Light Grid Accent 1"
    for r, row in enumerate(TABLE):
        for c_, cell in enumerate(row):
            table.cell(r, c_).text = cell
    doc.save(HERE / "sample.docx")


def make_pptx():
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    layout = prs.slide_layouts[5]
    for n, (title, bullets) in enumerate(
        [
            ("产品路线图 Q4", ["批次 1 · PDF / Office / HTML / 邮件", "批次 2 · OCR / 音视频转写", "批次 3 · Notebook / 导出包"]),
            ("多格式解析与编辑", ["覆盖 90% 的日常资料", "OCR 和转写全部本地运行,不外发"]),
            ("检索质量", ["RRF 融合", "交叉编码器重排", "反馈调权"]),
        ],
        start=1,
    ):
        slide = prs.slides.add_slide(layout)
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = RGBColor(0x17, 0x1B, 0x28) if n != 2 else RGBColor(0xF4, 0xF5, 0xFA)
        fg = RGBColor(0xE7, 0xE8, 0xF0) if n != 2 else RGBColor(0x17, 0x1B, 0x28)
        slide.shapes.title.text = title
        slide.shapes.title.text_frame.paragraphs[0].runs[0].font.color.rgb = fg
        slide.shapes.title.text_frame.paragraphs[0].runs[0].font.size = Pt(40)
        box = slide.shapes.add_textbox(Inches(1), Inches(2.4), Inches(11), Inches(3.5)).text_frame
        for i, text in enumerate(bullets):
            p = box.paragraphs[0] if i == 0 else box.add_paragraph()
            p.text = f"• {text}"
            p.runs[0].font.size = Pt(24)
            p.runs[0].font.color.rgb = fg
        slide.notes_slide.notes_text_frame.text = "先讲批次 1 的收益:覆盖 90% 的日常资料。"
    prs.save(HERE / "sample.pptx")


def make_xlsx():
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "评测汇总"
    ws.append(["编号", "查询", "命中名次", "耗时(ms)", "是否命中"])
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="5E6AD2")
    for i in range(1, 501):
        ws.append([f"q{i:03d}", f"UDS 断线怎么降级 {i}", (i % 7) + 1, 40 + (i * 13) % 90, "是" if i % 5 else "否"])
    ws.column_dimensions["B"].width = 28
    ws.freeze_panes = "A2"
    ws2 = wb.create_sheet("原始数据")
    ws2.append(["指标", "值"])
    ws2.append(["hit@1", 0.85])
    ws2.append(["hit@5", 1.0])
    ws2.append(["MRR", 0.893])
    wb.save(HERE / "sample.xlsx")


def make_stdlib_samples():
    """只用标准库就能生成的格式:odt / odp / epub / rtf / eml / mbox / ipynb / zip / tar.gz / html / svg / 二进制 / 未知扩展名文本。"""
    import base64
    import gzip
    import io
    import json
    import tarfile
    import zipfile

    ns = (
        'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
        'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
        'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"'
    )
    manifest = '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'

    def odf(path, mime, body, auto=""):
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("mimetype", mime, compress_type=zipfile.ZIP_STORED)
            z.writestr("META-INF/manifest.xml", manifest)
            z.writestr("content.xml", f'<?xml version="1.0"?><office:document-content {ns}><office:automatic-styles>{auto}</office:automatic-styles><office:body>{body}</office:body></office:document-content>')

    bold = '<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>'
    odf(
        HERE / "sample.odt",
        "application/vnd.oasis.opendocument.text",
        "<office:text><text:h text:outline-level=\"1\">向量检索综述</text:h>"
        + "".join(f"<text:p>{p}</text:p>" for p in PARAS[:2])
        + '<text:p>其中 <text:span text:style-name="B">RRF</text:span> 最关键。</text:p>'
        + "<text:list><text:list-item><text:p>稠密 + 稀疏互补</text:p></text:list-item><text:list-item><text:p>无需归一化</text:p></text:list-item></text:list>"
        + "<table:table>"
        + "".join("<table:table-row>" + "".join(f"<table:table-cell><text:p>{c}</text:p></table:table-cell>" for c in row) + "</table:table-row>" for row in TABLE)
        + "</table:table></office:text>",
        bold,
    )
    odf(
        HERE / "sample.odp",
        "application/vnd.oasis.opendocument.presentation",
        "<office:presentation>"
        + "".join(
            f'<draw:page draw:name="page{i}"><draw:frame presentation:class="title"><draw:text-box><text:p>{t}</text:p></draw:text-box></draw:frame>'
            f'<draw:frame presentation:class="outline"><draw:text-box><text:list><text:list-item><text:p>{b}</text:p></text:list-item></text:list></draw:text-box></draw:frame>'
            f"<presentation:notes><draw:frame><draw:text-box><text:p>备注 {i}</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>"
            for i, (t, b) in enumerate([("产品路线图", "批次 1 · PDF"), ("检索质量", "RRF 融合"), ("收尾", "谢谢")], 1)
        )
        + "</office:presentation>",
    )

    with zipfile.ZipFile(HERE / "sample.epub", "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
        z.writestr(
            "OEBPS/content.opf",
            '<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>检索之书</dc:title><dc:creator>Avery</dc:creator></metadata>'
            '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            + "".join(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(1, 4))
            + '</manifest><spine>'
            + "".join(f'<itemref idref="c{i}"/>' for i in range(1, 4))
            + "</spine></package>",
        )
        z.writestr("OEBPS/nav.xhtml", '<html><body><nav><ol>' + "".join(f'<li><a href="c{i}.xhtml">第 {i} 章</a></li>' for i in range(1, 4)) + "</ol></nav></body></html>")
        for i in range(1, 4):
            z.writestr(f"OEBPS/c{i}.xhtml", f"<html><body><h1>第 {i} 章</h1>" + "".join(f"<p>{p}</p>" for p in PARAS) + "</body></html>")

    (HERE / "sample.rtf").write_text(
        r"{\rtf1\ansi\ansicpg936\deff0{\fonttbl{\f0 SimSun;}}\pard {\b RTF 样例}\par 倒数排名融合（RRF）以 {\i 1/(k+rank)} 加权求和。\par "
        r"\trowd\cellx2000\cellx4000 k\cell 60\cell\row\trowd nDCG\cell 0.438\cell\row\pard 结尾。\par}",
        encoding="utf-8",
    )
    # RTF 里的非 ASCII 要用 \uN? 转义才合法
    rtf = (HERE / "sample.rtf").read_text(encoding="utf-8")
    rtf = "".join(c if ord(c) < 128 else "\\u%d?" % (ord(c) if ord(c) < 32768 else ord(c) - 65536) for c in rtf)
    (HERE / "sample.rtf").write_text(rtf, encoding="ascii")

    png = base64.b64encode(
        bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db00000000049454e44ae426082")
    ).decode()
    eml = (
        "From: =?utf-8?B?" + base64.b64encode("张三".encode()).decode() + "?= <zhang@example.com>\r\n"
        "To: li@example.com\r\nSubject: =?utf-8?B?" + base64.b64encode("周会纪要 · RRF 评测".encode()).decode() + "?=\r\n"
        "Date: Mon, 26 Oct 2026 10:00:00 +0800\r\nMIME-Version: 1.0\r\n"
        'Content-Type: multipart/mixed; boundary="M"\r\n\r\n'
        '--M\r\nContent-Type: multipart/alternative; boundary="A"\r\n\r\n'
        "--A\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n大家好，RRF 评测结果见附件。\r\n"
        '--A\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>大家好，<b>RRF</b> 评测结果见附件。</p><p>图：<img src="cid:logo"></p>\r\n--A--\r\n'
        "--M\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\n" + png + "\r\n"
        "--M\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        + base64.b64encode(b"%PDF-1.4 fake" * 20).decode() + "\r\n--M--\r\n"
    )
    (HERE / "sample.eml").write_bytes(eml.encode())
    (HERE / "sample.mbox").write_text(
        "From a@x Mon Oct 26 10:00:00 2026\nSubject: first\nFrom: a@x\n\nfirst body\n\nFrom b@y Mon Oct 26 11:00:00 2026\nSubject: second\nFrom: b@y\n\nsecond body\n",
        encoding="utf-8",
    )

    nb = {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": {"name": "python3", "language": "python"}, "language_info": {"name": "python"}},
        "cells": [
            {"cell_type": "markdown", "metadata": {}, "source": ["# RRF 评测\n", "\n", "对比 **k** 值：`20 / 60 / 100`。\n"]},
            {"cell_type": "code", "execution_count": 1, "metadata": {}, "source": ["import math\n", "def rrf(rank, k=60):\n", "    return 1 / (k + rank)\n", "print(rrf(1))"],
             "outputs": [{"output_type": "stream", "name": "stdout", "text": ["0.01639344262295082\n"]}]},
            {"cell_type": "code", "execution_count": 2, "metadata": {}, "source": ["[rrf(r) for r in range(1, 4)]"],
             "outputs": [{"output_type": "execute_result", "execution_count": 2, "metadata": {}, "data": {"text/plain": ["[0.0163, 0.0161, 0.0159]"]}}]},
            {"cell_type": "code", "execution_count": 3, "metadata": {}, "source": ["1/0"],
             "outputs": [{"output_type": "error", "ename": "ZeroDivisionError", "evalue": "division by zero", "traceback": ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"]}]},
            {"cell_type": "code", "execution_count": 4, "metadata": {}, "source": ["plot()"], "outputs": [{"output_type": "display_data", "metadata": {}, "data": {"image/png": png, "text/plain": ["<Figure>"]}}]},
        ],
    }
    (HERE / "sample.ipynb").write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")

    with zipfile.ZipFile(HERE / "sample.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.md", "# 样例包\n\n里面有源码、配置和图片。\n")
        z.writestr("src/main.rs", "fn main() {\n    println!(\"hello\");\n}\n")
        z.writestr("src/lib/util.py", "def add(a, b):\n    return a + b\n")
        z.writestr("assets/logo.png", base64.b64decode(png))
        z.writestr("data/blob.bin", bytes(range(256)))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as t:
        for name, data in {"pkg/notes.txt": b"tar notes\n", "pkg/conf/app.toml": b"[app]\nname = \"kb\"\n"}.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    (HERE / "sample.tar.gz").write_bytes(gzip.compress(buffer.getvalue()))

    (HERE / "sample.html").write_text(
        "<!doctype html><html><head><meta charset=utf-8><title>RRF 说明</title><style>h1{color:#c33}.x{display:none}</style><script>alert(1)</script></head>"
        "<body><nav>导航不该出现在阅读视图</nav><main><h1>RRF 说明</h1><p>倒数排名融合以 <b>1/(k+rank)</b> 对各路结果加权求和。</p>"
        '<table><tr><th>k</th><th>nDCG</th></tr><tr><td>60</td><td>0.438</td></tr></table><p><a href="https://example.com">链接</a> <a href="javascript:alert(1)">坏链接</a></p></main></body></html>',
        encoding="utf-8",
    )
    (HERE / "sample.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" fill="#eef"/><circle cx="80" cy="80" r="50" fill="#5e6ad2"/><text x="150" y="88" font-size="22" fill="#223">SVG 图形</text></svg>',
        encoding="utf-8",
    )
    (HERE / "sample.dat").write_bytes(bytes([0, 1, 2, 3, 0xFF, 0xFE, 0x41, 0x42, 0x43, 0, 0, 7, 8, 9] * 40) + b"embedded text string here\x00" + bytes(range(256)))
    (HERE / "sample.weird").write_text("这是一个扩展名没人认识的文本文件。\nsecond line\nkey = value\n", encoding="utf-8")
    (HERE / "sample.cs").write_text("namespace Kb;\npublic class Hit { public int Rank { get; set; } }\n", encoding="utf-8")


if __name__ == "__main__":
    make_stdlib_samples()
    make_pdf()
    make_docx()
    make_pptx()
    make_xlsx()
    for f in sorted(HERE.glob("sample.*")):
        print(f.name, f.stat().st_size)
