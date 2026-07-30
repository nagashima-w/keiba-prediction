/**
 * bet-allocation — 複勝の馬券配分最適化(馬券配分「機能C」の中核。C-1で純ロジックを実装、
 * C-2で「総資金」「1レース上限」の2軸化・最低額ロジック・見送り6分類へ契約を改訂)。
 *
 * 背景(ユーザー要望): 馬券に充てている資金の総額(総資金)と、1レースで使ってよい金額の上限
 * (1レース上限)を設定しておき、その中で的中率と配当の妙味から最適と思われる配分をケリー基準で
 * 提示する。見送り(配分しない)も答えとして出す。券種は当面複勝のみ。
 *
 * C-1からC-2への契約変更(なぜ budget を bankroll + perRaceCap に分けたか):
 *   C-1では単一の budget(1レースの予算)をケリー基準の元本として直接使っていたが、実測した結果
 *   「ケリー基準のbudgetは本来『総資金』であり、1レースの予算としてそのまま渡すと配分額が予算の
 *   3〜8%にしかならない」ことが判明した。ケリー基準は妙味(EV−1)の大きさに比例した額だけを
 *   賭ける設計であり、通常は「使ってよい上限」まで届かない。ユーザーから「常に上限より少ない
 *   買い方しか提案しないのは微妙」との指摘を受け、総資金(bankroll。ケリー計算の元本)と
 *   1レース上限(perRaceCap。これ以上は賭けないという歯止め)を独立した設定項目に分けた。
 *   配分総額は `min(λ·Σx*·bankroll, perRaceCap)` となり、通常はケリー適正額(λ·Σx*·bankroll)が
 *   採用され、妙味が大きいレースに限って上限で頭打ちになる。
 *
 * アルゴリズム全体(仕様「3. アルゴリズムの手順」。C-2で改訂):
 *   Step0 総資金・1レース上限の解決(resolveBankroll・resolveEffectivePerRaceCap)
 *   Step1 候補馬の選定(isPositive && placeOddsMin!==null のみ)
 *   Step2 出走全頭でPlaceJointModelの同時分布を構築
 *   Step3 同時分布を「複勝圏に入った候補馬の部分集合T」ごとに畳み込む
 *   Step4 貪欲逐次配分で連続最適比率 x*(ケリー基準・予算に依存しないスケール不変値)を求める
 *   Step5 ケリー適正額(kellyTargetStake = λ·Σx*·bankroll)を算出し、1レース上限を超える場合は
 *         比例縮小(s = min(1, perRaceCap/kellyTargetStake))してから betUnit 単位へ切り捨てる
 *   Step5.5 切り捨ての結果、全馬が0円になった場合は最低額(betUnit1単位)を
 *           continuousFraction最大の1頭にだけ与える(最低額ロジック。下記参照)
 *   Step6 見送り判定(6分類)・notDiversified判定・advisory(適正額超過警告)生成
 *
 * 設計判断(なぜこう作ったか):
 *
 * 1. なぜ条件付きベルヌーイモデルを採用したか(独立ケリー正規化を却下した理由):
 *    各馬の複勝的中を独立事象として個別にケリー計算し、後から予算内に正規化する設計は却下した。
 *    複勝は「同時に複数頭が当たりうる」券種であり、頭数・複勝人数という強い制約(必ずちょうど
 *    placeCount頭が当たる)が的中同士に相関を生む。独立仮定で各馬を計算すると、複数の的中を
 *    過度に見込んだ過大な配分になりうる。そこで同時分布モデル(PlaceJointModel)を明示的な
 *    差し替え可能コンポーネントとして切り出し、本ファイル(最適化ロジック)は同時分布が返す
 *    確率だけを使い、馬同士の独立性を一切仮定しない(受け入れ条件13。テストではスタブモデルに
 *    差し替え、完全相関/完全排反で最適化結果が変わることを構造的に検証する)。
 *
 * 2. なぜ切り捨ての剰余を再配分しないか:
 *    betUnit単位への切り捨てで生じた剰余を他の候補馬に補填(最大剰余法などで繰り上げ)する設計は
 *    却下した。切り捨てられた分はそのまま賭けない(1レース上限は「使い切らなくてよい上限」という
 *    ユーザー要望の直接的な実装)。剰余を再配分すると、妙味が薄い馬に無理に賭ける結果になり
 *    「見送り」の選択肢と矛盾する。ただし全馬が0円になる場合に限り、最低額ロジック(後述)で
 *    妙味最大の1頭にだけbetUnit1単位を与える(「予算より少ない買い方しか提案しない」というユーザー
 *    指摘への対応。詳細は3参照)。
 *
 * 3. 最低額ロジック(なぜ必要か・なぜ均等配分にしないか):
 *    ケリー適正額(kellyTargetStake)が正でも、betUnit(100円)未満に丸められると全馬0円=見送りに
 *    なってしまう。しかしケリー適正額が「賭ける価値がある」と判定している以上、機械的にbetUnit
 *    未満を切り捨てるだけでは「妙味はあるのに何も提案しない」という体験になる。そこで、丸めの結果
 *    totalStakeが0円になった場合に限り、continuousFraction(連続最適比率)が最大の1頭にだけ
 *    betUnit1単位(最小の実弾)を与える。複数頭に分散させる(例: betUnit×N頭)設計は採らない。
 *    理由はbetUnitが最小粒度(100円)であるため「100円をN頭に分ける」ことが原理的に不可能で、
 *    実際には「betUnit×N頭」という過大なベット(ケリー適正額の何倍にもなる)になってしまうため。
 *    1頭に絞ることで超過の倍率を最小限(betUnit/kellyTargetStake)に抑える。この超過は
 *    exceedsKellyTarget/advisoryでユーザーに明示する(4参照)。
 *
 *    最低額を適用するかどうかは、次の4条件をすべて満たす場合に限る(4条件目の理由は特に重要):
 *      - totalStake(丸め後)が0円であること(丸めで全損した場合のみ介入する)
 *      - continuousFractionが正の候補が1頭以上いること(妙味自体はあること)
 *      - resolvedBankroll > 0(総資金が有効であること。①未設定を救済しない)
 *      - effectivePerRaceCap >= betUnit(1レース上限がbetUnit以上であること。③上限不足を救済しない)
 *      - kellyTargetStake > 0(ケリー適正額が正であること。★λ=0を救済しないための条件★)
 *        λ=0(ケリー係数0)は「その資金配分では賭けない」というユーザーの明示的な指定であり、
 *        妙味の有無とは無関係にλ=0という設定そのものを尊重すべきである。この条件が無いと、
 *        妙味のある候補が存在する限りλ=0を設定してもbetUnit分だけ勝手に賭けてしまう
 *        (ユーザーが「係数0=賭けない」と設定した意図に反する。見送り理由④で扱う)。
 *
 * 4. exceedsKellyTarget/advisory(適正額超過警告)の設計:
 *    最低額ロジックにより totalStake が kellyTargetStake を上回ることがありうる
 *    (例: kellyTargetStake=36円にbetUnit100円を配分)。これは「ケリー基準が推奨する適正額を
 *    超えて賭けている」状態であり、資産成長率の観点では望ましくない。totalStake>kellyTargetStake
 *    を exceedsKellyTarget として機械的に検出し、true のときのみ advisory(数値込みの警告文言)を
 *    core側で生成する(UIに文言の複製を作らせないため。仕様「advisoryはcoreが数値込みで生成」)。
 *    exceedsKellyTargetの定義に「kellyTargetStake > 0」等の追加ガードは入れない(二重防御の禁止)。
 *    理由: resolvedBankroll・effectivePerRaceCapのクランプ(Step0)により
 *    kellyTargetStake = λ·Σx*·resolvedBankroll は常に0以上の有限値であることが構造的に保証される
 *    (resolvedBankroll>=0有限・Σx*>=0・λ∈[0,1]の全てが個別に保証されているため)。したがって
 *    isSkip(totalStake=0)の場面では 0 > kellyTargetStake(>=0) は常にfalseになり、追加ガードが
 *    無くても exceedsKellyTarget は誤って true にならない。追加ガードを入れるとStep0のクランプが
 *    壊れた場合にこのガードが症状を隠してしまい、クランプ自体の退行テストが偽陽性で通ってしまう
 *    (防御はStep0のクランプ1箇所に集約する。boss着手前ゲート2026-07-30合意)。
 *
 * 5. Step0(resolveBankroll/resolveEffectivePerRaceCap)がStep4より前に必要な理由・ゼロ除算ガード:
 *    C-1で2回発生した「サイレント破損」欠陥クラス(betUnit=0でInfinity、λ=NaNでNaNが
 *    isSkip=false/skipReason=nullのまま返る)の再発防止として、bankroll/perRaceCapの非有限・
 *    0以下の値は計算に入る前に必ずクランプする(resolveBankrollは0以下・非有限を0へ、
 *    resolveEffectivePerRaceCapは0以下・非有限を0へ、その後betUnitの倍数へ床関数)。
 *    このクランプが無いと、例えば perRaceCap=-50 を素朴に floor(-50/100)*100 すると -100 という
 *    「負のキャップ」が生まれ、以降のキャップ比例縮小係数 s = min(1, perRaceCap/kellyTargetStake)
 *    が負値になり、全馬のstakeが負になりうる(3回目のサイレント破損)。s の算出自体にも
 *    `kellyTargetStake > 0 ? ... : 0` というゼロ除算ガードを設けている
 *    (kellyTargetStake=0のときは0除算を避けs=0とし、以降のstake計算はいずれにせよ0になる)。
 *
 * 6. Step0/Step1の判定とStep2〜4(診断値・連続最適比率)の計算は独立に行う:
 *    「総資金/1レース上限が未設定」「候補0頭」であっても、診断値(placeProbSum等)や各候補の
 *    連続最適比率(continuousFraction)は必ず算出する。理由は次の2点:
 *    (a) placeProbSumDeviation・marginalDeviationMax は総資金・候補数と無関係にモデルの性質から
 *        決まる値であり、これらを見送り時に欠落させると、UIが「なぜ見送りになったか」の文脈
 *        (モデルの乖離状況)を提示できなくなる。
 *    (b) continuousFraction(連続最適比率)は総資金の絶対値に依存しない(スケール不変)ため、
 *        総資金が不足していても計算コストはゼロに等しい。見送り時にも埋めておくことで、
 *        「総資金があればこう配分したはず」という参考情報を示せる。
 *
 * 7. 見送り理由(skipReason)6分類の優先順位(重要な設計判断):
 *    優先順位は ①総資金未設定 → ②1レース上限未設定 → ③1レース上限不足 → ④ケリー係数0
 *    → ⑤候補0頭 → ⑥連続最適解ゼロ の順。
 *    ①②は仕様上の既定値(未設定・opt-in)であり、③(上限はあるがbetUnit未満)とは明確に意味が
 *    異なるため分離した。未設定は「妙味なし」ではなく「まだ判定していない」状態であり、これを
 *    ⑤(EVプラスの馬がいないため見送り)と同じ文言で報告すると、ユーザーは「このレースには妙味が
 *    ない」と受け取ってしまうが、実際には妙味の評価結果を配分に反映していないだけである。
 *    判定していないことを判定結果として報告してはならない。④(λ=0)は⑤(候補0頭)より優先する
 *    (λ=0はユーザーの明示的な「賭けない」指定であり、候補の有無で言い訳を変えてはならないため。
 *    boss着手前ゲート2026-07-30で確定した優先順位)。
 *    旧C-1の「⑤丸めでゼロ」は最低額ロジックの導入により到達不能になり分類から削除した
 *    (受け入れ条件10。到達不能であることを証明するテストを設けている)。
 *
 * 8. 診断値の符号規約(重要。両者で規約が異なる):
 *    - placeProbSumDeviation: 符号付き(placeProbSum − placeProbSumTarget)。正なら合計が目標
 *      (placeCount)を上回る方向、負なら下回る方向に偏っていることを示す。既存 verify.ts の
 *      overconfidenceGap と同じ「乖離は符号付きで残す」規約に合わせた(絶対値からは符号付き値を
 *      復元できないが、逆は可能なため情報を捨てない方を選ぶ)。
 *    - marginalDeviationMax: 絶対値の最大。条件付けにより合計が保存される(周辺確率の合計は
 *      常に一定)ため、各馬の乖離には必ず正負両方が現れ、符号付き最大値を取っても指標として
 *      意味を持たない。よって「乖離の大きさ」だけを表す絶対値の最大とした。
 *
 * 9. 公開する解決値の原則(C-2で明文化):
 *    「解決値は、他の公開フィールドの導出根拠になるものだけ公開する」。
 *    - kellyFraction(解決後のλ) → 公開。stakeの導出根拠
 *    - resolvedBankroll → 公開。kellyTargetStake = λ·Σx*·resolvedBankroll の導出根拠
 *    - effectivePerRaceCap → 公開。plannedStakeの導出根拠
 *    - betUnit/greedySteps → 非公開のまま(C-1の判断を変更しない)。丸め粒度・探索精度であり、
 *      他の公開フィールドの導出根拠として必須ではない
 *    公開フィールドだけで結果が自己検証できる(continuousFractionからΣx*が出るのでkellyTargetStake
 *    を外部から再計算して突き合わせられる)ことが実利。
 *
 * 機能Dへの備え(コスト実質ゼロの範囲のみ。券種拡張自体はC-2のスコープ外):
 *    - HorseAllocation → BetAllocation に改称(「馬」を出力型名から落とす。機能Dで買い目が
 *      馬の組になるため。umaban/placeProb/placeOddsMinのJSDocに一般化予定を記録)
 *    - 買い目ラベルの純関数化はrenderer側(bet-allocation-view.ts)の責務(本ファイルは非依存)
 *
 * C-2のスコープ境界: 本ファイルは packages/core 配下の純関数のみ。設定画面・IPC・renderer表示・
 * verify.ts・analysis-pipeline.ts への配線は別ファイル(shared/settings.ts・
 * renderer/bet-allocation-view.ts 等)の責務であり、本ファイルはそれらに一切依存しない
 * (入力は AllocationHorse という構造的最小型のみで受け取る)。
 */

