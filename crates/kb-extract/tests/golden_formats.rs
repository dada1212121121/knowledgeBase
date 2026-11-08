//! 黄金样本库与解析质量门。
//!
//! 每种格式 **≥3 个样本**(中文为主),逐个走 `ExtractorRegistry` 的完整链路,断言:
//! 1. **覆盖率**:每个样本的关键词都要出现在抽取结果里(总体 ≥ 95%,本测试要求 100%);
//! 2. **失败率**:0(有抽取器的格式不允许失败);
//! 3. **噪声**:导航 / 脚本 / 字体表这类内容不能出现在正文里。
//!
//! 样本在测试里**程序化生成**(PDF 手写 xref、OOXML / EPUB / ODT 用最小 zip、EML 用 MIME 文本),
//! 因此仓库里不需要提交二进制文件,CI 也不需要额外依赖。

use kb_core::model::SourceRef;
use kb_extract::default_registry;
use kb_extract::detect::detect;
use kb_extract::zip::build_stored_zip;

/// 一个样本。
struct Sample {
    /// 格式名(统计用)。
    format: &'static str,
    /// 文件名(决定扩展名与 detect 结果)。
    name: &'static str,
    /// 文件内容。
    bytes: Vec<u8>,
    /// 抽取后必须出现的关键词。
    markers: &'static [&'static str],
    /// 抽取后**不能**出现的内容(噪声)。
    noise: &'static [&'static str],
}

fn source_ref(name: &str) -> SourceRef {
    SourceRef {
        scheme: "file".to_owned(),
        location: name.to_owned(),
        project_root: None,
    }
}

/// 最小单页 PDF(Helvetica,英文;中文 PDF 的文字层需要嵌字体,这里只验证“逐页取文字”)。
fn pdf(text: &str) -> Vec<u8> {
    let content = format!("BT /F1 12 Tf 20 100 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R \
         /Resources << /Font << /F1 5 0 R >> >> >>"
            .to_owned(),
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len() + 1
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
    ];
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", index + 1));
    }
    let xref_at = out.len();
    out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
    out.push_str("0000000000 65535 f \n");
    for offset in &offsets {
        out.push_str(&format!("{offset:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
        objects.len() + 1
    ));
    out.into_bytes()
}

fn docx(blocks: &str) -> Vec<u8> {
    let document = format!(
        r#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body>{blocks}</w:body></w:document>"#
    );
    build_stored_zip(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", document.as_bytes()),
    ])
}

fn xlsx(sheet: &str, shared: &str) -> Vec<u8> {
    let workbook = r#"<workbook><sheets><sheet name="数据" sheetId="1"/></sheets></workbook>"#;
    let shared = format!("<sst>{shared}</sst>");
    build_stored_zip(&[
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/sharedStrings.xml", shared.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
    ])
}

fn pptx(slides: &str) -> Vec<u8> {
    build_stored_zip(&[("ppt/slides/slide1.xml", slides.as_bytes())])
}

fn odt(body: &str) -> Vec<u8> {
    let content = format!(
        r#"<?xml version="1.0"?><office:document-content xmlns:text="t" xmlns:table="tb"><office:body><office:text>{body}</office:text></office:body></office:document-content>"#
    );
    build_stored_zip(&[
        ("mimetype", b"application/vnd.oasis.opendocument.text"),
        ("content.xml", content.as_bytes()),
    ])
}

