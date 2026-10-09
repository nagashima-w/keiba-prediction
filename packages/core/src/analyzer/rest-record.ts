/**
 * 休み明け実績の要約(Issue #212・#210-A)。
 *
 * LLM分析の強調材料・懸念事項に「休み明け」が一律にマイナス材料として出ていた。休み明けで
 * 走る馬もいるため、その馬自身の過去の休み明けでの成績を中立な材料としてプロンプトへ渡し、
 * 実績と照らして判断させる(プロンプトの指示側は build-prompt.ts)。
 *
 * ## 「休み明け」の定義(ユーザー確定 2026-10-09: 戦績から自前で判定する案B)
 * 前走から71日以上あいた出走(derive-features.ts の `REST_MIN_DAYS`、「中10週」以上)。scorer
 * (bias-rotation.ts)・プロンプトの「レース間隔」と同じ定義を共有する(定義が2つに割れない)。
 * 馬柱(shutuba_past.html)の「Nヵ月休養」表示は使わない(取得が1本増え、地方での有無が未確認のため)。
 *
 * ## 初戦は数えない
 * 前走が無い出走(キャリア初戦)は「休み明け」ではない。scorer の `restRunNumber`(休み明け=1走目)
 * は初戦も1走目に含めるが、ここでは本物の休み明け(前走との間隔が71日以上)だけを数える。
 *
 * ## 着順の扱い(scorer と揃える)
 * `isPlaced`(derive-features.ts)と同じ。降着(demoted)は確定着順(value)で数える。非数値の着順
 * (中止・除外・取消・失格)・着順欠損は判定できないので走数に数えない。前走の日付が欠損して
 * 間隔が出せない走も数えない。
 *
 * ## 出す条件
 * 今回(analysisDate)が前走から71日以上のときだけ要約を返す。休み明けでない馬には null
 * (プロンプトにこの項目自体を出さない)。
 *
 * ## サンプル不足
 * 休み明けの走数が2走未満(scorer の minSampleForBias と同じ2)なら `サンプル不足=true` とし、note に
 * 「サンプル2走未満」と書く。プロンプトの指示はこの語を「実績が乏しいので中立に扱う」合図にする。
 *
 * 決定論・ネットワーク/DB非依存の純関数。例外を投げない。評価語は出さない(中立な事実のみ)。
 */

import {
  classifyRotationInterval,
  daysBetweenDates,
  deriveRaceFeatures,
  REST_MIN_DAYS,
} from "../scorer/derive-features.js";
import type { HorseRaceResult } from "../scraper/types.js";

/** 実績を「十分」とみなす最小の休み明け走数。scorer の minSampleForBias(2)と同じ値。 */
const MIN_SAMPLE = 2;

/** note と `着順` に載せる、新しい順の着順の最大件数。集計自体は全走を数える。 */
const MAX_LISTED_RANKS = 5;

/** summarizeRestRecord の出力。常に同じキー構成に固定する。 */
export interface RestRecordSummary {
  /** 今回の前走からの間隔(日)。 */
  readonly 今回間隔日数: number;
  /** 着順を判定できた過去の休み明け走数。 */
  readonly 走数: number;
  readonly 一着: number;
  readonly 二着: number;
  readonly 三着: number;
  /** 4着以下。 */
  readonly 着外: number;
  /** 3着以内(一着+二着+三着)。 */
  readonly 三着内: number;
  /** 過去の休み明け走の確定着順(新しい順、最大5件)。 */
  readonly 着順: readonly number[];
  /** 走数が2走未満。true のとき実績としては乏しい(中立に扱わせる合図)。 */
  readonly サンプル不足: boolean;
  /** プロンプトへそのまま載せる中立の材料文(評価語を含まない)。 */
  readonly note: string;
}

/** 着順の一覧を「3着・1着・6着」の形にする。 */
function ranksText(ranks: readonly number[]): string {
  return ranks.map((r) => `${r}着`).join("・");
}

/**
 * 休み明け実績を要約する。
 * @param results 戦績(新しい順。基準日より前の走だけ。呼び出し側で絞り込み済みのもの)
 * @param todayDate 今回の開催日(YYYY/MM/DD)
 * @returns 今回が休み明けでない・間隔が出せない場合は null
 */
export function summarizeRestRecord(
  results: readonly HorseRaceResult[],
  todayDate: string,
): RestRecordSummary | null {
  const last = results[0];
  if (last === undefined) {
    return null;
  }
  const todayGap = daysBetweenDates(last.date, todayDate);
  if (todayGap === null || classifyRotationInterval(todayGap) !== "休み明け") {
    return null;
  }

  let 一着 = 0;
  let 二着 = 0;
  let 三着 = 0;
  let 着外 = 0;
  const ranks: number[] = [];
  for (const f of deriveRaceFeatures([...results])) {
    // 初戦・日付欠損は interval が「不明」になり、ここで除かれる。
    if (f.interval !== "休み明け") continue;
    const finish = f.result.finishPosition;
    // 非数値着順・着順欠損は集計対象外(isPlaced と同じ扱い)。降着は確定着順 value。
    if (finish === null || finish.kind !== "順位") continue;
    ranks.push(finish.value);
    if (finish.value === 1) 一着++;
    else if (finish.value === 2) 二着++;
    else if (finish.value === 3) 三着++;
    else 着外++;
  }

  const 走数 = ranks.length;
  const 三着内 = 一着 + 二着 + 三着;
  const listed = ranks.slice(0, MAX_LISTED_RANKS);
  const サンプル不足 = 走数 < MIN_SAMPLE;

  const head = `今回は前走から${todayGap}日の休み明け。過去の休み明け(前走から${REST_MIN_DAYS}日以上)`;
  let note: string;
  if (走数 === 0) {
    note = `${head}の出走なし(サンプル2走未満)`;
  } else if (走数 === 1) {
    note = `${head}は1走のみ(${ranksText(listed)})でサンプル2走未満`;
  } else {
    note =
      `${head}は${走数}走で1着${一着}回・2着${二着}回・3着${三着}回・着外${着外}回` +
      `(3着内${三着内}/${走数}。新しい順に${ranksText(listed)})`;
  }

  return {
    今回間隔日数: todayGap,
    走数,
    一着,
    二着,
    三着,
    着外,
    三着内,
    着順: listed,
    サンプル不足,
    note,
  };
}
