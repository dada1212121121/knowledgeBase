#!/usr/bin/env python3
"""生成 Word 编辑面按需加载的字体资源：每个字体拆成「核心字体」+「扩展字形包」。

为什么要拆（实测，20 Mbps / 70 ms / CPU 4×，Word 20 页冷开 4.4 s）：引擎 WASM 下完之后，6 个拉丁字体面（1.09 MB）加中文字体（1.19 MB）
要再下载约 1.1 s，排版（commandInit）又必须等它们全部到位。而一份文档绝大多数时候只用到字体里很小的一部分字形：

- 拉丁面：ASCII、Latin-1、Latin Extended-A、常用标点 / 货币 / 箭头 / 数学符号（与幻灯片面的 LATIN_CORE_RANGES 同一批），
  连同复合字形用到的部件，约占 ~460 个字形（全部 2600~2800 个）。核心字体是一个**合法的 TTF**：所有度量表（cmap / hmtx / GPOS / kern / OS/2 …）
  原样保留，只有核心之外字形的轮廓是空的，所以排版（字宽、字距、行高）与完整字体逐字节同源；核心 + 基础表约 57 KB（brotli），完整字体约 165~215 KB。
- 中文：核心 = ASCII + 中文标点 / 全角 + 字频最高的 1024 个汉字；其余汉字按字频每 640 个一包，假名与其它符号一包。

扩展字形包（`*-ext*.ttf`）不是可用的字体：它是 sfnt 容器，只有两张表——`glyf`（字形轮廓原样拼接）和私有表 `KGix`（每条 gid + 字节数）。
用 `.ttf` 扩展名是为了让它和字体一样被预压缩、一样计入 dist 字体预算（`dist-report.mjs` 按扩展名归类）。
运行时 `engines/fonts/sparseFont.ts` 把核心字体和需要的扩展包拼成完整字体：glyf / loca 重新按 gid 顺序摆放，其余表原样；
全部拼上之后每个字形的字节与原字体逐字节相同（`--verify` 会检查）。

许可：Carlito / Liberation 带保留字体名，拆分属于修改版本，所以核心字体全部改了字体名（OFL 第 3 条），
版权与许可说明（name 表 0 / 13 / 14）原样保留；Noto Sans SC 沿用原来 GB2312 裁剪版的字体名（它的保留名是 Source）。见 web-ui/src/editor/engines/fonts/README.md。

产物（web-ui/src/editor/engines/fonts/gen/docx/，提交进仓库）：
  latin-<面>-core.ttf  latin-<面>-ext.ttf   6 个拉丁面
  cjk-core.ttf  cjk-ext-misc.ttf  cjk-ext-NN.ttf   中文
  ../docxFontManifest.ts                    清单（每包的字节数、覆盖的码位）

用法（需要 pip install fonttools brotli）：
  python3 scripts/build-docx-fonts.py            # 生成
  python3 scripts/build-docx-fonts.py --verify   # 不写文件：重新生成并检查①与已提交的产物一致 ②核心 + 全部扩展拼回去与原字体逐字节同源
"""
from __future__ import annotations

import argparse
import hashlib
import io
import re
import struct
import sys
from pathlib import Path

from fontTools import subset, ttLib

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web-ui"
FONTS = WEB / "src" / "editor" / "engines" / "fonts"
OUT = FONTS / "gen" / "docx"
MANIFEST = FONTS / "docxFontManifest.ts"
UPSTREAM = WEB / "node_modules" / "@betteroffice" / "fonts" / "assets"
NOTO = FONTS / "NotoSansSC-GB2312-Regular.ttf"
PPTX_MANIFEST = FONTS / "gen" / "glyphManifest.ts"

