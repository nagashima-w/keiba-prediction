-- Issue #729(段階 A): 自前の集計(person_year)と、netkeiba から取って保存してある年度別成績(jockey_results・trainer_results)の突き合わせ。
-- ★本番の D1 は読むだけ(SELECT のみ)。実行はメイン: `wrangler d1 execute DB --remote --file ...` は 1 つのファイルに複数の文を書けるので、下の 2 つの文をそれぞれ流す
--   (または 2 つ目の文だけ流す。`-- ==== …` の行で 2 つに分かれる)。ローカルの検証は cloud/test/person-year-compare.test.ts。
--
-- 比べるのは**中央**(kind = 'central')の**確定した年**(下の BETWEEN の 2 つの年。2021〜昨年。進行中の今年は netkeiba の値が最大 7 日前で、自前の値は前夜までなので、一致を期待しない)。
-- netkeiba 側の行がある人だけを基準にする(person_year に無い人は「自前に無い」として出る)。逆向き(自前にあって netkeiba 側に無い人)は、netkeiba 側を取っていない人なので出さない。
-- 全走査: jockey_results・trainer_results は数百行の小さい表で、診断のための 1 回限りの読み(分析の経路ではない。docs/db-sql-rules.md の決まり 1 は起床・要求ごとの読み)。
--   person_year は主キー (person_kind, person_id, year) の引き。
--
-- status:
--   match            starts も placed も一致
--   diff             どちらかが違う(d_starts・d_placed = 自前 − netkeiba)
--   missing_own      自前(person_year)にその人・年の行が無い(netkeiba 側にはある)。差は自前を 0 として数える
-- ==== 詳細(一致しない行だけ。差の大きい順) ====
WITH ref AS (
  SELECT 'jockey' AS person_kind, j.jockey_id AS person_id,
         CAST(json_extract(e.value, '$[0]') AS INTEGER) AS year,
         CAST(json_extract(e.value, '$[1]') AS INTEGER) AS ref_starts,
         CAST(json_extract(e.value, '$[2]') AS INTEGER) AS ref_placed
  FROM jockey_results j, json_each(j.years_json) e
  WHERE j.kind = 'central'
  UNION ALL
  SELECT 'trainer', t.trainer_id,
         CAST(json_extract(e.value, '$[0]') AS INTEGER),
         CAST(json_extract(e.value, '$[1]') AS INTEGER),
         CAST(json_extract(e.value, '$[2]') AS INTEGER)
  FROM trainer_results t, json_each(t.years_json) e
  WHERE t.kind = 'central'
)
SELECT r.person_kind, r.person_id, r.year,
       r.ref_starts, p.starts AS own_starts, COALESCE(p.starts, 0) - r.ref_starts AS d_starts,
       r.ref_placed, p.placed AS own_placed, COALESCE(p.placed, 0) - r.ref_placed AS d_placed,
       CASE WHEN p.person_id IS NULL THEN 'missing_own' WHEN p.starts = r.ref_starts AND p.placed = r.ref_placed THEN 'match' ELSE 'diff' END AS status
FROM ref r
LEFT JOIN person_year p ON p.person_kind = r.person_kind AND p.person_id = r.person_id AND p.year = r.year
WHERE r.year BETWEEN 2021 AND 2025
  AND (p.person_id IS NULL OR p.starts <> r.ref_starts OR p.placed <> r.ref_placed)
ORDER BY ABS(COALESCE(p.starts, 0) - r.ref_starts) DESC, r.person_kind, r.person_id, r.year;
-- ==== 要約(種別 × 状態の件数と、差の合計) ====
WITH ref AS (
  SELECT 'jockey' AS person_kind, j.jockey_id AS person_id,
         CAST(json_extract(e.value, '$[0]') AS INTEGER) AS year,
         CAST(json_extract(e.value, '$[1]') AS INTEGER) AS ref_starts,
         CAST(json_extract(e.value, '$[2]') AS INTEGER) AS ref_placed
  FROM jockey_results j, json_each(j.years_json) e
  WHERE j.kind = 'central'
  UNION ALL
  SELECT 'trainer', t.trainer_id,
         CAST(json_extract(e.value, '$[0]') AS INTEGER),
         CAST(json_extract(e.value, '$[1]') AS INTEGER),
         CAST(json_extract(e.value, '$[2]') AS INTEGER)
  FROM trainer_results t, json_each(t.years_json) e
  WHERE t.kind = 'central'
)
SELECT r.person_kind,
       CASE WHEN p.person_id IS NULL THEN 'missing_own' WHEN p.starts = r.ref_starts AND p.placed = r.ref_placed THEN 'match' ELSE 'diff' END AS status,
       COUNT(*) AS n,
       SUM(COALESCE(p.starts, 0) - r.ref_starts) AS sum_d_starts,
       SUM(COALESCE(p.placed, 0) - r.ref_placed) AS sum_d_placed
FROM ref r
LEFT JOIN person_year p ON p.person_kind = r.person_kind AND p.person_id = r.person_id AND p.year = r.year
WHERE r.year BETWEEN 2021 AND 2025
GROUP BY r.person_kind, status
ORDER BY r.person_kind, status;
