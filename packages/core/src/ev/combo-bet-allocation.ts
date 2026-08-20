/**
 * combo-bet-allocation — 買い目が「馬の組」になる券種(ワイド・三連複)への配分最適化の一般化
 * (機能D-2a・Issue #14)。
 *
 * 背景: 機能C-1/C-2で複勝専用に実装した `bet-allocation.ts` の配分ロジックを、ワイド・三連複が
 * 扱えるよう一般化する。boss着手前ゲート(2026-08-05)の決定に基づき、次の方針で実装した。
 *
 * 1. `bet-allocation.ts` の公開契約(allocateBetsのシグネチャ・AllocationHorse/BetAllocation/
 *    BetAllocationResult/BetAllocationConfigの各フィールド名・型・resolveEffectivePerRaceCapの
 *    公開場所)は一切変更しない。既存 `bet-allocation.test.ts` の80件は無改変のまま全件パスする
 *    (`git diff` で確認済み。報告参照)。`packages/app/**` も一切変更しない。
 * 2. 防御関数群・貪欲最適化・畳み込み・betUnit丸め・キャップ比例縮小・最低額ロジック・
 *    見送り理由の判定ロジック(文言を除く)は `allocation-primitives.ts` を通じて
 *    `bet-allocation.ts` と共有する(重複実装しない)。
 * 3. 見送り理由・advisoryの文言、券種固有フィールドは複勝側と独立して定義する(意図的な分離)。
 *
 * 2層構成:
 *   - 汎用エンジン `allocateGeneralBets`: 買い目候補(`AllocationCandidate`。umabans配列で
 *     券種非依存)を受け取り配分を最適化する。候補が単一馬(複勝)か組(ワイド・三連複)かに
 *     一切依存しない。**券種混在**(複勝1頭候補・ワイド2頭組・三連複3頭組を同じ配列に混ぜる)にも
 *     対応する(受け入れ条件8)。ただし本タスクでは renderer 配線・UI・設定は行わない
 *     (API形状のみ用意する)。
 *   - 候補ビルダー `buildComboCandidates`: ワイド・三連複向けに、出走馬番からの組合せ列挙・
 *     オッズMapからの4状態解決(present/missing/unfetched/malformed)・EV算出(既存
 *     `expected-value.ts` の `EvConfig`/`DEFAULT_EV_CONFIG` を再利用し閾値を二重定義しない)を
 *     行い、`allocateGeneralBets` への入力(`AllocationCandidate[]`)を作る。
 *
 * k(topFinishCount)についての重要な注意:
 *   ワイド・三連複の的中判定は「同時分布モデルが返す上位k着の集合に、買い目の全馬番が
 *   含まれるか(部分集合包含)」である。boss着手前ゲートで実測したフィクスチャ(5頭立てで
 *   複勝2点・ワイド3点=C(3,2))が示すとおり、ワイド・三連複はkが7頭以下でも常に3である。
 *   これは複勝の払戻対象人数(`resolvePlaceBetTarget().placeCount`。5〜7頭は対象外/4頭以下は
 *   非発売という別の判定)とは**無関係の独立した概念**である。呼び出し側は
 *   `resolvePlaceBetTarget` の結果をそのまま `topFinishCount` に流用してはならない
 *   (誤用するとワイド・三連複の的中確率が構造的に0になる。症状はテストで固定している。
 *   `combo-bet-allocation.test.ts`「kとplaceCountの分離」参照)。
 *
 * ## 数値防御カバレッジ表(受け入れ条件20。boss指摘2026-08-06「表がソースに残っていない」への対応)
 *
 * `allocateGeneralBets`/`buildComboCandidates`(本ファイル)が受け取る**外部由来の数値**を
 * 全数列挙する。会話・報告の中だけに存在する表はセッションが切れると失われる(#13の失敗形の
 * 再発)ため、本体のJSDocに固定する。次に本ファイルへ数値を追加する人は、この表に1行追加する
 * ことを忘れないこと。
 *
 * | 入力 | 経路 | 防御 | 方式 | 理由・テスト所在 |
 * |---|---|---|---|---|
 * | `topFinishCount` | `allocateGeneralBets`/`buildComboCandidates`両方(共有gatekeeper`validateTopFinishCount`) | あり | throw(非有限または負値。0・小数は許容) | 呼び出し側が構築する引数そのもの(市場データではない)。`topFinishCount=Infinity`は`place-joint-model.ts`の`k>=n`分岐に落ちて「健全に見える」非スキップ配分を返す(誤りが表面化しない最重症パターン、実測確認済み)。0・小数を許容するのは`place-joint-model.ts`が既にfloor+0クランプで意図的に許容している設計(`k===0`→`[{placed:[],probability:1}]`という明示的な契約)と非対称を作らないため。テスト: `combo-bet-allocation.test.ts`「topFinishCountの数値検証」describe |
 * | `comboSize` | `buildComboCandidates`(内部`kCombinationsOfUmabans`) | 部分的(構造的自己防御。追加防御はしない=対象外の判断) | 対象外(構造的自己防御) | ガード`k<=0\|\|k>items.length`は**NaN比較が常にfalseになるため、NaN・非整数(例:1.5)はこのガードを素通りする**(捕捉ではない)。ただし`backtrack`の停止条件`current.length===k`は`current.length`が常に整数であるためNaN/非整数と一致し得ず、深さ優先探索は**2^n通りの部分集合を最後まで歩いた末に**結果が空配列に収束する(早期returnではない)。実測(本ファイル筆者・n=18・k=NaN): 約4.6ms、k=1.5でも約2.4ms(負値・0・Infinityは`k<=0\|\|k>items.length`ガードで即座に捕捉され約0.001ms)。頭数は最大18で有界なので実用上は無害だが、将来`items`の上限を引き上げる変更をする者はこの2^n探索の存在を踏まえること |
 * | `AllocationCandidate.umabans`(各要素) | `allocateGeneralBets`(gatekeeper`validateCandidates`) | あり | throw(非有限または0以下) | `NaN<=NaN`は常にfalseなので昇順チェックだけでは素通りする。`combo-bet-allocation.test.ts`「入力の正規化」describe(umaban=NaN/0/負値のit.each) |
 * | `AllocationCandidate.odds` | `allocateGeneralBets`(gatekeeper`validateCandidates`) | あり | throw(非有限または0以下) | `combo-bet-allocation.test.ts`「候補の数値検証(odds/evの異常値)」describe |
 * | `AllocationCandidate.ev` | `allocateGeneralBets`(gatekeeper`validateCandidates`) | あり | throw(非有限) | 同上 |
 * | `oddsByKey`の値(`ReadonlyMap<string, number\|null>`) | `resolveComboOdds`/`buildComboCandidates`(classifier) | あり | 分類(`malformed`→`unjudged.oddsMalformedCount`。throwしない) | 最大987組を1件ずつ分類するのが仕事であり、1組の異常値のために残りの健全な分類結果を失うのは誤り。`combo-bet-allocation.test.ts`「オッズ4区分」describe |
 * | `evConfig.threshold` | `computeRaceEv`/`computeEstimatedRaceEv`(expected-value.ts)/`buildComboCandidates`(3箇所共有`resolveEvThreshold`) | あり | 既定値フォールバック(非有限→`DEFAULT_EV_CONFIG.threshold`=1.0) | 片側だけ守ると`ev>threshold`の比較が壊れた側だけ壊れる非対称が生まれるため3箇所で共有。`expected-value.test.ts`の`resolveEvThreshold`describe、`combo-bet-allocation.test.ts`「evConfig.thresholdの防御」describe |
 * | `GeneralBetAllocationConfig.candidateCap` | `allocateGeneralBets`(`resolveCandidateCap`) | あり | 既定値フォールバック(非有限・0以下→2000。暴走ガードとして再定義。旧来の性能チューニング値ではない) | `combo-bet-allocation.test.ts`「候補上限(候補cap)の境界」describe |
 * | `GeneralBetAllocationConfig.bankroll`/`perRaceCap`/`betUnit`/`greedySteps`/`kellyFraction` | `allocateGeneralBets`(`allocation-primitives.ts`の`resolveBankroll`等。複勝経路`bet-allocation.ts`と共有・D-2aでの変更なし) | あり(pre-existing) | 既定値フォールバック | `combo-bet-allocation.test.ts`「既存の防御が組合せでも生きること」describe |
 * | `horses[].placeProb` | `allocateGeneralBets`/`buildComboCandidates`(`model.buildDistribution`。`place-joint-model.ts`、D-2a未変更) | あり(pre-existing) | 対象外(既存防御に委ねる) | `place-joint-model.ts`が`[EPS,1-EPS]`クランプ+分母非有限時の均等分布フォールバックで吸収する(同ファイルのJSDocに明記済みの設計)。実測(本ファイル筆者): `placeProb`にNaN/±Infinity/-5を注入しても`allocateGeneralBets`の`totalStake`は常に有限値(クラッシュなし)。`bet-allocation.ts`の`allocateBets`と全く同一の消費パターンであり、D-2aが新規に開いた経路ではない |
 * | `horses[].umaban` | `allocateGeneralBets`(`model.buildDistribution`経由の同時分布)/`buildComboCandidates`(組合せ列挙の元データ) | あり(2つの異なる経路それぞれで) | 対象外(前者)+throw(後者、`allocateGeneralBets`への受け渡し時に`validateCandidates`が捕捉) | 実測(本ファイル筆者): (1)`allocateGeneralBets`が直接受け取る`horses[].umaban`が非有限でも、`foldToCandidateSubsets`が`candidateUmabanSet`(検証済み候補の馬番のみを含む集合)でフィルタするため、健全な候補のtotalStakeは不変(baseline一致を確認)。(2)一方、`buildComboCandidates`は`horses[].umaban`をそのまま組合せ列挙に使うため、非有限な馬番が`AllocationCandidate.umabans`に紛れ込んだ候補を生成しうる(実測: `isPositive:true`の候補として生成されるケースを確認)。この候補がそのまま`allocateGeneralBets`に渡されると`validateCandidates`が例外を投げて可視化する(実測で確認)。**buildComboCandidates自身はこの値を検証しない**(gatekeeperではなくclassifierであるため)ことに注意 |
 *
 * ## D-3(#15)・D-2b(#27)への申し送り(boss指摘2026-08-06)
 *
 * `allocateGeneralBets`/`buildComboCandidates`は契約違反(候補の構造・数値異常、topFinishCount異常)を
 * throwで止める設計にした(複勝専用の`allocateBets`が同種の異常を無防備のまま許容しているのとは
 * 対照的。`allocateBets`側にthrowを入れなかった理由は#31参照)。D-3でrenderer側からこれらを呼ぶ際、
 * `BatchAnalysisView.tsx:625`のようにrender内で直接呼ぶと未捕捉例外=画面クラッシュになる。
 * **呼び出し前に候補を検証して弾くか、error boundaryを置くこと。**
 *
 * **この受け皿は充足済み(Issue #31・2026-08-20時点で確認)。** `packages/app/src/renderer/
 * mixed-allocation-view.ts` が `allocateGeneralBets` の呼び出しをtry/catchで保護し、例外を
 * `MixedRaceAllocationInvalid`(`kind:"invalid"`)へ変換して他レースの計算・画面全体に波及させない
 * (受け皿の実体はtry/catchブロック本体。表示側のテストは`packages/app/test/
 * mixed-allocation-view.test.ts`のAC17〈5件〉が固定している)。D-3着手時に改めて受け皿を
 * 新設する必要はない。
 */

