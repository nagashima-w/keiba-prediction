-- クラウド版(D1)の migration 0048: 騎手・調教師の年ごとの集計(Issue #729 段階 A。#256 の材料を兼ねる)。exe の SQLite には無い、D1 専用の表と列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧 Worker はこれらの表・列を参照しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES・race_archive の列と索引)も同時に直す。
-- ★デプロイの順序: これらを読み書きする新しい Worker は、migration の適用より前に出してはならない。deploy-cloud.yml は migration を wrangler deploy より前に適用する。
--   適用前に新しい Worker が目録を保存すると、UPSERT が person_version を参照して失敗する(取得 DO は保存の例外を握って数える)。
-- 読み書きは cloud/src/person-stats-repository.ts だけ(毎晩の段取りは market-edge-core.ts の DO `RaceMarketEdgeDO` の人の段。var `PERSON_STATS_ENABLED` が "1" のときだけ動く)。
--
-- 目的: netkeiba の集計ページ(db.netkeiba.com/jockey|trainer/result.html)から取っている騎手・調教師の年度別成績(starts・placed)を、手元の過去の結果から自分で集計する。
-- 段階 A は集計の表を作るだけで、分析(scrape-race の取得)の置き換えは段階 B(並走の突き合わせのあとに別に決める)。
--
-- race_archive.person_version: 人の行への取り込みの済み印。NULL = 未処理、1 = 取り込み済み(版 PERSON_ROWS_VERSION)。数える馬が 0 頭で行を作らなかったレースにも、同じ batch で 1 を付ける(取り込み直さない)。
--   目録の行の中身が変わる保存(saveRaceArchive の UPSERT が更新する場合)は NULL に戻す(market_version・runs_version と同じ作り)。
-- idx_race_archive_person_pending: 未処理の中央・2021-01-01 以降の行だけの部分索引(2016〜2020 と地方は入れない。書き込みを増やさない)。
--   ★索引の WHERE は、cloud/src/person-stats-repository.ts の SELECT_PERSON_PENDING_PAGE_SQL の WHERE と同じ形(日付のリテラルも同じ)でなければならない
--   (違うと SQLite は部分索引を使わず、目録の全行を読む。cloud/test/person-stats-repository.integration.test.ts が照らす)。
--   書き込みの増分: 2021-01-01 以降の中央のレースを目録に入れる(新規・中身が変わる再保存)たび +1 行(未処理で入るため)。取り込んだとき索引から外れる(+1 行)。
ALTER TABLE race_archive ADD COLUMN person_version INTEGER;
CREATE INDEX IF NOT EXISTS idx_race_archive_person_pending ON race_archive (race_id) WHERE person_version IS NULL AND kind = 'central' AND race_date >= '2021-01-01';

-- race_person_rows: レースで 1 行(中央の過去の結果から 1 回だけ作る)。集計はこの表を年の範囲で読む(R2 を読み直さない)。
--   race_id      race_id(12 桁)。主キー
--   race_date    開催日(YYYY-MM-DD)。年ごとの集計の範囲読みに使う
--   venue_code   競馬場コード(race_id の場コード 2 桁。#256 の競馬場別の集計用)
--   course_type  芝 / ダ / 障 / NULL
--   distance     距離(m)。NULL あり
--   horses_json  数えた馬ごとの [騎手 ID, 調教師 ID, 区分] の配列(JSON)。区分は 3 着内 = 1・着外 = 0。取消・除外の馬は入れない。ID は null がありうる
-- WITHOUT ROWID + race_date の副索引 1 つ。1 行の書き込みは 2 行(本体 + 索引)。1 行は約 0.4KB、2021 年以降の約 2 万レースで約 8MB の見込み。
CREATE TABLE race_person_rows (
  race_id TEXT NOT NULL PRIMARY KEY,
  race_date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  course_type TEXT,
  distance INTEGER,
  horses_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_race_person_rows_date ON race_person_rows (race_date);

-- person_year: 騎手・調教師 × 年で 1 行(毎晩、取り込みで触れた年を race_person_rows から数え直して置き換える)。
--   person_kind  jockey か trainer
--   person_id    騎手 ID・調教師 ID(netkeiba の ID。先頭の 0 を含む文字列)
--   year         開催日の年(西暦 4 桁)
--   starts       騎乗数・出走数(取消・除外を除く全頭)
--   placed       うち 3 着内の数
--   computed_on  値を最後に変えた日(JST の YYYY-MM-DD)。値が同じ再計算では書き換えない(書き込みの行を増やさない)
-- WITHOUT ROWID・副索引なし。約 650 人 × 6 年で約 4,000 行(1MB 未満)の見込み。
CREATE TABLE person_year (
  person_kind TEXT NOT NULL CHECK (person_kind IN ('jockey', 'trainer')),
  person_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  starts INTEGER NOT NULL,
  placed INTEGER NOT NULL,
  computed_on TEXT NOT NULL,
  PRIMARY KEY (person_kind, person_id, year)
) WITHOUT ROWID;
