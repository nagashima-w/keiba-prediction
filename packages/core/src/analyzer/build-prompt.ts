/**
 * プロンプトテンプレートの版番号(Task#27 プロンプト改善A)。
 * `analyses` テーブルの prompt_version 列に保存され、verify を版ごとに比較できるようにする。
 *
 * 運用ルール: この定数は自動更新しない。buildPrompt が組み立てるプロンプト文面
 * (【指示】【予想印】等、LLMへ渡す指示・出力スキーマの実質的な内容)を変更したら、
 * この値を手動で更新すること(例: 同日内の追加改訂なら "2026-07-14.2"、日付が変われば
 * その日付で "1" から採番)。文面に影響しない変更(コメント修正など)では更新不要。
 *
 * 初期値 "2026-07-14.1" は、この記録の仕組み(Task#27)を導入した時点の現行プロンプトに
 * 対する初版として付与した(このプロンプト文面自体はTask#27より前から存在するが、
 * 版番号による追跡はここから開始する)。
 *
 * "2026-07-18.1": 展開想定の強化(印・prior・参考EV・±10%クリップ・出力スキーマは不変)。
 * 【展開想定】を「逃げ馬の数+ペース想定の1文」から「脚質分布・主導権候補・想定ペースの根拠・
 * 恵まれる/損する脚質」の構造化情報に拡充し、各馬行にも脚質の安定度・過去のペース傾向を追加した。
 *
 * "2026-07-19.1": 予想印の頭数制約緩和(B-1)+優先順位の明記(2026-07-19合意)。
 * 【予想印】の頭数制約を「◎〇▲=ちょうど1頭ずつ、△=1〜3頭」から「◎=ちょうど1頭のみ必須、
 * 〇▲=0〜1頭、△=0〜3頭」に緩和し、本線印(◎〇▲△)は◎→〇→▲→△の順で上位を飛ばさず
 * 途切れなく付ける(該当なしはそこで打ち止め・下位省略)gapless な優先順位を明記した。
 * ☆・注は本線と独立の人気薄枠であることも明記(prior・参考EV・±10%クリップ・出力スキーマは不変)。
 *
 * "2026-07-19.2": 条件替わり(妙味材料)の追加(2026-07-19 boss着手前ゲート合意)。
 * 各馬行に「条件替わり=」項目を追加し、サーフェス替わり・距離延長/短縮・中央⇄地方替わりを
 * 決定論的に判定して表示する(analyzer/condition-change.ts の computeConditionChangeTags)。
 * 該当なしの馬は「条件替わり=なし」。他セクション・出力スキーマ・予想印の指示は不変。
 *
 * "2026-07-19.3": 地方/コース形態の有利脚質補正(タスクB。2026-07-19 boss着手前ゲート合意)。
 * 【展開想定】セクションの末尾に2行追加する。(a) 全venue共通: コース形態(会場・回り・距離)
 * による前後有利はLLM自身でも判断するよう促す1行。(b) 地方(venueKind="nar")限定: 地方は
 * 前残り傾向が強く馬場不良時は差しも届きにくい旨の1行(中央には出さない)。恵まれる/損する脚質
 * (favoredStyles/disfavoredStyles)自体の対応表も、地方(nar)向けに leg-style.ts の
 * buildRaceDevelopment(venueKind/trackCondition引数追加)側で切り替わるようにした
 * (中央/venueKind未指定は従来表のまま変更なし)。既存4行の文言・出力スキーマ・予想印の指示は不変。
 *
 * タスクD-2(クリップ幅の版切替・±10%↔±15%のA/B・2026-07-21 boss着手前ゲート合意):
 * この PROMPT_VERSION 定数自体は対照(clipVariant="default")用の値であり、D-2自身のスコープでは
 * 変更しない(...clip010 へ改名しない、の意)。新設した clip-variants.ts の
 * CLIP_VARIANTS.default.promptVersion と同一の値をここに置いている(このファイル側が定義元、
 * clip-variants.ts はここから参照しない循環を避けるため独立に同じ文字列を持つ。ズレはテストで固定する)。
 * 新版(wide15)は CLIP_VARIANTS.wide15.promptVersion(対照の値+"-clip"+幅を3桁で表した値。
 * 例: 幅0.15→"clip015")を使う。buildPrompt は input.clipVariant(省略時は対照)に応じて
 * 【指示】【追加指示】ブロックの許容幅表記(±10%(絶対値0.10) 等)だけを CLIP_VARIANTS から
 * 機械導出し、他の文言・出力スキーマは不変。
 *
 * #26-P3: 中央芝で芝コースの開催進行(開催回・日次・柵の事実)を1行追加。方向は断定せず材料として
 * 提示。他文面・出力スキーマ不変。この対照(default)のPROMPT_VERSION更新に伴い、
 * CLIP_VARIANTS.wide15.promptVersion も同じ値+"-clip015"へ追随した(ユーザー確定事項A: 対照更新時、
 * 新版は必ず追随する運用に確定。D-2時点の「追随するかはその時点の合意による」という運用は
 * この固定ルールに置き換えた。詳細は clip-variants.ts 冒頭コメント参照)。
 *
 * #27-C(当日傾向をプロンプトに反映する配線。2026-07-23 boss着手前ゲート合意): 【レース情報】末尾
 * (turfWearHintの後)に、当日・同一場・同一面の確定済み結果から集計した傾向(same-day-trend.ts の
 * summarizeSameDayTrend)を1行追加できるようにした。呼び出し側(analysis-pipeline.ts)が
 * collectSameDayTrend で算出した SameDayTrendSummary を race.sameDayTrend として渡したときだけ描画し、
 * 脚質傾向が「データ不足」ならブロックごと非表示、内外傾向・上がり傾向は値がある指標だけ列挙する
 * (turfWearHintと同じ非破壊optionalの spread-omit 流儀。未指定なら既存文面バイト不変)。
 * 他文面・出力スキーマは不変。この対照(default)のPROMPT_VERSION更新に伴い、
 * CLIP_VARIANTS.wide15.promptVersion も同じ値+"-clip015"へ追随する(ユーザー確定事項A)。
 */
