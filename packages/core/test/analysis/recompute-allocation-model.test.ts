import { describe, expect, it } from "vitest";

import type { AnalysisRecord, RaceData } from "../../src/index.js";
import { runAnalysis } from "../../src/analysis/analysis-pipeline.js";
import { buildMixedCandidates } from "../../src/analysis/mixed-candidates.js";
import {
  buildAllocationForRows,
  recomputeAllocationFromProbs,
  type RecomputeHorseInput,
} from "../../src/analysis/recompute-allocation.js";
import type { OrderedPlaceJointModel, PlaceJointModel } from "../../src/ev/place-joint-model.js";
import { CONDITIONAL_BERNOULLI_MODEL } from "../../src/ev/place-joint-model.js";
import { PLACKETT_LUCE_MODEL } from "../../src/ev/plackett-luce-model.js";
import {
  ALL_BETS_SETTINGS,
  FIXED_NOW,
  KAISAI_DATE,
  RACE_ID,
  scrapeFixtureRace,
  viaJson,
} from "../golden/pipeline-golden-scenarios.js";

/**
 * Issue #524(#53-B): 配分の計算し直し(`recomputeAllocationFromProbs`)で、同時分布のモデルを差し替えられる口。
 * 検証の柱は3つ。
 * (1) 省略は本番と同じ(省略 = PLACKETT_LUCE_MODEL 明示。結果がバイト単位で変わらない)。
 * (2) 渡したモデルが全経路(複勝だけ・混在・下限で外れた買い目の反事実の配分・券種ごとの候補)に届く(スパイで数える。
 *     (1) だけでは、省略も明示もどちらも PL になるので、引き回しの抜けを検出できない)。
 * (3) モデルを変えると結果が変わる(差が 0 でないことを無条件に固定する)。
 * スパイ・PL を包むモデルはテストの中だけに置く(本番のコードには入れない)。
 */

interface Baseline {
  readonly race: RaceData;
  readonly horses: readonly RecomputeHorseInput[];
}

let baselineOnce: Promise<Baseline> | undefined;
function baseline(): Promise<Baseline> {
  baselineOnce ??= computeBaseline();
  return baselineOnce;
}

async function computeBaseline(): Promise<Baseline> {
  const race = await scrapeFixtureRace();
  let saved: AnalysisRecord | undefined;
  await runAnalysis(RACE_ID, KAISAI_DATE, {
    scrape: async () => race,
    analyze: null,
    saveAnalysis: (record) => {
      saved = record;
      return 1;
    },
    allocationSettings: ALL_BETS_SETTINGS,
    now: FIXED_NOW,
    llmSkipReason: "テスト: LLM なし",
  });
  const wakubanByUmaban = new Map(race.horses.map((h) => [h.shutuba.umaban, h.shutuba.wakuban]));
  const nameByUmaban = new Map(race.horses.map((h) => [h.shutuba.umaban, h.shutuba.name]));
  const horses = saved!.horses.map((h) => ({
    umaban: h.umaban,
    wakuban: wakubanByUmaban.get(h.umaban)!,
    horseName: nameByUmaban.get(h.umaban)!,
    prior: h.prior,
    adjustedProb: h.adjustedProb,
  }));
  return { race, horses };
}

/** PL に委譲し、id だけ別にして呼び出し回数を数えるモデル(転送の確認用)。 */
function spyModel(id = "spy-pl"): { readonly model: OrderedPlaceJointModel; readonly calls: () => number } {
  let count = 0;
  const model: OrderedPlaceJointModel = {
    id,
    approximate: PLACKETT_LUCE_MODEL.approximate,
    buildDistribution(horses, placeCount) {
      count += 1;
      return PLACKETT_LUCE_MODEL.buildDistribution(horses, placeCount);
    },
    buildOrderedDistribution(horses, topFinishCount) {
      count += 1;
      return PLACKETT_LUCE_MODEL.buildOrderedDistribution(horses, topFinishCount);
    },
  };
  return { model, calls: () => count };
}

/**
 * 入力の確率を `p^gamma` に変え(合計は元のまま保つ)てから PL に渡すモデル(「モデルを変えると結果が変わる」ことの確認用)。
 * 合計を保つのは、PL のフィットが合計の揃わない入力で収束しないことがあるため。
 */
