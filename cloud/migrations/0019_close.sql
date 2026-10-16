-- クラウド版(D1)の migration 0019: 締切の直前の再計算の結果(Issue #338〈#335-A1〉)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。分析時の提案の行〈analysis_allocation_meta・analysis_bets〉は上書きしない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。
-- ★デプロイの順序: この表を読み書きする新しい Worker は、migration の適用より前に出してはならない(deploy-cloud.yml は migration を wrangler deploy より前に適用する)。
--   表が無い間の読み出し(GET /api/analyses/{id})は、再計算の結果なし(null)に落とす。書き込みの失敗は DO が再試行し、尽きたら諦める(分析は止まらない)。
--
-- 発走前の分析が保存されたあと、発走の 5 分前(回 1)と 2 分前(回 2。暫定値)に、オッズだけを取り直し、確率は分析時のまま(LLM は呼ばない)で EV と配分を作り直す。
-- 1 回ぶんの結果が、(分析 id, 回)で 1 行。再計算できなかった回(failed)・行わなかった回(skipped)も、理由つきで 1 行を残す。
--
-- analysis_close: 回ごとの結果。
--   round                  回の番号(1 = 発走 5 分前、2 = 発走 2 分前〈暫定〉)
--   status                 ok = 再計算できた / failed = 失敗 / skipped = 行わなかった
--   reason                 ok のとき NULL。固定の語彙: failed = analysis-failed・fetch-failed・horse-set-mismatch・compute-failed・blocked / skipped = too-late・unset・nar-unsupported
--   due_at                 本来起こすはずだった時刻(ISO 8601 の UTC。発走 − リード)
--   fired_at               実際に動き始めた時刻(ISO 8601 の UTC)
--   late_ms                起床の遅れ(fired_at − due_at のミリ秒)
--   odds_official_datetime 取り直したオッズの netkeiba 側の時刻(official_datetime。ok のときだけ)
--   route 以降 17 列        配分のメタ。ok のときだけ入る(analysis_allocation_meta の、画面が読む 17 列と同じ名前・同じ意味。分析時の提案とは別の値になりうる)
CREATE TABLE analysis_close (
  analysis_id INTEGER NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 1),
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  reason TEXT,
  due_at TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  late_ms INTEGER NOT NULL,
  odds_official_datetime TEXT,
  route TEXT,
  unavailable_reason TEXT,
  fallback_reason TEXT,
  skip_reason_code TEXT,
  bankroll REAL,
  per_race_cap REAL,
  kelly_fraction REAL,
  ev_threshold REAL,
  include_combo_odds INTEGER,
  include_wide INTEGER,
  include_trio INTEGER,
  include_quinella INTEGER,
  include_exacta INTEGER,
  include_trifecta INTEGER,
  include_bracket_quinella INTEGER,
  bet_unit INTEGER,
  odds_status TEXT,
  PRIMARY KEY (analysis_id, round),
  FOREIGN KEY (analysis_id) REFERENCES analyses (id)
);

-- analysis_close_bets: ok の回の買い目(stake > 0 の行だけ。analysis_bets と同じ形・同じ意味)。
CREATE TABLE analysis_close_bets (
  analysis_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  bet_type TEXT NOT NULL,
  combo_key TEXT NOT NULL,
  stake INTEGER NOT NULL,
  odds REAL,
  ev REAL,
  PRIMARY KEY (analysis_id, round, bet_type, combo_key),
  FOREIGN KEY (analysis_id, round) REFERENCES analysis_close (analysis_id, round)
);
