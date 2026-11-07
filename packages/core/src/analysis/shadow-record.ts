/**
 * 並走(影の計算。Issue #649)の保存用の記録を作る(`runAnalysis` が呼ぶ)。**買い目・配分・EV・画面・LLM には使わない。**
 *
 * 入力は、プロンプトの組み立てより後ろで確定したもの(`scoreField` の prior と、取得したオッズ・戦績)だけ。ここの出力は `AnalysisRecord.shadow` に載るだけで、
 * `PromptInput`・`AdjustedHorse`・`HorseEv`・配分の入力のどれにも渡らない(`analysis-pipeline-shadow.test.ts` が固定する)。
 */

import type { PriorResult } from "../scorer/prior.js";
import type { RaceData } from "../pipeline.js";
import { computeShadowFlags } from "../ev/stat-shadow-flags.js";
import type { ShadowHorseRecord, ShadowRecord } from "../ev/stat-shadow-record.js";
import { computeShadowProbs, marketShares } from "../ev/stat-shadow.js";

export type { ShadowHorseRecord, ShadowRecord };

/**
 * @param race 先読み遮断済みのレースデータ(`odds.win` は分析の時点の単勝オッズ)。
 * @param priorByUmaban 統計モデルの prior(15 項目の寄与つき)。
 * @param analysisDate 分析日(YYYY/MM/DD)。
 * @returns 記録。頭数が 5 頭未満で確率を作れず、印も要らないときも、印は作る(確率だけ空)。
 */
export function buildShadowRecord(
  race: RaceData,
  priorByUmaban: ReadonlyMap<number, PriorResult>,
  analysisDate: string,
): ShadowRecord {
  const horses = race.horses.map((h) => {
    const umaban = h.shutuba.umaban;
    const o = race.odds.win[umaban]?.odds;
    return { h, umaban, winOdds: o === undefined || o === null ? null : o };
  });
  const q = marketShares(horses.map((x) => x.winOdds));
  const probs = computeShadowProbs(
    horses.map((x) => {
      const prior = priorByUmaban.get(x.umaban)!;
      return { umaban: x.umaban, prior: prior.prior, contributions: prior.contributions, winOdds: x.winOdds };
    }),
  );
  const records = horses.map((x, i): ShadowHorseRecord => {
    const qi = q === null ? null : q[i]!;
    const flags = computeShadowFlags(x.h.results ?? [], { date: analysisDate, courseType: race.race.courseType ?? null }, qi);
    return {
      umaban: x.umaban,
      inputWinOdds: x.winOdds,
      marketQ: qi,
      flagLongRest: flags.longRest,
      flagSurfaceChange: flags.surfaceChange,
      flagFrontRunner: flags.frontRunner,
      flagLongshotSlump: flags.longshotSlump,
    };
  });
  return { horses: records.sort((a, b) => a.umaban - b.umaban), probs };
}
