#!/usr/bin/env python3
"""知识库官方索引插件(格式切块与索引前脱敏共用一份实现)。

宿主通过逐行 JSON-RPC 调用;格式插件只实现 chunk:extract 仍用宿主内置解码,
这样插件失败时回退到内置分块器,不会把文件内容弄丢。脱敏插件走 enrich:
只在切块后改写文本,块数与顺序保持不变。

用法:python3 plugin.py vue|json|sql|svg|dart|kotlin|redact
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

# 单块上限留足余量:宿主硬上限是 1MB,这里按字符数控制,避免中文 UTF-8 超限。
MAX_TEXT = 200_000
MAX_CHUNKS = 10_000


def emit(value):
 print(json.dumps(value, ensure_ascii=False), flush=True)


def emit_error(request_id, message):
 emit(
 {
 "jsonrpc": "2.0",
 "id": request_id,
 "error": {"code": "plugin_error", "message": str(message)[:2000]},
 }
 )


def normalize(text):
 return text.replace("\r\n", "\n").replace("\r", "\n")


def line_at(text, offset):
 return text.count("\n", 0, max(0, offset)) + 1


def total_lines(text):
 return text.count("\n") + 1


def split_long(text, first_line):
 """按行切成不超过 MAX_TEXT 的片段,同时尽量保留行号。"""
 out = []
 buffer = []
 size = 0
 part_start = first_line
 current = first_line
 for line in text.splitlines(keepends=True):
 line_start = current
 line_end = current + line.count("\n")
 if len(line) > MAX_TEXT:
 if buffer:
 out.append(("".join(buffer), part_start, max(part_start, line_start)))
 buffer, size = [], 0
 for offset in range(0, len(line), MAX_TEXT):
 out.append((line[offset : offset + MAX_TEXT], line_start, max(line_start, line_end)))
 current = line_end
 part_start = current
 continue
 if buffer and size + len(line) > MAX_TEXT:
 out.append(("".join(buffer), part_start, max(part_start, line_start)))
 buffer, size = [], 0
 part_start = line_start
 buffer.append(line)
 size += len(line)
 current = line_end
 if buffer:
 out.append(("".join(buffer), part_start, max(part_start, current - 1 if current > part_start else part_start)))
 if not out:
 out.append((text, first_line, max(first_line, total_lines(text))))
 return out


def make_chunk(key, text, start, end, header, symbol=None, title=None):
 text = text.strip("\n")
 if not text.strip():
 return None
 start = max(1, int(start))
 end = max(start, int(end))
 return {
 "key": key[:240],
 "text": text[: 900_000],
 "start_line": start,
 "end_line": end,
 "header": (header or "")[:4000],
 "symbol": (symbol or "")[:500] or None,
 "title": (title or "")[:500] or None,
 }


def finish(chunks, text, source=""):
 """去空、去重 key、限制总量;一个有效块都没有时退回按行窗口。"""
 out = []
 seen = set()
 total = 0
 for chunk in chunks:
 if not chunk:
 continue
 key = chunk["key"]
 base = key
 n = 2
 while key in seen:
 key = f"{base}-{n}"
 n += 1
 chunk["key"] = key
 if total + len(chunk["text"].encode("utf-8")) > 15 * 1024 * 1024:
 break
 seen.add(key)
 total += len(chunk["text"].encode("utf-8"))
 out.append(chunk)
 if len(out) >= MAX_CHUNKS:
 break
 if out:
 return out
 return plain_chunks(text, source)


def plain_chunks(text, source, prefix="part"):
 chunks = []
 lines = text.splitlines(keepends=True)
 if not lines:
 return []
 buffer = []
 start = 1
 current = 1
 for line in lines:
 if len(buffer) >= 80 or sum(len(item) for item in buffer) + len(line) > 20_000:
 chunks.append(
 make_chunk(
 f"{prefix}-{len(chunks) + 1}",
 "".join(buffer),
 start,
 max(start, current - 1 if current > start else start),
 source,
 )
 )
 buffer = []
 start = current
 buffer.append(line)
 current += line.count("\n")
 if buffer:
 chunks.append(
 make_chunk(
 f"{prefix}-{len(chunks) + 1}",
 "".join(buffer),
 start,
 max(start, current - 1 if current > start else start),
 source,
 )
 )
 return [chunk for chunk in chunks if chunk]


# ---------------------------------------------------------------------------
# Vue 单文件组件
# ---------------------------------------------------------------------------

SCRIPT_RE = re.compile(r"<script\b[^>]*>(.*?)</script\s*>", re.I | re.S)
STYLE_RE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.I | re.S)
TEMPLATE_RE = re.compile(r"<template\b[^>]*>(.*?)</template\s*>", re.I | re.S)


def mask_ranges(text, ranges):
 chars = list(text)
 for start, end in ranges:
 for index in range(start, end):
 if chars[index] != "\n":
 chars[index] = " "
 return "".join(chars)


def chunk_vue(text, source):
 chunks = []
 script_ranges = []
 for match in SCRIPT_RE.finditer(text):
 script_ranges.append((match.start(), match.end()))
 body = match.group(1)
 start = line_at(text, match.start(1))
 end = line_at(text, max(match.start(1), match.end(1) - 1))
 for index, (part, part_start, part_end) in enumerate(split_long(body, start), 1):
 suffix = "" if index == 1 else f"-{index}"
 chunks.append(
 make_chunk(
 f"script{suffix}",
 part,
 part_start,
 part_end,
 f"{source} › script",
 symbol="script",
 title="脚本",
 )
 )
 style_ranges = []
 for match in STYLE_RE.finditer(text):
 style_ranges.append((match.start(), match.end()))
 masked = mask_ranges(text, script_ranges + style_ranges)
 match = TEMPLATE_RE.search(masked)
 if match:
 body = text[match.start(1) : match.end(1)]
 start = line_at(text, match.start(1))
 end = line_at(text, max(match.start(1), match.end(1) - 1))
 for index, (part, part_start, part_end) in enumerate(split_long(body, start), 1):
 suffix = "" if index == 1 else f"-{index}"
 chunks.append(
 make_chunk(
 f"template{suffix}",
 part,
 part_start,
 part_end,
 f"{source} › template",
 symbol="template",
 title="模板",
 )
 )
 return finish(chunks, text, source)


# ---------------------------------------------------------------------------
# JSON / JSONC
# ---------------------------------------------------------------------------


def strip_jsonc(text):
 out = []
 index = 0
 size = len(text)
 in_string = False
 quote = ""
 while index < size:
 char = text[index]
 if in_string:
 out.append(char)
 if char == "\\" and index + 1 < size:
 out.append(text[index + 1])
 index += 2
 continue
 if char == quote:
 in_string = False
 index += 1
 continue
 if char == '"':
 in_string = True
 quote = char
 out.append(char)
 index += 1
 continue
 if char == "/" and index + 1 < size and text[index + 1] == "/":
 while index < size and text[index] != "\n":
 index += 1
 continue
 if char == "/" and index + 1 < size and text[index + 1] == "*":
 index += 2
 while index + 1 < size and not (text[index] == "*" and text[index + 1] == "/"):
 if text[index] == "\n":
 out.append("\n")
 index += 1
 index = min(size, index + 2)
 continue
 out.append(char)
 index += 1
 cleaned = "".join(out)
 # 去掉对象 / 数组末尾的逗号,但只处理字符串外面的;字符串里的 ",}" 不能动。
 result = []
 index = 0
 in_string = False
 quote = ""
 while index < len(cleaned):
 char = cleaned[index]
 if in_string:
 result.append(char)
 if char == "\\" and index + 1 < len(cleaned):
 result.append(cleaned[index + 1])
 index += 2
 continue
 if char == quote:
 in_string = False
 index += 1
 continue
 if char == '"':
 in_string = True
 quote = char
 result.append(char)
 index += 1
 continue
 if char == ",":
 look = index + 1
 while look < len(cleaned) and cleaned[look] in " \t\r\n":
 look += 1
 if look < len(cleaned) and cleaned[look] in "}]":
 index += 1
 continue
 result.append(char)
 index += 1
 return "".join(result)


def json_key_line(text, key):
 match = re.search(r'"' + re.escape(key) + r'"\s*:', text)
 return line_at(text, match.start()) if match else 1


def pretty(value):
 return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False)


def json_value_chunks(path, value, text, out):
 rendered = pretty(value)
 if len(rendered) <= MAX_TEXT:
 # 标量补上路径,否则像 "demo" 这种块离开上下文就检索不到。
 body = rendered if isinstance(value, (dict, list)) else f"{path}: {rendered}"
 out.append(
 make_chunk(
 f"json-{len(out) + 1}",
 body,
 json_key_line(text, path.rsplit(".", 1)[-1].split("[")[0]),
 max(1, json_key_line(text, path.rsplit(".", 1)[-1].split("[")[0]) + rendered.count("\n")),
 path,
 symbol=path,
 title=path,
 )
 )
 return
 if isinstance(value, dict):
 items = list(value.items())
 group = {}
 for key, item in items:
 child_path = f"{path}.{key}"
 # 单个子项本身就超限时继续往下拆,不能把同一个大对象反复递归。
 if not group and len(pretty({key: item})) > MAX_TEXT:
 json_value_chunks(child_path, item, text, out)
 continue
 candidate = dict(group)
 candidate[key] = item
 if group and len(pretty(candidate)) > MAX_TEXT:
 json_value_chunks(path, group, text, out)
 group = {}
 group[key] = item
 if group:
 json_value_chunks(path, group, text, out)
 return
 if isinstance(value, list):
 group = []
 for item in value:
 child_path = f"{path}[{len(group)}]"
 if not group and len(pretty([item])) > MAX_TEXT:
 json_value_chunks(child_path, item, text, out)
 continue
 candidate = group + [item]
 if group and len(pretty(candidate)) > MAX_TEXT:
 json_value_chunks(path, group, text, out)
 group = []
 group.append(item)
 if group:
 json_value_chunks(path, group, text, out)
 return
 # 单个超长字符串:按字符切开,标注同一路径
 raw = rendered
 line = json_key_line(text, path.rsplit(".", 1)[-1].split("[")[0])
 for index in range(0, len(raw), MAX_TEXT):
 out.append(
 make_chunk(
 f"json-{len(out) + 1}",
 raw[index : index + MAX_TEXT],
 line,
 line,
 path,
 symbol=path,
 )
 )


def chunk_json(text, source):
 try:
 value = json.loads(strip_jsonc(text))
 except Exception:
 return plain_chunks(text, source, "json-part")
 out = []
 if isinstance(value, dict):
 if not value:
 return [make_chunk("json-empty", "{}", 1, 1, source, symbol="{}")]
 for key, item in value.items():
 json_value_chunks(str(key), item, text, out)
 else:
 json_value_chunks("$", value, text, out)
 return finish(out, text, source)


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------


def sql_statements(text):
 start = 0
 index = 0
 size = len(text)
 state = "normal"
 dollar = ""
 while index < size:
 char = text[index]
 nxt = text[index + 1] if index + 1 < size else ""
 if state == "single":
 if char == "\\":
 index += 2
 continue
 if char == "'" and nxt == "'":
 index += 2
 continue
 if char == "'":
 state = "normal"
 index += 1
 continue
 if state == "double":
 if char == '"' and nxt == '"':
 index += 2
 continue
 if char == '"':
 state = "normal"
 index += 1
 continue
 if state == "backtick":
 if char == "`":
 state = "normal"
 index += 1
 continue
 if state == "line-comment":
 if char == "\n":
 state = "normal"
 index += 1
 continue
 if state == "block-comment":
 if char == "*" and nxt == "/":
 state = "normal"
 index += 2
 else:
 index += 1
 continue
 if state == "dollar":
 if text.startswith(dollar, index):
 index += len(dollar)
 state = "normal"
 else:
 index += 1
 continue
 if char == "'":
 state = "single"
 elif char == '"':
 state = "double"
 elif char == "`":
 state = "backtick"
 elif char == "-" and nxt == "-":
 state = "line-comment"
 index += 2
 continue
 elif char == "#":
 state = "line-comment"
 elif char == "/" and nxt == "*":
 state = "block-comment"
 index += 2
 continue
 elif char == "$":
 match = re.match(r"\$[A-Za-z_0-9]*\$", text[index:])
 if match:
 dollar = match.group(0)
 state = "dollar"
 index += len(dollar)
 continue
 elif char == ";":
 yield text[start : index + 1], start
 start = index + 1
 index += 1
 if text[start:].strip():
 yield text[start:], start


def sql_header(statement):
 body = re.sub(r"--[^\n]*|/\*.*?\*/", "", statement, flags=re.S)
 lines = [line.strip() for line in body.splitlines() if line.strip()]
 first = lines[0] if lines else statement.strip().splitlines()[0]
 match = re.search(
 r"\b(?:CREATE|ALTER|DROP|COMMENT\s+ON|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+"
 r"(?:TABLE|VIEW|INDEX|SCHEMA|FUNCTION|PROCEDURE|TRIGGER|TYPE|DATABASE|UNIQUE\s+INDEX\s+)?([^\s(]+)",
 body,
 flags=re.I,
 )
 if match:
 return first[:120], match.group(1)[:120]
 return first[:120], first[:120]


def chunk_sql(text, source):
 chunks = []
 for number, (statement, offset) in enumerate(sql_statements(text), 1):
 if not re.sub(r"--[^\n]*|/\*.*?\*/", "", statement, flags=re.S).strip():
 continue
 start = line_at(text, offset)
 header, symbol = sql_header(statement)
 for part_number, (part, part_start, part_end) in enumerate(split_long(statement, start), 1):
 suffix = "" if part_number == 1 else f"-{part_number}"
 chunks.append(
 make_chunk(
 f"sql-{number}{suffix}",
 part,
 part_start,
 part_end,
 f"{source} › {header}",
 symbol=symbol,
 title=header,
 )
 )
 return finish(chunks, text, source)


# ---------------------------------------------------------------------------
# SVG
# ---------------------------------------------------------------------------


def local_name(tag):
 return tag.rsplit("}", 1)[-1]


def chunk_svg(text, source):
 try:
 root = ET.fromstring(text.encode("utf-8"))
 except Exception:
 return plain_chunks(text, source, "svg-part")
 counts = {}
 labels = []
 for element in root.iter():
 name = local_name(element.tag)
 counts[name] = counts.get(name, 0) + 1
 if name in ("title", "desc", "text"):
 value = "".join(element.itertext()).strip()
 if value and value not in labels:
 labels.append(value)
 elif name in ("g", "symbol", "use"):
 value = element.attrib.get("id") or element.attrib.get("aria-label")
 if value and value not in labels:
 labels.append(value)
 root_attrs = []
 for key in ("viewBox", "width", "height", "id", "aria-label"):
 if root.attrib.get(key):
 root_attrs.append(f"{key}={root.attrib[key]}")
 summary = ["SVG 图形概况"]
 if root_attrs:
 summary.append("画布:" + " ".join(root_attrs))
 top = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:15]
 summary.append("元素:" + ", ".join(f"{name}={count}" for name, count in top))
 chunks = [make_chunk("svg-meta", "\n".join(summary), 1, 1, source, symbol="svg", title="图形概况")]
 if labels:
 buffer = []
 start = 1
 for label in labels:
 buffer.append(label)
 if sum(len(item) for item in buffer) >= 6000:
 chunks.append(
 make_chunk(
 f"svg-text-{len(chunks)}",
 "\n".join(buffer),
 start,
 start + len(buffer) - 1,
 f"{source} › 文本",
 symbol="text",
 title="图形文本",
 )
 )
 start += len(buffer)
 buffer = []
 if buffer:
 chunks.append(
 make_chunk(
 f"svg-text-{len(chunks)}",
 "\n".join(buffer),
 start,
 start + len(buffer) - 1,
 f"{source} › 文本",
 symbol="text",
 title="图形文本",
 )
 )
 return finish(chunks, text, source)


# ---------------------------------------------------------------------------
# Dart / Flutter
# ---------------------------------------------------------------------------

DART_DIRECTIVE_RE = re.compile(
 r"^\s*(import|export|library|part\s+of|part)\b", re.I
)


def scan_dart_line(line, state):
 depth = state["depth"]
 index = 0
 size = len(line)
 while index < size:
 if state["block"]:
 if line.startswith("*/", index):
 state["block"] = False
 index += 2
 else:
 index += 1
 continue
 if state["string"]:
 quote = state["string"]
 if quote in ('"""', "'''"):
 end = line.find(quote, index)
 if end < 0:
 index = size
 else:
 state["string"] = ""
 index = end + len(quote)
 continue
 char = line[index]
 if char == "\\":
 index += 2
 continue
 if char == quote:
 state["string"] = ""
 index += 1
 continue
 if line.startswith("//", index):
 break
 if line.startswith("/*", index):
 state["block"] = True
 index += 2
 continue
 char = line[index]
 if char in ("'", '"'):
 quote = char * 3 if line.startswith(char * 3, index) else char
 state["string"] = quote
 index += len(quote)
 continue
 if char == "{":
 depth += 1
 elif char == "}":
 depth = max(0, depth - 1)
 index += 1
 state["depth"] = depth
 return depth