export const PROMPT_VERSION = "2026-07-23.1";

export {
  CLIP_VARIANTS,
  clipAbsoluteLabel,
  clipPercentLabel,
  DEFAULT_CLIP_VARIANT_ID,
  resolveClipVariant,
  type ClipVariant,
  type ClipVariantId,
} from "./clip-variants.js";

/**
 * プロンプト構築 — 1レース分の情報を LLM 用の1つのテキストにまとめる純関数。
 *
 * 仕様「3. analyzer」がプロンプトに含めると定めた情報:
 *  - 各馬の prior(scorer出力)
 *  - 調教評価(OikiriResult 由来: 評価テキスト+ランク。無い馬は「情報なし」)
 *  - 厩舎コメント(プレミアム限定で未取得のため既定「なし」。将来の受け皿として stableComment を optional に用意)
 *  - レース間隔、脚質と展開想定の材料(全コーナーの通過順から脚質を分類し、脚質分布・主導権候補・
 *    想定ペースの根拠・恵まれる/損する脚質を明示。Task「展開強化」)
 *  - 当日の天候・馬場状態
 *  - 単勝オッズ・人気・複勝オッズ下限・参考EV(市場データ。呼び出し側〈analysis-pipeline.ts〉が
 *    OddsSnapshot から算出して渡す。詳細は各フィールドのコメント参照)
 *  - LLMへの指示(複勝圏内確率をJSONのみで出力・prior±10%以内・根拠明記)と出力スキーマ指定
 *  - 予想印(◎〇▲△☆注)の定義・頭数制約・判断材料の指示(Task#22: ユーザー要望)
 *
 * ネットワーク・LLM・SDK には一切依存しない(テキストを組み立てて返すだけ)。
 */

import type { CourseType } from "../scraper/types.js";
import type { RaceIdVenueKind } from "../scraper/ids.js";
import { classifyTrackWetness } from "../scorer/derive-features.js";
import type { SameDayTrendSummary } from "./same-day-trend.js";
import type { TurfWearHint } from "./turf-wear.js";
import {
  clipAbsoluteLabel,
  clipPercentLabel,
  resolveClipVariant,
  type ClipVariantId,
} from "./clip-variants.js";
import {
  computeConditionChangeTags,
  type ConditionChangeRun,
  type ConditionChangeTag,
} from "./condition-change.js";
import {
  analyzeHorseLegStyle,
  buildRaceDevelopment,
  summarizePastPaceTendency,
  type HorseRunPassing,
  type RaceDevelopmentHorseInput,
} from "./leg-style.js";

/** プロンプトに載せる調教評価(無い馬は null/undefined)。 */
export interface PromptOikiri {
  /** 調教評価テキスト(例: 動き抜群)。 */
  readonly critic: string | null;
  /** 調教評価ランク(例: A)。 */
  readonly rank: string | null;
}