function sharpenedModel(gamma: number): OrderedPlaceJointModel {
  const sharpen = (horses: Parameters<PlaceJointModel["buildDistribution"]>[0]) => {
    const total = horses.reduce((s, h) => s + h.placeProb, 0);
    const powered = horses.map((h) => h.placeProb ** gamma);
    const poweredTotal = powered.reduce((s, p) => s + p, 0);
    return horses.map((h, i) => ({ ...h, placeProb: Math.min(0.99, (powered[i]! * total) / poweredTotal) }));
  };
  return {
    id: `sharpened-${gamma}`,
    approximate: false,
    buildDistribution: (horses, placeCount) => PLACKETT_LUCE_MODEL.buildDistribution(sharpen(horses), placeCount),
    buildOrderedDistribution: (horses, topFinishCount) => PLACKETT_LUCE_MODEL.buildOrderedDistribution(sharpen(horses), topFinishCount),
  };
}

/** 複勝だけの経路(組合せオッズを取得しない設定)。 */
const PLACE_ONLY_SETTINGS = { ...ALL_BETS_SETTINGS, includeComboOdds: false } as const;

const betKeys = (bets: readonly { betType: string; comboKey: string; stake: number }[]): string =>
  bets.map((b) => `${b.betType}:${b.comboKey}:${b.stake}`).join(",");