def dart_header(lines):
 for line in lines:
 stripped = line.strip()
 if not stripped or stripped.startswith(("//", "/*", "*", "@")):
 continue
 return stripped[:120]
 return "Dart"


def chunk_dart(text, source):
 chunks = []
 directives = []
 pending = []
 pending_start = 1
 buffer = []
 buffer_start = 1
 state = {"depth": 0, "block": False, "string": ""}
 for number, line in enumerate(text.splitlines(keepends=True), 1):
 start_depth = state["depth"]
 scan_dart_line(line, state)
 stripped = line.strip()
 if start_depth == 0 and not buffer:
 if not stripped:
 if pending:
 pending.append(line)
 continue
 if DART_DIRECTIVE_RE.match(stripped):
 directives.extend(pending)
 pending = []
 directives.append(line)
 continue
 if stripped.startswith(("//", "/*", "@")):
 if not pending:
 pending_start = number
 pending.append(line)
 continue
 if pending:
 buffer.extend(pending)
 buffer_start = pending_start
 pending = []
 else:
 buffer_start = number
 buffer.append(line)
 if buffer and state["depth"] == 0 and stripped.endswith(("}", ";")):
 body = "".join(buffer)
 header = dart_header(buffer)
 for part_number, (part, part_start, part_end) in enumerate(split_long(body, buffer_start), 1):
 suffix = "" if part_number == 1 else f"-{part_number}"
 chunks.append(
 make_chunk(
 f"dart-{len(chunks) + 1}{suffix}",
 part,
 part_start,
 part_end,
 f"{source} › {header}",
 symbol=header,
 title=header,
 )
 )
 buffer = []
 pending = []
 buffer_start = number + 1
 if buffer:
 body = "".join(buffer)
 header = dart_header(buffer)
 for part_number, (part, part_start, part_end) in enumerate(split_long(body, buffer_start), 1):
 suffix = "" if part_number == 1 else f"-{part_number}"
 chunks.append(
 make_chunk(
 f"dart-{len(chunks) + 1}{suffix}",
 part,
 part_start,
 part_end,
 f"{source} › {header}",
 symbol=header,
 title=header,
 )
 )
 if directives:
 body = "".join(directives).strip()
 if body:
 chunks.insert(
 0,
 make_chunk(
 "dart-directives",
 body,
 1,
 max(1, body.count("\n") + 1),
 f"{source} › imports",
 symbol="imports",
 title="导入",
 ),
 )
 return finish(chunks, text, source)


