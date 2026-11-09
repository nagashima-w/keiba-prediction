-- クラウド版(D1)の migration 0044: 過去のレース(2021 年〜)で、ブリンカーを着けていた馬を、JRA の過去の結果の頁から貯める表を足す(Issue #698。親は #695)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。表が無い間は新しい Worker の保存が止まるだけ)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
--
-- 既存の race_horse_entries には書かない(reduction_kg・foreign_mark が NOT NULL で、結果の頁には値が無い。0 を入れると「減量なし」と読めてしまう)ため、別の表にした。
-- 「着けていない馬」の行は書かない。**「past_blinker_races に行があるレースの馬で、past_blinker_horses に行が無い = 着けていなかった」**と読む(書き込みの行数を約 28 万行から数万行に減らすため)。
-- したがって past_blinker_races の行は、そのレースの past_blinker_horses の行を**書いたのと同じ batch(1 つのトランザクション)で**書く(書くのは cloud/src/past-blinker-repository.ts だけ)。
-- 両方の表とも WITHOUT ROWID で、副索引は作らない(使うのは主キーの引きと、race_id の範囲読みだけ。馬から引く索引は、分析で要るとわかってから足す)。1 行の書き込み = 1 書き込み。
--
-- past_blinker_races: 取り終えたレースごとに 1 行。
--   race_id         netkeiba の race_id(12 桁。結果の頁の cname から組む)。主キー
--   fetched_on      取った日(YYYYMMDD。JST)
--   head_count      頭数(結果の表の行の全部。取消・除外・中止なども含む)
--   blinker_count   ブリンカーの印のあった頭数(past_blinker_horses の、このレースの行数と一致する)
CREATE TABLE past_blinker_races (
  race_id TEXT NOT NULL PRIMARY KEY,
  fetched_on TEXT NOT NULL,
  head_count INTEGER NOT NULL,
  blinker_count INTEGER NOT NULL
) WITHOUT ROWID;

-- past_blinker_horses: ブリンカーを着けていた馬だけ、(レース, 馬)ごとに 1 行。
--   horse_id        馬の ID(10 桁。結果の頁の馬名リンクの pw01dud10 の次の 10 桁)
--   source          出どころ(`jra_result`)
--   fetched_on      取った日(YYYYMMDD。JST)
CREATE TABLE past_blinker_horses (
  race_id TEXT NOT NULL,
  horse_id TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_on TEXT NOT NULL,
  PRIMARY KEY (race_id, horse_id)
) WITHOUT ROWID;
