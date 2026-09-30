/**
 * 券種横断の馬券配分(機能D-2c第4段・Issue #28)の再現可能な計測スクリプト。
 *
 * ## 経緯(code-reviewer指摘・boss確認2026-08-13)
 *
 * `mixed-allocation-view.ts`・`mixed-allocation-cache.ts` のJSDocには当初、
 * (a) `greedySteps` の刻み幅が券種構成比を左右する具体的な数値例
 * (b) 1レースあたりの所要時間(約93ms・12レースで約1.1秒/レンダー)
 * という2つの実測値の主張が書かれていたが、**いずれもリポジトリ内に再現手段が無かった**
 * (`performance.now()`/`Date.now()` の計測コードが0件)。boss が実データで測り直したところ
 * (a) の具体的な数値(「資金500万でも0円」)は**再現しなかった**(条件を落として伝えた
 * オーケストレーターの誤り。α平坦化した合成確率での計測を無条件の事実として伝えていた)。
 *
 * この欠陥クラス(検証手段のない数値をコードに書く)が本プロジェクトで繰り返し指摘された
 * ため、`scripts/bench-allocation.ts`(D-2a・Issue #14)の前例に倣い、**次に読む人が
 * 同じ数値を自分の手元で再現できる**スクリプトとしてここに残す。
 *
 * ## 計測条件(必ず併記すること。boss指摘)
 * - 保存済みの実オッズフィクスチャ `docs/investigations/combo-odds-real-fetch/central-on.json`
 *   (中央16頭・race_id=202603020211・確定オッズ・**実レース日 2026/06/28**)を入力にする。
 *   **ネットワークには一切出ない**
 * - `runAnalysis` には `kaisaiDate="20260628"`(実レース日)を明示して渡す。渡さないと
 *   `resolveAnalysisDate` が実行日(`now()`)へフォールバックし、季節分類・休み明け走目の
 *   基準日が壁時計時刻とともにドリフトする(#40「#35-1a」で判明した欠陥。
 *   `docs/current-spec.md`「9. 確率の質の計測基盤」・Issue #40 参照)
 * - `runAnalysis` を `deps.analyze: null`(LLM未使用)で実行し、scorer が出す **実 prior**
 *   (LLM補正なし=adjustedProb===prior)をそのまま使う
 * - **戦績の先読みリークは遮断していない**: `deps.scrape` に渡すフィクスチャの
 *   `horses[].results` は日付フィルタをかけていない生データであり、当該レース自身の着順が
 *   prior の材料に混入したまま計測している(本番の `analysis-pipeline.ts` と同じ状態。
 *   是正は #39)。したがって本スクリプトが出す prior・EV・配分の絶対値は、確率の質の指標として
 *   額面通りに読んではならない(リーク遮断込みの計測は `ev/probability-quality.ts` +
 *   `scripts/test/probability-quality-regression.test.ts` を参照すること。#40「#35-1a」)。
 *   本スクリプトの目的は `greedySteps` 感度・所要時間の計測であり、prior の質そのものの
 *   計測ではないため、ここでは意図的にリーク遮断を追加していない
 * - ケリー係数 λ=0.5、EV閾値1.0(既定)
 *
 * 4. 枠連(bracketQuinella)を7券種に追加したときの署名畳み込み後のoutcome数・所要時間の
 *    実測(Issue #144〈#26-B〉。appにはまだ枠連の配線が無い〈#146〉ため、`buildMixedCandidates`が
 *    作る7券種の候補に、coreの`buildBracketQuinellaCandidates`が作る枠連候補を足して
 *    `allocateGeneralBets`へ渡す)。枠連は`fixtures/odds_wakuren_202603020211.json`
 *    (同レース・同16頭)を`parseComboOdds`経由でパースして使う。**畳み込み後のoutcome数は
 *    `allocateGeneralBets`の内部値なので、本スクリプトが同じ的中判定を再実装して数え、
 *    製品の`hitProb`と全候補で一致することを毎回検査する**(一致しなければ例外)。
 *
 * 5. 枠連(bracketQuinella)を配分に接続したとき(Issue #150〈#26-E3b〉。`includeBracketQuinellaInAllocation`)の
 *    実際の配分結果。`buildMixedAllocationDisplay`(画面が呼ぶ経路)を、他6券種をすべてONにした設定で
 *    枠連ON/OFFの2通り実行し、総額・点数・券種別構成比・枠連の候補件数(EVプラス件数)を並べる。
 *    - 「枠連が入るレース」: 中央16頭(`202603020211`。全8枠に馬がいる。実オッズ・実prior)。
 *      同じレースを枠連OFFにしたものが「入らない」比較対象(設定で入らない)。
 *    - 「発売のないレース」(**合成**): 同レースの先頭8頭(馬番1〜8)を馬番=枠番として並べ、
 *      ワイド・3連複は16頭の実オッズを馬番1〜8の組に絞った値、枠連は実フィクスチャ
 *      `fixtures/odds_wakuren_unsold_202607020505.json`(中央8頭の未発売の応答。`unavailable`)を使う。
 *      8頭の出馬表フィクスチャは無いため出走馬は合成であり、**この数値は「発売のないレースで枠連が入らず、
 *      判定不能にも数えられない」ことの確認であって、配分額の実測ではない**。
 *
 * ## 使い方
 *   pnpm tsx scripts/bench-mixed-allocation.ts
 *
 * ## 出力
 * 1. `greedySteps` 感度表: 資金/1レース上限の組合せ × greedySteps(既定1000 / 400)で、
 *    総額・点数・券種別構成比(複勝/ワイド/三連複)を表示する。
 * 2. 1レースあたりの所要時間(`buildMixedAllocationDisplay` を実運用と同じ既定設定で
 *    複数回実行した平均。ウォームアップ1回を除く)。
 * 3. 馬連(quinella)・馬単(exacta)・三連単(trifecta)を候補ビルダーに追加したときの性能・
 *    構成の実測(Issue #116 AC-7・Issue #117で追記・Issue #122 AC-7で馬単の構成を追加・
 *    Issue #137 AC-6で三連単のDBサイズ実測を追加・Issue #139〈#25-E3b〉AC7で三連単を
 *    含めたときの構成比較を追加)。`fixtures/odds_quinella_202603020211.json`・
 *    `fixtures/odds_exacta_202603020211.json`・`fixtures/odds_trifecta_202603020211.json`
 *    (いずれも同レース・同16頭)を`parseComboOdds`経由でパースしてそれぞれ`quinellaCombo`・
 *    `exactaCombo`・`trifectaCombo`を作り、`[place,win,wide,trio]`(馬連・馬単・三連単なし)・
 *    `[place,win,wide,trio,quinella]`(馬連あり)・`[place,win,wide,trio,quinella,exacta]`
 *    (馬単も追加)・`[place,win,wide,trio,quinella,exacta,trifecta]`(三連単も追加)の4条件で
 *    `buildMixedCandidates`+`allocateGeneralBets`の1レースあたりの所要時間(平均・ウォームアップ
 *    除く)・券種別候補数・点数・券種別構成比を並べて出す。
 *    **Issue #117で`resolveMixedBetTypes`(`includeQuinellaInAllocation`設定)、
 *    Issue #125で`resolveMixedBetTypes`(`includeExactaInAllocation`設定)、Issue #139で
 *    `resolveMixedBetTypes`(`includeTrifectaInAllocation`設定)がそれぞれ実際に接続された**が、
 *    本節は依然として`buildMixedCandidates`の`options.betTypes`へ明示的に条件を渡す実測であり、
 *    設定のON/OFFを経由しない(#1の`greedySteps`感度表が使う`central-on.json`フィクスチャには
 *    `quinellaCombo`/`exactaCombo`/`trifectaCombo`が無いため、そちらは本節と無関係に
 *    馬連・馬単・三連単の候補が常に0件になる。両者を混同しないこと。AC-11参照)。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseKaisaiDate, type RaceData } from "../packages/core/src/index.js";
import {
  runAnalysis,
  type AnalysisPipelineDeps,
} from "../packages/app/src/main/analysis-pipeline.js";
import type { AnalysisResult, ComboOddsScrapeOutcomeView } from "../packages/app/src/shared/analysis-types.js";
import {
  buildMixedCandidates,
  type MixedCandidateBuildInput,
} from "../packages/app/src/shared/mixed-candidates.js";
import {
  allocateGeneralBets,
  buildBracketQuinellaCandidates,
  DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  type AllocationBetType,
  type AllocationCandidate,
  type BracketJointModelHorse,
  type GeneralBetAllocationConfig,
  type JointModelHorse,
} from "../packages/core/src/ev/combo-bet-allocation.js";
import { foldOutcomeIndexSetsBySignature } from "../packages/core/src/ev/allocation-primitives.js";
import { PLACKETT_LUCE_MODEL } from "../packages/core/src/ev/plackett-luce-model.js";
import { buildMixedAllocationDisplay } from "../packages/app/src/renderer/mixed-allocation-view.js";
import type { MixedAllocationSettings } from "../packages/app/src/shared/mixed-race-allocation.js";
import { parseComboOdds } from "../packages/core/src/scraper/parse-combo-odds.js";
import { toComboOddsScalarMap } from "../packages/core/src/scraper/combo-odds-key.js";

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "investigations",
  "combo-odds-real-fetch",
  "central-on.json",
);

/**
 * 馬連フィクスチャ(Issue #116 AC-7)。`central-on.json`と同じレース(202603020211・16頭)
 * のため、既存の`greedySteps`感度・所要時間計測と同じ出走馬番の宇宙で比較できる。
 */