# 拉丁「核心」字符：与幻灯片面（scripts/build-office-fonts.py）同一批
LATIN_CORE_RANGES = [
    (0x20, 0x7E), (0xA0, 0x17F), (0x2C6, 0x2DD), (0x2010, 0x2027), (0x2030, 0x203A), (0x2044, 0x2044),
    (0x20A0, 0x20BF), (0x2113, 0x2113), (0x2116, 0x2116), (0x2122, 0x2122), (0x2126, 0x2126), (0x2190, 0x2199),
    (0x2202, 0x2202), (0x2206, 0x2206), (0x220F, 0x220F), (0x2211, 0x2212), (0x2215, 0x2215), (0x2219, 0x221A),
    (0x221E, 0x221F), (0x2229, 0x2229), (0x222B, 0x222B), (0x2248, 0x2248), (0x2260, 0x2261), (0x2264, 0x2265),
    (0x25A0, 0x25FF), (0xFB01, 0xFB02),
]
# 中文核心里的非汉字：ASCII + 中文标点 / 全角（与幻灯片面的 CJK_SYM_RANGE 同一批，另加 ASCII）
CJK_CORE_RANGES = [
    (0x20, 0x7E), (0x2018, 0x201A), (0x201C, 0x201E), (0x2026, 0x2026), (0x3000, 0x303F), (0x3105, 0x3129),
    (0x3220, 0x3229), (0xFF01, 0xFF9F), (0xFFA1, 0xFFBE), (0xFFC2, 0xFFC7), (0xFFCA, 0xFFCF), (0xFFD2, 0xFFD7),
    (0xFFDA, 0xFFDC), (0xFFE0, 0xFFE6), (0xFFE8, 0xFFEE),
]
HAN_CORE = 1024  # 字频最高的这么多个汉字放进核心
HAN_TIER = 640  # 其余汉字每这么多个一包

# 拉丁面：上游文件名 → (核心字体的新族名, 样式)。Carlito / Liberation 都带保留字体名，派生字体必须换名
LATIN_FACES = {
    "Carlito-Regular": ("KbOffice Latin", "Regular"),
    "Carlito-Bold": ("KbOffice Latin", "Bold"),
    "LiberationSans-Regular": ("KbOffice Sans", "Regular"),
    "LiberationSans-Bold": ("KbOffice Sans", "Bold"),
    "LiberationSerif-Regular": ("KbOffice Serif", "Regular"),
    "LiberationSerif-Bold": ("KbOffice Serif", "Bold"),
}


def in_ranges(cp: int, ranges) -> bool:
    return any(lo <= cp <= hi for lo, hi in ranges)


def ranges_of(codepoints) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for cp in sorted(set(codepoints)):
        if out and cp == out[-1][1] + 1:
            out[-1] = (out[-1][0], cp)
        else:
            out.append((cp, cp))
    return out


def checksum(data: bytes) -> int:
    padded = data + b"\0" * (-len(data) % 4)
    return sum(struct.unpack(f">{len(padded) // 4}I", padded)) & 0xFFFFFFFF


def write_sfnt(tables: dict[str, bytes]) -> bytes:
    """把若干张表写成 sfnt（TrueType）文件；有 head 表时校正 checkSumAdjustment。"""
    tags = sorted(tables)
    count = len(tags)
    entry_selector = count.bit_length() - 1
    search_range = (1 << entry_selector) * 16
    header = struct.pack(">IHHHH", 0x00010000, count, search_range, entry_selector, count * 16 - search_range)
    offset = 12 + 16 * count
    records, body = [], b""
    for tag in tags:
        data = tables[tag]
        if tag == "head":
            data = data[:8] + b"\0\0\0\0" + data[12:]
        records.append(struct.pack(">4sIII", tag.encode(), checksum(data), offset + len(body), len(data)))
        body += data + b"\0" * (-len(data) % 4)
    blob = header + b"".join(records) + body
    if "head" in tables:
        adjust = (0xB1B0AFBA - checksum(blob)) & 0xFFFFFFFF
        head_off = struct.unpack_from(">I", blob, 12 + 16 * tags.index("head") + 8)[0]
        blob = blob[: head_off + 8] + struct.pack(">I", adjust) + blob[head_off + 12 :]
    return blob


def glyph_slices(font: ttLib.TTFont) -> list[bytes]:
    """原字体每个字形的原始字节（含 loca 之间的填充），gid 顺序"""
    raw = font.reader["glyf"]
    locations = font["loca"].locations
    return [raw[locations[i] : locations[i + 1]] for i in range(font["maxp"].numGlyphs)]


def closure(font: ttLib.TTFont, gids: set[int]) -> set[int]:
    """复合字形引用的部件字形也要在同一个包里，否则拼出来的复合字形指向空字形"""
    order = font.getGlyphOrder()
    index = {name: i for i, name in enumerate(order)}
    glyf = font["glyf"]
    seen, stack = set(gids), list(gids)
    while stack:
        glyph = glyf[order[stack.pop()]]
        if glyph.isComposite():
            for component in glyph.components:
                gid = index[component.glyphName]
                if gid not in seen:
                    seen.add(gid)
                    stack.append(gid)
    return seen


