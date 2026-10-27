/**
 * 貪欲法の刻み幅 `greedySteps` が、券種構成比・点数を左右する度合いの測り直し(Issue #36)。
 *
 * ## 経緯
 * 2026-08-13 に、中央16頭・実オッズ・`analyze: null` の実 prior・λ=0.5 で測った表(複勝・ワイド・三連複だけ。
 * `scripts/bench-mixed-allocation.ts` の §1 と Issue #36 のコメント)を、統計モデルの見直し(#339 の重みの当て直し・
 * #353 のタイム指数・#354 の調教師)の後に、**全券種・本番の既定の設定**で測り直す。本スクリプトはその再現手段である。
 * 本番のコード・`greedySteps` の値・アルゴリズムは変えない(測るだけ)。ネットワークには出ない。
 *
 * ## 使い方
 *   pnpm tsx scripts/measure-greedy-steps.ts
 * 出力は決定的(同じコミットなら同じ表)。所要時間だけは末尾の別行に出し、表には混ぜない。
 *
 * ## 計測条件(出力の先頭にも書く)
 * - レース: `docs/investigations/combo-odds-real-fetch/central-on.json`(中央16頭・race_id=202603020211・確定オッズ・実レース日 2026/06/28)。
 *   馬ごとの実戦績・単勝/複勝/ワイド/三連複のオッズを持つ。馬連・馬単・三連単・枠連のオッズは、同じレースの
 *   `fixtures/odds_{quinella,exacta,trifecta,wakuren}_202603020211.json` から足す(`bench-mixed-allocation.ts` の §3〜5 と同じ)。
 *   ワイド・三連複は両方にあるので、一致することを入力の検査にしている(食い違えば例外)。
 * - prior: `runAnalysis` を `analyze: null` で実行して得る(LLM補正なし)。scorerConfig は `buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS)`
 *   (cloud の既定の重み15項目。#339・#353・#354 の後の値)。**騎手・調教師の成績は入っていない**: `central-on.json` はそれらを取得する前の
 *   保存で、リポジトリには代用のページしか無いため、「データなし」(補正なし)で測る。したがって調教師の項(#354)は prior を動かしていない。
 * - 設定: `DEFAULT_CLOUD_SETTINGS`(評価の閾値・λ・券種の ON/OFF・的中確率の下限)をそのまま使う。上書きするのは、資金と1レース上限
 *   (既定は未設定の 0 なので3シナリオ)と、`includeComboOdds`(既定 false=オッズを取得せず複勝のみの経路に落ちるため、true にして
 *   組合せ券種を測る)の2つだけ。
 * - greedySteps は `buildMixedRaceAllocation` の内側で既定値に固定されているため、そこからは変えられない。そこで
 *   `buildMixedCandidates` + `allocateGeneralBets` を直接呼び、config の `greedySteps` だけを動かす(`mixed-race-allocation.ts` の
 *   `buildMixedRaceAllocationCore` と同じ組み立て)。**既定の greedySteps では、直接計算の配分が `buildMixedRaceAllocation` の配分と
 *   一致することを毎回検査する**(組み立てが本番からずれたら例外)。
 *
 * ## 3つの条件(主表は C)
 * - C: 全8券種・的中確率の下限 = 本番の既定(0.05)。**本番の挙動。主表。**
 * - B: 全8券種・下限なし(0)。「下限が無かったらどうなるか」の参考。
 * - A: 単勝・複勝・ワイド・三連複のみ・下限なし。8/13 の表(複勝・ワイド・三連複の3券種)に近い券種にした比較用。
 *
 * ## 8/13 の表との比較の注意
 * 条件 A は8/13の表と揃っていない。(1) 券種: 8/13 は複勝・ワイド・三連複の3券種、条件 A は単勝を加えた4券種。(2) 同時分布のモデル:
 * 8/13 当時は CB、いまは PL。(3) prior: #339 の重み・#353 のタイム指数で変わっている。したがって数値は一致せず、差の大半は prior の
 * 変化と見られるが、上の3つを切り分けてはいない(8/13 の表は当時の prior・モデルでしか再現できない)。
 *
 * ## 「0.0%」の読み方
 * 構成比が 0.0% の券種は、「EV プラスの候補が無い」場合と「候補はあるが的中確率の下限(条件 C)で外れた」場合がある。両者を区別できるよう、
 * 出力はシナリオ×条件ごとに「EV プラスの候補」と「下限を通過した候補」の券種別の件数を分けて出す。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";

import { parseKaisaiDate, type RaceData } from "../packages/core/src/index.js";
import { runAnalysis } from "../packages/core/src/analysis/analysis-pipeline.js";
import type { AnalysisResult } from "../packages/core/src/analysis/analysis-types.js";
import { buildMixedCandidates, type MixedCandidateBuildInput } from "../packages/core/src/analysis/mixed-candidates.js";
import { buildMixedRaceAllocation, type MixedAllocationSettings } from "../packages/core/src/analysis/mixed-race-allocation.js";
import {
  allocateGeneralBets,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type AllocationBetType,
  type BracketJointModelHorse,
  type GeneralBetAllocation,
  type GeneralBetAllocationResult,
} from "../packages/core/src/ev/combo-bet-allocation.js";
import { toComboOddsScalarMap } from "../packages/core/src/scraper/combo-odds-key.js";
import { parseComboOdds, type ComboBetType } from "../packages/core/src/scraper/parse-combo-odds.js";
import { DEFAULT_SCORER_CONFIG } from "../packages/core/src/scorer/config.js";
import { buildCloudScorerConfig } from "../cloud/src/scorer-config.js";
import { DEFAULT_CLOUD_SETTINGS } from "../cloud/src/settings.js";

// ---------------------------------------------------------------------------
// 純粋な部分(テストで固定する)
// ---------------------------------------------------------------------------

/** 表に出す券種の列(順序つき)。`AllocationBetType` の全8券種。 */
export const BET_TYPE_COLUMNS: readonly { readonly betType: AllocationBetType; readonly label: string }[] = [
  { betType: "win", label: "単勝" },
  { betType: "place", label: "複勝" },
  { betType: "wide", label: "ワイド" },
  { betType: "quinella", label: "馬連" },
  { betType: "exacta", label: "馬単" },
  { betType: "trio", label: "三連複" },
  { betType: "trifecta", label: "三連単" },
  { betType: "bracketQuinella", label: "枠連" },
];