import {
  DEFAULT_EV_CONFIG,
  resolveEvThreshold,
  type EvConfig,
} from "./expected-value.js";
import { buildComboOddsKey } from "../scraper/combo-odds-key.js";
import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
  type PlaceJointModel,
  type PlaceOutcome,
} from "./place-joint-model.js";
import {
  applyMinimumStake,
  buildOutcomeIndexSets,
  computeKellyTarget,
  DEFAULT_BET_UNIT,
  DEFAULT_GREEDY_STEPS,
  DEFAULT_KELLY_FRACTION,
  determineSkipReasonCode,
  foldToCandidateSubsets,
  isUsableOdds,
  resolveBankroll,
  resolveBetUnit,
  resolveEffectivePerRaceCap,
  resolveGreedySteps,
  resolveKellyFraction,
  roundStakes,
  runGreedyAllocation,
  type OutcomeIndexSet,
  type SkipReasonCode,
} from "./allocation-primitives.js";

export type { JointModelHorse, PlaceJointModel, PlaceOutcome, EvConfig };
export { CONDITIONAL_BERNOULLI_MODEL, DEFAULT_EV_CONFIG };

// ============================================================================
// 汎用エンジン(券種非依存)
// ============================================================================

/**
 * 券種一般の買い目候補(構造的最小型)。複勝なら `umabans.length===1`、ワイドなら2、
 * 三連複なら3。odds/ev/isPositiveは呼び出し側(buildComboCandidates等)が算出済みの値を渡す。
 *
 * 契約: umabansは**昇順・重複なし**であること。違反する候補が1件でも含まれる場合、
 * `allocateGeneralBets` は例外を投げる(黙って通さない。受け入れ条件7)。
 */
