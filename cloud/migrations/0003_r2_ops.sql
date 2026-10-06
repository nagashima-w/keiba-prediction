-- クラウド版(D1)の migration 0003: R2 の操作回数のカウンタ(Issue #173・#169-c)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。

-- 月ごとの R2 の操作回数。ym は UTC の yyyymm(例: 202610)。
--   class_a: Class A の操作(PUT など。書き込み)の回数。保存の batch の中で +1 する(batch が失敗したらカウンタも増えない)
--   class_b: Class B の操作(GET など。読み出し)の回数。読み出しのたびに best-effort で +1 する
-- 柵の判定(無料枠の 10%)は cloud/src/r2-fence.ts。
CREATE TABLE r2_ops (
  ym INTEGER PRIMARY KEY,
  class_a INTEGER NOT NULL,
  class_b INTEGER NOT NULL
);