/** 配分1回分の集計。 */
export interface AllocationSummary {
  readonly totalStake: number;
  readonly betCount: number;
  readonly stakeByType: Readonly<Record<AllocationBetType, number>>;
  /** 券種ごとの構成比(0〜1)。総額0のときは全券種0。 */
  readonly shareByType: Readonly<Record<AllocationBetType, number>>;
}

/**
 * 配分結果を券種別に集計する。金額の合計が `totalStake` と食い違う・列に無い券種が混ざる場合は例外
 * (構成比の和が100%にならない表を、黙って出さない)。
 */
export function summarizeAllocations(
  result: Pick<GeneralBetAllocationResult, "totalStake" | "betCount" | "allocations">,
): AllocationSummary {
  const stakeByType = Object.fromEntries(BET_TYPE_COLUMNS.map((c) => [c.betType, 0])) as Record<AllocationBetType, number>;
  for (const a of result.allocations) {
    if (!(a.betType in stakeByType)) {
      throw new Error(`summarizeAllocations: 列に無い券種 ${String(a.betType)} が含まれています`);
    }
    stakeByType[a.betType] += a.stake;
  }
  const sum = BET_TYPE_COLUMNS.reduce((s, c) => s + stakeByType[c.betType], 0);
  if (sum !== result.totalStake) {
    throw new Error(`summarizeAllocations: 券種別の金額の合計 ${sum} が totalStake ${result.totalStake} と一致しません`);
  }
  const shareByType = Object.fromEntries(
    BET_TYPE_COLUMNS.map((c) => [c.betType, result.totalStake > 0 ? stakeByType[c.betType] / result.totalStake : 0]),
  ) as Record<AllocationBetType, number>;
  return { totalStake: result.totalStake, betCount: result.betCount, stakeByType, shareByType };
}

