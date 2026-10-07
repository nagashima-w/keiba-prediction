-- クラウド版(D1)の migration 0004: 設定の表(Issue #178・#164-c)。exe の SQLite には無い、D1 専用の表。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES)も同時に直す。

-- 設定は id = 1 の1行だけ(CHECK で固定)。settings_json は cloud/src/settings.ts の CloudSettings(項目・既定値・検証はそちら)。
-- 行が無ければ、全項目が既定値(exe の既定値と同じ)。値は `GET`/`POST /api/settings`(Issue #189)で編集する(直接の UPDATE でもよい)。
CREATE TABLE cloud_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
