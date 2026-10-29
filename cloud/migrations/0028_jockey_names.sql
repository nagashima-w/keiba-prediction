-- クラウド版(D1)の migration 0028: 出馬表の騎手名と騎手 ID の組 jockey_names(Issue #526 段階 1b)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表を読み書きする新しい Worker は、migration の適用より前に出してはならない。
--   書き込みの失敗は握って警告にして続ける(分析は止まらない)が、統計モデル用の書き出しは、この表を読めないとその回が失敗する(再試行して止まる)。
--   deploy-cloud.yml は migration を wrangler deploy より前に適用する。旧い Worker はこの表を参照しないので、適用後も壊れない(共存)。
--
-- 統計モデル用の書き出し(Issue #266・#526)の jockey_id を、騎手名から過去の分析にさかのぼって埋めるための対応表。
-- 出馬表の騎手名は略した名前(中央は「戸崎圭」「横山武」、地方はフルネーム)で、戦績(horse_runs)の騎手名はフルネームなので、戦績からは直せない。
-- 出馬表どうしで突き合わせるために、発走前の計算(cloud/src/race-day-core.ts)が、分析するたびに、そのレースの全馬の (騎手名, 騎手 ID) を書く。中央・地方とも。
-- 書き出しは、この表で「ID がちょうど 1 つの名前」だけを使って埋める(2 つ以上ある名前は埋めない)。読み書きは cloud/src/jockey-names-repository.ts と、cloud/src/prior-export-store.ts の `readLookups` だけ。
--
-- jockey_names: 騎手名 × 騎手 ID で 1 行。
--   jockey_name  出馬表の騎手名(前後の空白を除いた、パースした文字列そのまま。全角・半角も直さない)。主キーの 1 つめ
--   jockey_id    netkeiba の騎手 ID(例: "05386"・"a01ad"。先頭の 0 を含む文字列)。主キーの 2 つめ
--   first_seen   最初に見た開催日(YYYYMMDD。analyses.kaisai_date と同じ形)。監査用で、埋めるルールには使わない。同じ組は書き直さないので、最初の値が残る
-- 副索引は付けない(読み出しは全件。中央と地方で数百〜千数百行の見込み。未測定)。
--   見方の例: SELECT jockey_name, COUNT(*) AS n FROM jockey_names GROUP BY jockey_name HAVING n > 1;  -- 同じ名前に ID が 2 つ以上(埋めない名前)
CREATE TABLE jockey_names (
  jockey_name TEXT NOT NULL,
  jockey_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (jockey_name, jockey_id)
) WITHOUT ROWID;