/** プロンプトに載せる1頭分の情報。 */
export interface PromptHorse {
  /** 馬番。 */
  readonly umaban: number;
  /** 馬名。 */
  readonly horseName: string;
  /** scorer の prior(複勝圏内確率の事前推定値)。 */
  readonly prior: number;
  /** 調教評価。未取得なら null/undefined(「情報なし」と表記)。 */
  readonly oikiri?: PromptOikiri | null;
  /** 厩舎コメント(将来の受け皿)。未取得なら null/undefined(「なし」と表記)。 */
  readonly stableComment?: string | null;
  /**
   * 脚質・展開想定に使う過去走の情報(新しい順)。通過順(全コーナー)に加え、
   * pace(前半3F-後半3F)・last3f(上がり3F)があれば「過去のペース傾向」の算出に使う
   * (いずれも省略可。未指定の走はその走のペース傾向判定から除外されるだけで落ちない)。
   */
  readonly runs: readonly HorseRunPassing[];
  /**
   * 条件替わり(妙味材料)判定に使う過去走の条件(新しい順)。既存の runs(脚質・展開想定用)とは
   * 別配列であり、互いの意味論・挙動には一切影響しない。未指定(省略)は新馬相当として扱われ、
   * 条件替わりタグは全て「なし」になる(例外にはならない)。
   */
  readonly runConditions?: readonly ConditionChangeRun[];
  /** レース間隔テキスト(例: 中2週 / 休み明け)。無ければ「不明」と表記。 */
  readonly restInterval?: string | null;
  /** 単勝オッズ。取消等で未取得なら null/undefined(「不明」と表記)。 */
  readonly winOdds?: number | null;
  /** 人気。取得できない場合は null/undefined(「不明(オッズ値から判断)」と表記)。 */
  readonly popularity?: number | null;
  /**
   * 複勝オッズ下限。複勝未発売(oddsStatus=yoso)やオッズ欠損時は null/undefined
   * (「複勝未発売」と表記)。
   */
  readonly placeOddsMin?: number | null;
  /**
   * 参考EV(= 3着内率〈prior〉× 複勝オッズ下限)。呼び出し側が computeReferenceEv で算出して渡す。
   * どちらか欠落なら null/undefined(「算出不可」と表記)。
   * あくまでLLM補正前の参考値であり、最終的なEVはLLMが出す補正後確率で別途(ev/expected-value.ts の
   * computeRaceEv で)再計算される。プロンプトにもその旨を明記し、市場オッズへのアンカリングを防ぐ。
   */
  readonly referenceEv?: number | null;
}

/**
 * 参考EV(= 3着内率〈prior〉× 複勝オッズ下限)を計算する純関数。
 * ev/expected-value.ts の computeRaceEv(全馬・OddsSnapshot前提)を呼び回す必要はなく、
 * analyzer 層に閉じた単純計算で済む(呼び出し側が PromptHorse.referenceEv に渡す値の算出に使う)。
 * @param prior 3着内率(scorerのprior)
 * @param placeOddsMin 複勝オッズ下限。欠損(null)なら参考EVは算出不可としてnullを返す。
 */
export function computeReferenceEv(
  prior: number,
  placeOddsMin: number | null,
): number | null {
  if (placeOddsMin === null || !Number.isFinite(placeOddsMin)) {
    return null;
  }
  if (!Number.isFinite(prior)) {
    return null;
  }
  return prior * placeOddsMin;
}

/** レース全体の条件。 */
export interface BuildPromptRaceInfo {
  /** レース名(任意)。 */
  readonly raceName?: string;
  /** コース種別(芝/ダ/障)。 */
  readonly courseType: CourseType;
  /** 距離(m)。 */
  readonly distance: number;
  /** 競馬場名(任意)。 */
  readonly venueName?: string;
  /** 当日の天候。未取得なら null/undefined(「不明」と表記)。 */
  readonly weather?: string | null;
  /** 当日の馬場状態。未取得なら null/undefined(「不明」と表記)。 */
  readonly trackCondition?: string | null;
  /**
   * 前日分析時の「稍重以下の可能性」フラグ(仕様L104「雨予報時の馬場悪化シナリオ」)。
   * true なら、良馬場表記でも馬場悪化シナリオの評価指示をプロンプトに入れる。
   * scraper 側の予報連携は将来対応のため、当面は呼び出し側が任意指定する。
   */
  readonly wetForecast?: boolean;
  /**
   * 現レースの開催区分(中央/地方)。条件替わり(妙味材料)の中央⇄地方替わり判定にのみ使う。
   * 省略時はこのタグの判定だけをスキップする(サーフェス替わり・距離延長/短縮の判定には影響しない。
   * condition-change.ts の computeConditionChangeTags 参照)。
   */
  readonly venueKind?: RaceIdVenueKind;
  /**
   * 芝の傷み目安(タスク#26-P3。turf-wear.ts の assessTurfWear が返すヒント)。
   * 呼び出し側(analysis-pipeline.ts)が raceId・courseType・fence から算出して渡す
   * (このモジュール自体は raceId を保持しないため算出しない)。値がある(non-null)ときだけ
   * 【レース情報】末尾に1行追加する。undefined/null なら行自体を出さない(既存文面バイト不変。
   * weather 等と同じ spread-omit 流儀)。段階分け・方向判定はせず、事実(開催回・日次・柵)のみの
   * 中立な材料文を渡すため、ここでの整形も「行を出す/出さない」の判定のみに留める。
   */
  readonly turfWearHint?: TurfWearHint | null;
  /**
   * 当日の同一場・同一面傾向(タスク#27-C。same-day-trend.ts の collectSameDayTrend が返す集計結果)。
   * 呼び出し側(analysis-pipeline.ts)が当日・同一場・同一面の確定済み結果から算出して渡す
   * (このモジュール自体は raceId・DBを保持しないため算出しない)。undefined/null なら行自体を出さない
   * (turfWearHintと同じ spread-omit 流儀。既存文面バイト不変)。値があっても 脚質傾向 が
   * 「データ不足」ならブロックを一切出さない(呼び出し側の collectSameDayTrend は既にこのケースを
   * null に丸めて返すが、本関数はそれに依存せず自前でも判定する。defense in depth)。
   * 内外傾向・上がり傾向が null の指標は該当項目のみ省く。
   */
  readonly sameDayTrend?: SameDayTrendSummary | null;
}

