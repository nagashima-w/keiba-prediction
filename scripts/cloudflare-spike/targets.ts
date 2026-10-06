/**
 * 到達性の測定対象(Issue #159〈#21-A〉)。URL は core の URL ビルダが作る(再実装しない)。
 *
 * 合計 5 本(race.netkeiba.com 2本・db.netkeiba.com 2本・nar.netkeiba.com 1本)。
 * 1回の実行の上限 {@link MAX_NETKEIBA_REQUESTS} 本以内に収まる(余白 5 本)。
 * レース・馬は保存済みフィクスチャと同じ ID(`fixtures/shutuba_202603020211.html` 等)を使う。
 */

// バレル(@keiba/core)ではなく個別ファイルを import する: このファイルは Worker にもバンドルされ、
// バレルは better-sqlite3 等のネイティブ依存を巻き込むため。
import type { ProbeSource } from "./reachability.js";
import { parseHorseId, parseRaceId } from "../../packages/core/src/scraper/ids.js";
import {
  horseResultsApiUrl,
  horseUrl,
  oddsApiUrl,
  shutubaUrl,
} from "../../packages/core/src/scraper/urls.js";

/**
 * 取得対象の種類(どのパーサで読むか)。`combo-trio-json`(三連複のオッズ JSON)と `nar-odds-page`(地方の単勝・
 * 複勝オッズのページ)は、#162 段階1(socket-matrix)で足した。
 */
export type TargetKind =
  | "shutuba"
  | "odds-json"
  | "horse-page"
  | "horse-results"
  | "combo-trio-json"
  | "nar-odds-page";

/** 取得対象の種類の一覧(Worker の入力検査が使う)。 */
export const TARGET_KINDS: readonly TargetKind[] = [
  "shutuba",
  "odds-json",
  "horse-page",
  "horse-results",
  "combo-trio-json",
  "nar-odds-page",
];

export interface NetkeibaTarget {
  readonly id: string;
  readonly url: string;
  readonly kind: TargetKind;
  /** デコードに使うエンコーディング。db.netkeiba.com の馬ページだけ EUC-JP。 */
  readonly encoding: "utf-8" | "euc-jp";
}

/** Worker が取得を許すホスト(共有秘密を持っていても、これ以外へは出さない)。 */
export const ALLOWED_HOSTS: readonly string[] = [
  "race.netkeiba.com",
  "db.netkeiba.com",
  "nar.netkeiba.com",
];

/** https で、許可ホストの URL だけを許す(ユーザー情報付き・別ホスト・http は拒否)。 */
export function isAllowedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    ALLOWED_HOSTS.includes(parsed.hostname)
  );
}

/**
 * 到達性の測定対象を返す。**ホストが交互になる順(race → db → nar → race → db)**にしてある:
 * 400/403/429 が2回連続して打ち切りになっても、別のホストの結果が少なくとも1本は残るようにするため。
 */
export function buildTargets(): NetkeibaTarget[] {
  const centralRace = parseRaceId("202603020211");
  const narRace = parseRaceId("202654071210");
  const horse = parseHorseId("2021105857");
  return [
    { id: "central-shutuba", url: shutubaUrl(centralRace), kind: "shutuba", encoding: "utf-8" },
    // db.netkeiba.com の馬ページは EUC-JP(fixture-plan.ts も encoding を明示している)。
    { id: "db-horse-page", url: horseUrl(horse), kind: "horse-page", encoding: "euc-jp" },
    { id: "nar-shutuba", url: shutubaUrl(narRace), kind: "shutuba", encoding: "utf-8" },
    { id: "central-odds", url: oddsApiUrl(centralRace), kind: "odds-json", encoding: "utf-8" },
    { id: "db-horse-results", url: horseResultsApiUrl(horse), kind: "horse-results", encoding: "utf-8" },
  ];

}

export interface PlannedRequest {
  readonly source: ProbeSource;
  readonly target: NetkeibaTarget;
}

/**
 * 実際に送る順序(Issue #159 第2ラウンド。Worker とランナーの対照)。対象ごとに「Worker → ランナー」の
 * 順で、**同じ対象(同じ URL・同じ設定)を連続して**送る。変えるのは送信元だけ。合計は対象数の2倍=
 * 1回の実行の上限(10本)ちょうど。
 */
export function buildRequestPlan(): PlannedRequest[] {
  const plan: PlannedRequest[] = [];
  for (const target of buildTargets()) {
    plan.push({ source: "worker", target }, { source: "runner", target });
  }
  return plan;
}