import {
  CONDITIONAL_BERNOULLI_MODEL,
  type JointModelHorse,
  type PlaceJointModel,
  type PlaceOutcome,
} from "./place-joint-model.js";

// Phase 2 で同時分布モデルを差し替える際、C-2/C-3 が1本のサブパスで完結できるように
// place-joint-model.ts の主要な型・既定モデルを re-export する。
export type { JointModelHorse, PlaceJointModel, PlaceOutcome };
export { CONDITIONAL_BERNOULLI_MODEL };

/** 数値誤差を許容する微小値(浮動小数比較のガードに使う)。 */
const NUMERIC_EPS = 1e-9;

/** 配分最適化に渡す1頭分の情報(構造的最小型。AnalysisRow等shared型には依存しない)。 */
export interface AllocationHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 複勝圏内確率。 */
  readonly placeProb: number;
  /** 複勝オッズ下限。欠損なら null(候補外)。 */
  readonly placeOddsMin: number | null;
  /** 期待値。オッズ欠損なら null。 */
  readonly ev: number | null;
  /** EVプラス判定。 */
  readonly isPositive: boolean;
}

/** 馬券配分の設定。 */
export interface BetAllocationConfig {
  /**
   * 馬券用の総資金(円)。既定0(未設定=提案を出さない・opt-in)。
   * ケリー基準の元本。1レースの予算ではない(1レースの上限は perRaceCap で別途指定する)。
   */
  readonly bankroll: number;
  /** 1レースの上限(円)。既定0(未設定=提案を出さない・opt-in)。「これ以上は賭けない」歯止め。 */
  readonly perRaceCap: number;
  /** ケリー係数λ(0〜1)。既定0.5。 */
  readonly kellyFraction: number;
  /** 賭け金の最小単位(円)。既定100。 */
  readonly betUnit: number;
  /** 貪欲逐次配分の分割数。既定1000(1ステップ=連続最適比率の0.1%)。 */
  readonly greedySteps: number;
}