/** buildPrompt の入力。 */
export interface BuildPromptInput {
  /** レース条件。 */
  readonly race: BuildPromptRaceInfo;
  /** 出走馬(表示順はそのまま使うが、内部では馬番昇順に整列する)。 */
  readonly horses: readonly PromptHorse[];
  /** 脚質分類で参照する直近走数(既定3)。 */
  readonly recentRunsForLegStyle?: number;
  /**
   * 追加指示の注入口(Task#28 プロンプト改善C。設定画面から編集可能)。
   * verify(検証)で見えた補正の誤り傾向を元に、コード変更なしでプロンプトへ指示を差し込むための欄。
   * 空文字・空白のみ・未指定なら何も差し込まない(既存プロンプトと完全一致)。
   * 差し込み位置は【予想印】セクションの後・【出力スキーマ】セクションの前(アンカリング禁止・
   * ±10%制約など既存の設計思想指示より後ろに置き、それらを上書きしない旨を併記する)。
   * この文言自体は analyses.additional_instruction 列に保存され(analysis-store.ts)、
   * PROMPT_VERSION(テンプレート本体の版)とは別軸で「どの追加指示で分析したか」を追跡できる。
   */
  readonly additionalInstruction?: string;
  /**
   * クリップ幅の版ID(タスクD-2: ±10%↔±15%のA/B・新版並走)。省略時・不正値は対照("default"、
   * ±10%・絶対値0.10)へフォールバックし、既存プロンプトと完全一致する(clip-variants.ts の
   * resolveClipVariant に委譲)。分析パイプライン(呼び出し側)は、この値と同じ版IDを
   * parseAnalyzerResponse へ渡す maxAdjust の解決にも使う必要がある(単一ソースの CLIP_VARIANTS
   * から両者を導出することで文面とクリップ幅の食い違いを防ぐ。D-3)。
   */
  readonly clipVariant?: ClipVariantId;
}

/** null/undefined/空文字を既定表記へ丸める。 */
function orText(value: string | null | undefined, fallback: string): string {
  const v = value?.trim();
  return v ? v : fallback;
}

/** 調教評価を1行テキストにする(無ければ「情報なし」)。 */
function oikiriText(oikiri: PromptOikiri | null | undefined): string {
  if (!oikiri) {
    return "情報なし";
  }
  const critic = orText(oikiri.critic, "評価なし");
  const rank = orText(oikiri.rank, "-");
  return `評価「${critic}」ランク${rank}`;
}

/** 天候が雨系(「雨」を含む: 雨・小雨・大雨など)なら true。 */
function isRainyWeather(weather: string | null | undefined): boolean {
  return typeof weather === "string" && weather.includes("雨");
}

/** 有限数値でなければ fallback、そうでなければ倍率表記(小数1桁+「倍」)にする。 */
function oddsText(value: number | null | undefined, fallback: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return `${value.toFixed(1)}倍`;
}

/** 人気を「N番人気」表記にする(未取得は「不明(オッズ値から判断)」)。 */
function popularityText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "不明(オッズ値から判断)";
  }
  return `${value}番人気`;
}

/**
 * 条件替わりタグ配列を1行のテキストにする(該当なしは「なし」)。
 * 複数タグは「・」区切りで、computeConditionChangeTags が返す順序(サーフェス→距離→開催)のまま並べる。
 */
function conditionChangeText(tags: readonly ConditionChangeTag[]): string {
  if (tags.length === 0) {
    return "なし";
  }
  return tags.map((t) => t.label).join("・");
}

/** 参考EVを小数2桁で表記する(算出不可なら「算出不可」)。 */
function referenceEvText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "算出不可";
  }
  return value.toFixed(2);
}

/**
 * 当日の同一場・同一面傾向(タスク#27-C)を【レース情報】の1行にする。
 * summary が無い(undefined/null)、または脚質傾向が「データ不足」なら null(行を出さない)。
 * 内外傾向・上がり傾向は値がある(non-null)指標だけ「/」区切りで列挙する。
 */
function sameDayTrendText(
  courseType: CourseType,
  summary: SameDayTrendSummary | null | undefined,
): string | null {
  if (!summary || summary.脚質傾向 === "データ不足") {
    return null;
  }
  const parts = [`脚質=${summary.脚質傾向}`];
  if (summary.内外傾向 !== null) {
    parts.push(`内外=${summary.内外傾向}`);
  }
  if (summary.上がり傾向 !== null) {
    parts.push(`上がり=${summary.上がり傾向}`);
  }
  return (
    `当日の同場・同面傾向(${courseType}、確定${summary.サンプル数.レース数}R): ` +
    parts.join(" / ")
  );
}

/**
 * 1レース分のプロンプトを組み立てる。
 * 出力は決定論的(同一入力→同一文字列)。馬番昇順で各馬行を並べる。
 */
