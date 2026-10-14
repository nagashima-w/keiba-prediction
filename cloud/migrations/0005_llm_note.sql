-- クラウド版(D1)の migration 0005: LLM が使われなかった・一部しか使われなかった理由(Issue #194・#179-b)。exe の SQLite には無い、D1 専用の列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS)も同時に直す。

-- 画面に出す理由の**固定文言**(cloud/src/llm-run.ts の `LLM_NOTE_*` と、core の `FALLBACK_REASON_*`)。API のエラーの本文は入れない。
-- NULL は「理由なし」(LLM が問題なく効いた、または LLM を導入する前の分析)。LLM を使わなかった分析は、モデル欄(model)が NULL で、この列に理由が入る。
ALTER TABLE analyses ADD COLUMN llm_note TEXT;