/** 既定の馬券配分設定。 */
export const DEFAULT_BET_ALLOCATION_CONFIG: BetAllocationConfig = {
  bankroll: 0,
  perRaceCap: 0,
  kellyFraction: 0.5,
  betUnit: 100,
  greedySteps: 1000,
};

/**
 * 1頭分の配分結果。
 * 機能D(券種拡張)への備え: 現状は複勝(単一馬への賭け)のみを扱うため umaban: number で足りるが、
 * ワイド等の組み合わせ券種では買い目が複数馬の組になる。フィールドのJSDocに一般化の方針を記録し、
 * 型名自体も「馬」を含まない BetAllocation とした(旧名 HorseAllocation から改称)。
 */
export interface BetAllocation {
  /**
   * 馬番。
   * 機能Dへの備え: 複勝では単一馬への賭けなのでこの形で正しいが、券種拡張時は
   * `umabans: readonly number[]`(買い目を構成する馬番の組)へ一般化する予定。
   */
  readonly umaban: number;
  /** 実際の配分額(円。betUnitの倍数)。 */
  readonly stake: number;
  /** λ縮小前の連続最適比率 x*_i(0〜1。総資金・上限に依存しないスケール不変値)。旧名kellyFractionから改称。 */
  readonly continuousFraction: number;
  /** λ縮小後の比率 λ·x*_i(1レース上限による比例縮小 s は含まない。cap前の理論値)。 */
  readonly scaledFraction: number;
  /**
   * 入力の複勝圏内確率(書き換えない)。
   * 機能Dへの備え: 複勝固有のフィールド。券種拡張時は「買い目の的中確率」へ一般化する。
   */
  readonly placeProb: number;
  /**
   * 複勝オッズ下限。候補外なら null。
   * 機能Dへの備え: 複勝固有のフィールド。券種拡張時は「買い目のオッズ」へ一般化する。
   */
  readonly placeOddsMin: number | null;
  /** 期待値。候補外なら null。 */
  readonly ev: number | null;
  /** 正の連続配分を得たが丸め(cap比例縮小込み)で0円になったか。 */
  readonly droppedBelowMinimum: boolean;
  /** 候補外の理由。候補なら null。 */
  readonly excludedReason: string | null;
}