# ---------------------------------------------------------------------------
# Kotlin / Kotlin Script
# ---------------------------------------------------------------------------

KOTLIN_DIRECTIVE_RE = re.compile(r"^(package|import)\b")
KOTLIN_DECL_RE = re.compile(
 r"^(?:(?:public|private|protected|internal|open|final|abstract|sealed|data|enum|annotation|value|inline|suspend|operator|infix|tailrec|external|expect|actual|override|lateinit|const|companion)\s+)*"
 r"(?:class|interface|object|fun|val|var|typealias|constructor|init)\b"
)
KOTLIN_MODIFIER_RE = re.compile(
 r"^(?:public|private|protected|internal|open|final|abstract|sealed|data|enum|annotation|value|inline|suspend|operator|infix|tailrec|external|expect|actual|override|lateinit|const|companion)\s+"
)


def scan_kotlin_line(line, state):
 """更新花括号与圆括号深度;跳过字符串、字符和可嵌套的块注释。"""
 depth = state["depth"]
 index = 0
 size = len(line)
 while index < size:
 if state["block"] > 0:
 if line.startswith("*/", index):
 state["block"] -= 1
 index += 2
 elif line.startswith("/*", index):
 state["block"] += 1
 index += 2
 else:
 index += 1
 continue
 if state["string"]:
 quote = state["string"]
 if quote == '"""':
 end = line.find(quote, index)
 if end < 0:
 index = size
 else:
 state["string"] = ""
 index = end + len(quote)
 continue
 char = line[index]
 if char == "\\":
 index += 2
 continue
 if char == quote:
 state["string"] = ""
 index += 1
 continue
 if line.startswith("//", index):
 break
 if line.startswith("/*", index):
 state["block"] = 1
 index += 2
 continue
 char = line[index]
 if char in ("'", '"'):
 quote = char * 3 if line.startswith(char * 3, index) else char
 state["string"] = quote
 index += len(quote)
 continue
 if char == "{":
 depth += 1
 elif char == "}":
 depth = max(0, depth - 1)
 elif char == "(":
 state["paren"] += 1
 elif char == ")":
 state["paren"] = max(0, state["paren"] - 1)
 index += 1
 state["depth"] = depth
 return depth