describe("recomputeAllocationFromProbs の同時分布モデルの口(Issue #524)", { timeout: 60_000 }, () => {
  async function run(over: { model?: PlaceJointModel; settings?: typeof ALL_BETS_SETTINGS | typeof PLACE_ONLY_SETTINGS }) {
    const { race, horses } = await baseline();
    return recomputeAllocationFromProbs({
      raceId: RACE_ID,
      horses,
      odds: race.odds,
      comboOdds: race.meta.comboOdds,
      allocationSettings: over.settings ?? ALL_BETS_SETTINGS,
      ...(over.model === undefined ? {} : { model: over.model }),
    });
  }

  it("前提(空振り防止): 全券種 ON は混在の経路で多点・3 券種以上、組合せなしは複勝だけの経路で多点", async () => {
    const mixed = await run({});
    expect(mixed.allocation.meta.route).toBe("mixed");
    expect(mixed.allocation.bets.length).toBeGreaterThan(5);
    expect(new Set(mixed.allocation.bets.map((b) => b.betType)).size).toBeGreaterThanOrEqual(3);
    const placeOnly = await run({ settings: PLACE_ONLY_SETTINGS });
    expect(placeOnly.allocation.meta.route).toBe("place-only");
    expect(placeOnly.allocation.bets.length).toBeGreaterThan(3);
  });

  it("省略は PLACKETT_LUCE_MODEL の明示と同じ結果(混在・複勝だけの2経路。メタの modelId も plackett-luce)", async () => {
    for (const settings of [ALL_BETS_SETTINGS, PLACE_ONLY_SETTINGS]) {
      const omitted = await run({ settings });
      const explicit = await run({ settings, model: PLACKETT_LUCE_MODEL });
      expect(omitted.allocation.meta.modelId).toBe("plackett-luce");
      expect(viaJson(explicit)).toEqual(viaJson(omitted));
    }
  });

  it("渡したモデルは混在の経路にも複勝だけの経路にも届く(メタの modelId がスパイの id になり、スパイが呼ばれる)。結果自体は PL と同じ", async () => {
    const plain = await run({});
    for (const settings of [ALL_BETS_SETTINGS, PLACE_ONLY_SETTINGS]) {
      const spy = spyModel();
      const result = await run({ settings, model: spy.model });
      expect(result.allocation.meta.modelId, settings.includeComboOdds ? "mixed" : "place-only").toBe("spy-pl");
      expect(spy.calls()).toBeGreaterThan(0);
    }
    // スパイは PL に委譲するだけなので、id 以外は省略時と同じ(委譲に過不足がない)
    const spy = spyModel();
    const mixed = await run({ model: spy.model });
    expect(mixed.allocation.bets).toEqual(plain.allocation.bets);
  });

  it("複勝だけへ落ちる3つの理由(combo-odds-not-requested・combo-bet-types-off・no-combo-candidates)のすべてで、渡したモデルが配分に届く(メタの modelId がスパイの id になる)", async () => {
    const { race, horses } = await baseline();
    const noCombos: RaceData["odds"] = {
      ...race.odds,
      wideCombo: undefined,
      trioCombo: undefined,
      quinellaCombo: undefined,
      exactaCombo: undefined,
      trifectaCombo: undefined,
      bracketQuinellaCombo: undefined,
    };
    const allOff = {
      ...ALL_BETS_SETTINGS,
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: false,
      includeTrifectaInAllocation: false,
      includeBracketQuinellaInAllocation: false,
    };
    const cases = [
      // ① 組合せオッズを取得しない設定
      { reason: "combo-odds-not-requested", odds: race.odds, settings: PLACE_ONLY_SETTINGS },
      // ② 組合せの券種がすべて配分の対象外
      { reason: "combo-bet-types-off", odds: race.odds, settings: allOff },
      // ③ 組合せの券種は ON だが、組合せの候補が 0 件(組合せのオッズが無い)
      { reason: "no-combo-candidates", odds: noCombos, settings: ALL_BETS_SETTINGS },
    ] as const;
    expect(cases).toHaveLength(3);
    for (const c of cases) {
      const spy = spyModel();
      const result = recomputeAllocationFromProbs({
        raceId: RACE_ID,
        horses,
        odds: c.odds,
        comboOdds: race.meta.comboOdds,
        allocationSettings: c.settings,
        model: spy.model,
      });
      // 前提: その理由で複勝だけへ落ちていて、複勝の買い目がある(空の配分どうしの一致ではない)
      expect(result.allocation.meta.route, c.reason).toBe("place-only");
      expect(result.allocation.meta.fallbackReason, c.reason).toBe(c.reason);
      expect(result.allocation.bets.length, c.reason).toBeGreaterThan(0);
      expect(result.allocation.meta.modelId, c.reason).toBe("spy-pl");
      expect(spy.calls(), c.reason).toBeGreaterThan(0);
    }
  });

  it("券種ごとの候補ビルダー: モデルを使う7券種のすべてで、buildMixedCandidates に渡したモデルが呼ばれる(複勝はモデルを使わない)", async () => {
    const { race, horses } = await baseline();
    // 候補の構築に要る最小の行(確率・オッズ・EV)は、recompute が組み立てる行を使う
    const { rows } = recomputeAllocationFromProbs({
      raceId: RACE_ID,
      horses,
      odds: race.odds,
      comboOdds: race.meta.comboOdds,
      allocationSettings: ALL_BETS_SETTINGS,
    });
    const input = {
      oddsStatus: race.odds.oddsStatus,
      rows,
      raceId: RACE_ID,
      wideCombo: race.odds.wideCombo,
      trioCombo: race.odds.trioCombo,
      quinellaCombo: race.odds.quinellaCombo,
      exactaCombo: race.odds.exactaCombo,
      trifectaCombo: race.odds.trifectaCombo,
      bracketQuinellaCombo: race.odds.bracketQuinellaCombo,
      comboOdds: race.meta.comboOdds,
    };
    const modelUsing = ["win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
    expect(modelUsing).toHaveLength(7);
    for (const betType of modelUsing) {
      const spy = spyModel();
      buildMixedCandidates(input, { betTypes: [betType], model: spy.model });
      expect(spy.calls(), betType).toBeGreaterThan(0);
    }
    const placeSpy = spyModel();
    buildMixedCandidates(input, { betTypes: ["place"], model: placeSpy.model });
    expect(placeSpy.calls()).toBe(0);
  });

  it("下限で外れた買い目の反事実の配分(recordMissed)にもモデルが届く(混在・複勝だけの2経路): 外れた買い目があるとき、スパイの呼び出しが記録なしより増える", async () => {
    const { race, horses } = await baseline();
    for (const base of [ALL_BETS_SETTINGS, PLACE_ONLY_SETTINGS]) {
      const route = base.includeComboOdds ? "mixed" : "place-only";
      const { rows } = recomputeAllocationFromProbs({
        raceId: RACE_ID,
        horses,
        odds: race.odds,
        comboOdds: race.meta.comboOdds,
        allocationSettings: base,
      });
      // 複勝は的中確率が高いので、外れる買い目が出るよう下限を高くする
      const settings = { ...base, minHitProb: base.includeComboOdds ? 0.1 : 0.5 };
      const build = (recordMissed: boolean, model?: PlaceJointModel) =>
        buildAllocationForRows({
          rows, raceId: RACE_ID, odds: race.odds, comboOdds: race.meta.comboOdds, allocationSettings: settings, recordMissed,
          ...(model === undefined ? {} : { model }),
        });
      const off = spyModel();
      const offResult = build(false, off.model);
      const on = spyModel();
      const onResult = build(true, on.model);
      // 前提: 経路が想定どおりで、下限で外れた買い目があり、反事実の記録が実際に作られている
      expect(onResult.allocation.meta.route, route).toBe(route);
      expect(offResult.allocation.meta.belowFloorCount, route).toBeGreaterThan(0);
      expect(onResult.allocation.meta.missed?.length ?? 0, route).toBeGreaterThan(0);
      expect(on.calls(), route).toBeGreaterThan(off.calls());
      // 省略 = PL 明示(反事実の記録も含めて同じ)
      expect(viaJson(build(true, PLACKETT_LUCE_MODEL)), route).toEqual(viaJson(build(true)));
    }
  });

  it("複勝だけの経路: 条件付きベルヌーイに替えると、メタの modelId が変わり、買い目ごとの賭け金も変わる(差が 0 でない)", async () => {
    const pl = await run({ settings: PLACE_ONLY_SETTINGS });
    const cb = await run({ settings: PLACE_ONLY_SETTINGS, model: CONDITIONAL_BERNOULLI_MODEL });
    expect(cb.allocation.meta.route).toBe("place-only");
    expect(cb.allocation.meta.modelId).toBe("conditional-bernoulli");
    expect(cb.allocation.bets.length).toBeGreaterThan(0);
    // 合計の賭け金は1レースの上限に張り付く(両モデルとも同じ)ので、買い目ごとの賭け金の差を見る。差が 0 でないことを先に固定する
    const stakeOf = (bets: readonly { comboKey: string; stake: number }[]) => new Map(bets.map((b) => [b.comboKey, b.stake]));
    const plStakes = stakeOf(pl.allocation.bets);
    const maxDiff = Math.max(...cb.allocation.bets.map((b) => Math.abs(b.stake - (plStakes.get(b.comboKey) ?? 0))));
    expect(maxDiff).toBeGreaterThan(0);
    expect(betKeys(cb.allocation.bets)).not.toBe(betKeys(pl.allocation.bets));
  });

  it("混在の経路: 確率を変える順序つきモデル(p^γ を PL に渡す)に替えると、買い目が変わる(差が 0 でない)", async () => {
    const pl = await run({});
    const sharp = await run({ model: sharpenedModel(1.5) });
    expect(sharp.allocation.meta.route).toBe("mixed");
    expect(sharp.allocation.meta.modelId).toBe("sharpened-1.5");
    expect(betKeys(sharp.allocation.bets)).not.toBe(betKeys(pl.allocation.bets));
    // 候補の構築にもモデルが届いている: 券種ごとの EV プラスの点数(comboStats。候補ビルダーの診断から作る)も変わる。
    // 配分の関数(allocateGeneralBets)だけにモデルが届いて、候補は PL のまま、という半端な引き回しを検出する
    expect(pl.comboStats).not.toBeNull();
    expect(JSON.stringify(sharp.comboStats)).not.toBe(JSON.stringify(pl.comboStats));
  });

  it("条件付きベルヌーイ(順序なし)は、組合せの経路では単勝の候補で例外になり、route=invalid・買い目なしになる(本番の「順序のないモデルは例外」を保つ)", async () => {
    const cb = await run({ model: CONDITIONAL_BERNOULLI_MODEL });
    expect(cb.allocation.meta.route).toBe("invalid");
    expect(cb.allocation.bets).toHaveLength(0);
  });
});