/**
 * 配分最適化の診断値。
 * placeProbSumDeviation と marginalDeviationMax は符号規約が異なる(JSDoc参照)。
 */
export interface BetAllocationDiagnostics {
  /** 全出走馬(候補に限らない)の入力placeProbの単純合計。 */
  readonly placeProbSum: number;
  /** placeProbSumの目標値(= placeCount。理論上Σp_i=placeCountが成立すべき値)。 */
  readonly placeProbSumTarget: number;
  /**
   * placeProbSum − placeProbSumTarget(符号付き)。
   * 正なら合計が目標を上回る方向(確率を上げる方向)に偏っている、負なら下回る方向に偏っている。
   * LLM補正後は合計が保証されないため、見送り時も含め必ず算出する。
   */
  readonly placeProbSumDeviation: number;
  /**
   * 同時分布モデル(条件付けにより周辺確率が入力と厳密には一致しないPhase1の既知の不完全性)の
   * 乖離の大きさの最大値(絶対値)。各馬の乖離には方向(正負)が入り混じるため符号は持たない。
   */
  readonly marginalDeviationMax: number;
  /** 候補馬(isPositive && placeOddsMin!==null)の頭数。 */
  readonly candidateCount: number;
  /** 候補外の頭数。 */
  readonly excludedCount: number;
}

/** 馬券配分の最適化結果。 */
export interface BetAllocationResult {
  /** 全出走馬・馬番昇順。候補外も0円で含める。 */
  readonly allocations: readonly BetAllocation[];
  /** 配分総額(円)。最低額ロジック適用後の実際の合計。 */
  readonly totalStake: number;
  /** 総資金の入力値(そのまま。サニタイズしない)。 */
  readonly bankrollInput: number;
  /** 1レース上限の入力値(そのまま。サニタイズしない)。 */
  readonly perRaceCapInput: number;
  /**
   * 解決後の総資金。bankrollInputが非有限・0以下なら0(クランプのみ・床関数はかけない)。
   * kellyTargetStake の導出根拠として公開する(公開する解決値の原則。JSDoc「9.」参照)。
   */
  readonly resolvedBankroll: number;
  /** betUnitの倍数に切り捨てた実効1レース上限。perRaceCapInputが非有限・0以下なら0。 */
  readonly effectivePerRaceCap: number;
  /**
   * ケリー適正額(キャップ前・丸め前)= λ·Σx*·resolvedBankroll。
   * 1レース上限にもbetUnit丸めにも影響されない、ケリー基準が理論上推奨する金額。
   */
  readonly kellyTargetStake: number;
  /** min(kellyTargetStake, effectivePerRaceCap)。実際に使ってよい上限(丸め前)。 */
  readonly plannedStake: number;
  /** kellyTargetStake が effectivePerRaceCap を上回り、1レース上限で頭打ちになったか。 */
  readonly capApplied: boolean;
  /** 丸めで全馬0円になった際、continuousFraction最大の1頭にbetUnit1単位を配分したか。 */
  readonly minimumStakeApplied: boolean;
  /**
   * totalStake > kellyTargetStake か(最低額ロジックによりケリー適正額を上回って賭けた状態)。
   * advisory(警告文言)の表示駆動条件はこちら。minimumStakeAppliedとは別概念
   * (例: kellyTargetStake=150→totalStake=100は最低額を適用しているが適正額は超えていない)。
   */
  readonly exceedsKellyTarget: boolean;
  /** exceedsKellyTarget===trueのときの警告文言(数値込み)。falseなら null。 */
  readonly advisory: string | null;
  /**
   * 実際に適用したケリー係数λ。config.kellyFractionが非有限(NaN/Infinity)または[0,1]範囲外
   * だった場合は既定値(0.5)へフォールバックした後の値(resolveKellyFraction参照)。
   * 入力値そのものではなく、実際に計算へ使われた値である点に注意。
   */
  readonly kellyFraction: number;
  /** 実際に配分された(stake>0の)頭数。 */
  readonly betCount: number;
  /** 見送りか(totalStake===0)。 */
  readonly isSkip: boolean;
  /** 見送り理由。見送りでなければ null。 */
  readonly skipReason: string | null;
  /** 1点配分だが分散できる余地があった(分散できていない)旨の注記。 */
  readonly notDiversified: boolean;
  /** 使用した同時分布モデルの識別子。 */
  readonly modelId: string;
  /** 使用した同時分布モデルが近似か。 */
  readonly modelApproximate: boolean;
  /** 診断値。 */
  readonly diagnostics: BetAllocationDiagnostics;
}

/** 見送り理由(優先順位順)。理由の選定ロジックはコメント「7. 見送り理由...」を参照。 */
const REASON_BANKROLL_UNSET = "総資金が未設定のため配分を提案していません";
const REASON_CAP_UNSET = "1レースの上限が未設定のため配分を提案していません";
const REASON_CAP_TOO_SMALL = "1レースの上限が100円未満のため配分できません";
const REASON_KELLY_ZERO = "ケリー係数が0のため配分しません";
const REASON_NO_CANDIDATES = "EVプラスの馬がいないため見送りです";
const REASON_NO_EDGE = "妙味が小さく、賭ける価値のある配分が見つかりませんでした";