export function buildPrompt(input: BuildPromptInput): string {
  const { race } = input;
  const horses = [...input.horses].sort((a, b) => a.umaban - b.umaban);
  const recentRuns = input.recentRunsForLegStyle ?? 3;
  // クリップ幅の版(タスクD-2)。未指定・不正値は対照(±10%・絶対値0.10)へフォールバックする
  // (resolveClipVariant)。以下の【指示】【追加指示】ブロックの許容幅表記のみここから機械導出し、
  // 他の文言は変わらない(対照は完全不変=既存プロンプトとバイト完全一致)。
  const clipVariant = resolveClipVariant(input.clipVariant);
  const clipPercent = clipPercentLabel(clipVariant.maxAdjust);
  const clipAbsolute = clipAbsoluteLabel(clipVariant.maxAdjust);

  // 各馬の脚質・安定度・先行力スコアを分析する(全コーナーの位置取り推移を使う精緻化版。
  // leg-style.ts の analyzeHorseLegStyle。第1コーナーだけで判定していた旧ロジックと違い、
  // 「先頭コーナーで先頭に立ったが道中で失速した」ような馬を実態に近い脚質へ分類できる)。
  const legStyleAnalyses = new Map(
    horses.map((h) => [h.umaban, analyzeHorseLegStyle(h.runs, { recentRuns })]),
  );
  // 各馬の脚質分析から、レース全体の展開想定(脚質分布・主導権候補・想定ペースの根拠・
  // 恵まれる/損する脚質)を構造化する。LLMに「なぜそのペースを想定したか」まで示すことで、
  // 展開解釈の妥当性を検証しやすくし、予想印(特に☆・注)の判断材料にもなる。
  const developmentInputs: RaceDevelopmentHorseInput[] = horses.map((h) => {
    const a = legStyleAnalyses.get(h.umaban)!;
    return {
      umaban: h.umaban,
      style: a.style,
      stability: a.stability,
      frontRunningScore: a.frontRunningScore,
    };
  });
  // venueKind・trackCondition を渡すと、地方(nar)向けの恵まれる/損する脚質の対応表に切り替わる
  // (中央/venueKind未指定は従来表のまま。leg-style.ts の favoredStylesForPace 参照)。
  const development = buildRaceDevelopment(
    developmentInputs,
    race.venueKind,
    race.trackCondition,
  );

  // 馬場悪化シナリオ(仕様L104): 現在の天候が雨系、または馬場が稍重以下、または前日想定の
  // wetForecast=true の場合に、道悪適性を織り込む指示を追加する。良馬場かつ予報なしは通常指示のみ。
  const wetTrack =
    classifyTrackWetness(race.trackCondition ?? null, race.courseType)?.isWet ===
    true;
  const wetScenario =
    race.wetForecast === true || isRainyWeather(race.weather) || wetTrack;

  const lines: string[] = [];
  lines.push("あなたは競馬の複勝圏内(3着以内)確率を評価するアナリストです。");
  lines.push("");

  // レース情報。
  const raceHeader = [
    race.raceName ? `レース名: ${race.raceName}` : null,
    `コース: ${race.courseType}${race.distance}m`,
    race.venueName ? `競馬場: ${race.venueName}` : null,
    `天候: ${orText(race.weather, "不明")}`,
    `馬場状態: ${orText(race.trackCondition, "不明")}`,
    // 芝の傷み目安(タスク#26-P3): 値がある(non-null)ときだけ1行追加する。
    // undefined/null(raceId非保持のプレビュー等)なら行自体を出さず、既存文面バイト不変を保つ。
    race.turfWearHint ? `芝コースの開催進行: ${race.turfWearHint.note}` : null,
    sameDayTrendText(race.courseType, race.sameDayTrend),
  ].filter((x): x is string => x !== null);
  lines.push("【レース情報】");
  lines.push(...raceHeader);
  lines.push("");

  // 展開想定(Task「展開強化」)。
  // 従来は「逃げ馬の数」と粗いペース想定文の2行のみだったが、以下の4行に拡充する:
  //  1) 脚質分布: レース全体の隊列構成(どの脚質が何頭いるか)を数値でLLMに渡す。
  //  2) 主導権候補: ハナを切る可能性が最も高い馬を明示し、隊列のイメージを具体化する。
  //  3) ペース想定+根拠: 想定ペースだけでなく「なぜそう推定したか」(逃げ馬の頭数・主導権候補)
  //     を示し、LLMがその妥当性を検証したり、根拠が薄い場合は独自判断で補正できるようにする。
  //  4) 恵まれる/損する脚質: 想定ペースの定石(スロー=前残り、ハイ=差し追込有利)を明示し、
  //     予想印(特に☆・注の展開ハマり判定)の判断材料にする。
  lines.push("【展開想定】");
  lines.push(
    `脚質分布: 逃げ${development.styleCounts.逃げ}頭 / 先行${development.styleCounts.先行}頭 / ` +
      `差し${development.styleCounts.差し}頭 / 追込${development.styleCounts.追込}頭` +
      (development.unknownCount > 0 ? ` / 不明${development.unknownCount}頭` : ""),
  );
  lines.push(
    `主導権候補: ${
      development.paceSetterUmaban !== null
        ? `馬番${development.paceSetterUmaban}`
        : "該当馬なし(逃げ・先行タイプ不在)"
    }`,
  );
  lines.push(`ペース想定: ${development.pace}(根拠: ${development.paceReason})`);
  lines.push(
    `恵まれる脚質: ${
      development.favoredStyles.length > 0
        ? development.favoredStyles.join("・")
        : "特になし"
    }`,
  );
  lines.push(
    `損する脚質: ${
      development.disfavoredStyles.length > 0
        ? development.disfavoredStyles.join("・")
        : "特になし"
    }`,
  );
  // (a) 全venue共通: 上記は逃げ馬の頭数から機械的に推定した想定であり、会場・回り(右/左)・
  // 距離によるコース形態的な前後有利までは織り込んでいない。LLM自身の判断も促す。
  lines.push(
    "コース形態(会場・回り・距離)による前後有利は、上記に加えてあなた自身でも判断してください。",
  );
  // (b) 地方(venueKind="nar")限定: 地方競馬は中央より前残り傾向が強く、馬場が不良の場合は
  // 差しも届きにくくなる(タスクB)。中央には出さない。
  if (race.venueKind === "nar") {
    lines.push(
      "地方競馬は前残り(先行有利)傾向が強く、馬場不良時は差しも届きにくい点を加味してください。",
    );
  }
  lines.push("");

  // 各馬。
  // 「3着内率」= scorer が数値データから算出した複勝圏内(3着以内)確率の事前推定値。
  // ユーザー要望により、モデルに提示する語彙とモデルの出力(reason)を「3着内率」で統一する
  // (内部の変数・型名 prior は変更しない。JSONスキーマのキー place_prob も英語のまま)。
  lines.push(
    "【出走馬(3着内率 は scorer が数値データから算出した複勝圏内〈3着以内〉確率の事前推定値)】",
  );
  for (const h of horses) {
    const a = legStyleAnalyses.get(h.umaban)!;
    // 条件替わり(妙味材料): サーフェス替わり・距離延長/短縮・中央⇄地方替わりを決定論的に判定する
    // (condition-change.ts。runConditions未指定の馬は新馬相当としてpastRuns=[]扱いになり、
    // 全タグなし=「なし」表記に自然に落ちる)。
    const conditionChangeTags = computeConditionChangeTags({
      currentCourseType: race.courseType,
      currentDistance: race.distance,
      currentVenueKind: race.venueKind,
      pastRuns: h.runConditions ?? [],
    });
    // 脚質の「安定度」: 直近走で脚質がどれだけ一貫しているかを添え、LLMが展開読みの
    // 確度を判断できるようにする(例: 安定して差してくる馬か、その場その場で脚質が変わる馬か)。
    // 「過去ペース傾向」: その馬がこれまで速い/遅い流れをどれだけ経験しているか(展開への
    // 対応力の参考材料)を summarizePastPaceTendency で要約して添える。
    lines.push(
      `馬番${h.umaban} ${h.horseName}: ` +
        `3着内率=${h.prior.toFixed(2)}, ` +
        `脚質=${a.style ?? "不明"}(安定度:${a.stability}), ` +
        `過去ペース傾向=${summarizePastPaceTendency(h.runs, { recentRuns })}, ` +
        `レース間隔=${orText(h.restInterval, "不明")}, ` +
        `調教=${oikiriText(h.oikiri)}, ` +
        `厩舎コメント=${orText(h.stableComment, "なし")}, ` +
        `単勝オッズ=${oddsText(h.winOdds, "不明")}, ` +
        `人気=${popularityText(h.popularity)}, ` +
        `複勝オッズ下限=${oddsText(h.placeOddsMin, "複勝未発売")}, ` +
        `参考EV=${referenceEvText(h.referenceEv)}, ` +
        `条件替わり=${conditionChangeText(conditionChangeTags)}`,
    );
  }
  lines.push("");
  lines.push(
    "注記: 参考EVは 3着内率(LLM補正前の事前推定値)× 複勝オッズ下限 の参考値です。" +
      "あなたが出す補正後確率(place_prob)で最終的なEVは別途再計算されるため、参考EV自体を出力する必要はありません。",
  );
  lines.push(
    "重要: 単勝オッズ・人気・参考EVは、予想印の☆・注(人気薄判定)や妙味の把握に使ってください。" +
      "3着内率の補正そのものを市場オッズに近づける(アンカリングする)目的で使うことは禁止します。" +
      "補正の根拠はあくまで脚質・展開・調教・レース間隔・厩舎コメント等のデータに基づいてください。" +
      "本ツールは市場から独立した確率推定と市場オッズを掛け合わせて妙味を見つけることが目的であり、" +
      "確率推定が市場に迎合すると妙味が失われます。",
  );
  lines.push("");

  // 指示。
  lines.push("【指示】");
  lines.push(
    "各馬の複勝圏内確率を JSON のみで出力してください。散文や説明文は出力しないでください。",
  );
  lines.push(
    `補正は各馬の 3着内率(データからの事前推定)から ±${clipPercent}(絶対値${clipAbsolute})以内に留めてください。3着内率から大きく離れた値は禁止です。`,
  );
  lines.push(
    "補正には必ず根拠(調教・厩舎コメント・展開のいずれか)を reason に日本語で明記してください。",
  );
  // reason 文中の表記統一(ユーザー要望): 出力を見てパッとわかるよう、事前推定値は「3着内率」で書かせる。
  // 指示文自体にも英語表記(prior)を出さず「3着内率」に統一する。
  lines.push(
    "reason の文中では、事前推定値を指すときは必ず「3着内率」と日本語で表記してください(英語の略称は使わないでください)。",
  );
  if (wetScenario) {
    lines.push(
      "馬場悪化シナリオ: 天候・馬場から馬場が悪化する(または既に道悪の)可能性があります。" +
        "各馬の道悪適性の高低を織り込んで評価し、reason にもその旨を明記してください。",
    );
  }
  lines.push("place_prob は 0 以上 1 以下の小数です。全馬について出力してください。");
  lines.push("");

  // 予想印(Task#22: ユーザー要望による同一LLM呼び出しでの印決定)。
  // 頭数制約緩和(B-1)・本線印の優先順位(2026-07-19合意): 無理に頭数を埋めさせて質の低い印が
  // つくことを避けるため、◎以外は「自信があるところまでで止めてよい」設計にしている。
  lines.push("【予想印】");
  lines.push(
    "各馬に以下6種類の予想印(mark)のいずれか、または印なし(null)を1つ付けてください" +
      "(1頭に複数の印を付けることはできません)。",
  );
  // ◎は唯一の必須印(頭数下限1)。本線(◎〇▲△)の起点であり、他の本線印の有無に関わらず必ず1頭。
  lines.push("◎(本命): 1着になりそうな最有力の馬。必ずちょうど1頭。");
  // 〇以下は頭数下限を撤廃(0頭も許容)。無理に対抗馬を作らせるより、確信度が無ければ付けない方を優先する。
  lines.push(
    "〇(対抗): 本命に対抗できそうな2番手の馬。0〜1頭(該当馬がいなければ付けなくてよい)。",
  );
  lines.push(
    "▲(単穴): 本命と対抗を差し置いて勝てる可能性がある3番手の馬。0〜1頭(該当馬がいなければ付けなくてよい)。",
  );
  lines.push(
    "△(連下): 上記3つの印よりは劣るが、2着や3着に入りそうな馬。0〜3頭(該当馬がいなければ付けなくてよい)。",
  );
  lines.push(
    "☆(星): 人気はないが(単勝オッズ・人気を根拠に判断)、展開やペースがはまれば勝てる可能性のある穴馬。0〜1頭。",
  );
  lines.push(
    "注(注意): 人気はないが(単勝オッズ・人気を根拠に判断)、展開やペースがはまれば3着に入る可能性のある穴馬。0〜1頭。",
  );
  lines.push(
    "判断材料: 3着内率・参考EV・単勝オッズ/人気・脚質と展開想定、およびここまでの分析(各馬の place_prob と reason)を総合して判断してください。",
  );
  // 本線印(◎〇▲△)は「上位を飛ばして下位だけ付ける」ことを禁止する gapless な優先順位を持つ。
  // ◎→〇→▲→△の順で上から順に自信のある馬を並べ、自信がなくなった時点で下位の印は省略する
  // (例: ◎〇までしか確信が持てないなら▲△は付けない。◎のみでもよい)。
  lines.push(
    "本線印(◎〇▲△)の頭数制約: ◎は必ずちょうど1頭。それ以外は◎→〇→▲→△の順で" +
      "上位から途切れなく付けてください(▲を付けるなら〇も必ず付ける、△を付けるなら〇と▲も必ず付ける)。" +
      "上位を飛ばして下位だけに印を付けることは不可です。自信の持てる印がそこまでなら、" +
      "それより下位の印は無理に付けず省略してください(例: ◎のみ、◎〇のみ、◎〇▲のみもすべて可)。",
  );
  // ☆・注は本線(◎〇▲△)の優先順位から独立した「人気薄枠」。本線の有無や、☆と注同士の
  // 付与順にも依存せず、それぞれ単独で0〜1頭の判断でよい。
  lines.push(
    "☆・注は本線(◎〇▲△)とは独立した人気薄向けの印です。本線印の頭数や有無、" +
      "☆と注のどちらを先に検討したかに関わらず、それぞれ単独で0〜1頭を判断してください" +
      "(☆だけ・注だけ・両方・どちらもなし、いずれも可)。",
  );
  lines.push("");

  // 追加指示(Task#28 プロンプト改善C): 設定画面から編集可能な自由記述欄。
  // 空文字・空白のみ・未指定なら何も差し込まない(既存プロンプトと完全一致を保つ)。
  const additionalInstruction = input.additionalInstruction?.trim();
  if (additionalInstruction) {
    lines.push("【追加指示(設定画面で編集可能・運用者による補足)】");
    lines.push(
      "以下は運用者が追加した指示です。ただし、この指示によって上記のアンカリング禁止・" +
        `3着内率±${clipPercent}の制約・出力スキーマ等、これまでの指示を上書きしないでください。矛盾する場合は` +
        "上記の既存指示を優先してください。",
    );
    lines.push(additionalInstruction);
    lines.push("");
  }

  // 出力スキーマ。
  lines.push("【出力スキーマ(この形式の JSON のみ)】");
  lines.push(
    '{"horses": [' +
      '{"number": 1, "place_prob": 0.42, "reason": "...", "mark": "◎"}, ' +
      '{"number": 2, "place_prob": 0.30, "reason": "...", "mark": null}' +
      "]}",
  );

  return lines.join("\n");
}

