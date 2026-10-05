#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E13V: builtin_vendors.rs 内置表纯文本一致性验证（不跑 cargo，纯正则解析）"""
import re
import itertools
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

SRC = Path("/root/workspace/repos/deep-student/src-tauri/src/llm_manager/builtin_vendors.rs")

# 新增 7 条专用接口的预期归属（任务给定映射，按 model 字段精确匹配）
EXPECTED_NEW = {
    "BAAI/bge-m3": "builtin-siliconflow",
    "BAAI/bge-reranker-v2-m3": "builtin-siliconflow",
    "text-embedding-3-large": "builtin-openai",
    "text-embedding-3-small": "builtin-openai",
    "dall-e-3": "builtin-openai",
    "glm-4.6v": "builtin-zhipu",
    "glm-4.6v-flash": "builtin-zhipu",
}
FREE_KEY_IDS = ["builtin-pollinations", "builtin-llmtech", "builtin-kilo"]
TRI_FIELDS = ["is_embedding", "is_reranker", "is_image_generation"]

text = SRC.read_text(encoding="utf-8")
lines = text.splitlines()


def line_no(offset: int) -> int:
    """text 内偏移 -> 1-based 行号"""
    return text.count("\n", 0, offset) + 1


def slice_block(decl_pattern: str):
    """定位 `pub const XXX = &[` 声明行到其后第一个行首 `];` 的闭区间（1-based）"""
    m = re.search(decl_pattern, text, re.M)
    if not m:
        raise SystemExit(f"FATAL: 数组声明未找到: {decl_pattern}")
    start = line_no(m.start())
    for i in range(start, len(lines)):
        if lines[i].rstrip() == "];":
            # 防御：声明行与闭合行之间不允许再出现行首 ];，否则区间被截断
            inner = [ln for ln in range(start + 1, i) if lines[ln - 1].rstrip() == "];"]
            if inner:
                raise SystemExit(f"FATAL: 区间内出现意外 ]; 行 {inner}，区间切割不可信")
            return start, i + 1
    raise SystemExit("FATAL: 数组闭合 ]; 未找到")


STR_FIELD_RE = re.compile(r'^        (\w+): "(.*)",\s*$', re.M)
RAW_FIELD_RE = re.compile(r'^        (\w+): ([^"].*?),\s*$', re.M)
ENTRY_RE = re.compile(r'^    (BuiltinModel|BuiltinVendor) \{\n(.*?)^    \},', re.M | re.S)


def parse_block(start: int, end: int, kind: str):
    """解析 [start, end] 区间内的所有 kind 条目，返回 [(行号, fields)]"""
    block = "\n".join(lines[start - 1:end])
    out = []
    for m in ENTRY_RE.finditer(block):
        if m.group(1) != kind:
            continue
        body = m.group(2)
        fields = {}
        for fm in STR_FIELD_RE.finditer(body):
            fields[fm.group(1)] = fm.group(2)
        for fm in RAW_FIELD_RE.finditer(body):
            fields.setdefault(fm.group(1), fm.group(2))
        out.append((start - 1 + block[:m.start()].count("\n") + 1, fields))
    return out


V_START, V_END = slice_block(r'^pub const BUILTIN_VENDORS: &\[BuiltinVendor\] = &\[')
M_START, M_END = slice_block(r'^pub const BUILTIN_MODELS: &\[BuiltinModel\] = &\[')

vendors = parse_block(V_START, V_END, "BuiltinVendor")
models = parse_block(M_START, M_END, "BuiltinModel")

OUT = []


def emit(s: str = ""):
    OUT.append(s)