def reachable_gids(path: Path, codepoints: set[int]) -> set[int]:
    """从这些码位出发，经 cmap、复合字形部件、**GSUB 替换（连字 / 替代字形）**能到达的全部字形。

    只看 cmap 不够：Carlito 的 "ti" 等连字字形没有码位，要经 GSUB 的 liga 才到得了。核心里漏了它们，
    首屏 "Section" 里的 "ti" 会是一个空洞（实测逐像素对比发现），所以闭包按所有排版特性（layout_features='*'）算。
    用 fonttools 子集化器自己的闭包计算，不另写一套 GSUB 遍历。
    """
    font = ttLib.TTFont(path)
    options = subset.Options()
    options.layout_features = ["*"]
    options.layout_scripts = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(codepoints))
    subsetter._closure_glyphs(font)
    return {font.getGlyphID(name) for name in subsetter.glyphs_retained}


def sparse_glyf_loca(slices: list[bytes], keep: set[int]) -> tuple[bytes, bytes]:
    """只保留 keep 里的字形（其余为空）的 glyf + 长格式 loca"""
    glyf, offsets = b"", []
    for gid, data in enumerate(slices):
        offsets.append(len(glyf))
        if gid in keep:
            glyf += data
    offsets.append(len(glyf))
    return glyf, struct.pack(f">{len(offsets)}I", *offsets)


def ext_container(slices: list[bytes], gids: set[int]) -> bytes:
    """扩展字形包：glyf（字形原样拼接）+ KGix（条数 u32，然后每条 gid u16 + 字节数 u32）"""
    ordered = sorted(gids)
    glyf = b"".join(slices[g] for g in ordered)
    index = struct.pack(">I", len(ordered)) + b"".join(struct.pack(">HI", g, len(slices[g])) for g in ordered)
    return write_sfnt({"glyf": glyf, "KGix": index})


def with_long_loca(head: bytes) -> bytes:
    """head 表里 indexToLocFormat（偏移 50）改成 1（长格式）"""
    return head[:50] + struct.pack(">h", 1) + head[52:]


def renamed_name_table(font: ttLib.TTFont, family: str, style: str) -> bytes:
    name = font["name"]
    ps = f"{family.replace(' ', '')}-{style}"
    for record in list(name.names):
        if record.nameID in (1, 16):
            record.string = family
        elif record.nameID in (2, 17):
            record.string = style
        elif record.nameID == 3:
            record.string = f"{ps};derived"
        elif record.nameID == 4:
            record.string = f"{family} {style}"
        elif record.nameID == 6:
            record.string = ps
    return name.compile(font)


def post_without_names(font: ttLib.TTFont) -> bytes:
    """glyph 名字表（post 格式 2）占几十 KB，引擎不用；改成格式 3（只留头）"""
    post = font["post"]
    post.formatType = 3.0
    return post.compile(font)


def core_font(font: ttLib.TTFont, keep: set[int], slices: list[bytes], rename: tuple[str, str] | None) -> bytes:
    tables = {tag: font.reader[tag] for tag in font.reader.keys()}
    tables["glyf"], tables["loca"] = sparse_glyf_loca(slices, keep)
    tables["head"] = with_long_loca(tables["head"])
    if rename:
        tables["name"] = renamed_name_table(font, *rename)
        tables["post"] = post_without_names(font)
    # 只用于上屏的表：数字签名在改过之后无效
    tables.pop("DSIG", None)
    return write_sfnt(tables)


def han_order() -> str:
    text = PPTX_MANIFEST.read_text(encoding="utf8")
    match = re.search(r"HAN_ORDER = '([^']+)'", text)
    if not match:
        raise SystemExit("glyphManifest.ts 里找不到 HAN_ORDER")
    return match.group(1)


