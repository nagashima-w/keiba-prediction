-- クラウド版(D1)の migration 0029: 単勝・複勝の点数の上限の記録(Issue #533)。exe の SQLite には無い、D1 専用の列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS)も同時に直す。
-- ★デプロイの順序: この列に書く新しい Worker は、migration の適用より前に出してはならない(分析の保存の batch が落ちる)。
--   deploy-cloud.yml は migration を wrangler deploy より前に適用する。旧い Worker はこの列を参照しないので、適用後も壊れない(共存)。
--
-- 設定の `maxWinBetsPerRace`・`maxPlaceBetsPerRace`(1 レースあたりの単勝・複勝の点数の上限。整数 0〜18。0 は上限なし)で、賭け金の付く買い目の点数を抑える。
-- 配分を計算し直す(scripts/allocation-dataset.ts の replayRace)ときに、分析時に使った上限を再現できるよう、使った値を残す。
-- 新しい表は作らない(列を 2 つ足すだけ。保存の batch に増える文もない。#470 の UPDATE の列が 2 つ増える)。
--
--   max_win_bets   その分析で使った単勝の点数の上限(0 = 上限なし)。NULL = 記録なし(Issue #533 より前の行。旧い Worker は上限なしで配分したので、NULL は 0 と同じ意味)。
--   max_place_bets その分析で使った複勝の点数の上限(0 = 上限なし)。NULL の意味は max_win_bets と同じ。
-- 複勝だけの経路(組合せオッズを取得しない設定など)の配分には単勝がないので、max_win_bets は配分に効かない。値は設定のまま残す。
ALTER TABLE analysis_allocation_meta ADD COLUMN max_win_bets INTEGER;
ALTER TABLE analysis_allocation_meta ADD COLUMN max_place_bets INTEGER;
