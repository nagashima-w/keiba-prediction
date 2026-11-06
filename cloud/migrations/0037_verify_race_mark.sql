-- クラウド版(D1)の migration 0037: 検証の差分の再計算のための「レースの変更の印」の表を足す(Issue #624。親は #616 の段階 1。設計は #616 の 11/6 のコメント)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない)。この段階では印を書くだけで、読む側(検証の画面・再計算)は変えない。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES の verify_race_mark)も同時に直す。
-- ★印を書く文は cloud/src/verify-race-mark.ts。検証が読む表に書く 8 つの経路の batch が、最後に流す(cloud/test/verify-write-guard.test.ts が経路の数と書き手のファイルを固定する)。
--
-- verify_race_mark: 検証が読む表(分析・結果・組合せ払戻・直前オッズの再判定)にそのレースの書き込みがあるたびに、そのレースの行を 1 行 upsert する。
--   seq: 書き込みごとに単調に増える通し番号(表の最大値 + 1)。読む側は「前回読んだ seq より大きい行」だけを見れば、変わったレースを索引で拾える。
--   kaisai_date: そのレースの分析の最小の開催日(分析がまだ無いレースは NULL。後から分析が入ると、次の印で埋まる)。
-- WITHOUT ROWID: 主キー(race_id)が行の実体になる(他の D1 専用の表と同じ。Issue #445)。
CREATE TABLE verify_race_mark (
  race_id TEXT PRIMARY KEY,
  kaisai_date TEXT,
  seq INTEGER NOT NULL
) WITHOUT ROWID;

-- 変わったレースを seq の順に読むための索引。
CREATE INDEX idx_verify_race_mark_seq ON verify_race_mark (seq);
