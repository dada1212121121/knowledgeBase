#!/usr/bin/env python3
"""生成幻灯片面（PPTX 只读 / 编辑 / 协同）按需加载的字体资源。

为什么要拆（实测，9 Mbps / 70 ms）：原来一次性下载 Carlito 两个 TTF（brotli 后 422 KB）和 Noto Sans SC 的 GB2312 裁剪版
（1185 KB），占冷开传输的 48%。而引擎排版和浏览器画字其实只各用字体的一部分：

- 引擎排版只要「字宽 + 字距表（GPOS）+ 纵向度量」，不要字形轮廓。`metrics-*.ttf` 把所有字形轮廓清空、保留 cmap /
  hmtx / GPOS / GSUB / 度量表，排版结果与完整字体逐页一致（用 74 份真实 deck 的显示列表比对过，见 pptxFonts.parity.spec.ts）。
- 浏览器画字（paintSlide 用 fillText）才要真字形，而且只要这份文档里出现的字。woff2 比 TTF 的 brotli 小约 17%，
  再按需切片：拉丁文常用字符一包（`latin-core`），其余拉丁 / 希腊 / 西里尔 / 越南文一包（`latin-ext`）；
  中文汉字按字频从高到低排队，前 1024 个一片（覆盖约 87% 的日常用字），其余每 128 个一片；标点 / 全角（`cjk-sym`）与假名（`cjk-kana`）各一片。
  一份中文 deck 只取它实际用到的片。

产物（都在 web-ui/src/editor/engines/fonts/gen/，提交进仓库，和原来的字体文件一样）：
  metrics-latin-regular.ttf  metrics-latin-bold.ttf  metrics-cjk.ttf     引擎排版用
  latin-core-{regular,bold}.woff2  latin-ext-{regular,bold}.woff2         浏览器画拉丁文用
  cjk-sym.woff2  cjk-kana.woff2  cjk-han-NN.woff2                        浏览器画中文用
  glyphManifest.ts                                                       片的清单（字频顺序、每片包含的字符范围）

许可：Carlito 带保留字体名（Reserved Font Name "Carlito"），裁剪属于修改版本，所以派生字体全部改了字体名（KbOffice Latin），
版权与许可说明（name 表 0 / 13 / 14）原样保留；Noto Sans SC 沿用原来 GB2312 裁剪版的字体名。见 web-ui/src/editor/engines/fonts/README.md。

用法（需要 pip install fonttools brotli）：
  python3 scripts/build-office-fonts.py --freq /path/to/jieba/dict.txt
  python3 scripts/build-office-fonts.py --check          # 只校验已提交的产物与字频顺序一致，不写文件
字频来源：jieba 词典（dict.txt）里每个词的词频累加到它的每个汉字上；词典里没有的汉字排在最后（按码位）。
"""
from __future__ import annotations

import argparse
import io
import re
import sys
from pathlib import Path

from fontTools import subset, ttLib
from fontTools.ttLib.tables._g_l_y_f import Glyph

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "web-ui" / "src" / "editor" / "engines" / "fonts"
OUT = FONTS / "gen"

# 汉字前 HEAD 个一片，其后每 TAIL 个一片。数字来自对真实中文文档的模拟（300~4000 字的演示文稿，平均下载量最小的组合之一）
HAN_HEAD = 1024
HAN_TAIL = 128

