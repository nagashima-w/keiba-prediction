-- クラウド版(D1)の migration 0034: 検証の画面の未確定の一覧のための部分索引を足す(Issue #600。親は #594)。exe の SQLite には無い、D1 専用の索引。
-- migration は追加のみ(既存の表・列を壊さない。索引を足すだけなので、反映までの旧 Worker にも影響しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_INDEXES の analyses)も同時に直す。
-- ★索引の WHERE は、cloud/src/verify-store.ts の PENDING_PREDICATE(PENDING_SQL の WHERE)と同じ形でなければならない。
--   形が違うと SQLite は部分索引を使わず、未確定の一覧が分析の表のほぼ全部を読む(cloud/test/verify-pending-index.test.ts が両者を照らす)。
--
-- 目的: 未確定(発走時刻か条件の印が NULL)の分析だけを索引に入れ、一覧の SQL が未確定の行だけを読むようにする。
--   書き込みの増分: 作成時は未確定の行の数(本番で 66 行)。以後は分析を保存するたび 1 行(未確定で入るため)と、確定したとき 1 行(索引から外れる)。
CREATE INDEX IF NOT EXISTS idx_analyses_pending ON analyses (id) WHERE start_time IS NULL OR cond_read IS NULL;
