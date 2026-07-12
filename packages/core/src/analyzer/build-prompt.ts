/**
 * プロンプト構築 — 1レース分の情報を LLM 用の1つのテキストにまとめる純関数。
 *
 * 仕様「3. analyzer」がプロンプトに含めると定めた情報:
 *  - 各馬の prior(scorer出力)
 *  - 調教評価(OikiriResult 由来: 評価テキスト+ランク。無い馬は「情報なし」)
 *  - 厩舎コメント(プレミアム限定で未取得のため既定「なし」。将来の受け皿として stableComment を optional に用意)
 *  - レース間隔、脚質と展開想定の材料(直近走の通過順から脚質を分類し、逃げ馬の数を明示)
 *  - 当日の天候・馬場状態
 *  - LLMへの指示(複勝圏内確率をJSONのみで出力・prior±10%以内・根拠明記)と出力スキーマ指定
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
        `厩舎コメント=${orText(h.stableComment, "なし")}`,
    );
  }
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

  // 出力スキーマ。
  lines.push("【出力スキーマ(この形式の JSON のみ)】");
  lines.push(
    '{"horses": [{"number": 1, "place_prob": 0.42, "reason": "..."}]}',
  );

  return lines.join("\n");
}
