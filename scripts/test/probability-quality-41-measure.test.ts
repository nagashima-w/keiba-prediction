import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseKaisaiDate,
  parseRaceId,
  parseRaceResult,
  type RaceData,
  type RaceListEntry,
  type RaceResult,
} from "../../packages/core/src/index.js";
import { filterRaceDataBefore } from "../../packages/core/src/scorer/snapshot-filter.js";
import { runAnalysis } from "../../packages/app/src/main/analysis-pipeline.js";
import { FetchHaltedError } from "../probability-quality-41/guarded-fetcher.js";
import {
  measureRace,
  type MeasureDeps,
  type MeasureTarget,
} from "../probability-quality-41/measure.js";

/**
 * 1レースの観測(`measureRace`)を、保存済みフィクスチャでオフラインに検証する。
 * 実サイトへのリクエストは一切含まない(取得は注入された関数で置き換える)。
 * 中央16頭(raceId=202603020211・実レース日 2026/06/28・確定オッズ)と、
 * 地方12頭(raceId=202654071210・実レース日 2026/07/12・オッズページは常に "middle")。
 */

function loadRaceData(name: string): RaceData {
  const url = new URL(`../../docs/investigations/combo-odds-real-fetch/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as RaceData;
}

function loadFixtureHtml(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), "utf-8");
}

const CENTRAL = {
  raceData: loadRaceData("central-on.json"),
  resultHtml: loadFixtureHtml("result_202603020211.html"),
  kaisaiDate: "20260628",
  raceId: "202603020211",
};
const NAR = {
  raceData: loadRaceData("nar-on.json"),
  resultHtml: loadFixtureHtml("nar_result_202654071210.html"),
  kaisaiDate: "20260712",
  raceId: "202654071210",
};

function target(fx: typeof CENTRAL, region: "central" | "nar", requestedDate?: string): MeasureTarget {
  const entry: RaceListEntry = {
    raceId: parseRaceId(fx.raceId),
    name: "テスト",
    courseType: "芝",
    distance: 1800,
    entryCount: 16,
    raceNumber: 11,
  };
  return { entry, region, requestedDate: requestedDate ?? fx.kaisaiDate, kaisaiDate: fx.kaisaiDate };
}

function deps(fx: typeof CENTRAL, over: Partial<MeasureDeps> = {}): MeasureDeps {
  return {
    fetchResultHtml: async () => fx.resultHtml,
    scrape: async () => fx.raceData,
    now: () => new Date("2026-10-01T12:00:00.000Z"),
    ...over,
  };
}

/** runAnalysis(LLM なし)を駆動して prior を引く(測定側の実装とは独立の参照)。 */
async function referencePriors(raceData: RaceData, kaisaiDate: string): Promise<Map<number, number>> {
  const result = await runAnalysis(raceData.raceId, parseKaisaiDate(kaisaiDate), {
    scrape: async () => raceData,
    analyze: null,
    saveAnalysis: () => 0,
    allocationSettings: null,
  });
  return new Map(result.rows.map((r) => [r.umaban, r.prior]));
}

function withoutHorse(raceData: RaceData, umaban: number): RaceData {
  return { ...raceData, horses: raceData.horses.filter((h) => h.shutuba.umaban !== umaban) };
}

describe("measureRace: 中央16頭(確定オッズ)", () => {
  it("観測に成功し、識別情報・計測条件・馬ごとの値が揃う", async () => {
    const obs = await measureRace(target(CENTRAL, "central"), deps(CENTRAL));
    expect(obs.status).toBe("ok");
    if (obs.status !== "ok") throw new Error("前提");
    expect(obs.raceId).toBe("202603020211");
    expect(obs.region).toBe("central");
    expect(obs.venueCode).toBe("03");
    expect(obs.kaisaiDate).toBe("20260628");
    expect(obs.listedEntryCount).toBe(16);
    expect(obs.oddsStatus).toBe("result");
    expect(obs.runnerCount).toBe(16);
    expect(obs.horses).toHaveLength(16);
    expect(obs.scratched).toEqual([]);
    expect(obs.placedCount).toBe(3);
    expect(obs.conditions.priorSource).toBe("prior-only");
    expect(obs.conditions.dateApproximate).toBe(false);
    expect(obs.conditions.placeOddsKind).toBe("placeOddsMinLowerBound");
    expect(obs.fetchedAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("prior は runAnalysis(LLM なし・遮断後)の出力と一致し、合計は3付近になる", async () => {
    const obs = await measureRace(target(CENTRAL, "central"), deps(CENTRAL));
    if (obs.status !== "ok") throw new Error("前提");
    const reference = await referencePriors(CENTRAL.raceData, CENTRAL.kaisaiDate);
    expect(reference.size).toBe(16);
    for (const h of obs.horses) {
      expect(h.prior).toBe(reference.get(h.umaban));
    }
    const sum = obs.horses.reduce((s, h) => s + h.prior, 0);
    expect(sum).toBeGreaterThan(2.9);
    expect(sum).toBeLessThan(3.1);
  });

  it("結果は結果ページの着順から付く(1着=馬番13は1、16着=馬番14は0)。複勝オッズは生の OddsSnapshot から引く", async () => {
    const obs = await measureRace(target(CENTRAL, "central"), deps(CENTRAL));
    if (obs.status !== "ok") throw new Error("前提");
    const parsed = parseRaceResult(CENTRAL.resultHtml);
    const winner = parsed.horses.find((h) => h.finishPosition?.kind === "順位" && h.finishPosition.value === 1)!;
    const last = parsed.horses.find((h) => h.finishPosition?.kind === "順位" && h.finishPosition.value === 16)!;
    const w = obs.horses.find((h) => h.umaban === winner.umaban)!;
    const l = obs.horses.find((h) => h.umaban === last.umaban)!;
    expect(winner.umaban).not.toBe(last.umaban);
    expect(w.outcome).toBe(1);
    expect(l.outcome).toBe(0);
    expect(w.horseName).toBe(CENTRAL.raceData.horses.find((x) => x.shutuba.umaban === winner.umaban)!.shutuba.name);
    expect(w.horseName.length).toBeGreaterThan(0);
    expect(w.finish).toEqual({ kind: "順位", value: 1 });
    for (const h of obs.horses) {
      const raw = CENTRAL.raceData.odds.place[h.umaban];
      expect(h.placeOddsMin).toBe(raw?.oddsMin ?? null);
      expect(h.placeOddsMax).toBe(raw?.oddsMax ?? null);
    }
    expect(obs.horses.filter((h) => h.placeOddsMin !== null)).toHaveLength(16); // 前提: 空振りでない
  });

  it("リーク遮断の診断値(計測側が生の戦績に filterRaceDataBefore を掛けた値)を条件に残す", async () => {
    const obs = await measureRace(target(CENTRAL, "central"), deps(CENTRAL));
    if (obs.status !== "ok") throw new Error("前提");
    const expected = filterRaceDataBefore(CENTRAL.raceData, "2026/06/28").diagnostics;
    expect(expected.removedCount).toBeGreaterThan(0); // 前提: このフィクスチャは実際にリークを含む
    expect(obs.conditions.leakFilter).toEqual({
      cutoffDate: "2026/06/28",
      totalResultCount: expected.totalResultCount,
      removedCount: expected.removedCount,
      removedByCutoffCount: expected.removedByCutoffCount,
      removedByInvalidDateCount: expected.removedByInvalidDateCount,
    });
  });

  it("遡った開催日(要求日と使った開催日が違う場合)を識別情報に残し、kaisaiDate は使った日を渡す", async () => {
    const obs = await measureRace(target(CENTRAL, "central", "20260705"), deps(CENTRAL));
    expect(obs.requestedDate).toBe("20260705");
    expect(obs.kaisaiDate).toBe("20260628");
  });
});

describe("measureRace: 地方12頭(オッズページは常に middle)", () => {
  it("観測に成功し、oddsStatus は middle のまま記録される", async () => {
    const obs = await measureRace(target(NAR, "nar"), deps(NAR));
    if (obs.status !== "ok") throw new Error("前提");
    expect(obs.region).toBe("nar");
    expect(obs.venueCode).toBe("54");
    expect(obs.oddsStatus).toBe("middle");
    expect(obs.runnerCount).toBe(12);
    expect(obs.conditions.leakFilter.cutoffDate).toBe("2026/07/12");
  });
});

describe("measureRace: 取消・除外の馬(§3.2)", () => {
  /** 結果の馬番2を「取消」に差し替える。 */
  function resultWithScratched(base: string, umaban: number): RaceResult {
    const parsed = parseRaceResult(base);
    return {
      ...parsed,
      horses: parsed.horses.map((h) =>
        h.umaban === umaban ? { ...h, finishPosition: { kind: "非数値" as const, text: "取消" } } : h,
      ),
    };
  }

  it("取消の馬を RaceData から除いてから prior を計算し、観測に残さない(出走頭数で prior が決まる)", async () => {
    const obs = await measureRace(
      target(CENTRAL, "central"),
      deps(CENTRAL, { parseResult: () => resultWithScratched(CENTRAL.resultHtml, 2) }),
    );
    if (obs.status !== "ok") throw new Error("前提");
    expect(obs.runnerCount).toBe(15);
    expect(obs.horses.map((h) => h.umaban)).not.toContain(2);
    expect(obs.scratched).toEqual([{ umaban: 2, text: "取消", inShutuba: true }]);
    expect(obs.listedEntryCount).toBe(16);

    const reference15 = await referencePriors(withoutHorse(CENTRAL.raceData, 2), CENTRAL.kaisaiDate);
    const reference16 = await referencePriors(CENTRAL.raceData, CENTRAL.kaisaiDate);
    for (const h of obs.horses) {
      expect(h.prior).toBe(reference15.get(h.umaban));
    }
    // 空振り防止: 取消馬を除かなかった場合の prior とは別の値になる(除外が prior に効いている)。
    const someDiffer = obs.horses.some((h) => Math.abs(h.prior - reference16.get(h.umaban)!) > 1e-6);
    expect(someDiffer).toBe(true);
  });

  it("中止・失格は0として観測に残る(出走した)", async () => {
    const parsed = parseRaceResult(CENTRAL.resultHtml);
    const result: RaceResult = {
      ...parsed,
      horses: parsed.horses.map((h) =>
        h.umaban === 2 ? { ...h, finishPosition: { kind: "非数値" as const, text: "中止" } } : h,
      ),
    };
    const obs = await measureRace(target(CENTRAL, "central"), deps(CENTRAL, { parseResult: () => result }));
    if (obs.status !== "ok") throw new Error("前提");
    expect(obs.runnerCount).toBe(16);
    const h2 = obs.horses.find((h) => h.umaban === 2)!;
    expect(h2.outcome).toBe(0);
    expect(h2.finish).toEqual({ kind: "非数値", text: "中止" });
  });
});

describe("measureRace: 戦績の取得に失敗した馬", () => {
  it("戦績が null の馬を含んでもレースは除外せず、警告と失敗頭数を残す", async () => {
    const broken: RaceData = {
      ...CENTRAL.raceData,
      horses: CENTRAL.raceData.horses.map((h, i) => (i === 0 ? { ...h, results: null } : h)),
      meta: {
        ...CENTRAL.raceData.meta,
        warnings: [{ kind: "戦績", message: "馬ID X の戦績取得に失敗しました", horseId: CENTRAL.raceData.horses[0]!.shutuba.horseId }],
      },
    };
    const obs = await measureRace(target(CENTRAL, "central"), deps(CENTRAL, { scrape: async () => broken }));
    if (obs.status !== "ok") throw new Error("前提");
    expect(obs.resultsFailedHorseCount).toBe(1);
    const h = obs.horses.find((x) => x.umaban === CENTRAL.raceData.horses[0]!.shutuba.umaban)!;
    expect(h.resultsFetched).toBe(false);
    expect(h.usedRunCount).toBeNull();
    expect(obs.horses.filter((x) => x.resultsFetched)).toHaveLength(15);
    expect(obs.warnings).toHaveLength(1);
    expect(obs.warnings[0]!.kind).toBe("戦績");
  });

  it("戦績を取得できた馬は、遮断後に prior の計算へ使った走数を残す", async () => {
    const obs = await measureRace(target(CENTRAL, "central"), deps(CENTRAL));
    if (obs.status !== "ok") throw new Error("前提");
    const horse0 = CENTRAL.raceData.horses[0]!;
    const h = obs.horses.find((x) => x.umaban === horse0.shutuba.umaban)!;
    expect(h.resultsFetched).toBe(true);
    expect(h.usedRunCount!).toBeLessThan(horse0.results!.length); // 自レースの走などが遮断で減っている
    expect(h.usedRunCount!).toBeGreaterThanOrEqual(0);
  });
});

describe("measureRace: 観測から外すレース(全体は止めない。理由を記録して返す)", () => {
  const excluded = async (over: Partial<MeasureDeps>, fx: typeof CENTRAL = CENTRAL) => {
    const obs = await measureRace(target(fx, "central"), deps(fx, over));
    if (obs.status !== "excluded") throw new Error("前提: 除外されるはず");
    return obs;
  };

  it("結果が未確定(結果行が0件)なら result-not-confirmed", async () => {
    const obs = await excluded({ fetchResultHtml: async () => loadFixtureHtml("nar_result_presale_202642071612.html") });
    expect(obs.reason).toBe("result-not-confirmed");
  });

  it("結果ページの構造異常なら result-parse-error", async () => {
    const obs = await excluded({ fetchResultHtml: async () => "<html><body>空</body></html>" });
    expect(obs.reason).toBe("result-parse-error");
  });

  it("結果ページの取得に失敗(HTTP 400 以外の通常の失敗)なら result-fetch-error", async () => {
    const obs = await excluded({
      fetchResultHtml: async () => {
        throw new Error("boom");
      },
    });
    expect(obs.reason).toBe("result-fetch-error");
    expect(obs.detail).toContain("boom");
  });

  it("出馬表・オッズの取得失敗(scrape の例外)なら scrape-error", async () => {
    const obs = await excluded({
      scrape: async () => {
        throw new Error("shutuba down");
      },
    });
    expect(obs.reason).toBe("scrape-error");
    expect(obs.detail).toContain("shutuba down");
  });

  it("未知の着順文言を含むなら unclassified-finish(文言を残す)", async () => {
    const parsed = parseRaceResult(CENTRAL.resultHtml);
    const result: RaceResult = {
      ...parsed,
      horses: parsed.horses.map((h) =>
        h.umaban === 2 ? { ...h, finishPosition: { kind: "非数値" as const, text: "競走除外" } } : h,
      ),
    };
    const obs = await excluded({ parseResult: () => result });
    expect(obs.reason).toBe("unclassified-finish");
    expect(obs.detail).toContain("競走除外");
  });

  it("結果と出馬表の馬が対応しないなら horse-mismatch", async () => {
    const obs = await excluded({ scrape: async () => withoutHorse(CENTRAL.raceData, 5) });
    expect(obs.reason).toBe("horse-mismatch");
  });

  it("runAnalysis が例外を投げたら analysis-error", async () => {
    const obs = await excluded({
      runAnalysisFn: async () => {
        throw new Error("analysis boom");
      },
    });
    expect(obs.reason).toBe("analysis-error");
    expect(obs.detail).toContain("analysis boom");
  });

  it("runAnalysis が近似日(dateApproximate=true)を返したら date-approximate", async () => {
    const obs = await excluded({
      runAnalysisFn: async (raceId, kaisaiDate, d) => {
        const r = await runAnalysis(raceId, kaisaiDate, d);
        return { ...r, dateApproximate: true };
      },
    });
    expect(obs.reason).toBe("date-approximate");
  });

  it("runAnalysis の行数が出走頭数と一致しなければ analysis-error", async () => {
    const obs = await excluded({
      runAnalysisFn: async (raceId, kaisaiDate, d) => {
        const r = await runAnalysis(raceId, kaisaiDate, d);
        return { ...r, rows: r.rows.slice(1) };
      },
    });
    expect(obs.reason).toBe("analysis-error");
  });

  it("除外レースにも識別情報と取得時刻を残す", async () => {
    const obs = await excluded({ fetchResultHtml: async () => "<html></html>" });
    expect(obs.raceId).toBe("202603020211");
    expect(obs.listedEntryCount).toBe(16);
    expect(obs.fetchedAt).toBe("2026-10-01T12:00:00.000Z");
  });
});

describe("measureRace: 取得の停止は除外にせず伝える", () => {
  it("結果の取得で FetchHaltedError なら、除外として記録せずそのまま投げる", async () => {
    await expect(
      measureRace(
        target(CENTRAL, "central"),
        deps(CENTRAL, {
          fetchResultHtml: async () => {
            throw new FetchHaltedError("halt");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(FetchHaltedError);
  });

  it("scrape で FetchHaltedError なら、除外として記録せずそのまま投げる(途中までのデータで観測を作らない)", async () => {
    await expect(
      measureRace(
        target(CENTRAL, "central"),
        deps(CENTRAL, {
          scrape: async () => {
            throw new FetchHaltedError("halt");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(FetchHaltedError);
  });
});

describe("measureRace: raw の保存(リポジトリ外。取得した応答を解析より先に書く)", () => {
  it("結果 HTML と取消除外前の RaceData を、保存関数へ渡す", async () => {
    const saved: Array<{ kind: string; raceId: string; content: string }> = [];
    await measureRace(
      target(CENTRAL, "central"),
      deps(CENTRAL, { saveRaw: (kind, raceId, content) => void saved.push({ kind, raceId, content }) }),
    );
    expect(saved.map((s) => s.kind)).toEqual(["result-html", "race-data"]);
    expect(saved[0]!.content).toBe(CENTRAL.resultHtml);
    expect((JSON.parse(saved[1]!.content) as RaceData).horses).toHaveLength(16);
    expect(saved.every((s) => s.raceId === "202603020211")).toBe(true);
  });

  it("結果の解析で除外になるレースでも、取得済みの結果 HTML は保存済み", async () => {
    const saved: string[] = [];
    await measureRace(
      target(CENTRAL, "central"),
      deps(CENTRAL, {
        fetchResultHtml: async () => "<html></html>",
        saveRaw: (kind) => void saved.push(kind),
      }),
    );
    expect(saved).toEqual(["result-html"]);
  });
});