/** 券種(`AllocationBetType`)の文字列の列を、券種別の件数にする。列に無い券種が混ざれば例外(数えられない件数を黙って落とさない)。 */
export function countByBetType(betTypes: readonly string[]): Record<AllocationBetType, number> {
  const counts = Object.fromEntries(BET_TYPE_COLUMNS.map((c) => [c.betType, 0])) as Record<AllocationBetType, number>;
  for (const betType of betTypes) {
    if (!(betType in counts)) {
      throw new Error(`countByBetType: 列に無い券種 ${betType} が含まれています`);
    }
    counts[betType as AllocationBetType] += 1;
  }
  return counts;
}

/** 券種別の件数の引き算(a − b)。ある券種で b が a を上回れば例外(「通過 = EVプラス − 下限で外れ」が負にならない前提の検査)。 */
export function subtractCounts(
  a: Readonly<Record<AllocationBetType, number>>,
  b: Readonly<Record<AllocationBetType, number>>,
): Record<AllocationBetType, number> {
  const out = {} as Record<AllocationBetType, number>;
  for (const { betType } of BET_TYPE_COLUMNS) {
    if (b[betType] > a[betType]) {
      throw new Error(`subtractCounts: ${betType} で引く数 ${b[betType]} が引かれる数 ${a[betType]} を上回ります`);
    }
    out[betType] = a[betType] - b[betType];
  }
  return out;
}

/** 券種別の件数を「単勝5 / 複勝5 / …(計N)」の行にする。0件の券種は省略する(全部0なら「なし(計0)」)。 */
export function formatCountsLine(counts: Readonly<Record<AllocationBetType, number>>): string {
  const total = BET_TYPE_COLUMNS.reduce((s, c) => s + counts[c.betType], 0);
  const parts = BET_TYPE_COLUMNS.filter((c) => counts[c.betType] > 0).map((c) => `${c.label}${counts[c.betType]}`);
  return parts.length === 0 ? `なし(計${total})` : `${parts.join(" / ")}(計${total})`;
}

/** 構成比(0〜1)を小数1桁の百分率にする。 */
export function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * 設定の「配分に含める」6項目から券種の並びを作る。`mixed-race-allocation.ts` の非公開関数 `resolveMixedBetTypes` と同じ規則・同じ順
 * (複勝・単勝は常に含める)。ずれは、既定の greedySteps での本番の経路との一致の検査(`allocationsEqual`)が検出する。
 */
export function betTypesOfSettings(
  settings: Pick<
    MixedAllocationSettings,
    | "includeWideInAllocation"
    | "includeTrioInAllocation"
    | "includeQuinellaInAllocation"
    | "includeExactaInAllocation"
    | "includeTrifectaInAllocation"
    | "includeBracketQuinellaInAllocation"
  >,
): AllocationBetType[] {
  const betTypes: AllocationBetType[] = ["place", "win"];
  if (settings.includeWideInAllocation) betTypes.push("wide");
  if (settings.includeTrioInAllocation) betTypes.push("trio");
  if (settings.includeQuinellaInAllocation) betTypes.push("quinella");
  if (settings.includeExactaInAllocation) betTypes.push("exacta");
  if (settings.includeTrifectaInAllocation) betTypes.push("trifecta");
  if (settings.includeBracketQuinellaInAllocation) betTypes.push("bracketQuinella");
  return betTypes;
}

/** 2つの配分の買い目(券種+馬番の組)と金額が、並びを除いて同じか。 */
export function allocationsEqual(
  a: readonly Pick<GeneralBetAllocation, "betType" | "umabans" | "stake">[],
  b: readonly Pick<GeneralBetAllocation, "betType" | "umabans" | "stake">[],
): boolean {
  const toMap = (list: readonly Pick<GeneralBetAllocation, "betType" | "umabans" | "stake">[]): Map<string, number> =>
    new Map(list.map((x) => [`${x.betType}:${x.umabans.join(",")}`, x.stake] as const));
  const ma = toMap(a);
  const mb = toMap(b);
  if (a.length !== b.length || ma.size !== a.length || mb.size !== b.length) {
    return false;
  }
  for (const [key, stake] of ma) {
    if (mb.get(key) !== stake) return false;
  }
  return true;
}