const QUINELLA_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_quinella_202603020211.json",
);

/**
 * 馬連フィクスチャをパースし`quinellaCombo`(Record形)を作る。`scrape-race.ts`の
 * `fetchComboBetTypeOdds`と同じ変換経路(`parseComboOdds`→`toComboOddsScalarMap`→
 * `Object.fromEntries`)をそのまま使う(規則を再実装しない)。
 */
function loadQuinellaCombo(): Record<string, number | null> {
  const json = readFileSync(QUINELLA_FIXTURE_PATH, "utf-8");
  const parsed = parseComboOdds(json, "quinella");
  if (parsed.state !== "available") {
    throw new Error(`馬連フィクスチャが available ではありません(state=${parsed.state})`);
  }
  return Object.fromEntries(toComboOddsScalarMap(parsed.odds));
}

/**
 * 馬単フィクスチャ(Issue #122 AC-7)。`central-on.json`と同じレース(202603020211・16頭)
 * のため、既存の`greedySteps`感度・所要時間計測と同じ出走馬番の宇宙で比較できる。
 */
const EXACTA_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_exacta_202603020211.json",
);

/**
 * 馬単フィクスチャをパースし`exactaCombo`(Record形)を作る。`loadQuinellaCombo`と同じ
 * 変換経路(`parseComboOdds`→`toComboOddsScalarMap`→`Object.fromEntries`)をそのまま使う
 * (規則を再実装しない)。
 */