export interface AllocationCandidate {
  /** 買い目を構成する馬番の組(昇順・重複なし)。 */
  readonly umabans: readonly number[];
  /**
   * 採用したオッズ(単一値)。
   *
   * **ワイドは下限を使う(保守的見積り)**。既存 `expected-value.ts` の
   * `computeRaceEv`(複勝EV = placeProb × placeOddsMin)が複勝オッズの下限を採用している流儀を
   * 踏襲する。ワイドは最終配当が下限〜上限のレンジで確定する券種であり(仕様「4. ev — 期待値計算」
   * のコメント参照)、下限を使うとEVを過小評価する方向に倒れるため、EVプラス判定・配分計算が
   * 楽観的にならない(妙味を過大評価しない)。三連複はオッズが単一値で確定しているため、
   * そのまま採用する(下限/上限の選択問題自体が存在しない。
   * `docs/wide-trio-odds-investigation.md` §2.3「ワイドは幅(下限-上限)、3連複は単一値」参照)。
   *
   * **本モジュールはスカラー(既に1つに決まったオッズ値)を受け取る契約であり、
   * レンジ(下限-上限)から下限を選び出す変換ロジック自体は本モジュールに存在しない。**
   * その変換は呼び出し側(D-2b、Issue #27でのオッズ取得・配線実装)の責務である。
   * 誤解を避けるための明記: `buildComboCandidates` の `oddsByKey: ReadonlyMap<string, number | null>`
   * も同様にスカラー値を受け取るのみで、ワイドのレンジ表現(例: `[下限, 上限, 人気]`)から
   * 下限を取り出す処理は呼び出し側が済ませてから渡す必要がある。
   */
  readonly odds: number;
  /** 期待値(的中確率×odds)。 */
  readonly ev: number;
  /** EVプラス判定。falseの候補は最適化対象から除外される。 */
  readonly isPositive: boolean;
}

/**
 * 候補上限の既定値。
 *
 * **位置づけの変更(boss指摘・2026-08-05): 性能のための打ち切りとしては廃止し、
 * 「暴走ガード」に位置づけを変えた。** 当初(本実装時点)はcandidateCapを「計算量を
 * 抑えるための実用的な間引き」として既定50で運用していたが、`runGreedyAllocation`
 * (allocation-primitives.ts)を「候補数×outcome数」から「outcome数+総接触数」へ
 * 計算量最適化したことで、現実的な最大(18頭・複勝+ワイド+3連複混在=987候補)でも
 * candidateCapを外して秒未満で完了することを確認した(`pnpm tsx scripts/bench-allocation.ts`
 * で再現可能)。したがって候補cap=50を「性能を守るための間引き」として使い続けると、
 * **ケリー配分の質そのものを歪める**(候補を減らすと分散投資による相関緩和が効かなくなり、
 * 貪欲法が浅い局所解で止まる。boss実測: cap=50でΣx*=0.093、無制限でΣx*=0.854、
 * betCountがcap=50で13件・無制限で113件という大きな差が出た)。
 *
 * 既定値は「18頭の現実的な最大987候補では発動しない」ことを条件に、明らかに異常な
 * 候補数(データ生成バグ・呼び出し側の誤用等)からの暴走だけを止める安全弁として、
 * 実際に想定される最大値に十分な余裕を持たせた2000とした(987の2倍強)。
 * 候補上限を意図的に絞りたい場合は `GeneralBetAllocationConfig.candidateCap` を
 * 明示的に指定すること(既定値はもはや「性能チューニングの推奨値」ではない)。
 */
export const DEFAULT_CANDIDATE_CAP = 2000;

/** 券種一般の配分最適化設定。bet-allocation.tsのBetAllocationConfigに candidateCap を加えた形。 */
export interface GeneralBetAllocationConfig {
  readonly bankroll: number;
  readonly perRaceCap: number;
  readonly kellyFraction: number;
  readonly betUnit: number;
  readonly greedySteps: number;
  /**
   * 最適化に渡す候補数の上限(EV降順・同値は馬番配列の辞書順でタイブレークして選抜)。
   * **暴走ガードであり、性能チューニングのためのパラメータではない**(DEFAULT_CANDIDATE_CAPの
   * JSDoc参照)。既定値(2000)は現実的な最大候補数を大きく上回るため通常は発動しない。
   */
  readonly candidateCap: number;
}

/** 既定の券種一般配分設定。数値既定値は allocation-primitives.ts を参照し二重定義しない。 */
export const DEFAULT_GENERAL_BET_ALLOCATION_CONFIG: GeneralBetAllocationConfig = {
  bankroll: 0,
  perRaceCap: 0,
  kellyFraction: DEFAULT_KELLY_FRACTION,
  betUnit: DEFAULT_BET_UNIT,
  greedySteps: DEFAULT_GREEDY_STEPS,
  candidateCap: DEFAULT_CANDIDATE_CAP,
};

