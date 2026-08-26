/**
 * mixed-candidates — 券種横断(複勝・ワイド・三連複)の買い目候補ビルダー(機能D-2c第2段・Issue #28)。
 *
 * boss着手前ゲート(第2段Go)で確定した設計。第1段(`AnalysisResult` に `wideCombo?`/`trioCombo?`/
 * `comboOdds?` を追加)を土台に、`@keiba/core/ev/combo-bet-allocation` の汎用配分エンジン
 * (`allocateGeneralBets`)にそのまま渡せる `AllocationCandidate[]` を組み立てる純関数
 * `buildMixedCandidates` を提供する。**着手当時(第2段)は画面(`BatchAnalysisView.tsx`)・
 * 既存の複勝専用ビュー(`bet-allocation-view.ts`)を一切変更しなかった**(本ファイルからは
 * import するだけだった)。**追記(Issue #57)**: 本ファイル自体は `renderer/mixed-candidates.ts`
 * から `shared/mixed-candidates.ts` へ移動した(ファイル名は不変)。import 先も
 * `resolvePlaceBetTarget`/`PlaceBetUnavailableReason` の移設に伴い `./race-allocation.js`
 * (旧`./bet-allocation-view.js`)へ変わっている(下記import文参照)。
 *
 * ## 反証(boss着手前ゲートで実コードから確認済み。実装方針の前提)
 *
 * - **反証A**: `allocateGeneralBets` は配分計算に使う的中確率を同時分布から一律再導出する。
 *   候補の `ev` は (a) `isPositive` の入口フィルタ (b) 候補cap選抜の並べ替え(既定2000で発動しない)
 *   **だけ**に使われ、最適化そのものには入らない。したがって複勝(周辺確率ベースのEV)と
 *   組合せ(同時分布ベースのEV)の基準が異なっていても、**配分額は歪まない**(影響は「どの候補を
 *   載せるか」の入口判定だけ)。→ 複勝のEV基準は行の `ev`/`isPositive`(`computeRaceEv`/
 *   `computeEstimatedRaceEv` の値)を**そのまま**使う。既存の固定注記 `evThresholdFootnote`
 *   (`bet-allocation-view.ts`)が「配分の対象はEV閾値を上回った馬のみ」と述べている基準と
 *   一致させる(別基準にすると注記が事実と食い違う)。
 * - **反証B**: `docs/wide-trio-odds-investigation.md` §6 は「4頭以下でワイド・3連複が発売
 *   されないことは未確認」と記録している。頭数閾値をハードコードすると「未確認を判定結果として
 *   報告する」欠陥になる。発売可否はデータから直接観測できる(オッズが1件でも取れていれば
 *   発売されていた一次証拠)。→ **ワイド・3連複は頭数による門前払いを一切しない**
 *   (`buildComboCandidates` が `comboSize > 出走頭数` のとき組合せ列挙自体が0件になる、という
 *   構造的な結果に委ねる。頭数チェックを本ファイルには書かない)。
 * - **反証C**: 既存 `race-allocation.ts` の `buildRaceAllocation` は `resolvePlaceBetTarget`
 *   の可用性判定を「レース全体の表示ゲート」として使っている。本モジュールでは同じ関数を
 *   「複勝候補を載せるか否かの判定」に**格下げ**して再利用する(`combo-bet-allocation.ts` の
 *   JSDocが警告する「`resolvePlaceBetTarget` の結果を `topFinishCount` に誤用してはならない」
 *   と同種の取り違えを避けるため、本ファイルでは `topFinishCount` に流用せず常に定数3を使う)。
 *
 * ## yosoガードの複勝適用(boss裁定・ブリーフ差し替え。反証Cの誤り訂正)
 *
 * 当初のブリーフは複勝候補の条件を3つ(`placeOddsMin`/`ev`/`isPositive`)としていたが、これは
 * `race-allocation.ts` の `buildRaceAllocation` が `resolvePlaceBetTarget` より**手前**で
 * 判定している `oddsStatus==="yoso"` ガードを取りこぼしていた(反証Cで頭数判定だけを論じた際に
 * 一緒に落とした)。実コードで確認した事実:
 * - `analysis-pipeline.ts:587` は `oddsStatus==="yoso"` のとき `computeEstimatedRaceEv`
 *   (単勝オッズからの推定複勝下限、誤差±20〜30%)を使い、`placeOddsMin`/`ev`/`isPositive` は
 *   **null にならず**(`evEstimated:true` として区別される)通常どおり算出される。
 * - `docs/current-spec.md`(180行目)は「オッズ未発売(`oddsStatus="yoso"` の推定EVは誤差
 *   ±20〜30%で賭け金に直接効く)」を **提案しないレース** として明文化している。
 *
 * したがって3条件だけを実装すると、誤差±20〜30%の推定EVで選ばれた複勝馬が実資金配分候補に
 * 混入し、既存ポリシーから逸脱する。boss裁定によりこの段では **(a)** を採用する:
 * 複勝候補の条件を4つ(yosoガードを先頭に追加)とし、判定順序を
 * `1.yosoガード → 2.頭数可用性 → 3・4.行レベルの3条件` に固定する。
 *
 * yosoガードの理由は本質的に2つに分解できる(boss裁定):
 * - (i) 発売前だから組合せオッズが存在しない(全券種に等しく効く。データ状態として自然に表現される)
 * - (ii) 推定EVは誤差±20〜30%で賭け金に直接効くから使わない(**複勝の推定EVに固有**のポリシー)
 * 本モジュールでは複勝について (ii) を理由に候補ゼロを返し、診断値に `"yoso"` の理由コードを
 * 載せる(ワイド・3連複と対称)。**理由コードのみを返し、表示文言は持たない**
 * (`allocation-primitives.ts` の `SkipReasonCode` と同じ「コードを返し文言は呼び出し側」の
 * 流儀に揃える。`PLACE_BET_UNAVAILABLE_MESSAGES` 等の文言定義を複製しない)。
 *
 * `buildRaceAllocation` の `kind:"yoso"`(レース全体の表示ゲート)は本段では変更しない
 * (第4段で二重化を解消するかは第4段で判断する。現時点では判定が2箇所に現れることを許容する)。
 *
 * ## 第2段の既知の限界(誤読防止)
 *
 * 第2段時点では `scrapeRace` の `includeComboOdds` は既定 `false` で固定配線されている
 * (第1段のスコープ)。したがって現状は**全レースで** `wideCombo`/`trioCombo` が未取得
 * (`comboOdds` も `undefined`)になる。yoso のときにワイド・3連複の候補が0件になる理由は
 * 「yosoだから」ではなく「(第2段の配線上)未取得だから」であり、本ファイルはこの2つの
 * ゼロ件理由を診断値の型(`kind:"yoso"` と `kind:"built"` かつ `fieldPresence:"absent"`)で
 * 明確に区別する(誤ラベル禁止。yosoのときは列挙自体を行わず、`kind:"yoso"` を返す。
 * 実際に組合せオッズが取得済みかどうかとは無関係に、yosoである限りこの理由コードが優先される)。
 *
 * ## 券種フィルタ(`options.betTypes`)についての注意
 *
 * これは**第3段以降のための受け口**であり、本段(第2段)では妙味度による券種切り替えを
 * 実装しない(ユーザー決定Q2「常に全券種」)。既定値は全券種。型定義上、妙味度・
 * `RaceOpportunity` に類する値は本モジュールの入力に一切現れない(受け取れない)。
 *
 * ## EV閾値の統一(`options.evConfig`。機能D-2c第4段・Issue #28・D-4)
 *
 * 第4段のboss裁定B-2「閾値を揃える」により、`options.evConfig`(省略時は
 * `DEFAULT_EV_CONFIG`=閾値1.0)を`buildComboCandidates`へそのまま渡す。複勝候補は
 * `row.isPositive`(呼び出し元が`AppSettings.evThreshold`で既に判定済みの値)をそのまま使う
 * ため、呼び出し元(`mixed-race-allocation.ts` の `buildMixedRaceAllocation`)が**同じ`evThreshold`から組み立てた`evConfig`**を
 * ここへ渡すことで、複勝・ワイド・3連複が同一の閾値・同一の厳密不等号(`ev > threshold`)で
 * 判定される(`bet-allocation-view.ts`の`evThresholdFootnote`「配分の対象はEV閾値を上回った
 * 買い目のみです」という注記と実際の判定基準を一致させる)。
 */