function loadExactaCombo(): Record<string, number | null> {
  const json = readFileSync(EXACTA_FIXTURE_PATH, "utf-8");
  const parsed = parseComboOdds(json, "exacta");
  if (parsed.state !== "available") {
    throw new Error(`馬単フィクスチャが available ではありません(state=${parsed.state})`);
  }
  return Object.fromEntries(toComboOddsScalarMap(parsed.odds));
}

/**
 * 三連単フィクスチャ(Issue #137 AC-6)。`central-on.json`と同じレース(202603020211・16頭)
 * のため、既存の`greedySteps`感度・所要時間計測と同じ出走馬番の宇宙で比較できる
 * (P(16,3)=3360件。`fetch-combo-odds.test.ts`/`trifecta-odds-fixtures.test.ts`で
 * 固定済みの値と同じフィクスチャ)。
 */
const TRIFECTA_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_trifecta_202603020211.json",
);

/**
 * 三連単フィクスチャをパースし`trifectaCombo`(Record形)を作る。`loadExactaCombo`と同じ
 * 変換経路(`parseComboOdds`→`toComboOddsScalarMap`→`Object.fromEntries`)をそのまま使う
 * (規則を再実装しない)。
 */
function loadTrifectaCombo(): Record<string, number | null> {
  const json = readFileSync(TRIFECTA_FIXTURE_PATH, "utf-8");
  const parsed = parseComboOdds(json, "trifecta");
  if (parsed.state !== "available") {
    throw new Error(`三連単フィクスチャが available ではありません(state=${parsed.state})`);
  }
  return Object.fromEntries(toComboOddsScalarMap(parsed.odds));
}

/**
 * フィクスチャ(保存済みRaceData)を読み、runAnalysisを実LLM無しで実行してAnalysisResultを得る。
 *
 * **Issue #119(#24-C3)でexportした**: `scripts/verify-worker-pool-prepare.ts`(Workerプールの
 * 実機確認・実測用フィクスチャ生成)が、本スクリプトと同じ実オッズ・実prior・同じ計測条件
 * (上記JSDoc参照)でAnalysisResultを得るために再利用する(単一定義の原則。読み込みロジックの
 * 再実装をしない)。
 */
export async function loadAnalysisResult(): Promise<AnalysisResult> {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  // 保存済みフィクスチャは scrapeRace の戻り値(RaceData)をそのまま JSON.stringify したもの
  // (scripts/investigate-combo-odds-real-fetch.ts が書き出した形式)。ネットワークには出ない。
  const raceData = JSON.parse(raw) as RaceData;

  const deps: AnalysisPipelineDeps = {
    scrape: async () => raceData,
    // LLM未使用(analyze:null)。scorerが出すpriorがそのままadjustedProbになる(実prior)。
    analyze: null,
    saveAnalysis: () => 0,
    // Issue #59: このスクリプトでは配分提案の永続化を検証しない(この呼び出しでは配分計算を行わない)。
    allocationSettings: null,
  };
  // kaisaiDateを明示する(実レース日2026/06/28。#40「#35-1a」)。渡さないとresolveAnalysisDateが
  // 実行日(now())へフォールバックし、季節分類・休み明け走目の基準日が壁時計時刻とともに
  // ドリフトする(計測条件のJSDoc参照)。
  return runAnalysis(raceData.raceId, parseKaisaiDate("20260628"), deps);
}

/** AnalysisResultから、buildMixedCandidates/allocateGeneralBetsが要求する最小構造を取り出す。 */
function toMixedCandidateInput(result: AnalysisResult): MixedCandidateBuildInput {
  return {
    oddsStatus: result.oddsStatus,
    rows: result.rows,
    ...(result.wideCombo !== undefined ? { wideCombo: result.wideCombo } : {}),
    ...(result.trioCombo !== undefined ? { trioCombo: result.trioCombo } : {}),
    ...(result.comboOdds !== undefined ? { comboOdds: result.comboOdds } : {}),
  };
}

/**
 * 券種別(betType)に金額・点数を集計する(mixed-allocation-view.tsのbuildMixedAllocationBreakdownと
 * 同じ集計方式。Issue #76でumabans.lengthからの逆算をやめ、候補自身が運ぶbetTypeで集計する)。
 *
 * **Issue #96 AC-6: winを追加した。** #90で単勝(win)がアプリの配分提案に対応した後も
 * この集計はplace/wide/trioの3券種だけを見ていたため、構成比の合計が100%に満たない
 * (win分が構成比のどこにも計上されない)状態になっていた。
 */
function summarizeByBetType(
  allocations: readonly { readonly betType: AllocationBetType; readonly stake: number }[],
): { win: number; place: number; wide: number; trio: number } {
  const sumOf = (betType: AllocationBetType): number =>
    allocations.filter((a) => a.betType === betType).reduce((s, a) => s + a.stake, 0);
  return { win: sumOf("win"), place: sumOf("place"), wide: sumOf("wide"), trio: sumOf("trio") };
}

