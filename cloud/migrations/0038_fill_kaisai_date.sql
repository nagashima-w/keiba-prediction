-- クラウド版(D1)の migration 0038: 開催日(analyses.kaisai_date)が NULL の分析 11 件(7 レース)に開催日を埋める(Issue #630。ユーザーの決定・11/6)。
-- 追加・更新のみ(表・列は変えない)。行が 1 つも無い D1(手元・CI)でも失敗しない(UPDATE は 0 行、状態・印の upsert は空で終わる)。
-- 根拠(11/6 にメインが本番の D1 を SELECT だけで確かめた): 11 件とも 7/14〜15 に exe から移行した古い分析(exe_analysis_id あり)。分析の id は 5〜15。発走時刻(start_time)も空文字のまま(これは直さない)。
--  - 地方 4 レース(202630071511・202642071511・202648071511・202650071511。各 2 分析。id 5〜12): 地方のレース ID は日付を含むので 20260715。kaisaiDateFromNarRaceId(packages/core/src/scraper/ids.ts)と同じ読み方。
--  - 中央 3 レース(202605020411・202608030411・202604010211。各 1 分析。id 13〜15): 過去の結果の目録 race_archive.race_date が 2026-05-03 なので 20260503。
--  - kaisai_date の書式は YYYYMMDD(本番の既存の行で確認)。
-- ★別の行を書き換えないよう、分析の id とレース ID の両方で絞り、kaisai_date IS NULL の行だけを対象にする。
-- 書き換えたあと、その 7 レースの補完の状態(race_backfill)と検証の変更の印(verify_race_mark)を作り直す。
-- 文は cloud/src/race-backfill-state.ts の RECOMPUTE_RACES_SQL と cloud/src/verify-race-mark.ts の MARK_VERIFY_BY_ANALYSIS_IDS_SQL の ?1 を、状態は 7 レース ID、印は分析 ID 5〜15 の JSON 配列の文字列に替えただけ(印を分析 ID から引くのは、分析の行が無い D1 で印の行を作らないため)(cloud/test/migration-0038.integration.test.ts が一致を固定する)。

UPDATE analyses SET kaisai_date = '20260715'
WHERE kaisai_date IS NULL AND id BETWEEN 5 AND 12
  AND race_id IN ('202630071511', '202642071511', '202648071511', '202650071511');

UPDATE analyses SET kaisai_date = '20260503'
WHERE kaisai_date IS NULL AND id BETWEEN 13 AND 15
  AND race_id IN ('202605020411', '202608030411', '202604010211');

INSERT INTO race_backfill (race_id, kaisai_date, sm, st1, st2, st3, st4)
      SELECT race_id, kaisai_date, sm, st1, st2, st3, st4 FROM (SELECT a.race_id AS race_id, MIN(a.kaisai_date) AS kaisai_date,
             CASE WHEN rr.sm > 0 THEN 1 ELSE 0 END AS sm,
             CASE WHEN rr.n IS NULL THEN 1 ELSE 0 END AS st1,
             CASE WHEN rr.n IS NOT NULL AND (rr.odds = 0 OR rr.sm > 0) THEN 1 ELSE 0 END AS st2,
             CASE WHEN rr.n IS NOT NULL AND MAX(CASE WHEN a.race_class IS NULL THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS st3,
             CASE WHEN rr.n IS NOT NULL AND rr.payout = 0 THEN 1 ELSE 0 END AS st4
      FROM analyses a
      LEFT JOIN (SELECT race_id, COUNT(*) AS n,
                        SUM(CASE WHEN win_odds IS NOT NULL THEN 1 ELSE 0 END) AS odds,
                        SUM(CASE WHEN finish_position IS NULL AND scratched IS NULL THEN 1 ELSE 0 END) AS sm,
                        SUM(CASE WHEN win_payout IS NOT NULL THEN 1 ELSE 0 END) AS payout
                 FROM race_results WHERE race_id IN (SELECT value FROM json_each('["202630071511","202642071511","202648071511","202650071511","202605020411","202608030411","202604010211"]')) GROUP BY race_id) rr ON rr.race_id = a.race_id
      WHERE a.race_id IN (SELECT value FROM json_each('["202630071511","202642071511","202648071511","202650071511","202605020411","202608030411","202604010211"]'))
      GROUP BY a.race_id) WHERE true
      ON CONFLICT(race_id) DO UPDATE SET
        kaisai_date = excluded.kaisai_date, sm = excluded.sm,
        st1 = CASE WHEN excluded.st1 = 0 THEN 0 WHEN race_backfill.st1 = 2 THEN 2 ELSE 1 END, st2 = CASE WHEN excluded.st2 = 0 THEN 0 WHEN race_backfill.st2 = 2 THEN 2 ELSE 1 END, st3 = CASE WHEN excluded.st3 = 0 THEN 0 WHEN race_backfill.st3 = 2 THEN 2 ELSE 1 END, st4 = CASE WHEN excluded.st4 = 0 THEN 0 WHEN race_backfill.st4 = 2 THEN 2 ELSE 1 END
      WHERE race_backfill.kaisai_date IS NOT excluded.kaisai_date OR race_backfill.sm IS NOT excluded.sm
         OR race_backfill.st1 IS NOT (CASE WHEN excluded.st1 = 0 THEN 0 WHEN race_backfill.st1 = 2 THEN 2 ELSE 1 END) OR race_backfill.st2 IS NOT (CASE WHEN excluded.st2 = 0 THEN 0 WHEN race_backfill.st2 = 2 THEN 2 ELSE 1 END)
         OR race_backfill.st3 IS NOT (CASE WHEN excluded.st3 = 0 THEN 0 WHEN race_backfill.st3 = 2 THEN 2 ELSE 1 END) OR race_backfill.st4 IS NOT (CASE WHEN excluded.st4 = 0 THEN 0 WHEN race_backfill.st4 = 2 THEN 2 ELSE 1 END);

INSERT INTO verify_race_mark (race_id, kaisai_date, seq)
SELECT r.race_id, (SELECT MIN(kaisai_date) FROM analyses WHERE race_id = r.race_id), (SELECT COALESCE(MAX(seq), 0) FROM verify_race_mark) + r.n
FROM (SELECT race_id, ROW_NUMBER() OVER (ORDER BY race_id) AS n FROM (SELECT DISTINCT race_id FROM analyses WHERE id IN (SELECT value FROM json_each('[5,6,7,8,9,10,11,12,13,14,15]')))) r WHERE true
ON CONFLICT(race_id) DO UPDATE SET kaisai_date = excluded.kaisai_date, seq = excluded.seq;
