-- 結果の補完のレース単位の状態の表(Issue #597。#594-1)。追加のみ(既存の表・列は変えない)。
-- 補完の列挙・件数の SQL が分析の表の全部を毎回読んでいた(D1 の読み取りの約 6 割)のを、未完了の行だけの部分索引から読む形に替える。
-- 状態の導出の式は cloud/src/race-backfill-state.ts の raceBackfillStateSelect('') と同じ文字列(テストが一致を固定する)。
-- st1〜st4: 0 = 条件が偽 / 1 = 対象(未完了)/ 2 = 条件は真のままだが済み・諦め(DO の記録の写し。初回の写しは DO が行う)。

CREATE TABLE race_backfill (
  race_id TEXT PRIMARY KEY,
  kaisai_date TEXT,
  sm INTEGER NOT NULL DEFAULT 0,
  st1 INTEGER NOT NULL DEFAULT 0,
  st2 INTEGER NOT NULL DEFAULT 0,
  st3 INTEGER NOT NULL DEFAULT 0,
  st4 INTEGER NOT NULL DEFAULT 0
);

-- 部分索引: 状態が 0 でない行だけ(未完了と済み・諦め)。クエリ側にも `stN > 0` を書く(SQLite は `stN = 1` だけでは部分索引を使わない)。
-- kaisai_date DESC・race_id 昇順の並びで、列挙は索引の先頭から LIMIT 件で止まる。
CREATE INDEX idx_race_backfill_st1 ON race_backfill (st1, kaisai_date DESC, race_id) WHERE st1 > 0;
CREATE INDEX idx_race_backfill_st2 ON race_backfill (st2, kaisai_date DESC, race_id) WHERE st2 > 0;
CREATE INDEX idx_race_backfill_st3 ON race_backfill (st3, kaisai_date DESC, race_id) WHERE st3 > 0;
CREATE INDEX idx_race_backfill_st4 ON race_backfill (st4, kaisai_date DESC, race_id) WHERE st4 > 0;

-- 初期の投入: 既存の全レースの状態を作る(済み・諦めの写しは DO の初回の起動が行う)。
INSERT INTO race_backfill (race_id, kaisai_date, sm, st1, st2, st3, st4)
SELECT race_id, kaisai_date, sm, st1, st2, st3, st4 FROM (SELECT a.race_id AS race_id, MIN(a.kaisai_date) AS kaisai_date,
             CASE WHEN EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.finish_position IS NULL AND r.scratched IS NULL) THEN 1 ELSE 0 END AS sm,
             CASE WHEN NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id) THEN 1 ELSE 0 END AS st1,
             CASE WHEN EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id) AND (NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.win_odds IS NOT NULL) OR EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.finish_position IS NULL AND r.scratched IS NULL)) THEN 1 ELSE 0 END AS st2,
             CASE WHEN EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id) AND MAX(CASE WHEN a.race_class IS NULL THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS st3,
             CASE WHEN EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id) AND NOT EXISTS (SELECT 1 FROM race_results r WHERE r.race_id = a.race_id AND r.win_payout IS NOT NULL) THEN 1 ELSE 0 END AS st4
      FROM analyses a 
      GROUP BY a.race_id);