async function runGreedyStepsSensitivity(result: AnalysisResult): Promise<void> {
  const race = toMixedCandidateInput(result);
  const mixed = buildMixedCandidates(race, { evConfig: { threshold: 1.0 } });
  const horses: JointModelHorse[] = result.rows.map((r) => ({
    umaban: r.umaban,
    placeProb: r.adjustedProb,
  }));

  console.log("=== greedySteps 感度(中央16頭・実オッズ・実prior・λ=0.5) ===");
  console.log(
    `候補: 単勝${mixed.candidates.filter((c) => c.betType === "win").length}件 / ` +
      `複勝${mixed.candidates.filter((c) => c.betType === "place").length}件 / ` +
      `ワイド${mixed.candidates.filter((c) => c.betType === "wide").length}件 / ` +
      `三連複${mixed.candidates.filter((c) => c.betType === "trio").length}件`,
  );

  const scenarios: { readonly label: string; readonly bankroll: number; readonly perRaceCap: number }[] = [
    { label: "100万/100万", bankroll: 1_000_000, perRaceCap: 1_000_000 },
    { label: "100万/10万", bankroll: 1_000_000, perRaceCap: 100_000 },
    { label: "500万/500万", bankroll: 5_000_000, perRaceCap: 5_000_000 },
  ];
  const greedyStepsValues = [DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps, 400];

  for (const scenario of scenarios) {
    for (const greedySteps of greedyStepsValues) {
      const config: GeneralBetAllocationConfig = {
        bankroll: scenario.bankroll,
        perRaceCap: scenario.perRaceCap,
        kellyFraction: 0.5,
        betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
        greedySteps,
        candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
      };
      const alloc = allocateGeneralBets(horses, mixed.topFinishCount, mixed.candidates, config);
      const byType = summarizeByBetType(alloc.allocations);
      const total = alloc.totalStake;
      const pct = (n: number): string => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%");
      console.log(
        `  ${scenario.label} / greedySteps=${greedySteps}: ` +
          `総額${total.toLocaleString()}円 / ${alloc.betCount}点 / ` +
          `単勝${pct(byType.win)} / 複勝${pct(byType.place)} / ワイド${pct(byType.wide)} / 三連複${pct(byType.trio)}`,
      );
    }
  }
}

async function runPerRaceTiming(result: AnalysisResult): Promise<void> {
  const race = toMixedCandidateInput(result);
  const settings: MixedAllocationSettings = {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    // #24-D3a(Issue #115)で追加。Issue #117で`resolveMixedBetTypes`が接続されたため、
    // trueにすると候補ビルダーは実際に馬連を評価しにいく。ただし`toMixedCandidateInput`
    // (このファイル)は`result.quinellaCombo`をraceへ渡さないため、馬連の候補は常に0件
    // (unfetched)になり、配分額・構成比の出力は変わらない。一方、判定不能の分類自体は
    // 実行されるため、所要時間にはわずかな増分がありうる(実測で確認すること)。
    includeQuinellaInAllocation: true,
    // #24-E3a(Issue #124)で追加。Issue #125で`resolveMixedBetTypes`が接続されたため、
    // trueにすると候補ビルダーは実際に馬単を評価しにいく。ただし`toMixedCandidateInput`
    // (このファイル)は`result.exactaCombo`をraceへ渡さないため、馬単の候補は常に0件
    // (unfetched)になり、配分額・構成比の出力は変わらない(quinellaと同じ理由。AC-11参照)。
    includeExactaInAllocation: true,
    // #25-E3a(Issue #138)で追加。候補ビルダーはまだ三連単の候補を作らないため
    // (resolveMixedBetTypes未接続)、この値は感度表の出力に一切影響しない。
    includeTrifectaInAllocation: true,
    // #26-E3a(Issue #149)で追加。Issue #150(#26-E3b)で`resolveMixedBetTypes`が接続されたため、
    // trueにすると候補ビルダーは実際に枠連を評価しにいく。ただし`toMixedCandidateInput`(このファイル)は
    // `bracketQuinellaCombo`をraceへ渡さないため、枠連の候補は常に0件(unfetched)になり、配分額・構成比の
    // 出力は変わらない(馬連・馬単と同じ理由)。枠連を実オッズで評価した結果は下の5.節を参照。
    includeBracketQuinellaInAllocation: true,
  };

  // ウォームアップ1回(JITの影響を減らす)を除いた上で、実運用の1レース分の呼び出し
  // (buildMixedAllocationDisplay。既定greedySteps)を繰り返し計測する。
  buildMixedAllocationDisplay(race, settings);
  const iterations = 30;
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    buildMixedAllocationDisplay(race, settings);
    samples.push(performance.now() - t0);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const max = Math.max(...samples);
  console.log("");
  console.log("=== 1レースあたりの所要時間(buildMixedAllocationDisplay・既定greedySteps) ===");
  console.log(
    `平均${avg.toFixed(1)}ms / 最大${max.toFixed(1)}ms(n=${iterations}回・中央16頭。候補件数は上のgreedySteps感度の出力を参照)`,
  );
  console.log(
    `12レース一括分析の参考値(単純に12倍。実際は details 開閉等でレース単位に再計算される` +
      `〈AC21・mixed-allocation-cache.ts〉ため常に発生するわけではない): 約${(avg * 12).toFixed(0)}ms/レンダー`,
  );
}

/**
 * 券種別にstakeを集計する(`summarizeByBetType`の馬連・馬単・三連単版。Issue #116 AC-7・
 * Issue #122 AC-7で`exacta`、Issue #137 AC-6で`trifecta`を追加)。既存の
 * `summarizeByBetType`(win/place/wide/trioの4券種)は変更せず、この節専用に
 * `quinella`・`exacta`・`trifecta`を加えた別関数として持つ(既存節の出力を変えないため)。
 */