/** 候補外の理由。 */
const EXCLUDED_NOT_POSITIVE = "EVがプラスではないため対象外";
const EXCLUDED_NO_ODDS = "複勝オッズ下限が未確定のため対象外";

/**
 * 複勝の馬券配分を最適化する。
 * @param horses 出走全頭(候補馬に限らない。同時分布は全頭に依存するため)
 * @param placeCount 複勝の対象人数(何着まで複勝圏内か。3をハードコードしない)
 * @param config 馬券配分の設定(省略時は既定・bankroll=perRaceCap=0=未設定)
 * @param model 同時分布モデル(省略時は条件付きベルヌーイ。Phase 2の差し替え単位)
 */
export function allocateBets(
  horses: readonly AllocationHorse[],
  placeCount: number,
  config: BetAllocationConfig = DEFAULT_BET_ALLOCATION_CONFIG,
  model: PlaceJointModel = CONDITIONAL_BERNOULLI_MODEL,
): BetAllocationResult {
  const bankrollInput = config.bankroll;
  const perRaceCapInput = config.perRaceCap;

  // betUnit/greedySteps の防御。kellyFractionと同じ内部一貫性で、非有限・非正・非整数は
  // 既定値へフォールバックする。betUnitが0/NaNだと後続の割り算がInfinity/NaNになり、
  // totalStake等がNaNのまま isSkip=false/skipReason=null で返る(C-1で2回発生した
  // 「サイレント破損」欠陥クラス)。greedySteps<=0/NaNは貪欲ループが0回実行され、連続最適比率が
  // (実際は判定していないのに)全て0のまま返り、「妙味が小さい」という誤ったskipReasonになりうる。
  const betUnit = resolveBetUnit(config.betUnit);
  const greedySteps = resolveGreedySteps(config.greedySteps);

  // λ(ケリー係数)の防御。非有限(NaN/Infinity)・[0,1]範囲外は既定値(0.5)へフォールバックする。
  // λ>1を無防御に許すと totalStake が effectivePerRaceCap を超過しうる(受け入れ条件1違反)。
  // NaN/Infinityを無防御に許すと stake に NaN が混入し、isSkip/skipReasonがそれを検知できず
  // サイレントに破損した結果を返してしまう。採用した値は BetAllocationResult.kellyFraction に
  // 反映し、実際に使われたλを追跡可能にする。
  const kellyFraction = resolveKellyFraction(config.kellyFraction);

  // 出力を馬番昇順にする(入力を書き換えないよう新しい配列を作る)。
  const sortedHorses = [...horses].sort((a, b) => a.umaban - b.umaban);

  // Step0: 総資金・1レース上限の解決(クランプ・床関数はJSDoc「5.」参照)。
  const resolvedBankroll = resolveBankroll(bankrollInput);
  const effectivePerRaceCap = resolveEffectivePerRaceCap(perRaceCapInput, betUnit);

  // Step1: 候補選定。Step0/Step1の判定結果に関わらず常に行う(設計判断6)。
  const candidateHorses = sortedHorses.filter(
    (h) => h.isPositive && h.placeOddsMin !== null,
  );
  const candidateUmabanSet = new Set(candidateHorses.map((h) => h.umaban));

  // Step2: 出走全頭で同時分布を構築する(候補馬だけでなくレース全頭を渡す)。
  const jointHorses: JointModelHorse[] = sortedHorses.map((h) => ({
    umaban: h.umaban,
    placeProb: h.placeProb,
  }));
  const rawDistribution = model.buildDistribution(jointHorses, placeCount);

  // 診断値: 全出走馬のplaceProb合計・目標との乖離(符号付き)。
  const placeProbSum = sortedHorses.reduce((acc, h) => acc + h.placeProb, 0);
  const placeProbSumTarget = Number.isNaN(placeCount) ? 0 : placeCount;
  const placeProbSumDeviation = placeProbSum - placeProbSumTarget;

  // 診断値: Step2の畳み込み前(全頭)の同時分布から求めた各馬の周辺確率と入力placeProbの
  // 乖離の絶対値の最大(marginalDeviationMaxは符号を持たない。JSDoc「8.」参照)。
  const marginalDeviationMax = computeMarginalDeviationMax(sortedHorses, rawDistribution);

  // Step3: 候補馬の部分集合Tへ畳み込む。
  const foldedOutcomes = foldToCandidateSubsets(rawDistribution, candidateUmabanSet);

  // Step4: 貪欲逐次配分で連続最適比率(ケリー基準)を求める。総資金・上限に関わらず常に計算する
  // (設計判断6)。effectivePerRaceCap/resolvedBankrollに一切依存しないためスケール不変。
  const continuousFractions = optimizeContinuousFractions(
    candidateHorses,
    foldedOutcomes,
    greedySteps,
  );
  const sumContinuousFractions = continuousFractions.reduce((acc, x) => acc + x, 0);

  // ケリー適正額(キャップ前・丸め前)。resolvedBankroll>=0有限・Σx*>=0・λ∈[0,1]がいずれも
  // 個別に保証されているため、kellyTargetStakeは常に0以上の有限値になる(NaN/Infinityが
  // 生じない。JSDoc「5.」のゼロ除算ガードの前提)。
  const kellyTargetStake = kellyFraction * sumContinuousFractions * resolvedBankroll;
  const plannedStake = Math.min(kellyTargetStake, effectivePerRaceCap);
  const capApplied = kellyTargetStake > effectivePerRaceCap;

  // Step5: キャップ比例縮小係数 s。kellyTargetStake=0のときのゼロ除算ガードが必須
  // (C-1で2回繰り返した「サイレント破損」欠陥クラスの3回目を防ぐ)。
  const s = kellyTargetStake > 0 ? Math.min(1, effectivePerRaceCap / kellyTargetStake) : 0;

  // 各候補馬のstakeを算出する(cap比例縮小込み・betUnit未満切り捨て)。剰余は再配分しない
  // (設計判断2)。この時点ではまだ最低額ロジックを適用しない(全馬0円かどうかをまず確定させる)。
  const rawStakes: number[] = [];
  let totalStake = 0;
  for (let i = 0; i < candidateHorses.length; i++) {
    const continuousFraction = continuousFractions[i]!;
    const scaledFraction = kellyFraction * continuousFraction;
    const raw = Math.floor((s * scaledFraction * resolvedBankroll) / betUnit) * betUnit;
    const stake = raw < betUnit ? 0 : raw;
    rawStakes.push(stake);
    totalStake += stake;
  }

  // Step5.5: 最低額ロジック(設計判断3)。全馬0円で、かつ妙味・総資金・上限のいずれも
  // 「未判定」の状態でない場合に限り、continuousFraction最大の1頭にbetUnit1単位を与える。
  let minimumStakeApplied = false;
  if (
    totalStake === 0 &&
    candidateHorses.length > 0 &&
    resolvedBankroll > 0 &&
    effectivePerRaceCap >= betUnit &&
    kellyTargetStake > 0
  ) {
    let bestIdx = -1;
    let bestFraction = 0;
    for (let i = 0; i < candidateHorses.length; i++) {
      const fraction = continuousFractions[i]!;
      if (fraction <= 0) {
        continue;
      }
      // 同値は馬番昇順(既存慣行 race-opportunity.ts の rawScore タイブレークに揃える)。
      if (
        bestIdx === -1 ||
        fraction > bestFraction ||
        (fraction === bestFraction && candidateHorses[i]!.umaban < candidateHorses[bestIdx]!.umaban)
      ) {
        bestIdx = i;
        bestFraction = fraction;
      }
    }
    if (bestIdx !== -1) {
      rawStakes[bestIdx] = betUnit;
      totalStake = betUnit;
      minimumStakeApplied = true;
    }
  }

  // 丸め判定(cap比例縮小・最低額ロジックを含む)に到達したかどうか。到達していなければ
  // droppedBelowMinimumは常にfalse(「丸めで落とされた」という誤った説明を防ぐ。C-1由来の防御)。
  const reachedRoundingDecision = resolvedBankroll > 0 && effectivePerRaceCap >= betUnit;

  const allocationByUmaban = new Map<number, BetAllocation>();
  for (let i = 0; i < candidateHorses.length; i++) {
    const horse = candidateHorses[i]!;
    const continuousFraction = continuousFractions[i]!;
    const scaledFraction = kellyFraction * continuousFraction;
    const stake = rawStakes[i]!;
    allocationByUmaban.set(horse.umaban, {
      umaban: horse.umaban,
      stake,
      continuousFraction,
      scaledFraction,
      placeProb: horse.placeProb,
      placeOddsMin: horse.placeOddsMin,
      ev: horse.ev,
      droppedBelowMinimum: continuousFraction > 0 && stake === 0 && reachedRoundingDecision,
      excludedReason: null,
    });
  }

  // 候補外の馬も欠落させず0円で含める(受け入れ条件13で継承)。
  for (const horse of sortedHorses) {
    if (allocationByUmaban.has(horse.umaban)) {
      continue;
    }
    allocationByUmaban.set(horse.umaban, {
      umaban: horse.umaban,
      stake: 0,
      continuousFraction: 0,
      scaledFraction: 0,
      placeProb: horse.placeProb,
      placeOddsMin: horse.placeOddsMin,
      ev: horse.ev,
      droppedBelowMinimum: false,
      // placeOddsMin===null(オッズ未確定)を先に判定する。オッズ未確定の馬は ev===null・
      // isPositive===false になる(evaluateHorse/excluded と同じ規約)ため、!isPositive を
      // 先に見ると「まだ判定できていない(オッズ未確定)」馬まで「EVがプラスではない(判定した
      // 結果マイナス)」と誤ラベルしてしまう。判定不能 > 判定結果マイナス の順に判定する。
      excludedReason: horse.placeOddsMin === null ? EXCLUDED_NO_ODDS : EXCLUDED_NOT_POSITIVE,
    });
  }

  const allocations = sortedHorses.map((h) => allocationByUmaban.get(h.umaban)!);
  const betCount = allocations.filter((a) => a.stake > 0).length;
  const isSkip = totalStake === 0;

  // exceedsKellyTarget: 追加ガードを入れない(二重防御の禁止。JSDoc「4.」参照)。
  const exceedsKellyTarget = totalStake > kellyTargetStake;
  const advisory = buildAdvisory(exceedsKellyTarget, kellyTargetStake, betUnit);

  // Step6: 見送り理由(6分類・優先順位順)。isSkipのときのみ算出する。
  const skipReason = isSkip
    ? determineSkipReason(
        bankrollInput,
        perRaceCapInput,
        effectivePerRaceCap,
        betUnit,
        kellyTargetStake,
        kellyFraction,
        candidateHorses.length,
      )
    : null;

  // notDiversified: betCount===1 のときのみtrueになりうる。betCount===0(見送り)は
  // isSkip/skipReasonが説明責任を負うため常にfalse。
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
      placeProbSum,
      placeProbSumTarget,
      placeProbSumDeviation,
      marginalDeviationMax,
      candidateCount: candidateHorses.length,
      excludedCount: sortedHorses.length - candidateHorses.length,
    },
  };
}