/**
 * 1買い目分の配分結果。
 * bet-allocation.tsのBetAllocationとの違い(意図的な分離):
 *   - umaban(number) ではなく umabans(number[])。
 *   - 「全出走馬を0円で含める」契約は採らない。最適化に載せた買い目(候補cap適用後)だけを
 *     行として返す(候補外・オッズ欠損・未取得の買い目は診断値の件数で表現し、行としては
 *     出さない。決定: 組合せ券種は「候補として最適化に載せた買い目」だけを行として返す)。
 *   - placeProb(入力echo)ではなく hitProb(同時分布から**導出**した値)。組合せ候補の的中確率は
 *     外部から与えられる入力ではなく、同時分布から計算するしかないため。
 */
export interface GeneralBetAllocation {
  /** 買い目を構成する馬番の組(昇順・重複なし)。 */
  readonly umabans: readonly number[];
  /** 実際の配分額(円。betUnitの倍数)。 */
  readonly stake: number;
  /** λ縮小前の連続最適比率 x*_i。 */
  readonly continuousFraction: number;
  /** λ縮小後の比率(cap前の理論値)。 */
  readonly scaledFraction: number;
  /** 同時分布から導出したこの買い目の的中確率。 */
  readonly hitProb: number;
  /** 採用したオッズ。 */
  readonly odds: number;
  /** 期待値。 */
  readonly ev: number;
  /** 正の連続配分を得たが丸めで0円になったか。 */
  readonly droppedBelowMinimum: boolean;
}

/**
 * 券種一般の配分最適化の診断値。判定結果(judged)と判定不能(unjudged)を型レベルで
 * 混同させない(決定6)。本エンジン自体は「isPositiveな入力候補」しか受け取らないため、
 * EV非プラス/オッズ欠損/未取得の内訳は候補ビルダー側(ComboCandidateDiagnostics)が持つ。
 * 本エンジンが独自に持つのは「候補cap適用前後」の件数のみ。
 */
export interface GeneralBetAllocationDiagnostics {
  /** isPositiveな入力候補の数(candidateCap適用前)。 */
  readonly inputCandidateCount: number;
  /**
   * candidateCap(暴走ガード。DEFAULT_CANDIDATE_CAPのJSDoc参照)により最適化から
   * 切り捨てられた候補数。既定値では通常0(現実的な候補数を大きく上回るため)。
   * 0でない場合は、候補数が想定を超える異常な状態(データ生成バグ等)を疑うべき。
   */
  readonly truncatedByCapCount: number;
  /** 実際に最適化に載せた候補数(= min(inputCandidateCount, candidateCap))。 */
  readonly candidateCount: number;
  /**
   * 貪欲逐次配分が「収束」(増分の最大値が0以下になり自然停止)したか。
   * false は greedySteps を使い切って打ち切られたことを意味し、「収束した」とは言えない
   * (boss指摘2026-08-05: 無制限側でΣx*=1.000になっていたのは収束の証拠ではなく、
   * greedyStepsを使い切って総資金の100%を配分する解を返しただけだった)。
   * 複勝経路(bet-allocation.ts)はこの値を受け取って捨てる(公開型に追加しない)ため、
   * 誤読を防ぐ役目は組合せ経路のこのフィールドが担う。
   */
  readonly converged: boolean;
}

/** 券種一般の配分最適化結果。 */
export interface GeneralBetAllocationResult {
  /** 最適化に載せた買い目だけ(馬番配列の辞書順で決定的)。 */
  readonly allocations: readonly GeneralBetAllocation[];
  readonly totalStake: number;
  readonly bankrollInput: number;
  readonly perRaceCapInput: number;
  readonly resolvedBankroll: number;
  readonly effectivePerRaceCap: number;
  readonly kellyTargetStake: number;
  readonly plannedStake: number;
  readonly capApplied: boolean;
  readonly minimumStakeApplied: boolean;
  readonly exceedsKellyTarget: boolean;
  readonly advisory: string | null;
  readonly kellyFraction: number;
  readonly betCount: number;
  readonly isSkip: boolean;
  readonly skipReason: string | null;
  readonly notDiversified: boolean;
  readonly modelId: string;
  readonly modelApproximate: boolean;
  readonly diagnostics: GeneralBetAllocationDiagnostics;
}

/** 見送り理由(券種一般。決定3: 語は「買い目」に統一)。 */
const REASON_BANKROLL_UNSET = "総資金が未設定のため配分を提案していません";
const REASON_CAP_UNSET = "1レースの上限が未設定のため配分を提案していません";
const REASON_KELLY_ZERO = "ケリー係数が0のため配分しません";
const REASON_NO_CANDIDATES = "EVプラスの買い目がないため見送りです";
const REASON_NO_EDGE = "妙味が小さく、賭ける価値のある配分が見つかりませんでした";

function buildCapTooSmallReason(betUnit: number): string {
  return `1レースの上限が${betUnit}円未満のため配分できません`;
}

/** 見送り理由コード(allocation-primitives.ts)を券種一般の日本語文言へ変換する。 */
function skipReasonText(code: SkipReasonCode, betUnit: number): string {
  switch (code) {
    case "bankroll-unset":
      return REASON_BANKROLL_UNSET;
    case "cap-unset":
      return REASON_CAP_UNSET;
    case "cap-too-small":
      return buildCapTooSmallReason(betUnit);
    case "kelly-zero":
      return REASON_KELLY_ZERO;
    case "no-candidates":
      return REASON_NO_CANDIDATES;
    case "no-edge":
      return REASON_NO_EDGE;
  }
}

/** 適正額超過の警告文言(bet-allocation.tsと同内容だが、決定3により独立して定義する)。 */
function buildAdvisory(exceedsKellyTarget: boolean, kellyTargetStake: number, betUnit: number): string | null {
  if (!exceedsKellyTarget) {
    return null;
  }
  const kellyTargetYen = Math.round(kellyTargetStake);
  return (
    `ケリー適正額 ¥${kellyTargetYen} に対し、最小単位の${betUnit}円を配分しています。` +
    "適正額を上回る賭け方であり、長期的な資産成長率を下げます。"
  );
}

/**
 * candidateCap(候補上限)を防御する。非有限・0以下・非整数は既定値(50)へフォールバックする
 * (resolveBetUnit等と同じ流儀)。
 */