function summarizeByBetTypeWithQuinella(
  allocations: readonly { readonly betType: AllocationBetType; readonly stake: number }[],
): {
  win: number;
  place: number;
  wide: number;
  trio: number;
  quinella: number;
  exacta: number;
  trifecta: number;
} {
  const sumOf = (betType: AllocationBetType): number =>
    allocations.filter((a) => a.betType === betType).reduce((s, a) => s + a.stake, 0);
  return {
    win: sumOf("win"),
    place: sumOf("place"),
    wide: sumOf("wide"),
    trio: sumOf("trio"),
    quinella: sumOf("quinella"),
    exacta: sumOf("exacta"),
    trifecta: sumOf("trifecta"),
  };
}

/** 1回の`buildMixedCandidates`+`allocateGeneralBets`実行の計測結果。 */
interface QuinellaComparisonSample {
  readonly ms: number;
  readonly candidateCounts: Readonly<Record<string, number>>;
  readonly betCount: number;
  readonly totalStake: number;
  readonly byType: ReturnType<typeof summarizeByBetTypeWithQuinella>;
}

/**
 * 馬連(quinella)・馬単(exacta)を候補ビルダーに追加したときの性能・構成を実測する
 * (Issue #116 AC-7・Issue #122 AC-7で3条件目〈馬単〉を追加)。
 *
 * `betTypes=[place,win,wide,trio]`(馬連・馬単なし。**Issue #117で
 * `ALL_MIXED_CANDIDATE_BET_TYPES`に馬連が加わったため、この配列はもう既定値と同じではない**
 * 〈既定値は`[place,win,wide,quinella,trio]`〉。ここでは意図的に馬連・馬単を除いた比較用の
 * 配列として明示的に指定する)・`[place,win,wide,trio,quinella]`(馬連あり)・
 * `[place,win,wide,trio,quinella,exacta]`(馬単も追加。Issue #122 AC-7)の3条件を比較する。
 */
async function runQuinellaPerformanceComparison(result: AnalysisResult): Promise<void> {
  const baseRace = toMixedCandidateInput(result);
  const quinellaCombo = loadQuinellaCombo();
  const raceWithQuinella: MixedCandidateBuildInput = { ...baseRace, quinellaCombo };
  const exactaCombo = loadExactaCombo();
  const raceWithExacta: MixedCandidateBuildInput = { ...raceWithQuinella, exactaCombo };
  const trifectaCombo = loadTrifectaCombo();
  const raceWithTrifecta: MixedCandidateBuildInput = { ...raceWithExacta, trifectaCombo };
  const horses: JointModelHorse[] = result.rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb }));

  // Issue #137(AC-6・docs/current-spec.md向けのDBサイズ再現手段): trifectaComboを
  // JSON.stringifyしたバイト数を実測する(analyses.race_snapshot_jsonへ保存される
  // RaceSnapshot.trifectaComboと同じ形〈Record<string, number|null>〉・同じ変換経路)。
  // 再現: `pnpm tsx scripts/bench-mixed-allocation.ts` を実行しこの行の出力を見る。
  const trifectaComboJson = JSON.stringify(trifectaCombo);
  console.log("");
  console.log(
    `=== trifectaComboのJSONサイズ実測(中央16頭・実オッズ。Issue #137 AC-6・docs/current-spec.md向け) ===`,
  );
  console.log(
    `  キー数=${Object.keys(trifectaCombo).length}件(P(16,3)) / ` +
      `JSON.stringifyのバイト数=${trifectaComboJson.length}バイト` +
      `(analyses.race_snapshot_jsonへ保存されるRaceSnapshot.trifectaComboと同じ形)`,
  );

  const config: GeneralBetAllocationConfig = {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
    greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
    candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
  };

  const scenarios: readonly {
    readonly label: string;
    readonly race: MixedCandidateBuildInput;
    readonly betTypes: readonly AllocationBetType[];
  }[] = [
    { label: "馬連なし(place/win/wide/trio)", race: baseRace, betTypes: ["place", "win", "wide", "trio"] },
    {
      label: "馬連あり(place/win/wide/trio/quinella)",
      race: raceWithQuinella,
      betTypes: ["place", "win", "wide", "trio", "quinella"],
    },
    {
      label: "馬単も追加(place/win/wide/trio/quinella/exacta)",
      race: raceWithExacta,
      betTypes: ["place", "win", "wide", "trio", "quinella", "exacta"],
    },
    {
      label: "三連単も追加(place/win/wide/trio/quinella/exacta/trifecta)",
      race: raceWithTrifecta,
      betTypes: ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta"],
    },
  ];

  console.log("");
  console.log(
    "=== 馬連(quinella)・馬単(exacta)・三連単(trifecta)追加時の性能・構成比較(中央16頭・実オッズ。" +
      "Issue #116 AC-7・Issue #122 AC-7・Issue #137 AC-6) ===",
  );
  console.log(
    "    (本関数は4シナリオともbetTypesを明示的に指定するため、Issue #139で" +
      "ALL_MIXED_CANDIDATE_BET_TYPESに三連単が加わった後も、三連単なしの最初の3シナリオの" +
      "数値自体は変わらない〈既定値〈betTypes省略〉に依存する下記『greedySteps感度表』〈#1〉" +
      "とは異なる経路であることに注意〉)",
  );

  for (const scenario of scenarios) {
    const measure = (): QuinellaComparisonSample => {
      const t0 = performance.now();
      const mixed = buildMixedCandidates(scenario.race, {
        evConfig: { threshold: 1.0 },
        betTypes: scenario.betTypes,
      });
      const alloc = allocateGeneralBets(horses, mixed.topFinishCount, mixed.candidates, config);
      const ms = performance.now() - t0;
      const candidateCounts: Record<string, number> = {};
      for (const bt of scenario.betTypes) {
        candidateCounts[bt] = mixed.candidates.filter((c) => c.betType === bt).length;
      }
      return {
        ms,
        candidateCounts,
        betCount: alloc.betCount,
        totalStake: alloc.totalStake,
        byType: summarizeByBetTypeWithQuinella(alloc.allocations),
      };
    };

    measure(); // ウォームアップ1回(JITの影響を減らす。既存節と同じ流儀)。
    const iterations = 30;
    const samples: QuinellaComparisonSample[] = [];
    for (let i = 0; i < iterations; i++) {
      samples.push(measure());
    }
    const avgMs = samples.reduce((s, x) => s + x.ms, 0) / samples.length;
    // 候補数・配分結果は入力が同一なら決定的(乱数を使わない)なので、最後の1回を代表値として使う。
    const last = samples[samples.length - 1]!;
    const total = last.totalStake;
    const pct = (n: number): string => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%");
    console.log(`--- ${scenario.label} ---`);
    console.log(
      `  候補数: ${scenario.betTypes.map((bt) => `${bt}=${last.candidateCounts[bt]}件`).join(" / ")}`,
    );
    console.log(
      `  所要時間: 平均${avgMs.toFixed(1)}ms(n=${iterations}回・buildMixedCandidates+allocateGeneralBetsの合計)`,
    );
    console.log(
      `  配分: 総額${total.toLocaleString()}円 / ${last.betCount}点 / ` +
        `単勝${pct(last.byType.win)} / 複勝${pct(last.byType.place)} / ワイド${pct(last.byType.wide)} / ` +
        `三連複${pct(last.byType.trio)} / 馬連${pct(last.byType.quinella)} / 馬単${pct(last.byType.exacta)} / ` +
        `三連単${pct(last.byType.trifecta)}`,
    );
  }
}