/**
 * 総資金を解決する(クランプのみ・床関数はかけない)。非有限(NaN/Infinity)・0以下は0を返す
 * (見送り理由①「総資金未設定」へ自然につながる)。effectivePerRaceCapと異なりbetUnitの倍数への
 * 丸めは行わない(1レース単位の話ではなく総資金そのものであるため。boss着手前ゲート2026-07-30)。
 */
function resolveBankroll(bankroll: number): number {
  if (!Number.isFinite(bankroll) || bankroll <= 0) {
    return 0;
  }
  return bankroll;
}

/**
 * 1レース上限を実効値へ解決する(公開関数)。非有限(NaN/Infinity)・0以下は0を、そうでなければ
 * betUnitの倍数に切り捨てた値を返す。
 *
 * public exportする理由: SettingsViewの「実効上限」ライブプレビュー(入力欄直下に常時表示)が
 * この関数と全く同じロジックを使う必要がある。UI側にfloor演算をコピーすると、UIが「実効上限
 * 10,000円」と表示しながらcore側は別の値で計算する事態(嘘をつくUI)になりかねない
 * (boss着手前ゲート2026-07-30)。allocateBets内部もこの関数を呼び、コピー実装を作らない。
 *
 * betUnitはこの関数の外で既に resolveBetUnit 済みの値が渡される想定だが、公開APIとして
 * 任意の呼び出し元(将来のUIコード等)から異常なbetUnitを渡された場合の防御として、
 * 内部でも resolveBetUnit を通す(冪等なので二重に通しても結果は変わらない)。
 */