function resolveCandidateCap(candidateCap: number): number {
  if (!Number.isFinite(candidateCap) || candidateCap <= 0 || !Number.isInteger(candidateCap)) {
    return DEFAULT_CANDIDATE_CAP;
  }
  return candidateCap;
}

/** 馬番配列を辞書順(要素ごとの昇順、長さが異なれば短い方を先)で比較する。 */
function compareUmabansLex(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! - b[i]!;
    }
  }
  return a.length - b.length;
}

/** 候補cap選抜用の比較(EV降順、同値は馬番配列の辞書順=決定5)。 */
function compareCandidatesForCap(a: AllocationCandidate, b: AllocationCandidate): number {
  if (a.ev !== b.ev) {
    return b.ev - a.ev;
  }
  return compareUmabansLex(a.umabans, b.umabans);
}

/**
 * topFinishCount(上位何着まで)を検証する(gatekeeper。受け入れ条件20の走査・
 * code-reviewer実測2026-08-06で発見)。`allocateGeneralBets`/`buildComboCandidates`の
 * 両方が受け取る値であり、防御を本関数1箇所に集約して重複実装を避ける(受け入れ条件15、
 * 「片側だけ守って非対称を作らない」原則)。
 *
 * 実測で確認したリスク: topFinishCount=Infinityを`allocateGeneralBets`に渡すと、
 * place-joint-model.tsの「k>=n」分岐(全頭が同時に複勝圏内)に落ちて、isSkip=false・
 * 一見健全な非スキップの配分を返してしまう(誤りが結果から一切気づけない=最も重い
 * サイレント破損の形)。topFinishCountはoddsByKeyのような外部データ(スクレイピング結果)
 * ではなく呼び出し側が構築する引数そのものなので、受け入れ条件18の「呼び出し側構築の
 * 引数の契約違反→throw」に該当する(classifyしない)。
 *
 * 0・小数は許容する(place-joint-model.tsが既にfloor+0クランプで意図的に許容している
 * 設計に合わせ、同ファイルの既存トレランス方針と非対称にしない)。
 */
function validateTopFinishCount(topFinishCount: number): void {
  if (!Number.isFinite(topFinishCount) || topFinishCount < 0) {
    throw new Error(
      `不正なtopFinishCountです: 非負の有限値である必要があります(topFinishCount=${topFinishCount})`,
    );
  }
}

/**
 * 候補の正規化を検証する(受け入れ条件7)。馬番の組が「厳密な昇順」(=重複なし)でない候補、
 * または同じ組が複数回登場する場合は例外を投げる(黙って通さない)。
 */
function validateCandidates(candidates: readonly AllocationCandidate[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const { umabans, odds, ev } = candidate;
    if (umabans.length === 0) {
      throw new Error("不正な買い目です: 馬番の組が空です");
    }
    // 馬番自体の数値検証(受け入れ条件20の走査で発見。boss指摘2026-08-06の水平展開)。
    // 「昇順・重複なし」の比較(umabans[i] <= umabans[i-1])はNaN同士の比較が常にfalseになるため、
    // umaban=NaNは何個並んでいても素通りしてしまう(NaN<=NaNはfalse)。馬番自体が正の有限値で
    // あることを別途検証する(odds/evと同じ基準)。
    for (const u of umabans) {
      if (!Number.isFinite(u) || u <= 0) {
        throw new Error(
          `不正な買い目です: 馬番は正の有限値である必要があります(umabans=${umabans.join(",")}, 不正な値=${u})`,
        );
      }
    }
    for (let i = 1; i < umabans.length; i++) {
      if (umabans[i]! <= umabans[i - 1]!) {
        throw new Error(
          `不正な買い目です: 馬番の組は昇順・重複なしである必要があります(${umabans.join(",")})`,
        );
      }
    }
    const key = umabans.join(",");
    if (seen.has(key)) {
      throw new Error(`重複した買い目が含まれています(${key})`);
    }
    seen.add(key);

    // 数値(odds/ev)の検証(boss差し戻し・2026-08-06)。
    // 「サイレント破損」欠陥クラスの再発防止: payout計算(trialX[idx]*odds[idx])に
    // NaN/Infinityが1件でも混じると、貪欲ループのcurrentF・全候補の増分がNaN汚染され、
    // `NaN > 0` は常にfalseのため`bestIdx=-1`(=収束)に化ける。無関係な1候補の異常値が、
    // 他の健全な候補の配分まで巻き添えで消し、「妙味が小さく、賭ける価値のある配分が
    // 見つかりませんでした」という**判定結果**として誤って報告してしまう
    // (実際は「判定できていない」状態であり、判定結果と区別できないまま握り潰される)。
    // 構造検証(umabans)と同じく throw に揃える(除外して続行する設計は採らない。
    // 異常値を黙って除外すると「判定不能」が「候補外」に混ざり、受け入れ条件16
    // 〈オッズ状態分離〉の思想と矛盾するため。呼び出し側が気づくべき異常である)。
    // 判定基準は allocation-primitives.ts の isUsableOdds に委譲する(Issue #31。
    // resolveComboOdds・bet-allocation.tsの候補フィルタと同一基準を1箇所で共有する)。
    if (!isUsableOdds(odds)) {
      throw new Error(
        `不正な買い目です: oddsは正の有限値である必要があります(umabans=${umabans.join(",")}, odds=${odds})`,
      );
    }
    // evの非有限チェック: compareCandidatesForCapの `b.ev - a.ev` がNaNを返すと
    // Array#sortの比較関数契約(有限数を返す)に違反し、候補cap選抜の結果が
    // 実装依存で非決定的になる副次的な問題も防ぐ。
    if (!Number.isFinite(ev)) {
      throw new Error(
        `不正な買い目です: evは有限値である必要があります(umabans=${umabans.join(",")}, ev=${ev})`,
      );
    }
  }
}