/**
 * 枠連フィクスチャ(Issue #144 AC-性能)。`central-on.json`と同じレース(202603020211・16頭。
 * 全8枠が2頭ずつ=枠連36件)。
 */
const WAKUREN_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_wakuren_202603020211.json",
);

/** 枠連フィクスチャをパースしてオッズMap(キー: 枠番4桁)を作る(規則を再実装しない)。 */
function loadWakurenOddsMap(): Map<string, number | null> {
  const json = readFileSync(WAKUREN_FIXTURE_PATH, "utf-8");
  const parsed = parseComboOdds(json, "bracketQuinella");
  if (parsed.state !== "available") {
    throw new Error(`枠連フィクスチャが available ではありません(state=${parsed.state})`);
  }
  return toComboOddsScalarMap(parsed.odds);
}

/**
 * 署名畳み込み後のoutcome数(=`allocateGeneralBets`が`runGreedyAllocation`へ渡すoutcome件数)を
 * 数える。`allocateGeneralBets`の内部値で公開されていないため、ここで的中判定を**再実装**する
 * (順序付きoutcome空間から`indices`を作り`foldOutcomeIndexSetsBySignature`で畳む。
 * 製品と同じ手順)。再実装のずれを検出するため、呼び出し側は製品の`hitProb`との一致を検査する。
 */
function countFoldedOutcomes(
  horses: readonly BracketJointModelHorse[],
  topFinishCount: number,
  candidates: readonly AllocationCandidate[],
): { readonly foldedCount: number; readonly rawCount: number; readonly hitProbs: readonly number[] } {
  const ordered = PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, topFinishCount);
  if (ordered === null) {
    throw new Error("順序付きoutcome空間が判定不能です");
  }
  const wakubanOf = new Map(horses.map((h) => [h.umaban, h.wakuban] as const));
  const raw = ordered.map((outcome) => {
    const orderSet = new Set(outcome.order);
    const f0 = wakubanOf.get(outcome.order[0]!);
    const f1 = wakubanOf.get(outcome.order[1]!);
    const indices: number[] = [];
    candidates.forEach((c, i) => {
      const u = c.umabans;
      const hit =
        c.betType === "win"
          ? outcome.order[0] === u[0]
          : c.betType === "quinella"
            ? (outcome.order[0] === u[0] && outcome.order[1] === u[1]) ||
              (outcome.order[0] === u[1] && outcome.order[1] === u[0])
            : c.betType === "exacta"
              ? outcome.order[0] === u[0] && outcome.order[1] === u[1]
              : c.betType === "trifecta"
                ? outcome.order[0] === u[0] && outcome.order[1] === u[1] && outcome.order[2] === u[2]
                : c.betType === "bracketQuinella"
                  ? (f0 === u[0] && f1 === u[1]) || (f0 === u[1] && f1 === u[0])
                  : u.every((x) => orderSet.has(x));
      if (hit) indices.push(i);
    });
    return { indices, probability: outcome.probability };
  });
  const folded = foldOutcomeIndexSetsBySignature(raw);
  const hitProbs = new Array<number>(candidates.length).fill(0);
  for (const o of folded) {
    for (const idx of o.indices) hitProbs[idx] = hitProbs[idx]! + o.probability;
  }
  return { foldedCount: folded.length, rawCount: raw.length, hitProbs };
}

/**
 * 枠連(bracketQuinella)を7券種に足したときの署名畳み込み後のoutcome数・所要時間を実測する
 * (Issue #144〈#26-B〉)。枠連の候補は最大36件(C(8,2)+同枠8)で件数は小さいが、枠連の的中は
 * (枠(1着),枠(2着))の関数であり、同じ署名だったoutcomeが枠の組で分かれて畳み込みの粒度が
 * 細かくなりうるため、実測して悪化の有無を見る。
 */