import {
  buildComboCandidates,
  DEFAULT_EV_CONFIG,
  type AllocationCandidate,
  type ComboCandidateDiagnostics,
  type EvConfig,
  type JointModelHorse,
} from "@keiba/core/ev/combo-bet-allocation";

import type {
  AnalysisRow,
  ComboOddsFetchOutcomeView,
  ComboOddsScrapeOutcomeView,
  OddsStatus,
} from "./analysis-types.js";
import { resolvePlaceBetTarget, type PlaceBetUnavailableReason } from "./race-allocation.js";

/** 券種横断の買い目候補ビルダーが対象にできる券種。 */
export type MixedCandidateBetType = "place" | "wide" | "trio";

/** 既定の対象券種(全券種)。boss裁定Q2により、第2段はこれ以外の絞り込みを実装しない。 */
export const ALL_MIXED_CANDIDATE_BET_TYPES: readonly MixedCandidateBetType[] = [
  "place",
  "wide",
  "trio",
];

/**
 * `buildMixedCandidates` のオプション。
 *
 * `betTypes` は**第3段以降のための受け口**(受け入れ条件)。妙味度・`RaceOpportunity` に
 * 類する値を受け取るフィールドは意図的に存在しない(型レベルの保証)。
 */
export interface MixedCandidateBuildOptions {
  /** 対象券種(省略時は全券種 `ALL_MIXED_CANDIDATE_BET_TYPES`)。 */
  readonly betTypes?: readonly MixedCandidateBetType[];
  /**
   * ワイド・3連複のEV判定に使う閾値設定(省略時は `DEFAULT_EV_CONFIG` = 閾値1.0)。
   * 複勝候補は`row.isPositive`をそのまま使う(呼び出し元が同じ閾値で既に判定済みの値)ため、
   * 呼び出し元がここへ同じ閾値の`evConfig`を渡すことで全券種の判定基準を統一できる(D-4)。
   */
  readonly evConfig?: EvConfig;
}