/** 感度表の1行(1つの greedySteps)。 */
export interface SensitivityRow {
  readonly greedySteps: number;
  readonly summary: AllocationSummary;
  /** 的中確率の下限で、候補から外れた EV プラスの買い目の数。 */
  readonly belowFloorCount: number;
}

/** 感度表(Markdown の表)を、タイトル行 + 表の行の配列にする。 */
export function formatSensitivityTable(title: string, rows: readonly SensitivityRow[]): string[] {
  const head = ["greedySteps", "総額(円)", "点数", "下限で外れ", ...BET_TYPE_COLUMNS.map((c) => c.label)];
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  return [
    title,
    line(head),
    line(head.map(() => "---")),
    ...rows.map((r) =>
      line([
        String(r.greedySteps),
        r.summary.totalStake.toLocaleString("en-US"),
        String(r.summary.betCount),
        String(r.belowFloorCount),
        ...BET_TYPE_COLUMNS.map((c) => formatShare(r.summary.shareByType[c.betType])),
      ]),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 計測(フィクスチャ・計算)
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RACE_FIXTURE = path.join(ROOT, "docs", "investigations", "combo-odds-real-fetch", "central-on.json");
const KAISAI_DATE = "20260628";

/** 組合せオッズのフィクスチャ(同じレース 202603020211)。 */
const COMBO_FIXTURES: readonly { readonly betType: ComboBetType; readonly file: string }[] = [
  { betType: "wide", file: "odds_wide_202603020211.json" },
  { betType: "trio", file: "odds_trio_202603020211.json" },
  { betType: "quinella", file: "odds_quinella_202603020211.json" },
  { betType: "exacta", file: "odds_exacta_202603020211.json" },
  { betType: "trifecta", file: "odds_trifecta_202603020211.json" },
  { betType: "bracketQuinella", file: "odds_wakuren_202603020211.json" },
];

/** フィクスチャをパースして `Record<キー, オッズ|null>` にする(`scrapeRace` と同じ変換経路。規則を再実装しない)。 */
function loadCombo(betType: ComboBetType, file: string): Record<string, number | null> {
  const parsed = parseComboOdds(readFileSync(path.join(ROOT, "fixtures", file), "utf-8"), betType);
  if (parsed.state !== "available") {
    throw new Error(`${file} が available ではありません(state=${parsed.state})`);
  }
  return Object.fromEntries(toComboOddsScalarMap(parsed.odds));
}

/** キー順に依存せずに比べる。 */
function sortedEntries(record: Record<string, number | null> | undefined): [string, number | null][] {
  return Object.entries(record ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
}

/** 計測に使う入力(レース + 全券種の組合せオッズ)を作る。 */
export async function loadMeasurementRace(): Promise<{ readonly analysis: AnalysisResult; readonly race: MixedCandidateBuildInput }> {
  const raceData = JSON.parse(readFileSync(RACE_FIXTURE, "utf-8")) as RaceData;
  // cloud の既定の重みが core の既定と同じであること(同じなら、scorerConfig を渡す・渡さないで prior が変わらない)。違えば、どちらを
  // 「今の版」とするかの前提が変わるので止める。
  deepStrictEqual(buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS), DEFAULT_SCORER_CONFIG);
  const analysis = await runAnalysis(raceData.raceId, parseKaisaiDate(KAISAI_DATE), {
    scrape: async () => raceData,
    analyze: null,
    saveAnalysis: () => 0,
    allocationSettings: null,
    scorerConfig: buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS),
    now: () => new Date("2026-06-28T12:00:00.000Z"),
  });

  const combos = Object.fromEntries(COMBO_FIXTURES.map((f) => [f.betType, loadCombo(f.betType, f.file)])) as Record<ComboBetType, Record<string, number | null>>;
  // central-on.json と、足すフィクスチャが同じレースの同じオッズであること(ワイド・三連複は両方にある)。
  deepStrictEqual(sortedEntries(analysis.wideCombo), sortedEntries(combos.wide));
  deepStrictEqual(sortedEntries(analysis.trioCombo), sortedEntries(combos.trio));

  // 確定後のオッズ(出力の先頭に「確定後オッズ」と書く前提。発売前〈yoso〉や発売中のオッズでは測っていない)。
  if (analysis.oddsStatus !== "result") {
    throw new Error(`oddsStatus が result ではありません(${analysis.oddsStatus})。出力の先頭の「確定後オッズ」の記述が成り立ちません`);
  }
  const race: MixedCandidateBuildInput = {
    oddsStatus: analysis.oddsStatus,
    rows: analysis.rows,
    ...(analysis.comboOdds !== undefined ? { comboOdds: analysis.comboOdds } : {}),
    wideCombo: combos.wide,
    trioCombo: combos.trio,
    quinellaCombo: combos.quinella,
    exactaCombo: combos.exacta,
    trifectaCombo: combos.trifecta,
    bracketQuinellaCombo: combos.bracketQuinella,
  };
  return { analysis, race };
}

/** 資金と1レース上限のシナリオ。 */
export const SCENARIOS: readonly { readonly label: string; readonly bankroll: number; readonly perRaceCap: number }[] = [
  { label: "100万/10万", bankroll: 1_000_000, perRaceCap: 100_000 },
  { label: "100万/100万", bankroll: 1_000_000, perRaceCap: 1_000_000 },
  { label: "500万/500万", bankroll: 5_000_000, perRaceCap: 5_000_000 },
];

/** 測る greedySteps(既定の 1000 と、8/13 の 400、その前後と間)。 */
export const GREEDY_STEPS_VALUES: readonly number[] = [200, 400, 600, 800, 1000, 2000];

/** 条件 A・B・C(主表は C)。設定は `DEFAULT_CLOUD_SETTINGS` からの差分だけを持つ。 */
export const CONDITIONS: readonly {
  readonly id: "C" | "B" | "A";
  readonly title: string;
  readonly overrides: Partial<MixedAllocationSettings>;
}[] = [
  { id: "C", title: "条件C(主表・本番の既定): 全8券種・的中確率の下限 = 既定", overrides: {} },
  { id: "B", title: "条件B(参考): 全8券種・的中確率の下限なし(0)", overrides: { minHitProb: 0 } },
  {
    id: "A",
    title: "条件A(8/13に近い券種): 単勝・複勝・ワイド・三連複のみ・下限なし(0)。8/13とは単勝の有無と同時分布のモデル(CB→PL)が違う",
    overrides: {
      minHitProb: 0,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: false,
      includeTrifectaInAllocation: false,
      includeBracketQuinellaInAllocation: false,
    },
  },
];

/** 本番の既定の設定(`DEFAULT_CLOUD_SETTINGS`)から、配分の設定を作る。 */
function settingsFor(scenario: { bankroll: number; perRaceCap: number }, overrides: Partial<MixedAllocationSettings>): MixedAllocationSettings {
  const d = DEFAULT_CLOUD_SETTINGS;
  return {
    bankroll: scenario.bankroll,
    perRaceCap: scenario.perRaceCap,
    kellyFraction: d.kellyFraction,
    minHitProb: d.minHitProb,
    evThreshold: d.evThreshold,
    // 既定は false(オッズを取得せず複勝のみの経路)。組合せ券種を測るので true にする(本スクリプトの2つの上書きの1つ)。
    includeComboOdds: true,
    includeWideInAllocation: d.includeWideInAllocation,
    includeTrioInAllocation: d.includeTrioInAllocation,
    includeQuinellaInAllocation: d.includeQuinellaInAllocation,
    includeExactaInAllocation: d.includeExactaInAllocation,
    includeTrifectaInAllocation: d.includeTrifectaInAllocation,
    includeBracketQuinellaInAllocation: d.includeBracketQuinellaInAllocation,
    ...overrides,
  };
}

/** `buildMixedRaceAllocationCore` と同じ組み立てで、greedySteps だけを変えて配分を計算する。 */
function allocateWith(
  race: MixedCandidateBuildInput,
  analysis: AnalysisResult,
  settings: MixedAllocationSettings,
  greedySteps: number,
): GeneralBetAllocationResult {
  const mixed = buildMixedCandidates(race, {
    betTypes: betTypesOfSettings(settings),
    evConfig: { threshold: settings.evThreshold },
  });
  const horses: BracketJointModelHorse[] = analysis.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb, wakuban: r.wakuban }));
  return allocateGeneralBets(horses, mixed.topFinishCount, mixed.candidates, {
    bankroll: settings.bankroll,
    perRaceCap: settings.perRaceCap,
    kellyFraction: settings.kellyFraction,
    betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
    greedySteps,
    candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
    minHitProb: settings.minHitProb,
  });
}

