-- クラウド版(D1)の migration 0007: LLM 呼び出しの記録(Issue #197・#196-a の段2)。exe の SQLite には無い、D1 専用の列。
-- migration は追加のみ(既存の表・列を壊さない。反映までの間は旧 Worker が動くため。旧い行は NULL のまま)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_COLUMNS)も同時に直す。

-- 発走前の分析で LLM を呼んだ**1回ごと**の記録(JSON 配列の文字列。1件 = ok・ms〈所要時間〉・inputTokens・outputTokens〈thinking を含む〉・stopReason・model・replayed・error)。
-- 形と意味は cloud/src/llm-calls.ts の LlmCallRecord。プロンプト・応答の本文・鍵・エラーの本文は入れない(error は status=429・種別=timeout のような固定の説明だけ)。
-- NULL は「記録なし」(LLM を呼ばなかった=キー未登録、または LLM の記録を導入する前の分析)。公開後に、費用・時間・切り詰めを確かめるための列。
ALTER TABLE analyses ADD COLUMN llm_calls_json TEXT;