/** 畳み込み済みoutcomeから各候補の的中確率(周辺確率)を導出する。 */
function computeHitProbabilities(n: number, outcomeIndexSets: readonly OutcomeIndexSet[]): number[] {
  const hitProbs = new Array<number>(n).fill(0);
  for (const outcome of outcomeIndexSets) {
    for (const idx of outcome.indices) {
      hitProbs[idx] = hitProbs[idx]! + outcome.probability;
    }
  }
  return hitProbs;
}

/**
 * 券種一般の馬券配分を最適化する。買い目候補(AllocationCandidate)は単一馬(複勝)・
 * 2頭組(ワイド)・3頭組(三連複)のいずれでもよく、**混在してもよい**(受け入れ条件8)。
 *
 * @param horses 出走全頭(候補に限らない。同時分布は全頭の複勝圏内確率に依存するため)
 * @param topFinishCount 上位何着までを的中判定に使うか。**複勝の払戻対象人数
 *   (resolvePlaceBetTarget().placeCount)とは別概念**。ワイド・三連複では常に3を渡すこと
 *   (誤って複勝の対象人数を流用すると的中確率が構造的に0になる。JSDoc冒頭参照)。
 * @param candidates 買い目候補。isPositive===falseの候補は最適化対象から除外される
 *   (0件行としても出力されない。判定結果の内訳は呼び出し側〈候補ビルダー〉の診断値が持つ)。
 * @param config 配分設定(省略時は既定・bankroll=perRaceCap=0=未設定)
 * @param model 同時分布モデル(省略時は条件付きベルヌーイ)
 */
export function allocateGeneralBets(
  horses: readonly JointModelHorse[],
  topFinishCount: number,
  candidates: readonly AllocationCandidate[],
  config: GeneralBetAllocationConfig = DEFAULT_GENERAL_BET_ALLOCATION_CONFIG,
  model: PlaceJointModel = CONDITIONAL_BERNOULLI_MODEL,
): GeneralBetAllocationResult {
  validateTopFinishCount(topFinishCount);
  validateCandidates(candidates);

  const bankrollInput = config.bankroll;
  const perRaceCapInput = config.perRaceCap;
  const betUnit = resolveBetUnit(config.betUnit);
  const greedySteps = resolveGreedySteps(config.greedySteps);
  const kellyFraction = resolveKellyFraction(config.kellyFraction);
  const candidateCap = resolveCandidateCap(config.candidateCap);

  const resolvedBankroll = resolveBankroll(bankrollInput);
  const effectivePerRaceCap = resolveEffectivePerRaceCap(perRaceCapInput, betUnit);

  // isPositiveな候補だけを対象にする(bet-allocation.tsのStep1と同じ思想)。
  const positiveCandidates = candidates.filter((c) => c.isPositive);

  // 候補cap: EV降順・同値は馬番配列の辞書順で選抜する(決定5)。
  const rankedForCap = [...positiveCandidates].sort(compareCandidatesForCap);
  const truncatedByCapCount = Math.max(0, rankedForCap.length - candidateCap);
  const selected = rankedForCap.slice(0, candidateCap);

  // 最適化・出力の順序は馬番配列の辞書順で安定させる(受け入れ条件11: 出力の決定性)。
  const finalCandidates = [...selected].sort((a, b) => compareUmabansLex(a.umabans, b.umabans));

  const candidateUmabanSet = new Set<number>();
  for (const c of finalCandidates) {
    for (const u of c.umabans) {
      candidateUmabanSet.add(u);
    }
  }

  const rawDistribution = model.buildDistribution(horses, topFinishCount);
  const foldedOutcomes = foldToCandidateSubsets(rawDistribution, candidateUmabanSet);
  const outcomeIndexSets = buildOutcomeIndexSets(finalCandidates, foldedOutcomes, (c, outcome) =>
    c.umabans.every((u) => outcome.placed.includes(u)),
  );
  const hitProbs = computeHitProbabilities(finalCandidates.length, outcomeIndexSets);
  const odds = finalCandidates.map((c) => c.odds);
  // runGreedyAllocationは{fractions, converged}を返す(機能D-2a・boss指摘2026-08-05)。
  // convergedは組合せ経路では診断値に載せる(複勝経路は受け取って捨てるのと対照的。
  // 「無制限側のΣx*=1.000はgreedyStepsを使い切っただけで収束ではない」という誤読を
  // 防ぐため、判定結果を利用者に見える形で残す)。
  const { fractions: continuousFractions, converged } = runGreedyAllocation(
    finalCandidates.length,
    odds,
    outcomeIndexSets,
    greedySteps,
  );
  const sumContinuousFractions = continuousFractions.reduce((acc, x) => acc + x, 0);

  const { kellyTargetStake, plannedStake, capApplied, s } = computeKellyTarget(
    kellyFraction,
    sumContinuousFractions,
    resolvedBankroll,
    effectivePerRaceCap,
  );

  const rounded = roundStakes(continuousFractions, kellyFraction, s, resolvedBankroll, betUnit);
  let rawStakes = rounded.rawStakes;
  let totalStake = rounded.totalStake;

  const minimumStakeResult = applyMinimumStake(
    rawStakes,
    continuousFractions,
    totalStake,
    finalCandidates.length,
    resolvedBankroll,
    effectivePerRaceCap,
    betUnit,
    kellyTargetStake,
  );
  rawStakes = minimumStakeResult.rawStakes;
  totalStake = minimumStakeResult.totalStake;
  const minimumStakeApplied = minimumStakeResult.minimumStakeApplied;

  // 丸め判定に到達したかどうか(bet-allocation.tsと同じ防御)。
  const reachedRoundingDecision = resolvedBankroll > 0 && effectivePerRaceCap >= betUnit;

  const allocations: GeneralBetAllocation[] = finalCandidates.map((c, i) => {
    const continuousFraction = continuousFractions[i]!;
    const stake = rawStakes[i]!;
    return {
      umabans: c.umabans,
      stake,
      continuousFraction,
      scaledFraction: kellyFraction * continuousFraction,
      hitProb: hitProbs[i]!,
      odds: c.odds,
      ev: c.ev,
      droppedBelowMinimum: continuousFraction > 0 && stake === 0 && reachedRoundingDecision,
    };
  });

  const betCount = allocations.filter((a) => a.stake > 0).length;
  const isSkip = totalStake === 0;
  const exceedsKellyTarget = totalStake > kellyTargetStake;
  const advisory = buildAdvisory(exceedsKellyTarget, kellyTargetStake, betUnit);

  const skipReason = isSkip
    ? skipReasonText(
        determineSkipReasonCode(
          bankrollInput,
          perRaceCapInput,
          effectivePerRaceCap,
          betUnit,
          kellyTargetStake,
          kellyFraction,
          finalCandidates.length,
        ),
        betUnit,
      )
    : null;

  const positiveContinuousCount = continuousFractions.filter((x) => x > 0).length;
  const notDiversified = betCount === 1 && positiveContinuousCount >= 2;

  return {
    allocations,
    totalStake,
    bankrollInput,
    perRaceCapInput,
    resolvedBankroll,
    effectivePerRaceCap,
    kellyTargetStake,
    plannedStake,
    capApplied,
    minimumStakeApplied,
    exceedsKellyTarget,
    advisory,
    kellyFraction,
    betCount,
    isSkip,
    skipReason,
    notDiversified,
    modelId: model.id,
    modelApproximate: model.approximate,
    diagnostics: {
      inputCandidateCount: positiveCandidates.length,
      truncatedByCapCount,
      candidateCount: finalCandidates.length,
      converged,
    },
  };
}

