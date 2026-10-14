-- クラウド版(D1)の migration 0010: 日報の表(Issue #235)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。

-- 1 日 1 行(開催日が主キー。1 日 1 回で確定し、上書きしない)。日報の組み立て・形は cloud/src/daily-report-core.ts。
--   kaisai_date    開催日(YYYYMMDD)
--   created_at     作成時刻(ISO 8601 UTC)
--   model          文章を書いた LLM のモデル。文章が無い(キー未登録・LLM の失敗)日報は NULL
--   race_count     日報に載せたレース数(その日の分析をレースごとに最新の 1 件に絞った数)
--   total_stake    判定できた買い目の賭け金の合計(円)
--   total_return   判定できた買い目の払戻の合計(円)
--   summary        LLM の総括(一覧と Discord の要約に使う)。文章が無ければ NULL
--   body_json      日報の本文(統計・レースごとの行・LLM の文章。ReportBody)。画面が読む
--   llm_calls_json LLM を呼んだ 1 回ごとの記録(analyses.llm_calls_json と同じ形)。呼ばなかったときは NULL
CREATE TABLE daily_reports (
  kaisai_date TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT,
  race_count INTEGER NOT NULL,
  total_stake INTEGER NOT NULL,
  total_return INTEGER NOT NULL,
  summary TEXT,
  body_json TEXT NOT NULL,
  llm_calls_json TEXT
);
