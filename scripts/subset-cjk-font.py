#!/usr/bin/env python3
"""把完整的 Noto Sans SC 裁剪成 GB2312 汉字 + 常用标点的子集(办公文档编辑器的中文字体)。

用法: subset-cjk-font.py <完整字体.ttf> <输出.ttf>
裁剪时保留字体里的版权与许可说明(SIL OFL 要求),去掉竖排表、提示指令和 OpenType 排版特性(编辑器自己排版)。
"""
import sys

from fontTools import subset


def gb2312_chars() -> set[str]:
    chars = set()
    for lead in range(0xA1, 0xF8):
        for trail in range(0xA1, 0xFF):
            try:
                chars.add(bytes([lead, trail]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return chars


def main(source: str, target: str) -> None:
    ascii_chars = {chr(c) for c in range(0x20, 0x7F)}
    # 常用标点、CJK 符号、全角形式、拉丁补充、箭头、几何符号
    extra = {
        chr(c)
        for r in (range(0x2000, 0x2070), range(0x3000, 0x3040), range(0xFF00, 0xFFF0), range(0x00A0, 0x0100), range(0x2190, 0x2200), range(0x25A0, 0x2600))
        for c in r
    }
    text = "".join(sorted(gb2312_chars() | ascii_chars | extra))
    options = subset.Options()
    options.layout_features = []
    options.hinting = False
    options.glyph_names = False
    options.notdef_outline = True
    options.drop_tables += ["vhea", "vmtx", "STAT", "gasp", "prep", "BASE"]
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    options.name_languages = [0x409]
    font = subset.load_font(source, options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    subset.save_font(font, target, options)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
