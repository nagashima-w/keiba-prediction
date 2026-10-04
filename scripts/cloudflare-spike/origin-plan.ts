/**
 * 400 の原因の切り分け(Issue #160〈#21-B〉)の計画・集約・結論。実ネットワークにも Workers のランタイムにも
 * 依存しない純ロジック。
 *
 * 実験(変数は1つずつ変える):
 *  - E0 基準の再確認: race の出馬表を Worker の fetch とランナーの fetch から(#159 と同じ 400 / 200 の再現)
 *  - E1 ヘッダの観測(netkeiba へは出ない。`echo.ts`)
 *  - E2 ランナー + Workers 風のヘッダ → netkeiba(送信元はランナーのまま、ヘッダだけを足す)
 *  - E3 Worker の TCP ソケット → netkeiba(送信元は Cloudflare のまま、fetch の自動ヘッダ・TLS の特徴が無くなる)
 *
 * **結果の読み**: 拒否と数えるのは blocked(400/403/429)と challenge だけ(`compareSources` と同じ)。
 * それ以外(通信エラー・想定外のステータス・パース失敗・転送)は判定不能として、拒否にも成功にも数えない。
 */

import { judgeReachability, type NetkeibaProbeRecord } from "./reachability.js";
import type { EchoService } from "./echo-targets.js";
import { buildTargets, type NetkeibaTarget } from "./targets.js";

export type OriginExperiment = "E0" | "E2" | "E3";
export type OriginPlace = "worker" | "runner";
/** 取得の手段。fetch+worker-headers は、ランナーの fetch に Workers 風のヘッダを足したもの。 */
export type OriginVia = "fetch" | "fetch+worker-headers" | "socket";
/** 連続拒否を数える単位(「場所:手段」)。手段(fetch / ソケット)も別の送信元として数える。 */
export type OriginSourceKey = "worker:fetch" | "runner:fetch" | "runner:fetch+worker-headers" | "worker:socket";

export const ORIGIN_SOURCE_KEYS: readonly OriginSourceKey[] = [
  "worker:fetch",
  "runner:fetch",
  "runner:fetch+worker-headers",
  "worker:socket",
];

export interface OriginStep {
  readonly experiment: OriginExperiment;
  readonly place: OriginPlace;
  readonly via: OriginVia;
  readonly sourceKey: OriginSourceKey;
  readonly target: NetkeibaTarget;
}

/** 1本の取得の記録(`NetkeibaProbeRecord` に、どの実験・どの場所・どの手段かを足したもの)。 */
export interface OriginRecord extends NetkeibaProbeRecord {
  readonly experiment: OriginExperiment;
  readonly place: OriginPlace;
  readonly via: OriginVia;
  readonly sourceKey: OriginSourceKey;
}

/** E2 / E3 が測る対象(race の出馬表と db の馬ページ。EUC-JP)。 */
const E2_E3_TARGET_IDS = ["central-shutuba", "db-horse-page"] as const;

/** 実験ごとの計画の本数。 */
export const PLANNED_COUNT: Readonly<Record<OriginExperiment, number>> = { E0: 2, E2: 2, E3: 2 };

function targetById(id: string): NetkeibaTarget {
  const target = buildTargets().find((t) => t.id === id);
  if (target === undefined) {
    throw new Error(`測定対象が見つかりません: ${id}`);
  }
  return target;
}

/**
 * 送信の計画(netkeiba へ 6 本)。E0 → E3 → E2 の順。E2 は E1 の結果(Worker にだけ現れたヘッダ)が必要だが、
 * E3 の結果には依存しない。
 */
export function buildOriginPlan(): OriginStep[] {
  const race = targetById(E2_E3_TARGET_IDS[0]);
  const steps: OriginStep[] = [
    { experiment: "E0", place: "worker", via: "fetch", sourceKey: "worker:fetch", target: race },
    { experiment: "E0", place: "runner", via: "fetch", sourceKey: "runner:fetch", target: race },
  ];
  for (const id of E2_E3_TARGET_IDS) {
    steps.push({ experiment: "E3", place: "worker", via: "socket", sourceKey: "worker:socket", target: targetById(id) });
  }
  for (const id of E2_E3_TARGET_IDS) {
    steps.push({
      experiment: "E2",
      place: "runner",
      via: "fetch+worker-headers",
      sourceKey: "runner:fetch+worker-headers",
      target: targetById(id),
    });
  }
  return steps;
}