export function resolveEffectivePerRaceCap(perRaceCap: number, betUnit: number): number {
  const resolvedBetUnit = resolveBetUnit(betUnit);
  if (!Number.isFinite(perRaceCap) || perRaceCap <= 0) {
    return 0;
  }
  return Math.floor(perRaceCap / resolvedBetUnit) * resolvedBetUnit;
}

/**
 * λ(ケリー係数)を防御する。非有限(NaN/Infinity)・[0,1]範囲外は既定値(0.5)へフォールバック
 * する(resolveClipVariant等、本リポジトリの防御的フォールバックの流儀に合わせる。bankrollのように
 * 「範囲外を0に落とす」クランプではなく既定値へ戻すのは、λ=0への一律クランプだと「負値だから
 * 何も賭けない」という誤った理由(丸め起因のようなskipReason)を誘発しうるため。既定値
 * フォールバックであれば、以降の計算は「正常なλで判定した結果」として一貫する)。
 */
function resolveKellyFraction(kellyFraction: number): number {
  if (!Number.isFinite(kellyFraction) || kellyFraction < 0 || kellyFraction > 1) {
    return DEFAULT_BET_ALLOCATION_CONFIG.kellyFraction;
  }
  return kellyFraction;
}

/**
 * betUnit(賭け金の最小単位)を防御する。非有限・0以下・非整数は既定値(100)へフォールバック
 * する(kellyFractionと同じ流儀)。betUnitが0/NaNのまま割り算に渡ると計算結果がInfinity/NaNに
 * なり、以降totalStakeまでNaNが伝播してisSkip=false・skipReason=nullのままサイレントに
 * 破損した結果を返してしまう(重大バグの再発防止)。
 */
function resolveBetUnit(betUnit: number): number {
  if (!Number.isFinite(betUnit) || betUnit <= 0 || !Number.isInteger(betUnit)) {
    return DEFAULT_BET_ALLOCATION_CONFIG.betUnit;
  }
  return betUnit;
}

/**
 * greedySteps(貪欲逐次配分の分割数)を防御する。非有限・0以下・非整数は既定値(1000)へ
 * フォールバックする。greedySteps<=0/NaNだとStep4の貪欲ループが1回も実行されず、連続最適比率が
 * (実際には判定していないのに)全て0のまま返り、Step6が「妙味が小さく…」という誤ったskipReasonを
 * 報告してしまう(「判定していないことを判定結果として報告してはならない」欠陥)。
 */
function resolveGreedySteps(greedySteps: number): number {
  if (!Number.isFinite(greedySteps) || greedySteps <= 0 || !Number.isInteger(greedySteps)) {
    return DEFAULT_BET_ALLOCATION_CONFIG.greedySteps;
  }
  return greedySteps;
}

/**
 * 適正額超過の警告文言を組み立てる(設計判断4)。exceedsKellyTarget===falseならnull。
 * coreが数値込みの完成文を返し、UI側に文言の複製を作らせない。
 */
function buildAdvisory(
  exceedsKellyTarget: boolean,
  kellyTargetStake: number,
  betUnit: number,
): string | null {
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
 * Step2の畳み込み前(全頭)の同時分布から、各馬がいずれかの複勝圏内の組に含まれる確率
 * (周辺確率)を求め、入力placeProbとの乖離の絶対値の最大を返す。
 * 条件付けにより周辺確率の合計は保存されるため、乖離には正負両方が必ず現れる
 * (符号付き最大値は指標として無意味。よって絶対値の最大とする)。
 */
function computeMarginalDeviationMax(
  horses: readonly AllocationHorse[],
  rawDistribution: readonly PlaceOutcome[],
): number {
  const marginalByUmaban = new Map<number, number>();
  for (const outcome of rawDistribution) {
    for (const umaban of outcome.placed) {
      marginalByUmaban.set(umaban, (marginalByUmaban.get(umaban) ?? 0) + outcome.probability);
    }
  }
  let maxDeviation = 0;
  for (const horse of horses) {
    const marginal = marginalByUmaban.get(horse.umaban) ?? 0;
    const deviation = Math.abs(marginal - horse.placeProb);
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
    }
  }
  return maxDeviation;
}

/**
 * Step3: 同時分布を「複勝圏に入った候補馬の部分集合T」ごとに畳み込む。候補馬でない馬は
 * Tから除外される(候補馬に限定した部分集合に確率を合算する)。
 */
function foldToCandidateSubsets(
  rawDistribution: readonly PlaceOutcome[],
  candidateUmabanSet: ReadonlySet<number>,
): readonly PlaceOutcome[] {
  const folded = new Map<string, { placed: number[]; probability: number }>();
  for (const outcome of rawDistribution) {
    const t = outcome.placed.filter((u) => candidateUmabanSet.has(u)).sort((a, b) => a - b);
    const key = t.join(",");
    const existing = folded.get(key);
    if (existing) {
      existing.probability += outcome.probability;
    } else {
      folded.set(key, { placed: t, probability: outcome.probability });
    }
  }
  return [...folded.values()];
}