def kotlin_decl(line):
 """去掉注解和修饰符后,这一行是不是一个顶层声明。"""
 stripped = line.strip()
 while stripped.startswith("@"):
 # 注解可能带参数并跨行;单行形式只剥到空白处,跨行的留给 pending 原样保留
 parts = stripped.split(None, 1)
 stripped = parts[1].strip() if len(parts) > 1 else ""
 while True:
 match = KOTLIN_MODIFIER_RE.match(stripped)
 if not match:
 break
 stripped = stripped[match.end():].lstrip()
 return bool(KOTLIN_DECL_RE.match(stripped))


def kotlin_header(lines):
 for line in lines:
 stripped = line.strip()
 if not stripped or stripped.startswith(("//", "/*", "*", "@")):
 continue
 return stripped[:120]
 return "Kotlin"


def chunk_kotlin(text, source):
 chunks = []
 directives = []
 pending = []
 pending_start = 1
 buffer = []
 buffer_start = 1
 state = {"depth": 0, "paren": 0, "block": 0, "string": ""}

 def flush_buffer(end_line):
 nonlocal buffer, pending, buffer_start
 body = "".join(buffer)
 if not body.strip():
 buffer = []
 pending = []
 return
 header = kotlin_header(buffer)
 for part_number, (part, part_start, part_end) in enumerate(
 split_long(body, buffer_start), 1
 ):
 suffix = "" if part_number == 1 else f"-{part_number}"
 chunks.append(
 make_chunk(
 f"kotlin-{len(chunks) + 1}{suffix}",
 part,
 part_start,
 part_end,
 f"{source} › {header}",
 symbol=header,
 title=header,
 )
 )
 buffer = []
 pending = []
 buffer_start = max(buffer_start, end_line + 1)

 for number, line in enumerate(text.splitlines(keepends=True), 1):
 start_depth = state["depth"]
 start_paren = state["paren"]
 start_block = state["block"]
 scan_kotlin_line(line, state)
 stripped = line.strip()
 if start_depth == 0 and start_paren == 0:
 if not stripped:
 if buffer:
 flush_buffer(number)
 elif pending:
 pending.append(line)
 continue
 if not buffer and KOTLIN_DIRECTIVE_RE.match(stripped):
 directives.extend(pending)
 pending = []
 directives.append(line)
 continue
 if start_block > 0 or stripped.startswith(("//", "/*", "@", "*")):
 # 上一段已经收尾、又来了注释 / 注解:它属于下一个声明,不能塞回上一块。
 if buffer:
 flush_buffer(number - 1)
 if not pending:
 pending_start = number
 pending.append(line)
 continue
 # 上一个顶层声明已经收尾,又遇到新的声明:先把它单独成块。
 if buffer and kotlin_decl(stripped):
 flush_buffer(number - 1)
 if not buffer:
 if pending:
 buffer.extend(pending)
 buffer_start = pending_start
 pending = []
 else:
 buffer_start = number
 buffer.append(line)
 # 顶层声明以 `}` 结束,或属性 / 表达式函数没有花括号,靠空行和下一个声明分隔。
 if buffer and state["depth"] == 0 and stripped.endswith(("}", ";")):
 flush_buffer(number)

 if buffer:
 flush_buffer(number if "number" in locals() else 1)
 if directives:
 body = "".join(directives).strip()
 if body:
 chunks.insert(
 0,
 make_chunk(
 "kotlin-directives",
 body,
 1,
 max(1, body.count("\n") + 1),
 f"{source} › imports",
 symbol="imports",
 title="导入",
 ),
 )
 return finish(chunks, text, source)