export type Outcome = "good" | "bad" | "unknown";

function outcomeOfRecord(record: OriginRecord): Outcome {
  const { verdict } = judgeReachability(record);
  if (verdict === "ok") {
    return "good";
  }
  if (verdict === "blocked" || verdict === "challenge") {
    return "bad";
  }
  return "unknown";
}

/**
 * 実験の集約。計画の本数(plannedCount)がそろい、全対象が ok なら good、全対象が拒否なら bad。
 * それ以外(未実施・途中で止まった・判定不能が混じる・対象ごとに結果が違う)は unknown。
 */
export function outcomeOf(records: readonly OriginRecord[], experiment: OriginExperiment, plannedCount: number): Outcome {
  const mine = records.filter((r) => r.experiment === experiment);
  if (mine.length < plannedCount) {
    return "unknown";
  }
  const outcomes = mine.map(outcomeOfRecord);
  if (outcomes.every((o) => o === "good")) {
    return "good";
  }
  if (outcomes.every((o) => o === "bad")) {
    return "bad";
  }
  return "unknown";
}

/** E0 の再現: Worker の fetch が拒否され、ランナーの fetch が ok だった(#159 の 400 / 200)。 */
export function baselineReproduced(records: readonly OriginRecord[]): boolean {
  const worker = records.find((r) => r.experiment === "E0" && r.place === "worker");
  const runner = records.find((r) => r.experiment === "E0" && r.place === "runner");
  if (worker === undefined || runner === undefined) {
    return false;
  }
  return outcomeOfRecord(worker) === "bad" && outcomeOfRecord(runner) === "good";
}

export type OriginConclusion =
  | "baseline-not-reproduced"
  | "header-suspected"
  | "fetch-specific"
  | "ip-suspected"
  | "both-suspected"
  | "inconclusive";

/**
 * 結論(E0 の再現を前提ゲートにした、E2 × E3 の組合せ表)。
 *
 * | E2 \ E3 | good | bad | unknown |
 * |---|---|---|---|
 * | good | fetch-specific | ip-suspected | inconclusive |
 * | bad | header-suspected | both-suspected | header-suspected |
 * | unknown | fetch-specific | ip-suspected | inconclusive |
 *
 * E0 が再現しなかった場合は、E2・E3 の値にかかわらず baseline-not-reproduced(基準が再現しないと、
 * E3 の 200 は何も意味しない)。E3 が good なら、Cloudflare の IP から通ったことになるので、E2 に
 * かかわらず送信元(IP)の原因は否定できる。
 */
export function concludeOrigin(input: { baseline: boolean; e2: Outcome; e3: Outcome }): OriginConclusion {
  if (!input.baseline) {
    return "baseline-not-reproduced";
  }
  if (input.e2 === "bad" && input.e3 === "bad") {
    return "both-suspected";
  }
  if (input.e2 === "bad") {
    return "header-suspected";
  }
  if (input.e3 === "good") {
    return "fetch-specific";
  }
  if (input.e3 === "bad") {
    return "ip-suspected";
  }
  return "inconclusive";
}

/** 結果の読みに添える、E1 の観測の要約(TLS・HTTP バージョンの差)。 */
export interface E1Comparison {
  readonly observed: boolean;
  readonly service: EchoService | null;
  readonly workerHttpVersion: string | null;
  readonly runnerHttpVersion: string | null;
  readonly workerJa4: string | null;
  readonly runnerJa4: string | null;
}

export interface ConclusionReading {
  readonly summary: string;
  /** 結論の限界(分離できないもの・観測の限界)。 */
  readonly limitations: readonly string[];
}