/** 既定の greedySteps での直接計算が、本番の経路(`buildMixedRaceAllocation`)の配分と一致することを検査する。 */
function assertMatchesProduction(
  race: MixedCandidateBuildInput,
  settings: MixedAllocationSettings,
  direct: GeneralBetAllocationResult,
  label: string,
): void {
  const view = buildMixedRaceAllocation(race, settings);
  if (view.kind !== "mixed") {
    throw new Error(`${label}: 本番の経路が mixed ではありません(kind=${view.kind})`);
  }
  if (!allocationsEqual(direct.allocations, view.result.allocations) || direct.totalStake !== view.result.totalStake) {
    throw new Error(`${label}: 既定の greedySteps で、直接計算の配分が buildMixedRaceAllocation と一致しません(組み立てが本番からずれています)`);
  }
}

/** 計測の本体。出力する行を返す(副作用の出力は main が行う)。 */
export async function runMeasurement(greedyStepsValues: readonly number[] = GREEDY_STEPS_VALUES): Promise<string[]> {
  const { analysis, race } = await loadMeasurementRace();
  const out: string[] = [];
  const d = DEFAULT_CLOUD_SETTINGS;
  const defaultSteps = DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps;

  out.push(`# greedySteps の感度(Issue #36 の測り直し)`);
  out.push("");
  out.push("## 計測条件");
  out.push(`- **確定後オッズ(oddsStatus=${analysis.oddsStatus})・LLM の補正なし(prior のまま)・1 レース**(中央${analysis.rows.length}頭の 1 レースだけの測定。レース間のばらつきは測っていない)`);
  out.push(`- レース: 中央${analysis.rows.length}頭 raceId=${analysis.raceId}(実レース日 ${KAISAI_DATE})。oddsStatus=${analysis.oddsStatus}`);
  out.push(`- 入力: docs/investigations/combo-odds-real-fetch/central-on.json(実戦績・単複ワイド三連複のオッズ)+ fixtures/odds_{quinella,exacta,trifecta,wakuren}_202603020211.json`);
  out.push(`- prior: runAnalysis(analyze: null)の実 prior。scorerConfig = buildCloudScorerConfig(DEFAULT_CLOUD_SETTINGS)(core の既定と同一であることを検査済み)`);
  out.push(`- **騎手・調教師の成績は入っていない(データなし=補正なし)。調教師の項(#354)は prior を動かしていない**`);
  out.push(
    `- 設定(DEFAULT_CLOUD_SETTINGS): 評価の閾値=${d.evThreshold} / λ=${d.kellyFraction} / 的中確率の下限=${d.minHitProb}(条件Cのみ。B・Aは0) / ` +
      `配分に含める: ワイド=${d.includeWideInAllocation} 三連複=${d.includeTrioInAllocation} 馬連=${d.includeQuinellaInAllocation} 馬単=${d.includeExactaInAllocation} ` +
      `三連単=${d.includeTrifectaInAllocation} 枠連=${d.includeBracketQuinellaInAllocation}(条件Aは馬連・馬単・三連単・枠連をOFF)`,
  );
  out.push(
    `- **上書き**: 資金・1レース上限(既定は ${d.bankroll}/${d.perRaceCap}=未設定)を3シナリオに。includeComboOdds(既定 ${d.includeComboOdds}=オッズを取得せず複勝のみの経路)を true に`,
  );
  out.push(`- betUnit=${DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit} / candidateCap=${DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap} / 既定の greedySteps=${defaultSteps}`);
  out.push(`- 構成比は券種ごとの金額 ÷ 総額。「下限で外れ」は、的中確率の下限で候補から外れた EV プラスの買い目の数`);
  out.push(
    `- **8/13の表との比較の注意**: 条件Aは8/13の表と揃っていない。券種(8/13は複勝・ワイド・三連複の3券種、条件Aは単勝を足した4券種)・同時分布のモデル(8/13当時はCB、いまはPL)・prior(#339 の重み・#353 のタイム指数)が違う。差の大半は prior の変化と見られるが、切り分けてはいない`,
  );
  out.push(`- 構成比が 0.0% の券種は、「EVプラスの候補が無い」場合と「候補はあるが的中確率の下限で外れた」場合がある。シナリオ・条件ごとに、EVプラスの候補と下限を通過した候補の券種別の件数を分けて出す`);
  out.push("");

  let checked = 0;
  const t0 = performance.now();
  for (const scenario of SCENARIOS) {
    for (const condition of CONDITIONS) {
      const settings = settingsFor(scenario, condition.overrides);
      const mixed = buildMixedCandidates(race, { betTypes: betTypesOfSettings(settings), evConfig: { threshold: settings.evThreshold } });
      const evCounts = countByBetType(mixed.candidates.map((c) => c.betType));
      const rows: SensitivityRow[] = [];
      let passedCounts: Record<AllocationBetType, number> | null = null;
      for (const greedySteps of greedyStepsValues) {
        const result = allocateWith(race, analysis, settings, greedySteps);
        // 下限を通過した候補 = EVプラスの候補 − 下限で外れた候補(券種別)。最適化に載せた候補数(diagnostics)と合うことを検査する。
        const passed = subtractCounts(evCounts, countByBetType(result.belowFloor.map((b) => b.betType)));
        const passedTotal = BET_TYPE_COLUMNS.reduce((sum, c) => sum + passed[c.betType], 0);
        if (result.diagnostics.truncatedByCapCount !== 0 || passedTotal !== result.diagnostics.candidateCount) {
          throw new Error(`${scenario.label} / 条件${condition.id} / greedySteps=${greedySteps}: 通過した候補の数 ${passedTotal} が最適化に載せた候補数 ${result.diagnostics.candidateCount} と合いません`);
        }
        if (passedCounts !== null && formatCountsLine(passedCounts) !== formatCountsLine(passed)) {
          throw new Error(`${scenario.label} / 条件${condition.id}: 下限を通過した候補が greedySteps で変わりました(下限は最適化の前に適用されるはず)`);
        }
        passedCounts = passed;
        rows.push({ greedySteps, summary: summarizeAllocations(result), belowFloorCount: result.belowFloor.length });
        if (greedySteps === defaultSteps) {
          assertMatchesProduction(race, settings, result, `${scenario.label} / 条件${condition.id}`);
          checked += 1;
        }
      }
      out.push(`### ${scenario.label} — ${condition.title}`);
      out.push(`EVプラスの候補: ${formatCountsLine(evCounts)}`);
      out.push(`下限を通過した候補: ${formatCountsLine(passedCounts!)}`);
      out.push("");
      out.push(...formatSensitivityTable("", rows).slice(1));
      out.push("");
    }
  }
  out.push(`本番の経路(buildMixedRaceAllocation)との一致の検査: ${checked}件(シナリオ×条件。既定の greedySteps=${defaultSteps})すべて一致`);
  out.push(`(所要時間 ${((performance.now() - t0) / 1000).toFixed(1)} 秒。この行は環境で変わる)`);
  return out;
}

async function main(): Promise<void> {
  for (const line of await runMeasurement()) {
    console.log(line);
  }
}

// 直接実行したときだけ計測を走らせる(テストが import しても走らない)。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
