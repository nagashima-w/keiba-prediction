-- クラウド版(D1)の migration 0036: 変換の DO の目録の走査のための部分索引を足す(Issue #613。親は #594。調査は docs/investigations/db-usage-594.md の候補 2)。exe の SQLite には無い、D1 専用の索引。
-- migration は追加のみ(既存の表・列を壊さない。索引を足すだけなので、反映までの旧 Worker にも影響しない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES の race_archive)も同時に直す。
-- ★索引の WHERE は、cloud/src/race-archive-repository.ts の SELECT_CATALOG_PENDING_PAGE_SQL(未変換だけを引く走査)の WHERE と同じ形でなければならない。
--   形が違うと SQLite は部分索引を使わず、目録の全行を読む(cloud/test/race-archive-runs-index.test.ts が両者を照らす)。
--
-- 目的: 未変換(runs_version が NULL)の目録の行だけを索引に入れ、変換の DO が毎周、目録の全行(2,264 行)を読み直さずに済むようにする。
--   書き込みの増分: 作成時は未変換の行の数。以後はレースを目録に入れるたび +1 行(未変換で入るため)。変換して索引から外れるときは +0 行(手元のローカル D1 の rows_written の実測。本番の数え方は公開後の rows_written で確かめる。Issue #626)。
CREATE INDEX IF NOT EXISTS idx_race_archive_runs_pending ON race_archive (race_id) WHERE runs_version IS NULL;
