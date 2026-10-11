-- クラウド版(D1)の migration 0006: 馬ごとの強調材料(highlights)と懸念事項(concerns)(Issue #197・#196-a)。
-- exe の SQLite(analysis_horses)に足した列と**同じ列**(exe の CREATE TABLE と後付け migration の両方で足している)。そのため D1 専用の追加分ではなく、
-- scripts/test/cloud-d1-schema.test.ts の D1_EXTRA_COLUMNS には宣言しない(宣言すると、exe にもある列を二重に数えて不一致になる)。
-- 0001 は凍結した(exe のスキーマ変更で 0001 の生成物にも同じ列が入り、この ALTER と重複するため。scripts/gen-cloud-d1-migration.ts の説明を参照)。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま=項目なし)。
-- ★codec(packages/core/src/ev/analysis-store-codec.ts)は exe と cloud で共有している。この migration を本番の D1 に適用する前に、
--   新しい codec の Worker を出してはならない(INSERT が存在しない列を指して、保存が壊れる)。デプロイは migration の適用のあとに行う(deploy-cloud.yml)。

-- 各馬の項目の JSON 配列(文字列の配列。各最大3項目)。空配列は NULL で保存し、読むときに NULL・壊れた値を [] に戻す。
ALTER TABLE analysis_horses ADD COLUMN highlights_json TEXT;
ALTER TABLE analysis_horses ADD COLUMN concerns_json TEXT;