def build() -> tuple[dict[str, bytes], dict]:
    """返回 (文件名 → 字节, 清单数据)"""
    files: dict[str, bytes] = {}
    manifest: dict = {"latin": {}, "cjk": {}}

    for stem, (family, style) in LATIN_FACES.items():
        font = ttLib.TTFont(UPSTREAM / f"{stem}.ttf", lazy=True)
        slices = glyph_slices(font)
        order = font.getGlyphOrder()
        index = {name: i for i, name in enumerate(order)}
        cmap = font.getBestCmap()
        core = reachable_gids(UPSTREAM / f"{stem}.ttf", {cp for cp in cmap if in_ranges(cp, LATIN_CORE_RANGES)}) | {0}
        ext = set(range(len(slices))) - core
        ext_codepoints = [cp for cp, name in cmap.items() if index[name] in ext]
        key = stem.lower()
        files[f"latin-{key}-core.ttf"] = core_font(font, core, slices, (family, style))
        files[f"latin-{key}-ext.ttf"] = ext_container(slices, ext)
        manifest["latin"][stem] = {
            "key": key,
            "glyphs": len(slices),
            "extRanges": ranges_of(ext_codepoints),
        }

    noto = ttLib.TTFont(NOTO, lazy=True)
    slices = glyph_slices(noto)
    order = noto.getGlyphOrder()
    index = {name: i for i, name in enumerate(order)}
    cmap = noto.getBestCmap()
    han = han_order()
    han_set = set(han)
    gid_of = {chr(cp): index[name] for cp, name in cmap.items()}
    core_chars = [chr(cp) for cp in cmap if in_ranges(cp, CJK_CORE_RANGES) and chr(cp) not in han_set] + list(han[:HAN_CORE])
    core = reachable_gids(NOTO, {ord(c) for c in core_chars}) | {0}
    misc_chars = [chr(cp) for cp in cmap if chr(cp) not in han_set and not in_ranges(cp, CJK_CORE_RANGES)]
    exts: list[tuple[str, list[str]]] = [("misc", misc_chars)]
    for start in range(HAN_CORE, len(han), HAN_TIER):
        exts.append((f"{len(exts):02d}", list(han[start : start + HAN_TIER])))
    ext_entries = []
    for name, chars in exts:
        # 每个包带上自己那些字符需要的全部字形（同一个字形被别的包的字符共用时允许重复，包与包之间互不依赖）
        gids = closure(noto, {gid_of[c] for c in chars}) - core
        files[f"cjk-ext-{name}.ttf"] = ext_container(slices, gids)
        ext_entries.append({"name": name, "chars": len(chars)})
    files["cjk-core.ttf"] = core_font(noto, core, slices, None)
    manifest["cjk"] = {
        "coreRanges": CJK_CORE_RANGES,
        "extMiscRanges": ranges_of([ord(c) for c in misc_chars]),
        "ext": ext_entries,
        "hanCore": HAN_CORE,
        "hanTier": HAN_TIER,
        # 汉字扩展包按 HAN_ORDER（幻灯片面的字频顺序）切片；顺序一变，运行时算出的「某个字在第几包」就和生成的包对不上
        "hanOrderSha256": hashlib.sha256(han.encode("utf8")).hexdigest(),
    }
    for name, data in files.items():
        manifest.setdefault("sizes", {})[name] = len(data)
    return files, manifest


def ts_ranges(ranges) -> str:
    return "[" + ", ".join(f"[0x{lo:X}, 0x{hi:X}]" for lo, hi in ranges) + "]"


def render_manifest(manifest: dict) -> str:
    lines = [
        "/**",
        " * Word 编辑字体清单（由 scripts/build-docx-fonts.py 生成，不要手改；改了字体重新跑脚本）",
        " *",
        " * 每个字体拆成「核心字体」（合法的 TTF，只有核心字形有轮廓，度量表完整）和「扩展字形包」（sfnt 容器，只有 glyf + KGix）。",
        " * 运行时按文档里出现的字符决定要哪些扩展包（engines/fonts/docxFonts.ts），再由 sparseFont.ts 拼回完整字体。",
        " */",
        "",
        "/** 拉丁面：键是上游字体文件名（不含 .ttf）；extRanges 是该面 cmap 里**不在核心里**的码位区间（文档用到其中任何一个就要扩展包） */",
        "export const LATIN_SPARSE: Readonly<Record<string, { key: string; glyphs: number; extRanges: ReadonlyArray<readonly [number, number]> }>> = {",
    ]
    for stem, info in manifest["latin"].items():
        lines.append(f"  '{stem}': {{ key: '{info['key']}', glyphs: {info['glyphs']}, extRanges: {ts_ranges(info['extRanges'])} }},")
    cjk = manifest["cjk"]
    lines += [
        "}",
        "",
        f"/** 中文核心里的非汉字码位（ASCII + 中文标点 / 全角）；汉字按字频：前 {cjk['hanCore']} 个在核心里，其后每 {cjk['hanTier']} 个一包 */",
        f"export const CJK_CORE_RANGES: ReadonlyArray<readonly [number, number]> = {ts_ranges(cjk['coreRanges'])}",
        f"export const CJK_HAN_CORE = {cjk['hanCore']}",
        f"export const CJK_HAN_TIER = {cjk['hanTier']}",
        "/** 生成时 HAN_ORDER 的 SHA-256：单测核对，字频顺序变了就必须重新生成（否则某些汉字会去错误的扩展包里找） */",
        f"export const CJK_HAN_ORDER_SHA256 = '{cjk['hanOrderSha256']}'",
        "/** 「其它」包（假名与其它符号）覆盖的非汉字码位 */",
        f"export const CJK_EXT_MISC_RANGES: ReadonlyArray<readonly [number, number]> = {ts_ranges(cjk['extMiscRanges'])}",
        f"/** 汉字扩展包的个数（cjk-ext-01 … cjk-ext-NN，按字频顺序） */",
        f"export const CJK_EXT_TIERS = {len(cjk['ext']) - 1}",
        "",
        "/** 每个文件的字节数（下载后核对，对不上说明拿到的不是原文件） */",
        "export const DOCX_FONT_BYTES: Readonly<Record<string, number>> = {",
    ]
    for name, size in sorted(manifest["sizes"].items()):
        lines.append(f"  '{name}': {size},")
    lines += ["}", ""]
    return "\n".join(lines)


