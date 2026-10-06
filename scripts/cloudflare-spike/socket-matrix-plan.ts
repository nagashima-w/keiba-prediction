/**
 * #162 段階1(socket-matrix)の送信の計画。実ネットワークにも Workers のランタイムにも依存しない純ロジック。
 *
 * 目的: **Durable Object の中から**、TCP ソケットで netkeiba の各取得先を取得できるかを測る
 * (#160 の E3 は通常の Worker のハンドラからだった)。変えるのは取得の場所(通常 Worker → DO)と、
 * 最後の gzip 2 本の `Accept-Encoding: gzip` だけで、ヘッダは E3 と同じ集合(`STATIC_SOCKET_HEADERS`)。
 *
 * netkeiba へ出すのは 9 本(上限 10 本以内。予備 1 本)。順序の設計:
 *  - **ホストを交互にする**(race → db → nar → …): 400/403/429 が2回連続して打ち切りになっても、別のホストの結果が
 *    少なくとも1本は残るようにするため(#159 と同じ配慮)。
 *  - **gzip は最後に回す**: `Accept-Encoding` の追加が拒否の引き金になっても、identity の結果を汚さない。
 *  - **再現性の2本目(S1r)は、1本目(S1)から 6 本後**に置く(2 秒間隔なら 12 秒以上あく)。
 */

import { parseRaceId } from "../../packages/core/src/scraper/ids.js";
import { trioOddsApiUrl, narOddsPageUrl } from "../../packages/core/src/scraper/urls.js";
import type { HeaderEntry } from "./http1.js";
import { buildTargets, type NetkeibaTarget } from "./targets.js";

export type MatrixVariant = "identity" | "gzip";

/**
 * 各ステップの役割。
 *  - reference: #160 の E3(通常 Worker のソケット)と同じ対象。(a)「DO の中からでも同じ出馬表が取れるか」の基準
 *  - coverage: (b) 取得先の網羅
 *  - repeat: (d) 同じ URL の2回目(1回の実行の中の再現性)
 *  - compression: (c) `Accept-Encoding: gzip` を付けた版(identity の対と比べる)
 */
export type MatrixRole = "reference" | "coverage" | "repeat" | "compression";

export interface MatrixStep {
  /** ステップ ID(実行の中で一意)。 */
  readonly id: string;
  readonly variant: MatrixVariant;
  readonly role: MatrixRole;
  /** 比べる相手のステップ ID(repeat・compression のとき)。 */
  readonly pairWith: string | null;
  readonly target: NetkeibaTarget;
}

/**
 * #160 E3(通常 Worker のソケット)で取れた出馬表(`central-shutuba`)の本文のバイト数。
 * 出典: `docs/investigations/cloudflare-spike/round3-result.json` の `origin.records`(experiment=E3・targetId=central-shutuba)の
 * `bodyLength`。この値の一致は単体テストで固定してある(転記ではなく、リポジトリから再現できる値)。
 */
export const REFERENCE_E3_SHUTUBA_BYTES = 276708;

/** Worker から DO を呼ぶ回数(Free の subrequest 上限 50 を超える 51 回以上が要る)。netkeiba へは出ない。 */
export const SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT = 60;

function targetById(id: string): NetkeibaTarget {
  const target = buildTargets().find((t) => t.id === id);
  if (target === undefined) {
    throw new Error(`測定対象が見つかりません: ${id}`);
  }
  return target;
}

/** 送信の計画(netkeiba へ 9 本)。URL は core の URL ビルダが作る(再実装しない)。 */
export function buildSocketMatrixPlan(): MatrixStep[] {
  const central = parseRaceId("202603020211");
  const nar = parseRaceId("202654071210");
  const shutuba = targetById("central-shutuba");
  const trio: NetkeibaTarget = {
    id: "central-trio-odds",
    url: trioOddsApiUrl(central),
    kind: "combo-trio-json",
    encoding: "utf-8",
  };
  const narOdds: NetkeibaTarget = {
    id: "nar-odds-page",
    url: narOddsPageUrl(nar),
    kind: "nar-odds-page",
    encoding: "utf-8",
  };
  return [
    { id: "S1", variant: "identity", role: "reference", pairWith: null, target: shutuba },
    { id: "R1", variant: "identity", role: "coverage", pairWith: null, target: targetById("db-horse-results") },
    { id: "N1", variant: "identity", role: "coverage", pairWith: null, target: targetById("nar-shutuba") },
    { id: "O1", variant: "identity", role: "coverage", pairWith: null, target: targetById("central-odds") },
    { id: "T1", variant: "identity", role: "coverage", pairWith: null, target: trio },
    { id: "N2", variant: "identity", role: "coverage", pairWith: null, target: narOdds },
    { id: "S1r", variant: "identity", role: "repeat", pairWith: "S1", target: shutuba },
    { id: "S1g", variant: "gzip", role: "compression", pairWith: "S1", target: shutuba },
    { id: "T1g", variant: "gzip", role: "compression", pairWith: "T1", target: trio },
  ];
}

/**
 * ドライバが DO の `/do/netkeiba-socket` へ送る本文を組み立てる。**gzip の opt-in は、ステップの方式(variant)からここで決める**
 * (identity のステップには `acceptEncoding` のキー自体を付けない)。ヘッダには Accept-Encoding を入れない(Worker の入力検査が拒否する)。
 */
export function buildMatrixSocketBody(step: MatrixStep, headers: readonly HeaderEntry[]): Record<string, unknown> {
  return {
    targetId: step.target.id,
    url: step.target.url,
    kind: step.target.kind,
    encoding: step.target.encoding,
    headers: headers.map((h) => ({ name: h.name, value: h.value })),
    ...(step.variant === "gzip" ? { acceptEncoding: "gzip" } : {}),
  };
}