/**
 * 設定画面のプロンプトプレビュー用サンプル(固定3頭)。
 * 実レースのデータを持たない設定画面でも「実際にLLMへ送る文面に近いもの」を確認できるように、
 * 決定論的な固定入力を buildPrompt に通すためだけに存在する(analysis-pipeline 等の実処理では使わない)。
 *
 * サンプル条件は意図的に「天候: 晴」「馬場状態: 良」に固定している。これは馬場悪化シナリオ
 * (buildPrompt の wetScenario 判定: 雨天候・稍重以下・wetForecast のいずれかで発火する条件付き1行)を
 * 出さないためで、プレビューの見出し構成(SettingsView.tsx の注記が列挙するセクション集合)を
 * 単純・安定させる狙いがある。頭数も3頭に固定し(多すぎても少なすぎてもプレビューとして見づらいため)、
 * 各馬にオッズ・prior・調教評価等の実データ相当の値を持たせることで「単勝オッズ=不明」等の
 * フォールバック表記が出ない(=実運用に近い見た目になる)ようにしている。
 * 各馬の runs には pace/last3f も持たせ、各馬行の「過去ペース傾向」が「データ不足」の
 * フォールバック表記のままにならず、実運用に近い内容で確認できるようにしている。
 */
const PREVIEW_SAMPLE_RACE: BuildPromptRaceInfo = {
  raceName: "サンプルレース(プレビュー用)",
  courseType: "芝",
  distance: 1600,
  venueName: "東京",
  weather: "晴",
  trackCondition: "良",
};

