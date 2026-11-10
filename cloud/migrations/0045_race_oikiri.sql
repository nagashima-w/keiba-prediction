-- クラウド版(D1)の migration 0045: 過去のレースの追い切りの評価(ランクと評語)を貯める表 race_oikiri を足す(Issue #731。探索〈#700〉の材料)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧 Worker はこの表を参照しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表を書く新しい Worker は、migration の適用より前に出してはならない。deploy-cloud.yml は migration を wrangler deploy より前に適用する(表が無い間は保存が失敗するだけ)。
-- 書くのは cloud/src/race-oikiri-repository.ts だけ(毎晩の取得の段取りは race-archive-fetch-core.ts の `oikiri` モード。DO `RaceOikiriFetchDO`)。元の HTML は R2 に置かない(ユーザーの決定)。
--
-- race_oikiri: レースで 1 行(netkeiba の追い切りのページ race/oikiri.html から)。
--   race_id         race_id(12 桁)。主キー
--   race_date       開催日(YYYY-MM-DD。race_archive.race_date と同じ)
--   horses_json     馬ごとの [馬番, 馬 ID(10 桁), ランク(A〜D。空なら null), 評語(例「気配上々」。空なら null)] の配列(JSON。ページの並び)。頭数は配列の長さ
--   skipped_rows    ページにあったが読めずに捨てた行(馬番が範囲外・馬 ID のリンクが無い)の数。0 でなければ horses_json は欠けている
--   parser_version  読み取りの版(core の OIKIRI_PARSER_VERSION)。パーサを直したときに、読み直す対象を引く
--   fetched_at      取得した時刻(ISO 形式の UTC)。中身が変わった保存で更新し、変わらない再保存では据え置く
-- 時計・コースはこのページに無いので持たない。WITHOUT ROWID・副索引なし(1 行の書き込みが 1 行。約 1.4 万〜2 万行で、1 行は約 0.6KB、合計 10MB 前後の見込み)。
--   探索の読み方の例: SELECT race_id, race_date, horses_json FROM race_oikiri WHERE race_date BETWEEN '2024-01-01' AND '2024-12-31' ORDER BY race_id;
--   (race_date に索引は無い。主キーの全走査になるので、探索の側で 1 回だけ全件を読んで手元で絞る使い方を想定している)
CREATE TABLE race_oikiri (
  race_id TEXT NOT NULL PRIMARY KEY,
  race_date TEXT NOT NULL,
  horses_json TEXT NOT NULL,
  skipped_rows INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;
