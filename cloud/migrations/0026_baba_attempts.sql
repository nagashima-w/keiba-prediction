-- クラウド版(D1)の migration 0026: 馬場の取得の「枠ごとの試み」の記録(Issue #480〈#477-D〉)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表に書く新しい Worker は、migration の適用より前に出してはならない(枠の claim が落ち、その日の馬場の値が取得されない)。
--   deploy-cloud.yml は migration を wrangler deploy より前に適用する。旧い Worker はこの表を参照しないので、適用後も壊れない(共存)。
--
-- 馬場の取得は、開催日の 09:00 から 15 分おきに 12:00 まで(最大 13 枠)、当日の値がそろうまで取り直す。「JRA に出るのは 1 枠 1 回」の保証の実体がこの表の主キー。
-- baba_fetches(0017・0021。開催日 1 日 1 行)は、その日の要約として残す(取得の claim の batch で日の行を作り、結果の記録で更新する)。
-- 読み書きは cloud/src/baba-repository.ts だけ。管理者の GET /api/baba-fetch が、日ごとの `attempts` として返す。
--
-- baba_fetch_attempts: 開催日 × 枠で 1 行の、取得の試みの記録。
--   kaisai_date     開催日(YYYYMMDD。JST)。主キーの 1 つめ
--   slot            枠の番号(0 = 最初の枠〈09:00〉、以後 15 分ごとに +1、12 = 12:00。置き値で、取得の側の定数を変えれば本数も変わる)。主キーの 2 つめ =
--                   1 枠 1 回の保証の実体(INSERT ... ON CONFLICT DO NOTHING の changes が 1 のときだけ取得する)
--   attempted_at    試みた時刻(エポックミリ秒)。JRA に出る前に書く
--   finished_at     結果を記録した時刻(エポックミリ秒)。NULL = 試みたが結果を記録できなかった(クラッシュ・保存の失敗)。この枠は再試行しない
--   result          結果の分類(固定の語。baba_fetches.result と同じ)。例外の文面・URL・本文は残さない
--   api_fetched_at  クッション値のページを取り終えた時刻(ISO 8601)。取れていなければ NULL
--   venues_saved    この回で baba_conditions に書いた(新しく入った、または欠けを埋めた)競馬場の数
--   venues_dropped  この回で捨てた競馬場の数(計測日が当日でない・不正)
--   dropped_json    この回で捨てた競馬場の診断(baba_fetches.dropped_json と同じ形)
--   complete        1 = この回で、その日の全部の場(クッション値と含水率の両方が当日の値)がそろった。0 = まだ。NULL = 結果を記録できなかった
--                   (claim は、同じ日に complete = 1 の回があれば取得しない。DO のストレージが消えても、そろった日に取り直さない)
--   見方の例: SELECT kaisai_date, slot, result, venues_saved, complete FROM baba_fetch_attempts ORDER BY kaisai_date DESC, slot;
CREATE TABLE baba_fetch_attempts (
  kaisai_date TEXT NOT NULL,
  slot INTEGER NOT NULL,
  attempted_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT,
  api_fetched_at TEXT,
  venues_saved INTEGER,
  venues_dropped INTEGER,
  dropped_json TEXT,
  complete INTEGER,
  PRIMARY KEY (kaisai_date, slot)
) WITHOUT ROWID;