async function runBracketQuinellaPerformanceComparison(result: AnalysisResult): Promise<void> {
  const baseRace = toMixedCandidateInput(result);
  const raceAll: MixedCandidateBuildInput = {
    ...baseRace,
    quinellaCombo: loadQuinellaCombo(),
    exactaCombo: loadExactaCombo(),
    trifectaCombo: loadTrifectaCombo(),
  };
  const allBetTypes: readonly AllocationBetType[] = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta"];
  const mixed = buildMixedCandidates(raceAll, { evConfig: { threshold: 1.0 }, betTypes: allBetTypes });
  const horses: BracketJointModelHorse[] = result.rows.map((r) => ({
    umaban: r.umaban,
    wakuban: r.wakuban,
    placeProb: r.adjustedProb,
  }));
  const wakurenOdds = loadWakurenOddsMap();
  const realEv = buildBracketQuinellaCandidates(horses, mixed.topFinishCount, wakurenOdds, { threshold: 1.0 });
  // 最悪ケース: 全36件をEVプラス扱いにする(threshold=0。ev>0なら候補。署名への影響の上界を見る)。
  const allBracket = buildBracketQuinellaCandidates(horses, mixed.topFinishCount, wakurenOdds, { threshold: 0 });

  const config: GeneralBetAllocationConfig = {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    betUnit: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.betUnit,
    greedySteps: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.greedySteps,
    candidateCap: DEFAULT_GENERAL_BET_ALLOCATION_CONFIG.candidateCap,
  };
  const scenarios: readonly { readonly label: string; readonly candidates: readonly AllocationCandidate[] }[] = [
    { label: "枠連なし(7券種)", candidates: mixed.candidates },
    { label: "枠連あり(EVプラスのみ)", candidates: [...mixed.candidates, ...realEv.candidates] },
    { label: "枠連あり(全36件をEVプラス扱い。最悪ケース)", candidates: [...mixed.candidates, ...allBracket.candidates] },
  ];

  console.log("");
  console.log("=== 枠連(bracketQuinella)追加時の署名畳み込み後outcome数・所要時間(中央16頭・実オッズ。Issue #144) ===");
  for (const scenario of scenarios) {
    const counted = countFoldedOutcomes(horses, mixed.topFinishCount, scenario.candidates);
    const alloc = allocateGeneralBets(horses, mixed.topFinishCount, scenario.candidates, config);
    // 再実装した的中判定と製品のhitProbが全候補で一致すること(ずれていれば計測が無意味)。
    const productHit = new Map(alloc.allocations.map((a) => [`${a.betType}:${a.umabans.join(",")}`, a.hitProb] as const));
    scenario.candidates.forEach((c, i) => {
      const ph = productHit.get(`${c.betType}:${c.umabans.join(",")}`);
      if (ph === undefined || Math.abs(ph - counted.hitProbs[i]!) > 1e-9) {
        throw new Error(`bench内の的中判定が製品とずれています(${c.betType}:${c.umabans.join(",")}, 製品=${ph}, bench=${counted.hitProbs[i]})`);
      }
    });
    const iterations = 30;
    const samples: number[] = [];
    allocateGeneralBets(horses, mixed.topFinishCount, scenario.candidates, config); // ウォームアップ
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      allocateGeneralBets(horses, mixed.topFinishCount, scenario.candidates, config);
      samples.push(performance.now() - t0);
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const bracketCount = scenario.candidates.filter((c) => c.betType === "bracketQuinella").length;
    console.log(
      `  ${scenario.label}: 候補${scenario.candidates.length}件(うち枠連${bracketCount}件) / ` +
        `順序付きoutcome${counted.rawCount}件 → 畳み込み後${counted.foldedCount}件 / ` +
        `allocateGeneralBets平均${avg.toFixed(1)}ms(n=${iterations}回) / 点数${alloc.betCount}`,
    );
  }
}

/** 未発売(8頭)の枠連フィクスチャ(Issue #150 AC-7の「入らないレース」用。中央・発売なしの応答)。 */
const WAKUREN_UNSOLD_FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "odds_wakuren_unsold_202607020505.json",
);

/** 枠連の取得結果(ComboOddsFetchOutcomeView)を最小構成で作る(診断値の中身はこの計測の関心事ではない)。 */
function bracketOutcome(state: "available" | "unavailable"): NonNullable<ComboOddsScrapeOutcomeView["bracketQuinella"]> {
  return {
    state,
    diagnostics: {
      betType: "bracketQuinella",
      requestCount: 1,
      expectedComboCount: 0,
      obtainedComboCount: 0,
      missingComboCount: 0,
      axisUmabans: [],
      attempts: [],
      numericConflictCount: 0,
      nullWinConflictCount: 0,
      conflictSamples: [],
    },
  };
}

/**
 * 枠連を配分に接続したときの実際の配分結果を実測する(Issue #150〈#26-E3b〉)。冒頭JSDocの5.を参照。
 * 経路は画面と同じ`buildMixedAllocationDisplay`(`buildMixedRaceAllocation`+表示データ導出)。
 */
