import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AnalysisStore } from "../../src/ev/analysis-store.js";
import {
  importRaceResult,
  summarizeImport,
  toResultEntries,
  type ImportResultDeps,
} from "../../src/ev/result-import.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { parseRaceResult, RaceResultParseError } from "../../src/scraper/parse-race-result.js";

/**
 * Issue #207(#182-A)AC-A2: 結果の取込フロー(取得 → パース → 保存 → サマリ)の core への移設。
 *
 * 移設前は `packages/app/src/main/result-import.ts` にあった。クラウド版(cloud/)が app の import(core のバレル経由で better-sqlite3 を巻き込む)
 * を経由せずに使えるよう core へ移し、app は re-export する(#168 と同じ型)。**app 側の既存テスト(result-import.test.ts)は無改変で通る**(re-export の同一性)。
 * ここで固定するのは、移設で変わった唯一の契約「`saveResult` の依存は同期でも非同期でもよい(await する)」と、移設後のコードが core 単体で動くこと。
 * 変換(toResultEntries)・素通し(comboPayouts)の網羅は app 側の既存テストが引き続き担う。
 */

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf-8");
}

const RACE_ID = parseRaceId("202603020211");
const HTML = loadFixture("result_202603020211.html");

/** 実フィクスチャを返す取得と、実パーサ。保存だけを差し替える。 */
function depsWith(saveResult: ImportResultDeps["saveResult"]): ImportResultDeps & { fetchText: ReturnType<typeof vi.fn> } {
  const fetchText = vi.fn(async (_url: string, _options: { readonly bypassCache: true }) => HTML);
  return { fetchText, parse: parseRaceResult, saveResult };
}

describe("importRaceResult(core 版)", () => {
  it("常にライブ取得する(結果ページの URL を bypassCache: true で取得する)", async () => {
    const deps = depsWith(() => undefined);
    await importRaceResult(RACE_ID, deps);
    expect(deps.fetchText).toHaveBeenCalledTimes(1);
    expect(deps.fetchText).toHaveBeenCalledWith(`https://race.netkeiba.com/race/result.html?race_id=${RACE_ID}`, { bypassCache: true });
  });

  it("前提(空振り防止): 実フィクスチャは16頭で、複勝・単勝の払戻があり、馬連(8-13)が取れる", () => {
    const result = parseRaceResult(HTML);
    expect(result.horses).toHaveLength(16);
    expect(result.placePayouts.length).toBeGreaterThan(0);
    expect(result.winPayouts.length).toBeGreaterThan(0);
    expect(result.quinellaPayouts?.state).toBe("parsed");
  });

  it("同期の saveResult(戻り値 void)でも動き、取込サマリを返す", async () => {
    const saveResult = vi.fn();
    const outcome = await importRaceResult(RACE_ID, depsWith(saveResult));
    expect(saveResult).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "imported", raceId: RACE_ID, horseCount: 16, placePayoutCount: 3, hasPayout: true });
  });

  it("非同期の saveResult は完了を待ってからサマリを返す(保存の完了前に imported を返さない)", async () => {
    const events: string[] = [];
    const saveResult: ImportResultDeps["saveResult"] = async () => {
      events.push("save-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("save-end");
    };
    const outcome = await importRaceResult(RACE_ID, depsWith(saveResult));
    events.push("resolved");
    expect(outcome.status).toBe("imported");
    expect(events).toEqual(["save-start", "save-end", "resolved"]);
  });

  it("非同期の saveResult が reject したら、そのエラーを伝播する(imported を返さない・握りつぶさない)", async () => {
    const saveResult: ImportResultDeps["saveResult"] = async () => {
      throw new Error("D1 の保存に失敗");
    };
    await expect(importRaceResult(RACE_ID, depsWith(saveResult))).rejects.toThrow("D1 の保存に失敗");
  });

  it("同期の saveResult が throw したときも伝播する(従来どおり)", async () => {
    const saveResult: ImportResultDeps["saveResult"] = () => {
      throw new Error("sync fail");
    };
    await expect(importRaceResult(RACE_ID, depsWith(saveResult))).rejects.toThrow("sync fail");
  });

  it("構造異常(RaceResultParseError)は保存せずに伝播する", async () => {
    const saveResult = vi.fn();
    const deps: ImportResultDeps = {
      fetchText: async () => "<html></html>",
      parse: parseRaceResult,
      saveResult,
    };
    await expect(importRaceResult(RACE_ID, deps)).rejects.toBeInstanceOf(RaceResultParseError);
    expect(saveResult).not.toHaveBeenCalled();
  });

  it("未確定レース(発走前の実物)は保存せず not_confirmed を返す", async () => {
    const saveResult = vi.fn();
    const deps: ImportResultDeps = {
      fetchText: async () => loadFixture("nar_result_presale_202642071612.html"),
      parse: parseRaceResult,
      saveResult,
    };
    const outcome = await importRaceResult(parseRaceId("202642071612"), deps);
    expect(outcome).toEqual({ status: "not_confirmed", raceId: "202642071612" });
    expect(saveResult).not.toHaveBeenCalled();
  });

  it("実フィクスチャ → 移設後の importRaceResult → exe の AnalysisStore.saveResult(同期)→ 復元で、着順・払戻・組合せ払戻が往復する", async () => {
    const store = new AnalysisStore();
    try {
      const outcome = await importRaceResult(RACE_ID, {
        fetchText: async () => HTML,
        parse: parseRaceResult,
        saveResult: (rid, entries, courseType, comboPayouts) => store.saveResult(rid, entries, courseType, comboPayouts),
      });
      expect(outcome.status).toBe("imported");
      const result = parseRaceResult(HTML);
      const detail = store.getRaceResultDetail(RACE_ID);
      expect(detail?.horses).toHaveLength(16);
      expect(detail?.courseType).toBe(result.courseType);
      expect(store.getResult(RACE_ID)?.filter((r) => r.placePayout !== null)).toHaveLength(result.placePayouts.length);
      const quinella = store.getComboPayouts(RACE_ID, "quinella");
      expect(quinella.state).toBe("imported");
      expect(quinella.state === "imported" ? quinella.payouts.map((p) => [p.comboKey, p.payout]) : []).toContainEqual(["0813", 4550]);
    } finally {
      store.close();
    }
  });
});

describe("toResultEntries / summarizeImport(core 版。変換の網羅は app 側の既存テストが担う)", () => {
  const result = parseRaceResult(HTML);

  it("toResultEntries: 頭数・着順・単勝/複勝の払戻の対応付けが、パース結果と一致する", () => {
    const entries = toResultEntries(result);
    expect(entries).toHaveLength(result.horses.length);
    const winner = entries.find((e) => e.finishPosition === 1);
    expect(winner?.winPayout).toBe(result.winPayouts[0]!.payout);
    expect(entries.filter((e) => e.placePayout !== null)).toHaveLength(result.placePayouts.length);
  });

  it("summarizeImport: 払戻あり", () => {
    expect(summarizeImport(RACE_ID, result)).toEqual({
      status: "imported",
      raceId: RACE_ID,
      horseCount: 16,
      placePayoutCount: result.placePayouts.length,
      hasPayout: true,
    });
  });
});