/**
 * `buildMixedCandidates` が受け取るレース情報の最小構造(`AnalysisResult` からそのまま渡せる。
 * `RaceAllocationInput`〈race-allocation.ts〉と同じ流儀の構造的最小型)。
 */
export interface MixedCandidateBuildInput {
  readonly oddsStatus: OddsStatus;
  readonly rows: readonly AnalysisRow[];
  readonly wideCombo?: Record<string, number | null>;
  readonly trioCombo?: Record<string, number | null>;
  readonly comboOdds?: ComboOddsScrapeOutcomeView;
}

/**
 * 複勝候補が対象外の理由コード。頭数由来(`PlaceBetUnavailableReason`)に加えて `"yoso"` を持つ
 * (boss裁定。頭数由来のコードとは別値であることを型で保証する)。
 */
export type PlaceCandidateUnavailableReason = "yoso" | PlaceBetUnavailableReason;

/**
 * 複勝候補ビルドの診断値(判別共用体)。判定結果(`judged`)と判定不能(このユニオン自体の
 * `unavailable`/`not-requested` 分岐)を型レベルで分離する。
 * - `not-requested`: `options.betTypes` に `"place"` が含まれていない(列挙自体を行っていない)。
 * - `unavailable`: yosoガード、または頭数可用性(`resolvePlaceBetTarget`)により対象外。
 *   理由コードは判定順序(yoso→頭数)で1つに決まる。
 * - `judged`: 各行を判定した結果。`judged` は候補化した/EV非プラスで外した数、`unjudged` は
 *   オッズ・EVが欠損していて判定できなかった数(型で混ざらない)。
 */
export type PlaceCandidateDiagnostics =
  | { readonly kind: "not-requested" }
  | { readonly kind: "unavailable"; readonly reason: PlaceCandidateUnavailableReason }
  | {
      readonly kind: "judged";
      readonly judged: {
        readonly positiveCount: number;
        readonly notPositiveCount: number;
      };
      readonly unjudged: {
        readonly oddsMissingCount: number;
      };
    };