# ---------------------------------------------------------------------------
# 索引前脱敏(enrich)
# ---------------------------------------------------------------------------

SECRET_PATTERNS = [
 ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
 ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
 ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
 ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
 ("stripe-key", re.compile(r"\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b")),
 (
 "jwt",
 re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
 ),
 (
 "bearer-token",
 re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{20,}"),
 ),
]
PRIVATE_KEY_RE = re.compile(
 r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
 re.S,
)
SECRET_ASSIGNMENT_RE = re.compile(
 r"(?i)\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\b"
 r"(\s*[:=]\s*)([\"']?)([^\s\"',;#]{8,})\3"
)


def mask_private_key(match):
 body = match.group(0)
 lines = body.split("\n")
 # 保留原来的行数:引用里的行号不会因为脱敏而对不上。
 masked = ["[REDACTED PRIVATE KEY]"] + ["" for _ in lines[1:]]
 return "\n".join(masked)


def mask_assignment(match):
 return f"{match.group(1)}{match.group(2)}{match.group(3)}[REDACTED]{match.group(3)}"


def redact_text(text):
 text = PRIVATE_KEY_RE.sub(mask_private_key, text)
 for _, pattern in SECRET_PATTERNS:
 text = pattern.sub("[REDACTED]", text)
 text = SECRET_ASSIGNMENT_RE.sub(mask_assignment, text)
 return text


