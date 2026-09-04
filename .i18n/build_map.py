#!/usr/bin/env python3
"""oh-my-pi 汉化 · 翻译记忆构建器

用法: build_map.py <原文文件> <译文文件> <map.json>
按空行分块对齐，逐块哈希存入 map（源块 sha1 -> 译文块）。
块数不一致时报错退出（说明译文结构被破坏，需人工检查）。
"""
import hashlib, json, sys

def blocks(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    # 去掉汉化版头部说明（前两个块：HTML 注释 + blockquote 提示）
    return [b for b in text.split("\n\n")]

def main():
    src_f, dst_f, map_f = sys.argv[1:4]
    src, dst = blocks(src_f), blocks(dst_f)
    # 译文文件头部含汉化声明（注释+blockquote 同块），跳过 1 块
    if len(dst) == len(src) + 1 and "中文翻译版" in dst[0]:
        dst = dst[1:]
    if len(src) != len(dst):
        print(f"ERROR: 块数不一致 src={len(src)} dst={len(dst)}: {src_f}", file=sys.stderr)
        sys.exit(1)
    try:
        m = json.load(open(map_f, encoding="utf-8"))
    except FileNotFoundError:
        m = {}
    for s, d in zip(src, dst):
        if s.strip() == d.strip():
            continue  # 未翻译的块（代码块等）不进 map
        m[hashlib.sha1(s.encode()).hexdigest()] = d
    json.dump(m, open(map_f, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"OK {src_f}: {len(src)} 块, map 共 {len(m)} 条")

if __name__ == "__main__":
    main()
