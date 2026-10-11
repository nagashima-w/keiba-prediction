-- クラウド版(D1)の migration 0011: 確定の単勝オッズ・人気の写し(Issue #259)。exe の SQLite には無い、D1 専用の列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS)も同時に直す。

-- 結果ページ(result.html)の「単勝オッズ」「人気」の列(レース後の確定値。勝ち馬のオッズ × 100 が単勝の確定払戻に一致することを、保存済みの結果ページで検査している)。
--   win_odds  確定の単勝オッズ(倍)。NULL = 未取得(この migration より前に取り込んだ行・取消や除外でページの欄が空だった馬)
--   ninki     確定の人気。NULL の意味は win_odds と同じ
-- 既存の行は migration では埋めない(UPDATE を migration に置かない方針)。結果の補完(cloud/src/result-backfill-core.ts の段階 2)が、結果ページを取り直して NULL の列だけを埋める。
-- 索引は作らない(検証の集計が全件を読む。書き込みの行を増やさない)。
ALTER TABLE race_results ADD COLUMN win_odds REAL;
ALTER TABLE race_results ADD COLUMN ninki INTEGER;
