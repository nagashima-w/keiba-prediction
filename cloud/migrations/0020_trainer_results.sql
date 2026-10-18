-- クラウド版(D1)の migration 0020: 調教師の年ごとの成績の表(Issue #354〈#348 の TR1〉)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表を読み書きする新しい Worker は、migration の適用より前に出してはならない(deploy-cloud.yml は migration を wrangler deploy より前に適用する)。
--   表が無い間の読み書きは scrapeRace が警告にして取得へフォールバックする(分析は止まらないが、調教師のページを毎回取りにいく)。
--
-- 目的: 調教師の前2年(レースの年の Y−2・Y−1)の3着内率を統計モデル(prior)に使うために、調教師の年度別成績を日をまたいで共有する。
-- 前2年の行は確定値なので、更新は年に 1 回で足りる(騎手の `jockey_results` の 7 日とは違う): 読んだ取得日時が**レースの年の 1 月 1 日(JST)以降**なら
-- netkeiba に出ない(`scrapeRace`)。生の HTML(1 ページ約 50〜120KB)は置かず、パース後の小さな値だけを置く。
-- 読み書きは cloud/src/trainer-results-repository.ts だけ。
--
-- 騎手の `jockey_results` と同じ形(1 調教師・1 区分で 1 行。年ごとの成績は 1 つの JSON 配列)。表を分けるのは、調教師 ID と騎手 ID が
-- どちらも 5 桁の数字または英数字で、番号体系が別のため(同じ表に置くと取り違える)。
--   trainer_id  調教師 ID(netkeiba の trainer_id。5 桁の数字、または 5 桁の英数字)
--   kind        主催者の区分。'central'(中央の成績)または 'nar'(地方の成績)。今の Worker は中央しか使わない(地方は対象外)が、
--               地方に広げるときに主キーを変える migration が要らないよう、騎手の表と同じ列を持つ
--   years_json  年ごとの成績。`[[年, 出走数, 3着内の回数], ...]`(新しい年が先)。成績の行が無い調教師は `[]`(取得したが行が無い=未取得とは別。毎回取り直さない)
--   fetched_at  取得した時刻(エポックミリ秒)
CREATE TABLE trainer_results (
  trainer_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('central', 'nar')),
  years_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (trainer_id, kind)
);