fn epub(chapters: &[(&str, &str)]) -> Vec<u8> {
    let container = r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
    let mut manifest = String::new();
    let mut spine = String::new();
    let mut entries: Vec<(String, Vec<u8>)> = vec![
        ("mimetype".to_owned(), b"application/epub+zip".to_vec()),
        (
            "META-INF/container.xml".to_owned(),
            container.as_bytes().to_vec(),
        ),
    ];
    for (index, (title, body)) in chapters.iter().enumerate() {
        let id = format!("c{}", index + 1);
        manifest.push_str(&format!(
            r#"<item id="{id}" href="{id}.xhtml" media-type="application/xhtml+xml"/>"#
        ));
        spine.push_str(&format!(r#"<itemref idref="{id}"/>"#));
        entries.push((
            format!("OEBPS/{id}.xhtml"),
            format!("<html><head><title>{title}</title></head><body><p>{body}</p></body></html>")
                .into_bytes(),
        ));
    }
    let opf =
        format!(r#"<package><manifest>{manifest}</manifest><spine>{spine}</spine></package>"#);
    entries.push(("OEBPS/content.opf".to_owned(), opf.into_bytes()));
    let refs: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(name, data)| (name.as_str(), data.as_slice()))
        .collect();
    build_stored_zip(&refs)
}

fn eml(subject: &str, body: &str, attachments: &[(&str, &str)]) -> Vec<u8> {
    let mut text = format!(
        "From: a@example.com\r\nSubject: {subject}\r\n\
         Content-Type: multipart/mixed; boundary=\"B\"\r\n\r\n\
         --B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"
    );
    for (name, content) in attachments {
        text.push_str(&format!(
            "--B\r\nContent-Type: text/plain; name=\"{name}\"\r\n\
             Content-Disposition: attachment; filename=\"{name}\"\r\n\r\n{content}\r\n"
        ));
    }
    text.push_str("--B--\r\n");
    text.into_bytes()
}

/// 全部样本(每种格式 ≥3 个)。
fn samples() -> Vec<Sample> {
    vec![
        Sample {
            format: "pdf",
            name: "report.pdf",
            bytes: pdf("Quarterly revenue grew twelve percent"),
            markers: &["Quarterly revenue", "twelve percent"],
            noise: &[],
        },
        Sample {
            format: "pdf",
            name: "manual.pdf",
            bytes: pdf("Install the daemon before indexing"),
            markers: &["Install the daemon", "indexing"],
            noise: &[],
        },
        Sample {
            format: "pdf",
            name: "notes.pdf",
            bytes: pdf("Hybrid retrieval combines vector and keyword"),
            markers: &["Hybrid retrieval", "keyword"],
            noise: &[],
        },
        Sample {
            format: "docx",
            name: "report.docx",
            bytes: docx(
                r#"<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>
                   <w:p><w:r><w:t>本季度新增两个数据源。</w:t></w:r></w:p>"#,
            ),
            markers: &["季度报告", "两个数据源"],
            noise: &[],
        },
        Sample {
            format: "docx",
            name: "table.docx",
            bytes: docx(
                r#"<w:p><w:r><w:t>预算明细</w:t></w:r></w:p>
                   <w:tbl>
                     <w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>
                     <w:tr><w:tc><w:p><w:r><w:t>研发</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
                   </w:tbl>"#,
            ),
            markers: &["预算明细", "项目", "研发", "42"],
            noise: &[],
        },
        Sample {
            format: "docx",
            name: "meeting.docx",
            bytes: docx(
                r#"<w:p><w:r><w:t>会议纪要:确认解析流水线的阶段划分。</w:t></w:r></w:p>"#,
            ),
            markers: &["会议纪要", "阶段划分"],
            noise: &[],
        },
        Sample {
            format: "xlsx",
            name: "budget.xlsx",
            bytes: xlsx(
                r#"<sheetData>
                     <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
                     <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>7</v></c></row>
                   </sheetData>"#,
                "<si><t>名称</t></si><si><t>数量</t></si><si><t>甲</t></si>",
            ),
            markers: &["名称", "数量", "甲"],
            noise: &[],
        },
        Sample {
            format: "xlsx",
            name: "merged.xlsx",
            bytes: xlsx(
                r#"<sheetData>
                     <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
                     <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100</v></c></row>
                     <row r="3"><c r="B3"><v>200</v></c></row>
                   </sheetData>
                   <mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells>"#,
                "<si><t>季度</t></si><si><t>金额</t></si><si><t>Q1</t></si>",
            ),
            markers: &["季度", "金额", "Q1", "200"],
            noise: &[],
        },
        Sample {
            format: "xlsx",
            name: "inline.xlsx",
            bytes: xlsx(
                r#"<sheetData>
                     <row r="1"><c r="A1" t="inlineStr"><is><t>指标</t></is></c></row>
                     <row r="2"><c r="A2" t="inlineStr"><is><t>延迟</t></is></c><c r="B2"><v>12</v></c></row>
                   </sheetData>"#,
                "",
            ),
            markers: &["指标", "延迟", "12"],
            noise: &[],
        },
        Sample {
            format: "pptx",
            name: "deck.pptx",
            bytes: pptx(
                r#"<p:sld><p:cSld><p:spTree><p:sp><p:txBody>
                     <a:p><a:r><a:t>季度汇报</a:t></a:r></a:p>
                     <a:p><a:r><a:t>收入同比增长 12%</a:t></a:r></a:p>
                   </p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#,
            ),
            markers: &["季度汇报", "12%"],
            noise: &[],
        },
        Sample {
            format: "pptx",
            name: "plan.pptx",
            bytes: pptx(
                r#"<p:sld><p:cSld><p:spTree><p:sp><p:txBody>
                     <a:p><a:r><a:t>下一步计划</a:t></a:r></a:p>
                     <a:p><a:r><a:t>补齐多格式解析</a:t></a:r></a:p>
                   </p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#,
            ),
            markers: &["下一步计划", "多格式解析"],
            noise: &[],
        },
        Sample {
            format: "pptx",
            name: "retro.pptx",
            bytes: pptx(
                r#"<p:sld><p:cSld><p:spTree><p:sp><p:txBody>
                     <a:p><a:r><a:t>回顾:抓取限速踩过的坑</a:t></a:r></a:p>
                   </p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#,
            ),
            markers: &["回顾", "限速"],
            noise: &[],
        },
        Sample {
            format: "odt",
            name: "summary.odt",
            bytes: odt(
                r#"<text:h text:outline-level="1">年度总结</text:h>
                   <text:p>第一段正文。</text:p>"#,
            ),
            markers: &["年度总结", "第一段正文"],
            noise: &[],
        },
        Sample {
            format: "odt",
            name: "table.odt",
            bytes: odt(
                r#"<table:table>
                     <table:table-row><table:table-cell><text:p>指标</text:p></table:table-cell><table:table-cell><text:p>值</text:p></table:table-cell></table:table-row>
                     <table:table-row><table:table-cell><text:p>营收</text:p></table:table-cell><table:table-cell><text:p>42</text:p></table:table-cell></table:table-row>
                   </table:table>"#,
            ),
            markers: &["指标", "营收", "42"],
            noise: &[],
        },
        Sample {
            format: "odt",
            name: "todo.odt",
            bytes: odt("<text:p>待办:补齐 ODT 抽取的表格分支。</text:p>"),
            markers: &["待办", "表格分支"],
            noise: &[],
        },
        Sample {
            format: "rtf",
            name: "memo.rtf",
            bytes: r"{\rtf1\ansi\deff0{\fonttbl{\f0 Helvetica;}}\f0 备忘:确认限速参数\par 每秒最多 5 次\par}"
                .as_bytes()
                .to_vec(),
            markers: &["备忘", "限速参数", "每秒最多"],
            noise: &["fonttbl", "Helvetica"],
        },
        Sample {
            format: "rtf",
            name: "letter.rtf",
            bytes: r"{\rtf1 正文第一段\par 正文第二段\par}".as_bytes().to_vec(),
            markers: &["正文第一段", "正文第二段"],
            noise: &[],
        },
        Sample {
            format: "rtf",
            name: "quote.rtf",
            bytes: r"{\rtf1 \u25991? \u26723?}".as_bytes().to_vec(),
            markers: &["文", "档"],
            noise: &[],
        },
        Sample {
            format: "epub",
            name: "book.epub",
            bytes: epub(&[
                ("第一章 起步", "先安装工具链。"),
                ("第二章 进阶", "再配置索引。"),
            ]),
            markers: &["第一章", "第二章", "工具链", "配置索引"],
            noise: &[],
        },
        Sample {
            format: "epub",
            name: "manual.epub",
            bytes: epub(&[("安装", "解压后运行 kb init。")]),
            markers: &["安装", "kb init"],
            noise: &[],
        },
        Sample {
            format: "epub",
            name: "novel.epub",
            bytes: epub(&[("序章", "故事从这里开始。")]),
            markers: &["序章", "故事"],
            noise: &[],
        },
        Sample {
            format: "eml",
            name: "mail.eml",
            bytes: eml("周报", "本周完成了抓取。", &[("notes.txt", "附件正文")]),
            markers: &["周报", "抓取"],
            noise: &[],
        },
        Sample {
            format: "eml",
            name: "reply.eml",
            bytes: eml("Re: 评审", "同意方案。", &[]),
            markers: &["评审", "同意方案"],
            noise: &[],
        },
        Sample {
            format: "eml",
            name: "notice.eml",
            bytes: eml("通知", "周五维护。", &[("a.txt", "A"), ("b.txt", "B")]),
            markers: &["通知", "维护"],
            noise: &[],
        },
        Sample {
            format: "html",
            name: "page.html",
            bytes: r#"<html lang="zh"><head><title>安装</title><script>var x=1;</script></head>
                <body><nav>导航一</nav><h1>安装</h1><p>先安装 Rust。</p><footer>版权</footer></body></html>"#
                .as_bytes()
                .to_vec(),
            markers: &["安装", "Rust"],
            noise: &["导航一", "var x", "版权"],
        },
        Sample {
            format: "html",
            name: "guide.html",
            bytes: r#"<html><body><h2>配置</h2><p>编辑 config.toml。</p></body></html>"#.as_bytes().to_vec(),
            markers: &["配置", "config.toml"],
            noise: &[],
        },
        Sample {
            format: "html",
            name: "faq.html",
            bytes: r#"<html><body><h1>常见问题</h1><p>如何重建索引?</p></body></html>"#.as_bytes().to_vec(),
            markers: &["常见问题", "重建索引"],
            noise: &[],
        },
        Sample {
            format: "csv",
            name: "table.csv",
            bytes: "名称,数量\n甲,1\n乙,2\n".as_bytes().to_vec(),
            markers: &["名称", "数量", "甲", "乙"],
            noise: &[],
        },
        Sample {
            format: "csv",
            name: "quoted.csv",
            bytes: "a,b\n\"x,1\",\"he said \"\"hi\"\"\"\n".as_bytes().to_vec(),
            markers: &["x,1", "he said"],
            noise: &[],
        },
        Sample {
            format: "csv",
            name: "multi.csv",
            bytes: "键,值\n多行,\"第一行\n第二行\"\n".as_bytes().to_vec(),
            markers: &["多行", "第一行", "第二行"],
            noise: &[],
        },
        Sample {
            format: "md",
            name: "doc.md",
            bytes: "# 标题\n\n正文内容。\n\n| A | B |\n|---|---|\n| 1 | 2 |\n".as_bytes().to_vec(),
            markers: &["标题", "正文内容", "A", "B"],
            noise: &[],
        },
        Sample {
            format: "md",
            name: "code.md",
            bytes: "# 示例\n\n```rust\nfn f() {}\n```\n".as_bytes().to_vec(),
            markers: &["示例", "fn f()"],
            noise: &[],
        },
        Sample {
            format: "md",
            name: "list.md",
            bytes: "# 清单\n\n- 第一项\n- 第二项\n".as_bytes().to_vec(),
            markers: &["清单", "第一项", "第二项"],
            noise: &[],
        },
        Sample {
            format: "txt",
            name: "plain.txt",
            bytes: "纯文本第一段。\n\n纯文本第二段。\n".as_bytes().to_vec(),
            markers: &["纯文本第一段", "纯文本第二段"],
            noise: &[],
        },
        Sample {
            format: "txt",
            name: "log.txt",
            bytes: "2025-10-20 启动完成\n".as_bytes().to_vec(),
            markers: &["启动完成"],
            noise: &[],
        },
        Sample {
            format: "ipynb",
            name: "analysis.ipynb",
            bytes: serde_json::json!({
                "nbformat": 4,
                "metadata": {"language_info": {"name": "python"}},
                "cells": [
                    {"cell_type": "markdown", "source": ["# 数据分析\n", "统计每日活跃。\n"]},
                    {"cell_type": "code", "source": ["df.head()"], "outputs": [
                        {"output_type": "stream", "text": ["active_users 1234\n"]}
                    ]}
                ]
            })
            .to_string()
            .into_bytes(),
            markers: &["数据分析", "每日活跃", "df.head()", "active_users"],
            noise: &[],
        },
        Sample {
            format: "ipynb",
            name: "train.ipynb",
            bytes: serde_json::json!({
                "nbformat": 4,
                "metadata": {"language_info": {"name": "python"}},
                "cells": [
                    {"cell_type": "markdown", "source": ["## 训练脚本\n"]},
                    {"cell_type": "code", "source": ["model.fit(X, y)"], "outputs": [
                        {"output_type": "error", "ename": "ValueError", "evalue": "shape mismatch"}
                    ]}
                ]
            })
            .to_string()
            .into_bytes(),
            markers: &["训练脚本", "model.fit", "ValueError"],
            noise: &[],
        },
        Sample {
            format: "ipynb",
            name: "explore.ipynb",
            bytes: serde_json::json!({
                "nbformat": 4,
                "metadata": {"language_info": {"name": "python"}},
                "cells": [
                    {"cell_type": "markdown", "source": ["### 探索性查询\n"]},
                    {"cell_type": "code", "source": ["rows = len(df)"], "outputs": []}
                ]
            })
            .to_string()
            .into_bytes(),
            markers: &["探索性查询", "rows = len(df)"],
            noise: &[],
        },
        Sample {
            format: "log",
            name: "app.log",
            bytes: "2025-10-20 10:00:01 INFO 心跳正常\n2025-10-20 10:00:02 INFO 心跳正常\n2025-10-20 10:01:30 ERROR 连接超时 host=db\n"
                .as_bytes()
                .to_vec(),
            markers: &["心跳正常", "连接超时"],
            noise: &[],
        },
        Sample {
            format: "log",
            name: "access.log",
            bytes: "10:00:01 GET /api/v1/search 200\n10:00:02 POST /api/v1/uploads 201\n"
                .as_bytes()
                .to_vec(),
            markers: &["/api/v1/search", "/api/v1/uploads"],
            noise: &[],
        },
        Sample {
            format: "log",
            name: "worker.log",
            bytes: "2025-10-21 08:00:00 WARN 队列积压 12\n2025-10-21 08:00:30 WARN 队列积压 12\n2025-10-21 08:02:00 INFO 恢复\n"
                .as_bytes()
                .to_vec(),
            markers: &["队列积压", "恢复"],
            noise: &[],
        },
        Sample {
            format: "sql",
            name: "schema.sql",
            bytes: "CREATE TABLE items (id TEXT PRIMARY KEY, body TEXT);\n-- 建索引\nCREATE INDEX idx_items ON items(body);\n"
                .as_bytes()
                .to_vec(),
            markers: &["CREATE TABLE items", "idx_items"],
            noise: &[],
        },
        Sample {
            format: "sql",
            name: "query.sql",
            bytes: "SELECT count(*) FROM items WHERE body LIKE '%索引%';\n".as_bytes().to_vec(),
            markers: &["SELECT count(*)", "items"],
            noise: &[],
        },
        Sample {
            format: "sql",
            name: "migration.sql",
            bytes: "ALTER TABLE items ADD COLUMN anchor TEXT;\nUPDATE items SET anchor = NULL;\n"
                .as_bytes()
                .to_vec(),
            markers: &["ALTER TABLE items", "ADD COLUMN anchor"],
            noise: &[],
        },
        Sample {
            format: "txt",
            name: "note.txt",
            bytes: "随手记:记得清理增量目录。".as_bytes().to_vec(),
            markers: &["随手记", "增量目录"],
            noise: &[],
        },
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_format_meets_the_coverage_threshold() {
    let registry = default_registry();
    let samples = samples();
    let mut failures: Vec<String> = Vec::new();
    let mut markers_total = 0usize;
    let mut markers_hit = 0usize;
    let mut per_format: std::collections::BTreeMap<&str, (usize, usize, usize)> =
        std::collections::BTreeMap::new();

    for sample in &samples {
        let detected = detect(&sample.bytes, sample.name.rsplit('.').next().unwrap_or(""));
        assert!(
            registry
                .pick(&sample.bytes, sample.name.rsplit('.').next().unwrap_or(""))
                .is_some(),
            "{} 应能挑到抽取器(识别为 {:?})",
            sample.name,
            detected.kind
        );
        let doc = match registry
            .extract(
                &source_ref(sample.name),
                &sample.bytes,
                sample.name.rsplit('.').next().unwrap_or(""),
            )
            .await
        {
            Ok(doc) => doc,
            Err(err) => {
                failures.push(format!("{} 抽取失败: {err}", sample.name));
                continue;
            }
        };
        let text = doc.text();
        let entry = per_format.entry(sample.format).or_insert((0, 0, 0));
        entry.0 += 1;
        let mut all_found = true;
        for marker in sample.markers {
            markers_total += 1;
            if text.contains(marker) {
                markers_hit += 1;
                entry.1 += 1;
            } else {
                all_found = false;
                failures.push(format!("{} 缺少关键词 {marker:?}:{text:?}", sample.name));
            }
        }
        for noise in sample.noise {
            entry.2 += 1;
            if text.contains(noise) {
                failures.push(format!("{} 出现了噪声 {noise:?}:{text:?}", sample.name));
            }
        }
        if !all_found {
            continue;
        }
    }

    // 每种格式至少 3 个样本
    for (format, (count, _, _)) in &per_format {
        assert!(
            *count >= 3,
            "{format} 的样本只有 {count} 个,黄金样本库要求每种格式 ≥3"
        );
    }
    let coverage = markers_hit as f64 / markers_total.max(1) as f64;
    assert!(
        failures.is_empty(),
        "解析质量门未通过(覆盖率 {:.1}%):\n{}",
        coverage * 100.0,
        failures.join("\n")
    );
    assert!(
        coverage >= 0.95,
        "覆盖率 {:.1}% 低于 95% 阈值",
        coverage * 100.0
    );
    // 打印一张表,便于人工核对(测试默认不显示,加 --nocapture 可见)
    println!("格式      样本  关键词  噪声");
    for (format, (count, markers, noise)) in &per_format {
        println!("{format:<9} {count:>3} {markers:>6} {noise:>5}");
    }
    println!("覆盖率 {:.1}%", coverage * 100.0);
}