def verify_roundtrip(files: dict[str, bytes]) -> list[str]:
    """核心 + 全部扩展拼回去之后，每个字形的字节必须和原字体一致；核心字体的度量表必须和原字体一致"""
    problems: list[str] = []

    def parse(blob: bytes) -> dict[str, bytes]:
        count = struct.unpack_from(">H", blob, 4)[0]
        tables = {}
        for i in range(count):
            tag, _sum, off, length = struct.unpack_from(">4sIII", blob, 12 + 16 * i)
            tables[tag.decode()] = blob[off : off + length]
        return tables

    def merged(core_name: str, ext_names: list[str], original: ttLib.TTFont) -> None:
        core = parse(files[core_name])
        slices = glyph_slices(original)
        loca = struct.unpack(f">{len(slices) + 1}I", core["loca"])
        got = [core["glyf"][loca[i] : loca[i + 1]] for i in range(len(slices))]
        for name in ext_names:
            ext = parse(files[name])
            count = struct.unpack_from(">I", ext["KGix"], 0)[0]
            cursor = 0
            for i in range(count):
                gid, length = struct.unpack_from(">HI", ext["KGix"], 4 + 6 * i)
                got[gid] = ext["glyf"][cursor : cursor + length]
                cursor += length
        bad = [g for g in range(len(slices)) if got[g] != slices[g]]
        if bad:
            problems.append(f"{core_name}: {len(bad)} 个字形拼回去与原字体不一致（例如 gid {bad[:5]}）")
        # 度量与排版相关的表必须原样
        for tag in ("cmap", "hmtx", "hhea", "maxp", "OS/2", "GPOS", "GSUB", "kern"):
            if tag in original.reader.keys() and core.get(tag) != original.reader[tag]:
                problems.append(f"{core_name}: 表 {tag} 与原字体不一致")

    for stem in LATIN_FACES:
        font = ttLib.TTFont(UPSTREAM / f"{stem}.ttf", lazy=True)
        merged(f"latin-{stem.lower()}-core.ttf", [f"latin-{stem.lower()}-ext.ttf"], font)
    noto = ttLib.TTFont(NOTO, lazy=True)
    merged("cjk-core.ttf", sorted(n for n in files if n.startswith("cjk-ext-")), noto)
    # fonttools 能打开核心字体（结构合法），字形数没变
    for name in files:
        if name.endswith("-core.ttf"):
            try:
                opened = ttLib.TTFont(io.BytesIO(files[name]))
                opened["glyf"]  # 触发解析
            except Exception as error:  # noqa: BLE001
                problems.append(f"{name}: fonttools 打不开（{error}）")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true", help="不写文件，只检查")
    args = parser.parse_args()
    files, manifest = build()
    text = render_manifest(manifest)
    problems = verify_roundtrip(files)
    if args.verify:
        for name, data in files.items():
            path = OUT / name
            if not path.exists() or path.read_bytes() != data:
                problems.append(f"{name}: 与已提交的产物不一致（重新跑 scripts/build-docx-fonts.py）")
        if not MANIFEST.exists() or MANIFEST.read_text(encoding="utf8") != text:
            problems.append("docxFontManifest.ts 与重新生成的不一致")
    else:
        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.glob("*.ttf"):
            old.unlink()
        for name, data in files.items():
            (OUT / name).write_bytes(data)
        MANIFEST.write_text(text, encoding="utf8")
    total = sum(len(v) for v in files.values())
    print(f"{len(files)} 个文件，共 {total / 1024:.0f} KB（原始）" + ("" if args.verify else f"，写入 {OUT}"))
    for problem in problems:
        print("✗", problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
