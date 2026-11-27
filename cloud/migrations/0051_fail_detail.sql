-- クラウド版(D1)の migration 0051: JRA の取得の失敗の詳細の列 fail_detail を、odds_snapshots と baba_fetch_attempts に足す(Issue #804)。D1 専用の表。
-- migration は追加のみ(ADD COLUMN の 2 文だけ。既存の列・行は変わらない。反映までの間は旧 Worker が動くが、旧 Worker の INSERT・UPDATE はこの列を使わないので壊れない)。
-- ★ここを変えるときは、scripts/test/cloud-d1-schema.test.ts の「宣言した追加分」(D1_EXTRA_TABLES の odds_snapshots・baba_fetch_attempts)も同時に直す。
-- ★デプロイの順序: この列を書く新しい Worker は、migration の適用より前に出してはならない(deploy-cloud.yml は migration を wrangler deploy より前に適用する。列が無い間は保存が失敗する)。
-- 書くのは cloud/src/odds-snapshot-repository.ts(INSERT。追記だけの決まりは 0046 のまま)と cloud/src/baba-repository.ts(枠の行の UPDATE。既存の 1 文に列を足すだけ)。
--
-- fail_detail: 取れなかったときの詳細(短い JSON。NULL = 詳細なし)。**既存の status・reason・result の値と意味は変えない**(探索・画面・テストが読む)。固定の鍵と語だけで、例外の文面・URL・応答の本文・ヘッダの値は入らない。
--   形: {"p": 頁, "k": 種類, "h": HTTP の状態(あれば), "c": 拠点(あれば)}。鍵の順は p・k・h・c。例: {"p":"tanpuku","k":"blocked","h":403,"c":"NRT"}
--   p(頁): odds_snapshots は tanpuku(単勝・複勝。必須の頁)・discover(開催選択・レース選択。場・レースのリンクを拾う取得)・unknown / baba_fetch_attempts は cushion・moist・access・course(最初に失敗した頁)
--   k(種類。固定の語): dns(名前の解決。workerd の例外 `internal error`)・reset(接続の拒否・切断・TLS。workerd の例外 `Network connection lost`。三つは区別できない)・timeout・
--     blocked(HTTP 403 で、JRA の手前の配信の防御〈Akamai〉による拒否の形。server ヘッダが Akamai、または本文の先頭 2KB に Access Denied と edgesuite)・
--     cf-NNNN(Cloudflare 自身のエラー応答。本文が `error code: NNNN` で、NNNN は 4 桁。例 cf-1016)・http(それ以外の HTTP の失敗)・redirect・too-large・unknown(語彙に無いもの・詳細が取れなかったもの)
--   h: HTTP の応答が来たときの状態(100〜599)。応答が来る前の失敗(dns・reset・timeout)は無い
--   c: 取得した Cloudflare の拠点の 3 文字のコード(例 NRT)。**その日の最初の JRA の取得のときの拠点**(DO が 1 日 1 回 cdn-cgi/trace から読む。その日のうちに DO の場所が変わっても同じ値)。取れなければ無い
--   書くのは取れなかった行だけ: odds_snapshots は status = 'failed' の行(ok・skipped と、0050 までの古い行は NULL)/ baba_fetch_attempts は result が ok でなく、JRA のページの取得(通信・HTTP)の失敗が分かった枠の行(取得の失敗が無い shape-mismatch・no-today-venues の枠と、取得口の例外は NULL。result が ok の枠は、開催情報などの取得の失敗があっても NULL)
--   見方の例: SELECT race_id, lead_min, reason, fail_detail FROM odds_snapshots WHERE status = 'failed'; / SELECT kaisai_date, slot, result, fail_detail FROM baba_fetch_attempts WHERE fail_detail IS NOT NULL;
ALTER TABLE odds_snapshots ADD COLUMN fail_detail TEXT;
ALTER TABLE baba_fetch_attempts ADD COLUMN fail_detail TEXT;