const SUMMARIES: Readonly<Record<OriginConclusion, string>> = {
  "fetch-specific":
    "fetch に固有の要素(ヘッダ・TLS の特徴など)が原因で、ソケットで回避できる(Cloudflare の IP からでも、ソケットなら取得できた。送信元の IP が原因である可能性は低い)。",
  "header-suspected":
    "ヘッダが原因の疑いが強い(送信元をランナーのまま、Workers 風のヘッダを付けただけで拒否された)。",
  "ip-suspected":
    "送信元(IP)が原因の疑いが強い(Cloudflare の IP からは、fetch の自動ヘッダを無くしたソケットでも拒否された)。",
  "both-suspected":
    "判定不能: ヘッダを足したランナー(E2)もソケット(E3)も拒否された。ヘッダと送信元の両方が拒否に寄与している可能性があり、どちらか一方では説明できない。",
  "baseline-not-reproduced":
    "判定不能: 基準(E0: Worker の fetch は拒否、ランナーの fetch は ok)が今回の実行で再現しなかったため、E2・E3 の結果から原因を読まない。",
  inconclusive:
    "判定不能: E2・E3 の結果から原因を絞れなかった(通信エラー・想定外のステータス・対象ごとの結果の食い違い・未実施)。",
};

function transportLines(e1: E1Comparison): string[] {
  const lines: string[] = [];
  const hasTls = e1.observed && e1.service === "peet" && e1.workerJa4 !== null && e1.runnerJa4 !== null;
  if (!hasTls) {
    lines.push("TLS の指紋と HTTP バージョンは観測できていない(エコーが返さない、または E1 が取れなかった)。");
    return lines;
  }
  if (e1.workerHttpVersion !== e1.runnerHttpVersion) {
    lines.push(
      `HTTP バージョンも両側で違う(worker: ${e1.workerHttpVersion ?? "不明"} / runner: ${e1.runnerHttpVersion ?? "不明"})ので、分離できない要素に加わる。`,
    );
  } else {
    lines.push(`HTTP バージョンは E1 の範囲では両側で同じだった(${e1.workerHttpVersion ?? "不明"})。`);
  }
  if (e1.workerJa4 !== e1.runnerJa4) {
    lines.push(`TLS の指紋(JA4)が両側で違う(worker: ${e1.workerJa4} / runner: ${e1.runnerJa4})。`);
  } else {
    lines.push("TLS の指紋(JA4)は E1 の範囲では両側で同じだった。");
  }
  return lines;
}

/** 結論の文面と、必ず併記する限界を返す。 */
export function describeConclusion(conclusion: OriginConclusion, e1: E1Comparison): ConclusionReading {
  const limitations: string[] = [];
  if (conclusion === "fetch-specific") {
    limitations.push(
      "E3(ソケット)で変わったのは、fetch が付けるヘッダと fetch の TLS の特徴の両方であり、どちらが原因かは分離できない。",
    );
    limitations.push(
      "E2 は『Worker にだけ現れたヘッダの追加が、拒否を起こすのに十分か』だけを見ている。E2 が拒否でなくても、ヘッダの値・順序・大文字小文字・HTTP/2 は動かしていないので、ヘッダが原因でないとは言えない。",
    );
    limitations.push(...transportLines(e1));
  } else if (conclusion === "header-suspected") {
    limitations.push(
      "E2 は送信元(ランナー)を変えずに、Worker にだけ現れたヘッダをまとめて足した実験で、拒否された。どのヘッダが効いたかは絞っていない。",
    );
  } else if (conclusion === "ip-suspected") {
    limitations.push(
      "ソケットで自前に組んだリクエストの不備(ヘッダの欠落・順序・TLS)でも拒否されうるので、疑いにとどまる。",
    );
    limitations.push(...transportLines(e1));
  }
  limitations.push("各実験の対象は2対象(race の出馬表と db の馬ページ。E0 は race の1対象)で、標本が小さい。");
  limitations.push(
    "E1 はエコーサービス宛ての Worker の fetch が見せるヘッダ・TLS であり、CloudFront 宛てでも同じとは限らない。",
  );
  return { summary: SUMMARIES[conclusion], limitations };
}
