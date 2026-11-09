#!/usr/bin/env python3
"""#682 事後の確認(事前登録の外): 頭数 16 以上のレースの中で、ハンデ・1400m 以下・1番人気が牡馬が、
さらに 1 番人気を崩れやすくするか。基準 = 確認の期間の「頭数 16 以上」の 1 番人気(X16d)。
使い方: posthoc.py <confirm_raw_dir> <posthoc_raw_dir> <out.json>
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import by_class, evaluate, load_raw  # noqa: E402

confirm, post, out = sys.argv[1:4]
base = by_class(load_raw(confirm)["X16d"])
res = []
for pid, d in load_raw(post).items():
    r = evaluate(by_class(d), base)
    r.update({"id": pid, "label": d["label"]})
    res.append(r)
    print(f"{pid} {d['label']}: n={r['n']} 4着以下率 {r['fail_rate']} (頭数16以上の他 期待 {r['exp_rate']}) 実/期 {r['ratio']} z={r['z']}")
json.dump(res, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