# 拉丁「核心」字符：ASCII、Latin-1、Latin Extended-A、常用标点 / 货币 / 箭头 / 数学符号 / 几何图形
LATIN_CORE_RANGES = [
    (0x20, 0x7E), (0xA0, 0x17F), (0x2C6, 0x2DD), (0x2010, 0x2027), (0x2030, 0x203A), (0x2044, 0x2044),
    (0x20A0, 0x20BF), (0x2113, 0x2113), (0x2116, 0x2116), (0x2122, 0x2122), (0x2126, 0x2126), (0x2190, 0x2199),
    (0x2202, 0x2202), (0x2206, 0x2206), (0x220F, 0x220F), (0x2211, 0x2212), (0x2215, 0x2215), (0x2219, 0x221A),
    (0x221E, 0x221F), (0x2229, 0x2229), (0x222B, 0x222B), (0x2248, 0x2248), (0x2260, 0x2261), (0x2264, 0x2265),
    (0x25A0, 0x25FF), (0xFB01, 0xFB02),
]
# 浏览器默认开启的排版特性；保留它们，画出来的字距 / 连字与原来的完整字体一致
BROWSER_FEATURES = ["kern", "liga", "clig", "calt", "ccmp", "locl", "mark", "mkmk", "rlig", "rclt"]
# 与 web-ui/src/editor/engines/pptxModel.ts 的 CJK 正则同一批码位 + 引号 / 省略号（原来的中文字体一并接管它们）
CJK_REGEX = re.compile("[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f\u2018-\u201f\u2026]")
FAMILY = "KbOffice Latin"


def is_han(cp: int) -> bool:
    return 0x4E00 <= cp <= 0x9FFF


def is_kana(cp: int) -> bool:
    return 0x3040 <= cp <= 0x30FF


def in_ranges(cp: int, ranges) -> bool:
    return any(a <= cp <= b for a, b in ranges)


def rename_latin(font: ttLib.TTFont, style: str) -> None:
    """Carlito 有保留字体名，派生字体不能再叫这个名字（OFL 第 3 条）。版权 / 许可说明保留。"""
    name = font["name"]
    full = f"{FAMILY} {style}"
    ps = f"KbOfficeLatin-{style}"
    for record in list(name.names):
        if record.nameID in (1, 16):
            record.string = FAMILY
        elif record.nameID in (2, 17):
            record.string = style
        elif record.nameID == 3:
            record.string = f"{ps};derived from Carlito"
        elif record.nameID == 4:
            record.string = full
        elif record.nameID == 6:
            record.string = ps


