/**
 * 空の殻の Durable Object `CloudMigration`(Issue #394〈#390 D-2〉)。**何もしない。呼ぶコードも、binding も無い。**
 *
 * もとは exe から移したファイルの取り込みの DO(Issue #216〈#167-B1〉)だった。移行は #167 で完了し、機能を廃止した(#394。ユーザー決定 2026-10-19)ので、
 * 取り込みのコード・API・画面・形式の検証は削除した。
 *
 * **クラスだけを残している理由**: 本番には、この DO の namespace(wrangler.toml の migration v3〈`new_sqlite_classes = ["CloudMigration"]`〉で作られた)と、
 * その保存データ(単一インスタンス `main` の kv 3 キー: 取り込みの状態・当日の予算・詳細が未完了の分析の記憶)が残っている。
 * クラスを消すには `deleted_classes` の migration が要り、**それは本番の DO と保存データを不可逆に消す**(Cloudflare のドキュメント:「Running a Delete migration will delete
 * all Durable Objects associated with the deleted class, including all of their stored data」。デプロイ後は、その版より前へのロールバックもできない)。
 * そのため、このタスクでは消さず、**殻として残す**(完全に可逆。戻したければクラスを元に戻すだけ)。
 *
 * **完全削除(`deleted_classes`)は、別の Issue で、ユーザーの明示の承認を得てから行う。** 承認が出たら、この殻・`worker.ts` と `smoke-worker.ts` の export・
 * wrangler.toml の v3 の説明を消し、`[[migrations]]` に新しい tag で `deleted_classes = ["CloudMigration"]` を足す(`scripts/test/cloud-config-guard.test.ts` の
 * 「`deleted_classes` を使わない」検査も、その Issue で直す)。
 */
import { DurableObject } from "cloudflare:workers";

export class CloudMigration extends DurableObject {}
