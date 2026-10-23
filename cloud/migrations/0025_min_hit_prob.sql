-- クラウド版(D1)の migration 0025: 的中確率の下限と、下限で外した買い目の記録(Issue #470〈#468-A〉)。exe の SQLite には無い、D1 専用の列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS)も同時に直す。
-- ★デプロイの順序: この列に書く新しい Worker は、migration の適用より前に出してはならない(分析の保存の batch が落ちる)。
--   deploy-cloud.yml は migration を wrangler deploy より前に適用する。旧い Worker はこの列を参照しないので、適用後も壊れない(共存)。
--
-- 設定の `minHitProb`(的中確率の下限。0〜1。0 は下限なし)未満の買い目は、配分の候補から外す。外した買い目と、使った下限を記録して、下限が本当に効いているかを後から確かめられるようにする。
-- 新しい表は作らない(行を増やさない: 外した買い目は 1 レースで最大数百件になりうるので、1 行ずつ書くと D1 の書き込みの行数が増える)。保存の batch には、同じメタ行への UPDATE が 1 文増える。`analysis_bets` は『賭け金が付いた行だけ』のまま変えない。
--
--   min_hit_prob      その分析で使った下限(0 = 下限なし)。NULL = 記録なし(Issue #470 より前の行)。
--   below_floor_count 下限で外れた EV プラスの買い目の数(券種を問わない)。0 = 外れた候補なし。NULL = 配分の計算に到達していない(未設定・発売前・対象外・無効)、または旧い行。
--   missed_json       下限を外さなかった場合に賭け金が付いた買い目(JSON の配列。`would_stake > 0` のものだけ)。各要素のキー: bet_type・combo_key(`analysis_bets.combo_key` と同じ形)・hit_prob・odds・ev・would_stake。
--                     表し方(3 通りを区別できる):
--                       NULL … 記録していない(旧い行 / 下限なし〈min_hit_prob = 0〉/ 外れた候補なし〈below_floor_count = 0〉/ 配分の計算に到達していない)。
--                              below_floor_count > 0 かつ NULL なら、外れたが『外さなかった場合の賭け金』を計算していない(分析の保存以外の経路)。
--                       '[]'  … 外れた候補はあったが、外さなかった場合でも賭け金が付くものは無かった。
--                       配列  … 外さなかった場合に賭け金が付いた候補。
--                     集計の例: SELECT json_extract(j.value, '$.bet_type'), count(*), sum(json_extract(j.value, '$.would_stake'))
--                               FROM analysis_allocation_meta m, json_each(m.missed_json) j GROUP BY 1;
--                     『外さなかった場合の賭け金』は、下限なしでもう一度配分を計算したときの、その買い目の賭け金(下限ありの配分とは、残る買い目の賭け金も変わる)。
ALTER TABLE analysis_allocation_meta ADD COLUMN min_hit_prob REAL;
ALTER TABLE analysis_allocation_meta ADD COLUMN below_floor_count INTEGER;
ALTER TABLE analysis_allocation_meta ADD COLUMN missed_json TEXT;
