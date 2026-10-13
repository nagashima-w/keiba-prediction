-- クラウド版(D1)の migration 0015: 月報の表(Issue #265・#279)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。

-- 1 か月 1 行(月 YYYYMM が主キー。1 か月 1 回で確定し、通常の保存は上書きしない。上書きは管理者の作り直し〈Issue #280〉だけが、文章のある前の月報を文章の無い記録で潰さない条件つきの UPSERT 1 文で行う)。月報の組み立て・形は cloud/src/monthly-report-core.ts。
-- 列の意味は daily_reports(0010)と同じ(開催日 → 月)。
--   month          月(YYYYMM。JST の暦)
--   created_at     作成時刻(ISO 8601 UTC)
--   model          文章(または読めなかった応答の生の文章)を書いた LLM のモデル。文章が無い月報〈キー未登録・LLM が 2 回とも失敗〉は NULL
--   race_count     月報に載せたレース数(その月の分析をレースごとに最新の 1 件に絞った数)
--   total_stake    判定できた買い目の賭け金の合計(円)
--   total_return   判定できた買い目の払戻の合計(円)
--   summary        LLM の総括(一覧と Discord の要約に使う)。文章が無ければ NULL。応答が読めなかったときは生の文章の先頭 300 字
--   body_json      月報の本文(統計・日ごとの行・版ごとの行・LLM の文章〈narrative: summary/good/improve/outlook〉・生の文章・文章が無い理由・プロンプトの版。MonthlyReportBody)。画面が読む
--   llm_calls_json LLM を呼んだ 1 回ごとの記録(最大 2 回)。呼ばなかったときは NULL
CREATE TABLE monthly_reports (
  month TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT,
  race_count INTEGER NOT NULL,
  total_stake INTEGER NOT NULL,
  total_return INTEGER NOT NULL,
  summary TEXT,
  body_json TEXT NOT NULL,
  llm_calls_json TEXT
);
