-- クラウド版(D1)の migration 0002: D1 専用の追加分(exe の SQLite には無い)。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が新スキーマで動くため)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS・D1_EXTRA_INDEXES)も同時に直す。

-- 大きな列(race_snapshot_json・raw_response・馬ごとの contributions)を置く R2 オブジェクトのキー(#172 で使う)。
-- NULL は「R2 に詳細が無い」(安全柵・保存失敗)。
ALTER TABLE analyses ADD COLUMN detail_key TEXT;

-- 開催日で絞る一覧(#165)。
CREATE INDEX idx_analyses_kaisai_date ON analyses (kaisai_date);

-- 版別の分析済みレースの列挙(`WHERE prompt_version = ? ORDER BY race_id`。#166 の二重実行防止)。
-- 列の順は (prompt_version, race_id) でなければならない(等価比較の列を先頭にし、race_id の並びを索引から得る)。
CREATE INDEX idx_analyses_prompt_version_race ON analyses (prompt_version, race_id);
