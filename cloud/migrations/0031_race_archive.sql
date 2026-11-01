-- クラウド版(D1)の migration 0031: 過去の結果ページの目録 race_archive(Issue #551〈#549-A2〉。親は #549)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表を読み書きする新しい Worker は、migration の適用より前に出してはならない。deploy-cloud.yml は migration を wrangler deploy より前に適用する。
--   旧い Worker はこの表を参照しないので、適用後も壊れない(共存)。この Issue の時点では、本番の Worker はこの表を読み書きしない(呼び出し元は #549-A3)。
--
-- 過去 5 年分の結果ページ(中央)を Cloudflare で取って R2 に置いたとき、どのレースが何の版で R2 のどこにあるかを引くための目録。
-- 本体(読み取り結果の JSON と元の HTML を gzip したもの)は R2 の `race-results/{race_id}.json.gz`。D1 には目録だけを置く。
-- 読み書きは cloud/src/race-archive-repository.ts だけ。書く順は R2 → D1(片方が失敗したら、同じレースをもう一度保存すればやり直せる)。
--
-- race_archive: レースで 1 行。
--   race_id         race_id(12 桁)。主キー
--   kind            置き場: central(中央)か nar(地方)
--   race_date       開催日(YYYY-MM-DD)
--   parser_version  読み取りの版(core の RACE_RECORD_PARSER_VERSION)。パーサを直したときに、読み直す対象を引く
--   r2_key          R2 のキー
--   raw_bytes       gzip する前の JSON の UTF-8 バイト数。同じ中身の再保存かどうかの比較に使う(圧縮後の長さは、取得時刻の違いで変わりうる)
--   fetched_at      取得した時刻(ISO 形式の UTC)。中身が変わった保存で更新し、変わらない再保存では据え置く
-- WITHOUT ROWID・副索引なし(書き込みの行を増やさない。1 行は約 100B、5 年分で約 2MB の見込み)。列挙は主キーの順で行う。
--   見方の例: SELECT parser_version, COUNT(*) FROM race_archive GROUP BY parser_version;  -- 読み取りの版ごとの件数
CREATE TABLE race_archive (
  race_id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('central', 'nar')),
  race_date TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;
