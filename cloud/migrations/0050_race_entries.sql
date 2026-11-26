-- クラウド版(D1)の migration 0050: 前日の事前分析で読んだ出馬表の保存(Issue #799)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧 Worker はこれらの表を参照しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES・WITHOUT ROWID の宣言)も同時に直す。
-- ★デプロイの順序: この表に書く新しい Worker は、migration の適用より前に出してはならない(書き込みが落ち、その間の出馬表が保存されない。分析は止まらない)。
--   deploy-cloud.yml は migration を wrangler deploy より前に適用する。
--
-- 目的: 別の Worker が、前日の夜に D1 を読むだけで出馬表を得られるようにする。**保存するだけ**(分析・画面・LLM には使わない)。
-- 書くのは RaceDay の事前分析(morning)の計算ステップの末尾(キャッシュ済みの出馬表を写す。netkeiba への取得は増やさない)。中央・地方とも書く。
-- 読み書きは cloud/src/race-entries-repository.ts だけ。同じ値の再保存は行を書かない(値が変わったときだけ更新)。
--
-- race_entry_races: レース 1 件につき 1 行。WITHOUT ROWID + 開催日の副索引 1 つ(1 行の書き込みは 2 行。「その日のレース」を引くため)。
--   race_id      レース ID(12 桁。中央・地方)。主キー
--   kaisai_date  開催日(YYYYMMDD。analyses.kaisai_date と同じ形)
--   venue_code   競馬場コード(race_id の 5〜6 桁目。中央は 01〜10)
--   course_type  芝 / ダ / 障
--   distance     距離(m)
--   race_class   クラス。中央は正準ラベル(新馬・未勝利・1勝クラス…・オープン)、地方は生のトークン(C1・A2B1…)。読めなければ NULL
--   grade        グレード(G1 など)。無ければ NULL
--   start_time   発走時刻(JST の HH:MM)。読めなければ NULL
--   saved_at     最後に値を書いた時刻(エポックミリ秒)。同じ値の再保存では更新しない
CREATE TABLE race_entry_races (
  race_id TEXT NOT NULL PRIMARY KEY,
  kaisai_date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  course_type TEXT NOT NULL,
  distance INTEGER NOT NULL,
  race_class TEXT,
  grade TEXT,
  start_time TEXT,
  saved_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX idx_race_entry_races_date ON race_entry_races (kaisai_date, race_id);

-- race_entry_horses: 1 頭につき 1 行(出馬表に載った馬。取消・除外の馬も scratch つきで残す)。WITHOUT ROWID(副索引なし。レースごとの読みは主キー先頭の範囲)。
--   race_id, umaban  主キー
--   waku             枠番
--   horse_id         馬 ID(netkeiba の 10 桁)
--   jockey_id        騎手 ID(netkeiba)。取れなかった・取消の馬は NULL
--   trainer_id       調教師 ID(netkeiba)。取れなかった・取消の馬は NULL
--   kinryo           斤量(kg)。取消・除外の馬は NULL
--   sex, age         性(牡・牝・セ)と齢。取消・除外の馬は NULL
--   scratch          取消・除外・不明。出走する馬は NULL
--   saved_at         最後に値を書いた時刻(エポックミリ秒)
-- 書き込みの見込み: 初回 1 日で、中央 36 レース約 650 行(馬 約 580 + レース 36 + 索引 36)。地方は 1 日 約 500〜1,300 行。再保存で値が同じなら 0 行。
CREATE TABLE race_entry_horses (
  race_id TEXT NOT NULL,
  umaban INTEGER NOT NULL,
  waku INTEGER NOT NULL,
  horse_id TEXT NOT NULL,
  jockey_id TEXT,
  trainer_id TEXT,
  kinryo REAL,
  sex TEXT,
  age INTEGER,
  scratch TEXT,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (race_id, umaban)
) WITHOUT ROWID;
