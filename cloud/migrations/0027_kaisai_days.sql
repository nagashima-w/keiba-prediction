-- クラウド版(D1)の migration 0027: 開催日ごとの記録 kaisai_days(Issue #519)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表を読み書きする新しい Worker は、migration の適用より前に出してはならない(書き込みと読み出しが失敗し、芝の開催進行の通算・柵の日数が出ない)。
--   ただし失敗は握って警告にして続けるので、分析そのものは止まらない。deploy-cloud.yml は migration を wrangler deploy より前に適用する。旧い Worker はこの表を参照しないので、適用後も壊れない(共存)。
--
-- 芝の開催進行(プロンプトの「芝コースの開催進行」の行)に、連続開催の通算の日数と、いまの柵になってから何日目かを足すための記録。
-- 発走前の計算(cloud/src/race-day-core.ts)が、中央のレースを分析するたびに、そのレースの (場コード, 年, 回, 日次) の行を書く(同じ日・同じ場のレースが何度書いても、1 行に収まる)。
-- 分析は、同じ場の過去の行を読み、前の回から続けて芝を使っているかと、いまの柵が何日続いているかを数える(数え方は packages/core/src/analyzer/turf-wear.ts)。
-- 中央(場コード 01〜10)だけ。地方は書かない。読み書きは cloud/src/kaisai-days-repository.ts だけ。
--
-- kaisai_days: 場 × 年 × 回 × 日次で 1 行。
--   track_code   場コード(2 桁。レース ID の 5〜6 桁目)。主キーの 1 つめ
--   year         開催年(西暦 4 桁。レース ID の 1〜4 桁目)。主キーの 2 つめ
--   kai          開催回(レース ID の 7〜8 桁目)。主キーの 3 つめ
--   nichi        開催日次(レース ID の 9〜10 桁目)。主キーの 4 つめ
--   kaisai_date  開催日(YYYYMMDD。analyses.kaisai_date と同じ形)。最初に書いた値を保つ(上書きしない)
--   fence        その日の芝の柵(例: "A")。芝のレースで読めたときだけ。読めない・芝以外は NULL。NULL の行は、最初に読めたレースが埋める(既に入っている値は上書きしない)
-- 副索引は付けない(1 つの場で年に 30〜40 行しかなく、読み出しは主キーの先頭〈場コード・年〉で絞る)。
--   見方の例: SELECT * FROM kaisai_days WHERE track_code = '06' AND year = 2026 ORDER BY kai, nichi;
CREATE TABLE kaisai_days (
  track_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  kai INTEGER NOT NULL,
  nichi INTEGER NOT NULL,
  kaisai_date TEXT NOT NULL,
  fence TEXT,
  PRIMARY KEY (track_code, year, kai, nichi)
) WITHOUT ROWID;