def verdict(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


emit(f"目标文件: {SRC}")
emit(f"解析区间: BUILTIN_VENDORS L{V_START}-{V_END} | BUILTIN_MODELS L{M_START}-{M_END}")
emit(f"条目计数: vendor={len(vendors)} model={len(models)}")
emit("")

# ---------- 检查 1: 每个 BuiltinModel 的 vendor_id 存在于 BUILTIN_VENDORS ----------
vid_set = {v["id"] for _, v in vendors}
bad1 = [(ln, m.get("id", "?"), m.get("vendor_id", "?"))
        for ln, m in models if m.get("vendor_id") not in vid_set]
ok1 = not bad1
emit(f"[1] vendor_id 引用存在性: {verdict(ok1)}")
for ln, mid, vid in bad1:
    emit(f"    L{ln} model={mid} 引用了不存在的 vendor_id={vid}")
emit("")

# ---------- 检查 2: id 唯一（vendor 与 model 各自）----------
dup_v = {k: c for k, c in Counter(v["id"] for _, v in vendors).items() if c > 1}
dup_m = {k: c for k, c in Counter(m["id"] for _, m in models).items() if c > 1}
ok2 = not dup_v and not dup_m
emit(f"[2] id 唯一性: {verdict(ok2)}  (vendor {len(vendors)} 条 / model {len(models)} 条)")
for k, c in dup_v.items():
    emit(f"    vendor id 重复: {k} x{c}")
for k, c in dup_m.items():
    emit(f"    model id 重复: {k} x{c}")
emit("")

# ---------- 检查 3: 免 Key 三家 auth_mode == Some(super::AUTH_MODE_NONE) ----------
EXPECT_AUTH = "Some(super::AUTH_MODE_NONE)"
bad3 = []
ok3 = True
emit(f"[3] 免 Key 三家 auth_mode: 期望值 `{EXPECT_AUTH}`")
for vid in FREE_KEY_IDS:
    hit = [(ln, v) for ln, v in vendors if v.get("id") == vid]
    if not hit:
        emit(f"    FAIL {vid}: vendor 表中不存在")
        ok3 = False
        continue
    ln, v = hit[0]
    got = v.get("auth_mode", "<missing>")
    ok = got == EXPECT_AUTH
    ok3 = ok3 and ok
    emit(f"    {verdict(ok)} {vid} (L{ln}) auth_mode={got}")
emit("")

# ---------- 检查 4: 所有 base_url 以 https:// 开头 ----------
bad4 = [(ln, v.get("id", "?"), v.get("base_url", "<missing>"))
        for ln, v in vendors if not v.get("base_url", "").startswith("https://")]
ok4 = not bad4
emit(f"[4] base_url 全 https: {verdict(ok4)}")
for ln, vid, url in bad4:
    emit(f"    L{ln} {vid} base_url={url}")
emit("")

# ---------- 检查 5: notes 非空 ----------
bad5 = []
ok5 = True
emit("[5] notes 非空:")
for ln, v in vendors:
    raw = v.get("notes")
    if raw is None:
        emit(f"    FAIL {v.get('id', '?')} (L{ln}): notes 字段缺失")
        ok5 = False
        continue
    # 字面非空，且剥离 \n 转义后的实质内容也非空
    if raw.strip() == "" or raw.replace("\\n", "").strip() == "":
        emit(f"    FAIL {v.get('id', '?')} (L{ln}): notes 为空或仅含换行")
        ok5 = False
emit(f"    汇总: {verdict(ok5)}")
emit("")

# ---------- 检查 6: 同 vendor_id 的模型条目连续排列 ----------
seq = [m.get("vendor_id", "?") for _, m in models]
pos = defaultdict(list)
for idx, vid in enumerate(seq):
    pos[vid].append(idx)
broken = {vid: ps for vid, ps in pos.items() if ps != list(range(ps[0], ps[-1] + 1))}
ok6 = not broken
emit(f"[6] 同 vendor_id 模型条目连续: {verdict(ok6)}")
emit("    完整 vendor_id 序列（模型数组顺序，含条目序号）:")
for idx, vid in enumerate(seq):
    emit(f"      {idx:02d} {vid}")
emit("    压缩连续段: " + " -> ".join(f"{k}x{len(list(g))}" for k, g in itertools.groupby(seq)))
if broken:
    for vid, ps in broken.items():
        emit(f"    FAIL {vid} 出现于条目位 {ps}（非单一连续区间，被隔开）")
emit("")

# ---------- 检查 7: 79/79 全部带三字段 ----------
missing = []
badval = []
for ln, m in models:
    miss = [f for f in TRI_FIELDS if f not in m]
    if miss:
        missing.append((ln, m.get("id", "?"), miss))
        continue
    for f in TRI_FIELDS:
        if m[f] not in ("true", "false"):
            badval.append((ln, m.get("id", "?"), f, m[f]))
ok7 = (len(models) == 79) and not missing and not badval
emit(f"[7] 三字段齐全（is_embedding/is_reranker/is_image_generation）: {verdict(ok7)}")
emit(f"    条目总数 = {len(models)}（期望 79）: {verdict(len(models) == 79)}")
for ln, mid, miss in missing:
    emit(f"    L{ln} {mid} 缺字段: {','.join(miss)}")
for ln, mid, f, val in badval:
    emit(f"    L{ln} {mid} {f} 值异常: {val}")
emit("")

# ---------- 检查 8: 新增 7 条 vendor_id 归属 ----------
by_model = defaultdict(list)
for ln, m in models:
    by_model[m.get("model", "?")].append((ln, m))
ok8 = True
emit("[8] 新增 7 条专用接口归属（按 model 字段精确匹配）:")
for model_name, expect_vid in EXPECTED_NEW.items():
    hits = by_model.get(model_name, [])
    if not hits:
        emit(f"    FAIL {model_name}: 模型表中未找到")
        ok8 = False
        continue
    for ln, m in hits:
        got = m.get("vendor_id", "?")
        ok = got == expect_vid
        ok8 = ok8 and ok
        extra = f"  (id={m.get('id', '?')}, L{ln})"
        emit(f"    {verdict(ok)} {model_name} -> 期望 {expect_vid} / 实际 {got}{extra}")
    if len(hits) > 1:
        emit(f"    WARN {model_name} 出现 {len(hits)} 次，已逐条判定")
emit("")

# ---------- 汇总 ----------
results = [ok1, ok2, ok3, ok4, ok5, ok6, ok7, ok8]
emit("=" * 60)
emit("汇总:")
labels = ["vendor_id 引用", "id 唯一性", "免 Key 三家 auth_mode", "base_url 全 https",
          "notes 非空", "同 vendor 连续", "三字段齐全+79 条", "新增 7 条归属"]
for i, (label, ok) in enumerate(zip(labels, results), 1):
    emit(f"  [{i}] {label}: {verdict(ok)}")
emit(f"  总计: {sum(results)}/8 PASS" + ("  — 全部通过" if all(results) else "  — 存在 FAIL，见上文详情"))
emit(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

print("\n".join(OUT))
