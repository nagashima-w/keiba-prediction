-- クラウド版(D1)の migration 0001: exe の最終スキーマ(new AnalysisStore() 後の sqlite_master のダンプ)。
-- ★このファイルは scripts/gen-cloud-d1-migration.ts が生成する。手で編集しない(exe のスキーマが変わったら、スクリプトを再実行する)。
-- D1 専用の追加分は 0002_d1.sql にある。migration は追加のみ(既存の表・列を壊さない)。

CREATE TABLE analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        race_id TEXT NOT NULL,
        analyzed_at TEXT NOT NULL,
        ev_estimated INTEGER,
        prompt_version TEXT,
        additional_instruction TEXT,
        kaisai_date TEXT,
        model TEXT,
        raw_response TEXT,
        race_snapshot_json TEXT,
        history_cutoff_date TEXT,
        prompt_lookahead_guarded INTEGER
      );

CREATE TABLE analysis_allocation_meta (
        analysis_id INTEGER PRIMARY KEY,
        route TEXT NOT NULL,
        unavailable_reason TEXT,
        fallback_reason TEXT,
        skip_reason_code TEXT,
        combo_odds_wide TEXT,
        combo_odds_trio TEXT,
        bankroll REAL NOT NULL,
        per_race_cap REAL NOT NULL,
        kelly_fraction REAL NOT NULL,
        ev_threshold REAL NOT NULL,
        include_combo_odds INTEGER NOT NULL,
        include_wide INTEGER NOT NULL,
        include_trio INTEGER NOT NULL,
        include_quinella INTEGER,
        include_exacta INTEGER,
        include_trifecta INTEGER,
        include_bracket_quinella INTEGER,
        bet_unit INTEGER,
        greedy_steps INTEGER,
        candidate_cap INTEGER,
        model_id TEXT,
        model_approximate INTEGER,
        odds_status TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analyses (id)
      );

CREATE TABLE analysis_bets (
        analysis_id INTEGER NOT NULL,
        bet_type TEXT NOT NULL,
        combo_key TEXT NOT NULL,
        stake INTEGER NOT NULL,
        odds REAL,
        ev REAL,
        PRIMARY KEY (analysis_id, bet_type, combo_key),
        FOREIGN KEY (analysis_id) REFERENCES analyses (id)
      );

CREATE TABLE analysis_horses (
        analysis_id INTEGER NOT NULL,
        umaban INTEGER NOT NULL,
        prior REAL NOT NULL,
        adjusted_prob REAL NOT NULL,
        place_odds_min REAL,
        ev REAL,
        is_positive INTEGER NOT NULL,
        contributions_json TEXT,
        mark TEXT,
        reason TEXT,
        PRIMARY KEY (analysis_id, umaban),
        FOREIGN KEY (analysis_id) REFERENCES analyses (id)
      );

CREATE TABLE race_combo_payout_imports (
        race_id TEXT NOT NULL,
        bet_type TEXT NOT NULL,
        PRIMARY KEY (race_id, bet_type)
      );

CREATE TABLE race_combo_payouts (
        race_id TEXT NOT NULL,
        bet_type TEXT NOT NULL,
        combo_key TEXT NOT NULL,
        payout INTEGER NOT NULL,
        PRIMARY KEY (race_id, bet_type, combo_key)
      );

CREATE TABLE race_result_meta (
        race_id TEXT PRIMARY KEY,
        course_type TEXT
      );

CREATE TABLE race_results (
        race_id TEXT NOT NULL,
        umaban INTEGER NOT NULL,
        finish_position INTEGER,
        place_payout REAL,
        win_payout REAL, passing_json TEXT, last3f REAL,
        PRIMARY KEY (race_id, umaban)
      );

CREATE INDEX idx_analyses_race
        ON analyses (race_id);