def gb2312_han() -> set[str]:
    chars: set[str] = set()
    for lead in range(0xA1, 0xF8):
        for trail in range(0xA1, 0xFF):
            try:
                chars.add(bytes([lead, trail]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return {c for c in chars if is_han(ord(c))}


def han_order(noto: ttLib.TTFont, freq_path: Path) -> list[str]:
    cmap = noto.getBestCmap()
    han = [chr(cp) for cp in cmap if is_han(cp)]
    assert len(han) == len(set(han))
    weight: dict[str, int] = {}
    for line in freq_path.read_text(encoding="utf8").splitlines():
        parts = line.split()
        if len(parts) < 2 or not parts[1].isdigit():
            continue
        for ch in parts[0]:
            weight[ch] = weight.get(ch, 0) + int(parts[1])
    # 字频从高到低；同频或词典里没有的按码位，保证每次生成顺序一致
    return sorted(han, key=lambda c: (-weight.get(c, 0), ord(c)))


def metrics_only(src: Path, dst: Path, rename: str | None = None) -> None:
    """清空字形轮廓，保留排版需要的一切（cmap / hmtx / GPOS / GSUB / GDEF / 度量表）。"""
    font = ttLib.TTFont(src)
    for table in ("fpgm", "prep", "cvt ", "gasp", "hdmx", "LTSH", "VDMX", "DSIG", "kern"):
        if table in font:
            del font[table]
    glyf = font["glyf"]
    for glyph_name in font.getGlyphOrder():
        glyf[glyph_name] = Glyph()
        advance, _ = font["hmtx"][glyph_name]
        font["hmtx"][glyph_name] = (advance, 0)
    for attr in ("xMin", "yMin", "xMax", "yMax"):
        setattr(font["head"], attr, 0)
    if rename:
        rename_latin(font, rename)
    font.save(dst)


def subset_woff2(src: Path, dst: Path, codepoints: list[int], features: list[str], rename: str | None = None) -> None:
    options = subset.Options()
    options.layout_features = features
    options.hinting = False
    options.glyph_names = False
    options.notdef_outline = True
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    options.name_languages = [0x409]
    options.drop_tables += ["vhea", "vmtx", "STAT", "gasp", "prep", "BASE"]
    options.flavor = "woff2"
    font = subset.load_font(str(src), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    if rename:
        rename_latin(font, rename)
    font.flavor = "woff2"
    font.save(str(dst))


def ts_string(text: str) -> str:
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def ranges_of(codepoints: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for cp in sorted(set(codepoints)):
        if out and cp == out[-1][1] + 1:
            out[-1] = (out[-1][0], cp)
        else:
            out.append((cp, cp))
    return out


def range_text(ranges: list[tuple[int, int]]) -> str:
    return ", ".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in ranges)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--freq", type=Path, help="jieba dict.txt（汉字字频来源）")
    parser.add_argument("--check", action="store_true", help="只校验，不写文件")
    args = parser.parse_args()

    noto_path = FONTS / "NotoSansSC-GB2312-Regular.ttf"
    noto = ttLib.TTFont(noto_path)
    noto_cmap = noto.getBestCmap()
    manifest_path = OUT / "glyphManifest.ts"

    if args.check:
        text = manifest_path.read_text(encoding="utf8")
        match = re.search(r"export const HAN_ORDER = '([^']*)'", text)
        count = re.search(r"export const HAN_SLICE_COUNT = (\d+)", text)
        if not match or not count:
            print("glyphManifest.ts 里缺少 HAN_ORDER / HAN_SLICE_COUNT", file=sys.stderr)
            return 1
        committed = match.group(1)
        in_font = {chr(cp) for cp in noto_cmap if is_han(cp)}
        if len(committed) != len(set(committed)) or set(committed) != in_font:
            print("HAN_ORDER 与 Noto 子集里的汉字不一致", file=sys.stderr)
            return 1
        if in_font != gb2312_han():
            print("Noto 子集的汉字不是恰好的 GB2312 一级二级汉字", file=sys.stderr)
            return 1
        expected = 1 + (len(committed) - HAN_HEAD + HAN_TAIL - 1) // HAN_TAIL
        have = len(list(OUT.glob("cjk-han-*.woff2")))
        if int(count.group(1)) != expected or have != expected:
            print(f"汉字片应有 {expected} 个（清单 {count.group(1)}，文件 {have}）", file=sys.stderr)
            return 1
        print(f"✓ HAN_ORDER {len(committed)} 个汉字，{have} 个汉字片")
        return 0

    if not args.freq or not args.freq.exists():
        print("需要 --freq 指向 jieba 的 dict.txt", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*"):
        old.unlink()

    # ---- 引擎排版用 ----
    metrics_only(FONTS / "Carlito-Regular.ttf", OUT / "metrics-latin-regular.ttf", "Regular")
    metrics_only(FONTS / "Carlito-Bold.ttf", OUT / "metrics-latin-bold.ttf", "Bold")
    metrics_only(noto_path, OUT / "metrics-cjk.ttf")

    sym = [cp for cp in noto_cmap if CJK_REGEX.match(chr(cp)) and not is_han(cp) and not is_kana(cp)]
    kana = [cp for cp in noto_cmap if is_kana(cp)]

    # ---- 拉丁字形 ----
    for style, source in (("regular", "Carlito-Regular.ttf"), ("bold", "Carlito-Bold.ttf")):
        cmap = ttLib.TTFont(FONTS / source).getBestCmap()
        core = [cp for cp in cmap if in_ranges(cp, LATIN_CORE_RANGES)]
        # 扩展片是**完整的** Carlito（含核心字符）：一行文字里希腊 / 西里尔 / 越南文字母和空格、逗号
        # 混在一起时，整行用同一个字体画，字距表（kern）才能跨过这些字符起作用。如果扩展片只含扩展字符，
        # 这一行会被拆成两个字体，字距在交界处失效，画出来和原来的完整字体有亚像素差别（实测，见 README）。
        # 代价只是扩展片多约 16 KB，且只有文档里真有这些文字时才下载。控制字符（U+0 / U+D 等）不需要字形。
        full = [cp for cp in cmap if cp >= 0x20]
        label = style.capitalize()
        subset_woff2(FONTS / source, OUT / f"latin-core-{style}.woff2", core, BROWSER_FEATURES, label)
        subset_woff2(FONTS / source, OUT / f"latin-ext-{style}.woff2", full, BROWSER_FEATURES, label)

    # ---- 中文字形 ----
    order = han_order(noto, args.freq)
    # 中文字体只用来画字形，排版特性（竖排 / 连字等）不需要
    subset_woff2(noto_path, OUT / "cjk-sym.woff2", sym, [])
    subset_woff2(noto_path, OUT / "cjk-kana.woff2", kana, [])
    slices = [order[:HAN_HEAD]] + [order[i : i + HAN_TAIL] for i in range(HAN_HEAD, len(order), HAN_TAIL)]
    for index, chars in enumerate(slices):
        subset_woff2(noto_path, OUT / f"cjk-han-{index:02d}.woff2", [ord(c) for c in chars], [])

    latin_cmap = ttLib.TTFont(FONTS / "Carlito-Regular.ttf").getBestCmap()
    core_cps = sorted(cp for cp in latin_cmap if in_ranges(cp, LATIN_CORE_RANGES))
    ext_cps = sorted(cp for cp in latin_cmap if cp >= 0x80 and not in_ranges(cp, LATIN_CORE_RANGES))
    # 扩展片不接管中文标点片的码位（弯引号 / 省略号）：这些字在有中文的文档里必须用中文字体画（与原来一致），
    # 如果扩展片也声明了它们，扩展片和标点片谁后下载完谁就赢，同一份文档会时而对时而错
    sym_set = set(sym)
    full_cps = sorted(cp for cp in latin_cmap if cp >= 0x20 and cp not in sym_set)
    manifest = f"""/**
 * 字体片清单（由 scripts/build-office-fonts.py 生成，不要手改；改了字体重新跑脚本）
 *
 * HAN_ORDER 是 GB2312 的 {len(order)} 个汉字按字频从高到低的顺序：第 0 片是前 {HAN_HEAD} 个，其后每 {HAN_TAIL} 个一片。
 * 其余几组是各片包含的码位范围（FontFace 的 unicode-range）：只让某一片接管它实际带有的字，没加载的字不会被误画成空框。
 */
export const HAN_HEAD = {HAN_HEAD}
export const HAN_TAIL = {HAN_TAIL}
export const HAN_ORDER = {ts_string(''.join(order))}
/** 汉字片总数（含第 0 片） */
export const HAN_SLICE_COUNT = {len(slices)}
export const LATIN_CORE_RANGE = {ts_string(range_text(ranges_of(core_cps)))}
/** 拉丁扩展字符（核心片之外、Carlito 有的）：只用来判断「这个字要不要加载扩展片」 */
export const LATIN_EXT_RANGE = {ts_string(range_text(ranges_of(ext_cps)))}
/** 扩展片声明的码位：Carlito 的全部字符，但不含中文标点片接管的那些（弯引号 / 省略号）；与核心片重叠的部分是同一份字形，谁先谁后都一样 */
export const LATIN_FULL_RANGE = {ts_string(range_text(ranges_of(full_cps)))}
/** 中文标点 / 全角 / 注音等：与汉字、假名之外、原来中文字体接管的码位同一批 */
export const CJK_SYM_RANGE = {ts_string(range_text(ranges_of(sym)))}
export const CJK_KANA_RANGE = {ts_string(range_text(ranges_of(kana)))}
"""
    manifest_path.write_text(manifest, encoding="utf8")
    sizes = {p.name: p.stat().st_size for p in sorted(OUT.glob("*")) if p.name != "glyphManifest.ts"}
    total = sum(sizes.values())
    print(f"生成 {len(sizes)} 个文件，共 {total / 1024:.0f} KB；汉字 {len(order)} 个 → {len(slices)} 片")
    return 0


if __name__ == "__main__":
    sys.exit(main())