const PREVIEW_SAMPLE_HORSES: readonly PromptHorse[] = [
  {
    umaban: 1,
    horseName: "サンプルホース1",
    prior: 0.55,
    oikiri: { critic: "動き抜群", rank: "A" },
    stableComment: "仕上がり良好",
    runs: [
      { passing: [1, 1, 1, 1], fieldSize: 16, pace: "36.5-35.8", last3f: 35.8 },
      { passing: [2, 2, 1, 1], fieldSize: 14, pace: "35.9-36.4", last3f: 34.9 },
    ],
    restInterval: "中2週",
    winOdds: 3.2,
    popularity: 1,
    placeOddsMin: 1.2,
    referenceEv: computeReferenceEv(0.55, 1.2),
  },
  {
    umaban: 2,
    horseName: "サンプルホース2",
    prior: 0.35,
    oikiri: { critic: "順調", rank: "B" },
    stableComment: null,
    runs: [
      { passing: [6, 6, 5, 4], fieldSize: 16, pace: "35.5-36.9", last3f: 36.2 },
      { passing: [7, 6, 5, 5], fieldSize: 15, pace: "36.2-36.5", last3f: 36.0 },
    ],
    restInterval: "中4週",
    winOdds: 6.8,
    popularity: 2,
    placeOddsMin: 1.6,
    referenceEv: computeReferenceEv(0.35, 1.6),
  },
  {
    umaban: 3,
    horseName: "サンプルホース3",
    prior: 0.18,
    oikiri: { critic: "平凡", rank: "C" },
    stableComment: null,
    runs: [
      { passing: [12, 11, 10, 9], fieldSize: 16, pace: "34.9-37.8", last3f: 36.8 },
      { passing: [13, 12, 11, 10], fieldSize: 15, pace: "35.2-37.5", last3f: 37.0 },
    ],
    restInterval: "休み明け",
    winOdds: 24.5,
    popularity: 8,
    placeOddsMin: 3.4,
    referenceEv: computeReferenceEv(0.18, 3.4),
  },
];

/**
 * 設定画面向けプロンプトプレビュー — 固定サンプルレースを buildPrompt に通した文面を返す純関数。
 * additionalInstruction はそのまま buildPrompt の input.additionalInstruction に渡す
 * (空文字・空白のみ・未指定なら【追加指示】セクションは出ない。buildPrompt 側の挙動に委ねる)。
 * clipVariant(タスクD-2)もそのまま buildPrompt の input.clipVariant に渡す(省略時は対照)。
 * これにより設定画面のクリップ幅版セレクタで選んだ版が、プレビューの許容幅表記にも反映される。
 * 入力が固定のため、同じ引数を渡せば常に同一の文字列を返す(決定論的)。
 */
export function buildPromptPreview(
  additionalInstruction?: string,
  clipVariant?: ClipVariantId,
): string {
  return buildPrompt({
    race: PREVIEW_SAMPLE_RACE,
    horses: PREVIEW_SAMPLE_HORSES,
    additionalInstruction,
    clipVariant,
  });
}