/**
 * `wideCombo`/`trioCombo` フィールド自体の状態(値の中身とは独立に、まず「どういう状態の
 * フィールドを受け取ったか」を表す)。`{}` を「発売なし」と断定しないための3分類。
 * - `absent`: キー自体が無い(`undefined`)。
 * - `empty`: 空オブジェクト(`{}`)。
 * - `present`: 1件以上の値を持つ。
 */
export type ComboFieldPresence = "absent" | "empty" | "present";

/**
 * ワイド・3連複候補ビルドの診断値(判別共用体)。
 * - `not-requested`: `options.betTypes` に対象券種が含まれていない(列挙自体を行っていない)。
 * - `yoso`: `oddsStatus==="yoso"`。発売前は組合せオッズが存在しないため列挙自体を行わず候補ゼロ
 *   (第2段の既知の限界により「未取得」と紛らわしいが、型として明確に別枝にして誤ラベルを防ぐ)。
 * - `built`: `buildComboCandidates` に委譲して列挙・判定した。`fieldPresence`
 *   (`wideCombo`/`trioCombo` フィールド自体の状態)と `comboOddsState`
 *   (`comboOdds.<betType>.state`。取得できなければ `"unknown"`)を**両方**載せる
 *   (`{}` になった原因〈市場側の unavailable なのか取得失敗の failed なのか〉は
 *   `comboOddsState` でのみ判別できる。`AnalysisResult.wideCombo` のJSDoc参照)。
 */
export type ComboCandidateDiagnosticsView =
  | { readonly kind: "not-requested" }
  | { readonly kind: "yoso" }
  | {
      readonly kind: "built";
      readonly fieldPresence: ComboFieldPresence;
      readonly comboOddsState: ComboOddsFetchOutcomeView["state"] | "unknown";
      readonly build: ComboCandidateDiagnostics;
    };

/** `buildMixedCandidates` の診断値(券種ごと)。 */
export interface MixedCandidateDiagnostics {
  readonly place: PlaceCandidateDiagnostics;
  readonly wide: ComboCandidateDiagnosticsView;
  readonly trio: ComboCandidateDiagnosticsView;
}

/** `buildMixedCandidates` の結果。 */
export interface MixedCandidateBuildResult {
  /** `allocateGeneralBets` にそのまま渡せる買い目候補(券種混在)。 */
  readonly candidates: readonly AllocationCandidate[];
  /**
   * 上位何着までを的中判定に使うか。**常に3**(`resolvePlaceBetTarget().placeCount` を
   * 流用しない。反証C)。
   */
  readonly topFinishCount: number;
  readonly diagnostics: MixedCandidateDiagnostics;
}

/** ワイド・3連複それぞれの買い目構成頭数(`@keiba/core` の `COMBO_SIZE` と同じ値。券種非依存モジュール間の依存を増やさないため独立して持つ)。 */
const COMBO_SIZE: Record<"wide" | "trio", number> = { wide: 2, trio: 3 };

/** ワイド・3連複の的中判定に使う上位着数。複勝の払戻対象人数とは無関係の独立した定数(反証C)。 */
const COMBO_TOP_FINISH_COUNT = 3;

/** 複勝候補を構築する(boss裁定(a): yosoガード→頭数可用性→行レベル3条件の優先順位)。 */
function buildPlaceCandidates(race: MixedCandidateBuildInput): {
  candidates: AllocationCandidate[];
  diagnostics: PlaceCandidateDiagnostics;
} {
  // 1. yosoガード(boss裁定。頭数判定より先に判定する)。
  if (race.oddsStatus === "yoso") {
    return { candidates: [], diagnostics: { kind: "unavailable", reason: "yoso" } };
  }
  // 2. 頭数可用性(既存 resolvePlaceBetTarget を「候補を載せるか否か」の判定に格下げして再利用)。
  const target = resolvePlaceBetTarget(race.rows.length);
  if (!target.available) {
    return { candidates: [], diagnostics: { kind: "unavailable", reason: target.reason } };
  }
  // 3・4. 行レベル: placeOddsMin!==null かつ ev!==null(判定不能)、isPositive===true(判定結果)。
  const candidates: AllocationCandidate[] = [];
  let positiveCount = 0;
  let notPositiveCount = 0;
  let oddsMissingCount = 0;
  for (const row of race.rows) {
    if (row.placeOddsMin === null || row.ev === null) {
      oddsMissingCount++;
      continue;
    }
    if (row.isPositive !== true) {
      notPositiveCount++;
      continue;
    }
    positiveCount++;
    candidates.push({ umabans: [row.umaban], odds: row.placeOddsMin, ev: row.ev, isPositive: true });
  }
  return {
    candidates,
    diagnostics: {
      kind: "judged",
      judged: { positiveCount, notPositiveCount },
      unjudged: { oddsMissingCount },
    },
  };
}

