-- クラウド版(D1)の migration 0022: レースの条件(負担重量の種別・牝馬限定)の記録(Issue #421 段階 1)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。表が無い間は新しい Worker の保存が失敗するが、警告になるだけで分析は止まらない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表に書く新しい Worker は、migration の適用より前に出してはならない(書き込みが落ち、その間のレースの条件が記録されない)。
--   deploy-cloud.yml は migration を wrangler deploy より前に適用する。旧い Worker はこの表を指さないので、適用後も壊れない(共存)。
--
-- 目的: 前走との照合(段階 2。前走のレース ID でこの表を引き、「前走がハンデ戦か・牝馬限定か・今回と同じ条件か」を内部の記録だけで判定する)のために、
-- 中央のレースの条件をレース単位で貯める。段階 1 は「貯めるだけ」(統計モデル・LLM・画面には使わない)。読み書きは cloud/src/race-conditions-repository.ts だけ。
-- 書くのは日単位の DO の取得ステップ(朝・発走前)。出馬表の `div.RaceData02` の span から読んだ値で、地方は読まない(行を作らない)。
-- 手動の単独・一括実行は書かない(限界)。
--
-- race_conditions: レース 1 件につき 1 行。WITHOUT ROWID(主キーが行の実体。副索引は作らない=書き込みの行を増やさない)。
--   race_id       レース ID(12 桁。中央)。主キー
--   weight_type   負担重量の種別(ハンデ・別定・定量・馬齢)。出馬表に見つからない・曖昧(異なる種別が複数)なら NULL(読もうとしたが決まらなかった)
--   fillies_only  牝馬限定か(1/0)。`RaceData02` を読めたときだけ行を書くので NOT NULL(読めなかったレースは行を作らない)
--   saved_at      最後に値を書いた時刻(エポックミリ秒)。同じ値の再保存では更新しない(UPSERT の WHERE が、値が違うときだけ書く=rows_written を食わない)
CREATE TABLE race_conditions (
  race_id TEXT NOT NULL PRIMARY KEY,
  weight_type TEXT,
  fillies_only INTEGER NOT NULL,
  saved_at INTEGER NOT NULL
) WITHOUT ROWID;