// ============================================================================
// 候補ビルダー(ワイド・三連複固有)
// ============================================================================

/**
 * ワイド・三連複等のオッズMapキーを生成する唯一の正規化関数(決定2)。
 * netkeibaの実キー形式(`docs/wide-trio-odds-investigation.md` §2.3。ワイド"0102"・
 * 3連複"010203")に一致させる: 馬番昇順ソート後、2桁ゼロ埋めで連結する。
 * 呼び出し側にキー文字列を組み立てさせない(キー形式の二重定義を防ぐ)。
 *
 * **実体は `../scraper/combo-odds-key.js` に移設した**(機能D-2b-A・Issue #32・
 * boss着手前ゲート2026-08-06案(a))。ワイド・3連複の組合せオッズパーサ(`scraper/*`)からも
 * 同じキー形式が必要になったため、`scraper → ev` という逆向きの層依存を避ける目的で
 * `scraper` 配下の葉モジュールへ実装を1本化し、ここでは re-export するだけにする
 * (`padStart(2,"0")` の連結ロジックを2箇所に複製しない)。既存の import 経路
 * (`ev/combo-bet-allocation.js` から `buildComboOddsKey` を import する既存テスト等)を
 * 壊さないよう、公開位置(このモジュールからexportされること)は維持する。
 */
export { buildComboOddsKey };

/**
 * combo オッズの解決結果(判別共用体)。取得済み/欠損(null)/未取得(キー不在)/
 * **不正な数値(malformed)** の4状態を区別する(決定2。boss指摘2026-08-06で4状態目を追加)。
 * `Map#get(...) ?? null` のような未取得と欠損の同一視を禁止する
 * (本リポジトリが繰り返した「判定不能を判定結果と誤ラベルする」欠陥クラスの再発防止)。
 *
 * ## malformed(非有限・0以下)を追加した理由と、throwしない理由(受け入れ条件18)
 *
 * `buildComboCandidates` は**入口検証の二層原則**における「データの分類器」であり
 * (対して `allocateGeneralBets`/`validateCandidates` は「公開APIの門番」)、外部データ由来の
 * 異常値(取得したオッズがNaN・Infinity・0・負値等)は**分類して診断値の件数に残す**
 * (throwしない)。理由: `buildComboCandidates` は最大987組を1件ずつ分類するのが仕事であり、
 * 1組のオッズが壊れていただけでレース全体の分類を投げ捨てるのは誤りである(1件のNaNのために
 * 残り986件の健全な分類結果まで失われてしまう)。
 *
 * 修正前は数値検証が無く、`resolveComboOdds` が非有限値でも無条件に`{state:"present"}`を
 * 返していたため、NaNは`ev=NaN`→`isPositive=(NaN>閾値)=false`という経路で
 * **judged.notPositiveCount(判定結果)に紛れ込み**、Infinityは`isPositive=true`のまま
 * `candidates`配列に混入していた(たまたま下流の`allocateGeneralBets`側の`validateCandidates`
 * throwで止まっていたに過ぎず、`buildComboCandidates`自身が意図して防いでいたわけではない)。
 * いずれも「判定不能」を「判定結果」に混ぜる、受け入れ条件16が禁じた欠陥である。
 */
export type ComboOddsResolution =
  | { readonly state: "present"; readonly odds: number }
  | { readonly state: "missing" }
  | { readonly state: "unfetched" }
  | { readonly state: "malformed" };

/**
 * oddsByKeyから馬番の組のオッズを4状態判別共用体で解決する唯一の関数。
 * 数値としての妥当性(非有限・0以下)の判定もこの関数に集約する
 * (`AllocationCandidate.odds`と同じ基準=正の有限値。`validateCandidates`のthrow基準と
 * 値としては同じだが、ここでは分類〈malformed〉として扱いthrowはしない)。
 */
export function resolveComboOdds(
  oddsByKey: ReadonlyMap<string, number | null>,
  umabans: readonly number[],
): ComboOddsResolution {
  const key = buildComboOddsKey(umabans);
  if (!oddsByKey.has(key)) {
    return { state: "unfetched" };
  }
  // has()で存在を確認済みのため、get()の戻り値は number | null に限られる
  // (undefinedの可能性はMap#getの型シグネチャ上の保険であり、ここでは到達しない)。
  const value = oddsByKey.get(key)!;
  if (value === null) {
    return { state: "missing" };
  }
  // 判定基準は allocation-primitives.ts の isUsableOdds に委譲する(Issue #31。
  // validateCandidates・bet-allocation.tsの候補フィルタと同一基準を1箇所で共有する)。
  if (!isUsableOdds(value)) {
    return { state: "malformed" };
  }
  return { state: "present", odds: value };
}