/** `Record<string, number|null> | undefined` からフィールド自体の状態を判定する。 */
function resolveFieldPresence(record: Record<string, number | null> | undefined): ComboFieldPresence {
  if (record === undefined) {
    return "absent";
  }
  return Object.keys(record).length === 0 ? "empty" : "present";
}

/** ワイド・3連複候補を構築する(反証B: 頭数門前払いをしない。委譲先 buildComboCandidates の列挙結果に委ねる)。 */
function buildComboCandidatesForBetType(
  betType: "wide" | "trio",
  requested: boolean,
  race: MixedCandidateBuildInput,
  horses: readonly JointModelHorse[],
  evConfig: EvConfig,
): { candidates: readonly AllocationCandidate[]; diagnostics: ComboCandidateDiagnosticsView } {
  if (!requested) {
    return { candidates: [], diagnostics: { kind: "not-requested" } };
  }
  // yosoガード: 発売前は組合せオッズが存在しない(第2段の「未取得」とは別理由。誤ラベル禁止)。
  if (race.oddsStatus === "yoso") {
    return { candidates: [], diagnostics: { kind: "yoso" } };
  }
  const record = betType === "wide" ? race.wideCombo : race.trioCombo;
  const fieldPresence = resolveFieldPresence(record);
  const comboOddsState = race.comboOdds?.[betType]?.state ?? "unknown";
  const oddsByKey = new Map<string, number | null>(Object.entries(record ?? {}));
  // D-4: evConfigを渡し、複勝(row.isPositive)と同じ閾値・同じ厳密不等号で判定させる。
  const result = buildComboCandidates(
    horses,
    COMBO_TOP_FINISH_COUNT,
    COMBO_SIZE[betType],
    oddsByKey,
    evConfig,
  );
  return {
    candidates: result.candidates,
    diagnostics: { kind: "built", fieldPresence, comboOddsState, build: result.diagnostics },
  };
}

/**
 * 券種横断(複勝・ワイド・3連複)の買い目候補を構築する。
 *
 * @param race レース情報の最小構造(`AnalysisResult` をそのまま渡せる)
 * @param options 対象券種(省略時は全券種)。第3段以降のための受け口(第2段では絞り込みを実装しない)
 */
export function buildMixedCandidates(
  race: MixedCandidateBuildInput,
  options: MixedCandidateBuildOptions = {},
): MixedCandidateBuildResult {
  const betTypes = options.betTypes ?? ALL_MIXED_CANDIDATE_BET_TYPES;
  const evConfig = options.evConfig ?? DEFAULT_EV_CONFIG;
  const horses: JointModelHorse[] = race.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb }));

  const place = betTypes.includes("place")
    ? buildPlaceCandidates(race)
    : { candidates: [] as AllocationCandidate[], diagnostics: { kind: "not-requested" } as PlaceCandidateDiagnostics };
  const wide = buildComboCandidatesForBetType("wide", betTypes.includes("wide"), race, horses, evConfig);
  const trio = buildComboCandidatesForBetType("trio", betTypes.includes("trio"), race, horses, evConfig);

  return {
    candidates: [...place.candidates, ...wide.candidates, ...trio.candidates],
    topFinishCount: COMBO_TOP_FINISH_COUNT,
    diagnostics: { place: place.diagnostics, wide: wide.diagnostics, trio: trio.diagnostics },
  };
}
