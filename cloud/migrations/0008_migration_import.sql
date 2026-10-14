-- クラウド版(D1)の migration 0008: exe からの移行(Issue #216・#167-B1)のための列と、一覧を分析日時の順にするための索引。exe の SQLite には無い、D1 専用。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS・D1_EXTRA_INDEXES)も同時に直す。

-- exe の keiba.db での分析 id。移行の冪等性の鍵(同じファイルを2回取り込んでも、同じ分析を2回作らない)。web で分析したものは NULL。
ALTER TABLE analyses ADD COLUMN exe_analysis_id INTEGER;

-- 一意の索引は部分索引にする: web の分析(NULL)の保存で索引の書き込み行を増やさない(D1 Free の書き込みは 1 日 10 万行)。
-- 検索の文は `exe_analysis_id IS NOT NULL` を添えると、この索引を使う。
CREATE UNIQUE INDEX idx_analyses_exe_id ON analyses (exe_analysis_id) WHERE exe_analysis_id IS NOT NULL;

-- 一覧(`GET /api/analyses`)を分析日時の降順にするための索引(移行した分析は D1 の id が新しいのに分析日時は古いので、`ORDER BY id DESC` では
-- 古い分析が最新として並ぶ)。絞り込みなし・race_id・kaisai_date のそれぞれで、並べ替えの一時領域を使わず先頭の N 件だけを読む。
-- rowid(id)は索引の末尾に暗黙に入るので、`ORDER BY analyzed_at DESC, id DESC` もこの索引だけで満たせる。
CREATE INDEX idx_analyses_analyzed_at ON analyses (analyzed_at);
CREATE INDEX idx_analyses_race_analyzed ON analyses (race_id, analyzed_at);
CREATE INDEX idx_analyses_kaisai_analyzed ON analyses (kaisai_date, analyzed_at);
