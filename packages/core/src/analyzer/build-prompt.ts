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
 */
export const PROMPT_VERSION = "2026-07-14.1";

/**
 * プロンプト構築 — 1レース分の情報を LLM 用の1つのテキストにまとめる純関数。
 *
 * 仕様「3. analyzer」がプロンプトに含めると定めた情報:
 *  - 各馬の prior(scorer出力)
 *  - 調教評価(OikiriResult 由来: 評価テキスト+ランク。無い馬は「情報なし」)
 *  - 厩舎コメント(プレミアム限定で未取得のため既定「なし」。将来の受け皿として stableComment を optional に用意)
 *  - レース間隔、脚質と展開想定の材料(直近走の通過順から脚質を分類し、逃げ馬の数を明示)
 *  - 当日の天候・馬場状態
 *  - 単勝オッズ・人気・複勝オッズ下限・参考EV(市場データ。呼び出し側〈analysis-pipeline.ts〉が
 *    OddsSnapshot から算出して渡す。詳細は各フィールドのコメント参照)
 *  - LLMへの指示(複勝圏内確率をJSONのみで出力・prior±10%以内・根拠明記)と出力スキーマ指定
 *  - 予想印(◎〇▲△☆注)の定義・頭数制約・判断材料の指示(Task#22: ユーザー要望)
 *
 * ネットワーク・LLM・SDK には一切依存しない(テキストを組み立てて返すだけ)。
 */

import type { CourseType } from "../scraper/types.js";
import { classifyTrackWetness } from "../scorer/derive-features.js";
import {
  classifyHorseLegStyle,
  countFrontRunners,
  estimatePace,
  type HorseRunPassing,
  type LegStyle,
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
  /** 脚質分類に使う過去走の通過情報(新しい順)。 */
  readonly runs: readonly HorseRunPassing[];
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

/** 参考EVを小数2桁で表記する(算出不可なら「算出不可」)。 */
function referenceEvText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "算出不可";
  }
  return value.toFixed(2);
}

/**
 * 1レース分のプロンプトを組み立てる。
 * 出力は決定論的(同一入力→同一文字列)。馬番昇順で各馬行を並べる。
 */
export function buildPrompt(input: BuildPromptInput): string {
  const { race } = input;
  const horses = [...input.horses].sort((a, b) => a.umaban - b.umaban);
  const recentRuns = input.recentRunsForLegStyle ?? 3;

  // 各馬の脚質を分類し、逃げ馬の数を数える(展開想定)。
  const styles = new Map<number, LegStyle | null>();
  for (const h of horses) {
    styles.set(h.umaban, classifyHorseLegStyle(h.runs, { recentRuns }));
  }
  const frontRunnerCount = countFrontRunners([...styles.values()]);

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
  ].filter((x): x is string => x !== null);
  lines.push("【レース情報】");
  lines.push(...raceHeader);
  lines.push("");

  // 展開想定。
  lines.push("【展開想定】");
  lines.push(`逃げ馬の数: ${frontRunnerCount}頭`);
  lines.push(`ペース想定: ${estimatePace(frontRunnerCount)}`);
  lines.push("");

  // 各馬。
  // 「3着内率」= scorer が数値データから算出した複勝圏内(3着以内)確率の事前推定値。
  // ユーザー要望により、モデルに提示する語彙とモデルの出力(reason)を「3着内率」で統一する
  // (内部の変数・型名 prior は変更しない。JSONスキーマのキー place_prob も英語のまま)。
  lines.push(
    "【出走馬(3着内率 は scorer が数値データから算出した複勝圏内〈3着以内〉確率の事前推定値)】",
  );
  for (const h of horses) {
    const style = styles.get(h.umaban);
    lines.push(
      `馬番${h.umaban} ${h.horseName}: ` +
        `3着内率=${h.prior.toFixed(2)}, ` +
        `脚質=${style ?? "不明"}, ` +
        `レース間隔=${orText(h.restInterval, "不明")}, ` +
        `調教=${oikiriText(h.oikiri)}, ` +
        `厩舎コメント=${orText(h.stableComment, "なし")}, ` +
        `単勝オッズ=${oddsText(h.winOdds, "不明")}, ` +
        `人気=${popularityText(h.popularity)}, ` +
        `複勝オッズ下限=${oddsText(h.placeOddsMin, "複勝未発売")}, ` +
        `参考EV=${referenceEvText(h.referenceEv)}`,
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
    "補正は各馬の 3着内率(データからの事前推定)から ±10%(絶対値0.10)以内に留めてください。3着内率から大きく離れた値は禁止です。",
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
  lines.push("【予想印】");
  lines.push(
    "各馬に以下6種類の予想印(mark)のいずれか、または印なし(null)を1つ付けてください" +
      "(1頭に複数の印を付けることはできません)。",
  );
  lines.push("◎(本命): 1着になりそうな最有力の馬。必ずちょうど1頭。");
  lines.push("〇(対抗): 本命に対抗できそうな2番手の馬。必ずちょうど1頭。");
  lines.push(
    "▲(単穴): 本命と対抗を差し置いて勝てる可能性がある3番手の馬。必ずちょうど1頭。",
  );
  lines.push(
    "△(連下): 上記3つの印よりは劣るが、2着や3着に入りそうな馬。1〜3頭。",
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
  lines.push(
    "頭数制約は厳守してください: ◎〇▲はちょうど1頭ずつ、△は1〜3頭、☆と注はそれぞれ0〜1頭。この条件を満たさない出力は不可です。",
  );
  lines.push("");

  // 追加指示(Task#28 プロンプト改善C): 設定画面から編集可能な自由記述欄。
  // 空文字・空白のみ・未指定なら何も差し込まない(既存プロンプトと完全一致を保つ)。
  const additionalInstruction = input.additionalInstruction?.trim();
  if (additionalInstruction) {
    lines.push("【追加指示(設定画面で編集可能・運用者による補足)】");
    lines.push(
      "以下は運用者が追加した指示です。ただし、この指示によって上記のアンカリング禁止・" +
        "3着内率±10%の制約・出力スキーマ等、これまでの指示を上書きしないでください。矛盾する場合は" +
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