async function runBracketQuinellaAllocationComparison(result: AnalysisResult): Promise<void> {
  const base = toMixedCandidateInput(result);
  const wakuren = parseComboOdds(readFileSync(WAKUREN_FIXTURE_PATH, "utf-8"), "bracketQuinella");
  if (wakuren.state !== "available") {
    throw new Error(`枠連フィクスチャが available ではありません(state=${wakuren.state})`);
  }
  const race16: MixedCandidateBuildInput = {
    ...base,
    quinellaCombo: loadQuinellaCombo(),
    exactaCombo: loadExactaCombo(),
    trifectaCombo: loadTrifectaCombo(),
    bracketQuinellaCombo: Object.fromEntries(toComboOddsScalarMap(wakuren.odds)),
    comboOdds: { ...base.comboOdds, bracketQuinella: bracketOutcome("available") },
  };
  const settingsOn: MixedAllocationSettings = {
    bankroll: 1_000_000,
    perRaceCap: 100_000,
    kellyFraction: 0.5,
    evThreshold: 1.0,
    includeComboOdds: true,
    includeWideInAllocation: true,
    includeTrioInAllocation: true,
    includeQuinellaInAllocation: true,
    includeExactaInAllocation: true,
    includeTrifectaInAllocation: true,
    includeBracketQuinellaInAllocation: true,
  };
  const settingsOff: MixedAllocationSettings = { ...settingsOn, includeBracketQuinellaInAllocation: false };

  // 「発売のないレース」(合成8頭)。ワイド・3連複は16頭の実オッズを馬番1〜8の組に絞る。
  const keepFirst8 = (record: Record<string, number | null> | undefined): Record<string, number | null> =>
    Object.fromEntries(
      Object.entries(record ?? {}).filter(([key]) => {
        const nums = key.match(/../g)!.map(Number);
        return nums.every((n) => n >= 1 && n <= 8);
      }),
    );
  const unsold = parseComboOdds(readFileSync(WAKUREN_UNSOLD_FIXTURE_PATH, "utf-8"), "bracketQuinella");
  const race8: MixedCandidateBuildInput = {
    oddsStatus: base.oddsStatus,
    rows: result.rows.filter((r) => r.umaban <= 8).map((r) => ({ ...r, wakuban: r.umaban })),
    wideCombo: keepFirst8(base.wideCombo),
    trioCombo: keepFirst8(base.trioCombo),
    bracketQuinellaCombo: {},
    comboOdds: { wide: base.comboOdds?.wide, trio: base.comboOdds?.trio, bracketQuinella: bracketOutcome("unavailable") },
  };
  const settings8: MixedAllocationSettings = {
    ...settingsOn,
    includeQuinellaInAllocation: false,
    includeExactaInAllocation: false,
    includeTrifectaInAllocation: false,
  };

  console.log("");
  console.log("=== 枠連(bracketQuinella)を配分に接続したときの配分結果(Issue #150・buildMixedAllocationDisplay・実運用と同じ経路) ===");
  console.log(`  (未発売フィクスチャのパース結果: state=${unsold.state}。8頭の例は出走馬を合成している。冒頭JSDoc 5.参照)`);
  const cases: readonly {
    readonly label: string;
    readonly race: MixedCandidateBuildInput;
    readonly settings: MixedAllocationSettings;
  }[] = [
    { label: "中央16頭・枠連ON(枠連が入るレース)", race: race16, settings: settingsOn },
    { label: "中央16頭・枠連OFF(同じレース。設定で入らない)", race: race16, settings: settingsOff },
    { label: "合成8頭・枠連ON(発売なし=unavailable。入らない)", race: race8, settings: settings8 },
  ];
  for (const c of cases) {
    const view = buildMixedAllocationDisplay(c.race, c.settings);
    if (view.kind !== "mixed") {
      console.log(`  ${c.label}: kind=${view.kind}(混在経路に入らなかった)`);
      continue;
    }
    const total = view.result.totalStake;
    const bracket = view.display.breakdown.bracketQuinella;
    const diag = view.diagnostics.bracketQuinella;
    const positive = diag.kind === "built" ? diag.build.judged.positiveCount : null;
    const pct = (n: number): string => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%");
    const iterations = 10;
    buildMixedAllocationDisplay(c.race, c.settings); // ウォームアップ
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      buildMixedAllocationDisplay(c.race, c.settings);
      samples.push(performance.now() - t0);
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log(
      `  ${c.label}: 総額${total.toLocaleString()}円 / ${view.result.betCount}点 / ` +
        `枠連 ${bracket.stake.toLocaleString()}円(${pct(bracket.stake)}) ${bracket.count}点 / ` +
        `枠連の候補(EVプラス)${positive === null ? "なし(対象外)" : `${positive}件`} / ` +
        `判定不能の合計${view.display.unjudged.oddsMissingCount + view.display.unjudged.oddsUnfetchedCount + view.display.unjudged.oddsMalformedCount}件 / ` +
        `枠連の注記=${view.display.bracketQuinellaNote ?? "なし"} / 平均${avg.toFixed(1)}ms(n=${iterations})`,
    );
  }
}

async function main(): Promise<void> {
  const result = await loadAnalysisResult();
  console.log(`raceId=${result.raceId} rows=${result.rows.length}頭 oddsStatus=${result.oddsStatus}`);
  await runGreedyStepsSensitivity(result);
  await runPerRaceTiming(result);
  await runQuinellaPerformanceComparison(result);
  await runBracketQuinellaPerformanceComparison(result);
  await runBracketQuinellaAllocationComparison(result);
}

// このファイルを直接実行したとき(`pnpm tsx scripts/bench-mixed-allocation.ts`)だけ計測一式を
// 走らせる。Issue #119(#24-C3)で`loadAnalysisResult`を他スクリプト
// (`scripts/verify-worker-pool-prepare.ts`)からexportして再利用するようにしたため、
// このガードが無いと**importしただけ**でも本スクリプトの計測一式(コンソール出力)が
// 副作用として実行されてしまう(単一定義の原則を守るための変更で、既存の直接実行時の
// 挙動・出力は一切変えない)。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}