/** 候補ビルダーの診断値。判定結果(judged)と判定不能(unjudged)を型レベルで分離する(決定6)。 */
export interface ComboCandidateDiagnostics {
  /** 列挙した買い目の総数(= C(出走頭数, comboSize))。 */
  readonly enumeratedCount: number;
  /** 判定結果(オッズを取得でき、EVを計算できた買い目)。 */
  readonly judged: {
    /** EVプラスと判定し候補にした数(= candidates.length)。 */
    readonly positiveCount: number;
    /** EV非プラスで候補外にした数。 */
    readonly notPositiveCount: number;
  };
  /** 判定不能(オッズが取得できず、または数値として不正でEVを計算できなかった買い目)。 */
  readonly unjudged: {
    /** オッズ欠損(Mapの値がnull)で評価できなかった数。 */
    readonly oddsMissingCount: number;
    /** 未取得(Mapにキーが存在しない)のため評価していない数。 */
    readonly oddsUnfetchedCount: number;
    /**
     * オッズが取得済みだが数値として不正(非有限・0以下)で評価できなかった数
     * (受け入れ条件18・boss指摘2026-08-06)。判定結果(judged)には絶対に混ざらない。
     */
    readonly oddsMalformedCount: number;
  };
}

/** 候補ビルダーの結果。 */
export interface ComboCandidateBuildResult {
  /** EVプラスと判定した候補(allocateGeneralBetsへそのまま渡せる)。 */
  readonly candidates: readonly AllocationCandidate[];
  readonly diagnostics: ComboCandidateDiagnostics;
}

/** items(昇順)から要素数kの組合せを列挙する(順序は決定的。place-joint-model.tsの
 *  kCombinationsと同じアルゴリズムだが、券種非依存モジュール間の依存を増やさないため
 *  独立して持つ)。 */
function kCombinationsOfUmabans(items: readonly number[], k: number): number[][] {
  const results: number[][] = [];
  if (k <= 0 || k > items.length) {
    return results;
  }
  const current: number[] = [];
  const backtrack = (start: number): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      backtrack(i + 1);
      current.pop();
    }
  };
  backtrack(0);
  return results;
}

/**
 * combo(馬番の組)の的中確率を、同時分布(畳み込み前の生の分布)から直接導出する。
 * combo.length===topFinishCountの場合(例: 三連複×k=3)は「T=combo」の1点のみが該当し、
 * combo.length<topFinishCountの場合(例: ワイド×k=3)は「combo⊆T」を満たす全Tの確率を合算する。
 */
function computeComboHitProb(combo: readonly number[], rawDistribution: readonly PlaceOutcome[]): number {
  let total = 0;
  for (const outcome of rawDistribution) {
    if (combo.every((u) => outcome.placed.includes(u))) {
      total += outcome.probability;
    }
  }
  return total;
}

/**
 * ワイド・三連複向けの買い目候補を構築する(列挙+オッズ4状態解決+EV算出)。
 *
 * @param horses 出走全頭(複勝圏内確率。同時分布構築に使う)
 * @param topFinishCount 上位何着までを的中判定に使うか(ワイド・三連複は常に3。JSDoc冒頭参照)
 * @param comboSize 買い目を構成する頭数(ワイド=2、三連複=3)
 * @param oddsByKey buildComboOddsKeyで生成したキーへのオッズMap(値がnullなら欠損、
 *   キーが無ければ未取得)。**値はスカラー(既に1つに決まったオッズ)であること。**
 *   ワイドのレンジ表現(下限-上限)から下限を選び出す変換は本関数の責務ではなく、
 *   呼び出し側(D-2b・Issue #27)が済ませてから渡すこと(AllocationCandidate.oddsのJSDoc参照)。
 * @param evConfig EV判定の設定(省略時は既存expected-value.tsの既定閾値1.0・厳密不等号を再利用。
 *   閾値を二重定義しない)
 * @param model 同時分布モデル(省略時は条件付きベルヌーイ)
 */
export function buildComboCandidates(
  horses: readonly JointModelHorse[],
  topFinishCount: number,
  comboSize: number,
  oddsByKey: ReadonlyMap<string, number | null>,
  evConfig: EvConfig = DEFAULT_EV_CONFIG,
  model: PlaceJointModel = CONDITIONAL_BERNOULLI_MODEL,
): ComboCandidateBuildResult {
  validateTopFinishCount(topFinishCount);
  const umabans = [...horses].map((h) => h.umaban).sort((a, b) => a - b);
  const combos = kCombinationsOfUmabans(umabans, comboSize);
  const rawDistribution = model.buildDistribution(horses, topFinishCount);

  const candidates: AllocationCandidate[] = [];
  let notPositiveCount = 0;
  let oddsMissingCount = 0;
  let oddsUnfetchedCount = 0;
  let oddsMalformedCount = 0;
  // 閾値の防御(受け入れ条件19)。computeRaceEv/computeEstimatedRaceEvと同じ関数を再利用し、
  // 二重定義しない(受け入れ条件17)。非有限のまま`ev > threshold`に使うと、どんなに良い
  // オッズでも比較が常にfalse(NaN/+Infinityの場合)またはtrue(-Infinityの場合)に
  // 固定され、全候補が黙って誤分類される。
  const threshold = resolveEvThreshold(evConfig.threshold);

  for (const combo of combos) {
    const resolution = resolveComboOdds(oddsByKey, combo);
    if (resolution.state === "unfetched") {
      oddsUnfetchedCount++;
      continue;
    }
    if (resolution.state === "missing") {
      oddsMissingCount++;
      continue;
    }
    if (resolution.state === "malformed") {
      oddsMalformedCount++;
      continue;
    }
    const hitProb = computeComboHitProb(combo, rawDistribution);
    const ev = hitProb * resolution.odds;
    const isPositive = ev > threshold;
    if (!isPositive) {
      notPositiveCount++;
      continue;
    }
    candidates.push({ umabans: combo, odds: resolution.odds, ev, isPositive: true });
  }

  return {
    candidates,
    diagnostics: {
      enumeratedCount: combos.length,
      judged: { positiveCount: candidates.length, notPositiveCount },
      unjudged: { oddsMissingCount, oddsUnfetchedCount, oddsMalformedCount },
    },
  };
}
