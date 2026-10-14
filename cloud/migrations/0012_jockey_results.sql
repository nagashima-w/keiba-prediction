-- クラウド版(D1)の migration 0012: 騎手の年ごとの成績の表(Issue #226)。exe の SQLite には無い、D1 専用の表。
-- 番号が 0011 でなく 0012 なのは、#259 が 0011 を使うため(番号の衝突は取り込み順でメインが調整する)。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
--
-- 目的: 騎手の成績の更新は週に 1 回で十分(ユーザー決定 2026-10-11)。取得物のキャッシュは開催日ごとの DO の SQLite にあり、日をまたいで
-- 再利用されないので、パース後の小さな値だけを D1 に置いて日をまたいで共有する。生の HTML(1 ページ約 70KB)は置かない。
-- 読み書きは cloud/src/jockey-results-repository.ts だけ。読んで 7 日(取得日時から)以内なら netkeiba に出ない。
--
-- 1 騎手・1 区分(中央/地方)で 1 行。年ごとの成績は 1 つの JSON 配列(`[[年, 騎乗数, 3着内], ...]`。新しい年が先)にまとめる:
-- 年ごとに行を分けると、取得 1 回あたりの書き込みが「年数+1 行」(1 騎手で約 15 行)になり、読みの結合も要る。まとめれば書き込みは 1 騎手 1 行で、
-- 読みは 1 クエリ、書き込みは 20 人で 1 クエリ(D1 の「1 回の呼び出しあたりのクエリ数」の上限を食わない)。
--   jockey_id   騎手 ID(netkeiba の jockey_id。5 桁の数字、または 5 桁の英数字)
--   kind        主催者の区分。'central'(中央のレースの騎手。中央の成績)または 'nar'(地方のレースの騎手。地方の成績。同じ騎手 ID でも別の行)
--   years_json  年ごとの成績。`[[年, 騎乗数, 3着内の回数], ...]`。中央/地方の成績が無い騎手は `[]`(取得したが行が無い=未取得とは別。毎回取り直さない)
--   fetched_at  取得した時刻(エポックミリ秒)。これから 7 日を超えたら取り直す
CREATE TABLE jockey_results (
  jockey_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('central', 'nar')),
  years_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (jockey_id, kind)
);