def enrich_redact(params):
 chunks = params.get("chunks") or []
 out = []
 for chunk in chunks:
 if not isinstance(chunk, dict):
 raise ValueError("chunk 必须是对象")
 copy = dict(chunk)
 copy["text"] = redact_text(str(copy.get("text") or ""))
 if not copy["text"].strip():
 # enrich 不允许把内容改空;整块都是密钥时至少留一个可检索的标记。
 copy["text"] = "[REDACTED]"
 out.append(copy)
 return {"chunks": out}


# ---------------------------------------------------------------------------
# 分发
# ---------------------------------------------------------------------------

FORMATS = {
 "vue": chunk_vue,
 "json": chunk_json,
 "sql": chunk_sql,
 "svg": chunk_svg,
 "dart": chunk_dart,
 "kotlin": chunk_kotlin,
}

ENRICH_FORMATS = {
 "redact": enrich_redact,
}


def main():
 fmt = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("KB_PLUGIN_NAME", "")
 fmt = fmt.removeprefix("official-").lower()
 handler = FORMATS.get(fmt)
 enricher = ENRICH_FORMATS.get(fmt)
 for raw in sys.stdin:
 raw = raw.strip()
 if not raw:
 continue
 request_id = None
 try:
 request = json.loads(raw)
 request_id = request.get("id")
 method = request.get("method")
 params = request.get("params") or {}
 if method == "initialize":
 emit({"jsonrpc": "2.0", "id": request_id, "result": {"api_version": 1}})
 elif method == "shutdown":
 break
 elif method == "chunk":
 if handler is None:
 raise ValueError(f"未知的官方插件类型 {fmt}")
 doc = params.get("doc") or {}
 text = normalize(str(doc.get("text") or ""))
 source = str(doc.get("source") or "")
 emit({"jsonrpc": "2.0", "id": request_id, "result": {"chunks": handler(text, source)}})
 elif method == "enrich":
 if enricher is None:
 raise ValueError(f"未知的官方增强插件类型 {fmt}")
 emit({"jsonrpc": "2.0", "id": request_id, "result": enricher(params)})
 else:
 raise ValueError(f"不支持的方法 {method}")
 except Exception as error: # 任何解析 / 格式错误都回错误,让宿主回退
 emit_error(request_id, error)


if __name__ == "__main__":
 main()
