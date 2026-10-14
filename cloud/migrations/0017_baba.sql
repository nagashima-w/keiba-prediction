-- クラウド版(D1)の migration 0017: 外部の馬場の API(JRA の競馬場の最新の馬場状態)の取得の試みと、競馬場ごとの当日の値(Issue #294〈#293-A〉)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。表が無い間は新しい Worker の取得が止まるだけで、分析は止まらない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
--
-- 利用の条件は「JRA の開催日に、利用者全体で 1 日 1 回」。取得する前に baba_fetches に開催日の行を INSERT し(主キーの衝突 = 既に試みた)、その後でだけ API に出る。
-- 読み書きは cloud/src/baba-repository.ts だけ。値の読み出し(LLM と画面への表示)は #295。
--
-- baba_fetches: 開催日 1 日につき 1 行の、取得の試みの記録。
--   kaisai_date     開催日(YYYYMMDD。JST)。主キー = 1 日 1 回の保証の実体(INSERT ... ON CONFLICT DO NOTHING の changes が 1 のときだけ取得する)
--   attempted_at    試みた時刻(エポックミリ秒)。API に出る前に書く
--   finished_at     結果を記録した時刻(エポックミリ秒)。NULL = 試みたが結果を記録できなかった(クラッシュ・保存の失敗)。この日は再試行しない
--   result          結果の分類(固定の語: ok・no-today-venues・not-json・shape-mismatch・stale・timeout・network・too-large・redirect・http-<status>・other)。例外の文面・URL・本文は残さない
--   api_fetched_at  応答の fetchedAt(ISO 8601。形が読めたときだけ)
--   venues_saved    baba_conditions に保存した競馬場の数
--   venues_dropped  捨てた競馬場の数(計測日が当日でない・不正・場コードの重複)
CREATE TABLE baba_fetches (
  kaisai_date TEXT NOT NULL PRIMARY KEY,
  attempted_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  api_fetched_at TEXT,
  venues_saved INTEGER,
  venues_dropped INTEGER
) WITHOUT ROWID;

-- baba_conditions: 開催日 × 競馬場(JRA の場コード 01〜10)で 1 行の、当日の馬場の値。計測日が当日の競馬場だけを保存する(古い値・開催していない競馬場は捨てる)。
--   measured_at              計測日時(YYYY-MM-DDTHH:MM+09:00。応答の measuredAt には年が無いので、取得日の JST から補って曜日で検算したもの)
--   cushion                  クッション値
--   turf_* / dirt_*          芝・ダートの状態(全体・ゴール前・4角。良・稍重など)と含水率(ゴール前・4角。%)
--   rainfall_mm              降水量(mm)。応答に無ければ NULL
--   used_course              使用コース(例: Aコース（内柵を最内に設置）)
--   turf_length              芝丈
--   turf_state_text          芝の状態の文章(応答の turfCondition)
--   raw_json                 応答の競馬場 1 件ぶんの元の JSON(4096 字以内のときだけ。超えれば NULL。パーサを直したときの再導出・将来の特徴量の材料)
--   saved_at                 保存した時刻(エポックミリ秒)
-- 文字列は制御文字を除き、長さを切って保存する(外部の API の応答の文章が、後続で LLM に入るため)。
CREATE TABLE baba_conditions (
  kaisai_date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  cushion REAL,
  turf_condition TEXT,
  turf_goal_condition TEXT,
  turf_corner4_condition TEXT,
  turf_goal_moisture REAL,
  turf_corner4_moisture REAL,
  dirt_condition TEXT,
  dirt_goal_condition TEXT,
  dirt_corner4_condition TEXT,
  dirt_goal_moisture REAL,
  dirt_corner4_moisture REAL,
  rainfall_mm REAL,
  used_course TEXT,
  turf_length TEXT,
  turf_state_text TEXT,
  raw_json TEXT,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (kaisai_date, venue_code)
) WITHOUT ROWID;