/**
 * Step4: 貪欲逐次配分で連続最適比率(ケリー基準のバンクロール比率 x*_i、0〜1)を求める。
 * 目的関数 F(x) = Σ_T P(T)·log(1 − Σx_i + Σ_{i∈T}x_i·o_i)。
 * 総資金・1レース上限には一切依存しない(スケール不変)。
 *
 * 貪欲法は大域最適の保証がない(目的関数は凹だが、多次元の逐次貪欲探索であるため)。
 * これは既知の設計上の限界であり、テスト(全探索との突き合わせ)で差の上界を固定して明示する。
 *
 * 計算量: 1ステップあたり候補数×畳み込み後outcome数の評価が必要(greedySteps回繰り返す)。
 * 実測では出走頭数18・全頭候補(最悪ケースに近い。畳み込み後outcome数はC(18,3)=816)・
 * greedySteps=1000で約13ms(開発機実測)。実運用の候補数(通常は数頭程度)ではさらに軽量。
 */
function optimizeContinuousFractions(
  candidates: readonly AllocationHorse[],
  foldedOutcomes: readonly PlaceOutcome[],
  greedySteps: number,
): number[] {
  const n = candidates.length;
  if (n === 0) {
    return [];
  }

  const odds = candidates.map((c) => c.placeOddsMin!);
  // 各畳み込み済み outcome を候補配列内インデックスの集合として持っておく(高速化)。
  const outcomeIndexSets = foldedOutcomes.map((outcome) => {
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (outcome.placed.includes(candidates[i]!.umaban)) {
        indices.push(i);
      }
    }
    return { indices, probability: outcome.probability };
  });

  const x = new Array<number>(n).fill(0);
  const delta = 1 / greedySteps;
  let sumX = 0;

  const computeF = (trialSumX: number, trialX: readonly number[]): number | null => {
    let total = 0;
    for (const outcome of outcomeIndexSets) {
      let payout = 0;
      for (const idx of outcome.indices) {
        payout += trialX[idx]! * odds[idx]!;
      }
      const wealth = 1 - trialSumX + payout;
      if (wealth <= NUMERIC_EPS) {
        // 資産が0以下になる割当は候補から除外する(logの定義域外)。
        return null;
      }
      total += outcome.probability * Math.log(wealth);
    }
    return total;
  };

  let currentF = computeF(sumX, x)!; // 全て0の初期状態は必ず有効(wealth=1 for 全outcome)。

  for (let step = 0; step < greedySteps; step++) {
    let bestIdx = -1;
    let bestIncrement = 0; // 増分の最大値が0以下になったら停止するため、初期値は0(厳密に上回る候補のみ採用)。
    const trialSumX = sumX + delta;
    for (let i = 0; i < n; i++) {
      const trialX = x.slice();
      trialX[i] = trialX[i]! + delta;
      const trialF = computeF(trialSumX, trialX);
      if (trialF === null) {
        continue;
      }
      const increment = trialF - currentF;
      if (increment > bestIncrement) {
        bestIncrement = increment;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      break; // 増分の最大値が0以下 → 停止(残りは配分しない=「使い切らない」の実現)。
    }
    x[bestIdx] = x[bestIdx]! + delta;
    sumX = trialSumX;
    currentF = computeF(sumX, x)!;
  }

  return x;
}

/**
 * Step6: 見送り理由を6分類・優先順位順に決定する(設計判断7参照)。
 * isSkip(totalStake===0)のときにのみ呼び出される。
 *
 * ⑥(連続最適比率が全て0)には明示的な条件チェックを置かず、①〜⑤をすべて通過した場合の
 * 最終フォールバックとして返す。理由: isSkip(totalStake===0)かつ①(resolvedBankroll>0)・
 * ②③(effectivePerRaceCap>=betUnit)・④(kellyTargetStake>0またはλ≠0)・⑤(candidateCount>0)を
 * すべて通過した時点で、最低額ロジック(Step5.5)が発動しなかった理由は
 * kellyTargetStake===0(=Σx*===0、全continuousFractionが0)しかありえない
 * (resolvedBankroll・effectivePerRaceCapは正、λ≠0なのでkellyTargetStake=λ·Σx*·resolvedBankroll
 * が0になるのはΣx*=0の場合のみ)。この帰結は構造的に保証されるため、追加の条件チェックは
 * 二重防御になり不要(exceedsKellyTargetの設計判断4と同じ思想)。
 */
function determineSkipReason(
  bankrollInput: number,
  perRaceCapInput: number,
  effectivePerRaceCap: number,
  betUnit: number,
  kellyTargetStake: number,
  kellyFraction: number,
  candidateCount: number,
): string {
  // ①総資金が未設定・負値・非有限(NaN/Infinity)。opt-inの既定状態であり「妙味なし」ではない。
  if (!Number.isFinite(bankrollInput) || bankrollInput <= 0) {
    return REASON_BANKROLL_UNSET;
  }
  // ②1レース上限が未設定・負値・非有限。
  if (!Number.isFinite(perRaceCapInput) || perRaceCapInput <= 0) {
    return REASON_CAP_UNSET;
  }
  // ③1レース上限はあるがbetUnit未満(実効上限が1単位に満たない)。
  if (effectivePerRaceCap < betUnit) {
    return REASON_CAP_TOO_SMALL;
  }
  // ④ケリー係数が0(ユーザーの明示的な「賭けない」指定。候補の有無より優先する)。
  if (kellyTargetStake === 0 && kellyFraction === 0) {
    return REASON_KELLY_ZERO;
  }
  // ⑤候補(EVプラスかつオッズあり)が1頭もいない。
  if (candidateCount === 0) {
    return REASON_NO_CANDIDATES;
  }
  // ⑥連続最適比率が全て0(妙味が極小で、賭ける価値がないとケリー基準が判断した)。
  return REASON_NO_EDGE;
}
