# 示例：统计本次需求文本的字符数/单词数/行数（Python 脚本，context 经 stdin 传入）
import json, sys

ctx = json.load(sys.stdin)["context"]
req = ctx.get("requirements") or ""
stats = {"chars": len(req), "words": len(req.split()), "lines": len(req.splitlines())}
print(json.dumps({
    "output": "字符 %d · 单词 %d · 行 %d" % (stats["chars"], stats["words"], stats["lines"]),
    "success": True,
    "data": stats,
}, ensure_ascii=False))
