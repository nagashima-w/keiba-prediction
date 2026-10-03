import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseKaisaiDate,
  parseRaceId,
  scrapeRace,
  type AnalysisRecord,
  type RaceFetcher,
} from "@keiba/core";
import { describe, expect, it } from "vitest";

import { runAnalysis, type AnalysisPipelineDeps } from "../src/main/analysis-pipeline.js";

/**
 * analysis-pipeline-scratch.test.ts — Issue #154。
 * 出馬表に取消・除外の馬が残っていても、`scrapeRace` が出走馬から除くため、`runAnalysis` の
 * 頭数・prior の Σ 目標・複勝の発売条件が**実際に走る馬だけ**で決まること。
 * 取消馬のいないレースの出力は従来と完全に一致すること(回帰)。
 *
 * 8頭・取消1頭の出馬表は合成(実物は中央 202606040901 の16頭・取消1の1本のみ。発走前の印・地方の
 * 印・「除外」の文言は未観測で、同じ雛形・同じ印と見込んでいる)。`scrapeRace` を実物のまま
 * 通すので、パーサ→除去→分析の配線全体が検証される。
 */

function loadFixture(name: string): string {
  const url = new URL(`../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

const RESULTS_FIXTURE = loadFixture("horse_results_2021105857.json");
const RACE_ID = "202606040901";
const KAISAI = "20260927";
const FIXED_NOW = new Date("2026-09-27T01:00:00.000Z");

/** 合成の出馬表行。`scratched` が true なら取消の行(`HorseList Cancel` + `Cancel_Txt`)。 */
function row(n: number, scratched: boolean): string {
  const waku = Math.min(n, 8);
  return `
    <tr class="HorseList${scratched ? " Cancel" : ""}" id="tr_${scratched ? "" : n}">
      <td class="Waku${waku} Txt_C"><span>${waku}</span></td>
      <td class="Umaban${n} Txt_C">${n}</td>
      ${scratched ? `<td class="Cancel_Txt">取消</td>` : ""}
      <td class="HorseInfo"><span class="HorseName"><a href="https://db.netkeiba.com/horse/20241051${String(n).padStart(2, "0")}" title="テスト馬${n}">テスト馬${n}</a></span></td>
      <td class="Barei Txt_C">牝2</td>
      <td class="Txt_C">55.0</td>
      <td class="Jockey"><a href="https://db.netkeiba.com/jockey/result/recent/01043/" title="騎手">騎手</a></td>
      <td class="Trainer"><span class="Label1">美浦</span><a href="https://db.netkeiba.com/trainer/result/recent/01126/" title="調教師">調教師</a></td>
      <td class="Weight">${scratched ? "" : "464(-8)"}</td>
    </tr>`;
}

/** 8行(馬番1〜8)の出馬表。`scratchedUmaban` の馬だけ取消の印を付ける(null なら全頭出走)。 */
function shutubaHtml(scratchedUmaban: number | null): string {
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1, i + 1 === scratchedUmaban));
  return `
    <div class="RaceList_Item02">
      <h1 class="RaceName">合成レース</h1>
      <div class="RaceData01">09:50発走 / 芝1600m / 天候:晴 / 馬場:良</div>
    </div>
    <table><tbody>${rows.join("")}</tbody></table>`;
}

/** 8頭ぶんの合成オッズJSON。取消馬は実取得と同じく null・9999。 */
function oddsJson(scratchedUmaban: number | null): string {
  const win: Record<string, [string, string, string]> = {};
  const place: Record<string, [string, string, string]> = {};
  for (let n = 1; n <= 8; n++) {
    const key = String(n).padStart(2, "0");
    if (n === scratchedUmaban) {
      win[key] = ["---.-", "0.0", "9999"];
      place[key] = ["---.-", "---.-", "9999"];
    } else {
      win[key] = [`${3 + n}.0`, "0.0", String(n)];
      place[key] = ["3.0", "4.0", String(n)];
    }
  }
  return JSON.stringify({
    status: "result",
    data: { official_datetime: "2026-09-27 09:40:00", odds: { "1": win, "2": place } },
  });
}

function fetcherFor(scratchedUmaban: number | null): RaceFetcher {
  return {
    async fetchText(url: string): Promise<string> {
      if (url.includes("shutuba.html")) return shutubaHtml(scratchedUmaban);
      if (url.includes("ajax_horse_results")) return RESULTS_FIXTURE;
      if (url.includes("oikiri.html")) throw new Error("調教(このテストでは使わない)");
      if (url.includes("api_get_jra_odds")) return oddsJson(scratchedUmaban);
      throw new Error(`未知のURL: ${url}`);
    },
  };
}

/** 複勝だけの配分設定(組合せオッズは取らない)。発売条件の判定(7頭以下は複勝候補なし)を直接見る。 */
const PLACE_ONLY_SETTINGS = {
  bankroll: 300000,
  perRaceCap: 20000,
  kellyFraction: 0.5,
  includeComboOdds: false,
  includeWideInAllocation: false,
  includeTrioInAllocation: false,
  includeQuinellaInAllocation: false,
  includeExactaInAllocation: false,
  includeTrifectaInAllocation: false,
  includeBracketQuinellaInAllocation: false,
} as const;

async function analyze(scratchedUmaban: number | null) {
  const saved: AnalysisRecord[] = [];
  const deps: AnalysisPipelineDeps = {
    scrape: (raceId) => scrapeRace(raceId, { fetcher: fetcherFor(scratchedUmaban), now: () => FIXED_NOW }),
    analyze: null,
    saveAnalysis: (rec) => {
      saved.push(rec);
      return 1;
    },
    now: () => FIXED_NOW,
    llmSkipReason: "APIキー未設定",
    allocationSettings: PLACE_ONLY_SETTINGS,
  };
  const result = await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
  expect(saved).toHaveLength(1); // 前提固定。
  return { result, record: saved[0]! };
}

describe("runAnalysis: 取消馬は頭数・prior・複勝の発売条件に入らない(Issue #154)", () => {
  it("取消1頭の8頭立ては、結果の行・保存する馬が7頭になり、取消馬の行が無いこと", async () => {
    const { result, record } = await analyze(6);
    expect(result.rows.map((r) => r.umaban)).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(record.horses.map((h) => h.umaban)).toEqual([1, 2, 3, 4, 5, 7, 8]);
  });

  it("prior の合計は目標 min(3,頭数)=3 に出走7頭だけで揃うこと(取消馬が目標の一部を持っていかない)", async () => {
    const { result } = await analyze(6);
    expect(result.rows).toHaveLength(7); // 前提固定。
    const sum = result.rows.reduce((s, r) => s + r.prior, 0);
    expect(sum).toBeCloseTo(3, 6);
  });

  it("複勝の発売条件: 取消込みなら8頭で配分対象だが、取消を除いた7頭は two-place-only で複勝候補を出さないこと(判定の反転)", async () => {
    // 対照: 全頭出走の8頭立ては複勝が配分対象(unavailable ではない)。
    const control = await analyze(null);
    expect(control.result.rows).toHaveLength(8); // 前提固定。
    expect(control.record.allocation!.meta.route).not.toBe("unavailable");
    expect(control.record.allocation!.meta.unavailableReason).toBeNull();

    // 取消1頭: 実際に走るのは7頭 → 複勝は2着まで払戻で本ツールの対象外。
    const scratched = await analyze(6);
    expect(scratched.result.rows).toHaveLength(7); // 前提固定。
    expect(scratched.record.allocation!.meta.route).toBe("unavailable");
    expect(scratched.record.allocation!.meta.unavailableReason).toBe("two-place-only");
  });

  it("取消馬の警告(出走取消)が分析結果の warnings に出ること(画面の警告欄に載る)", async () => {
    const { result } = await analyze(6);
    const scratchWarnings = result.warnings.filter((w) => w.includes("取消") && w.includes("6番"));
    expect(scratchWarnings).toHaveLength(1);
    expect(scratchWarnings[0]).toContain("テスト馬6");
  });

  it("取消馬のいないレースは warnings に出走取消が出ず、8頭ぶんの行を返すこと(回帰)", async () => {
    const { result } = await analyze(null);
    expect(result.rows.map((r) => r.umaban)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.warnings.some((w) => w.includes("取消"))).toBe(false);
    // prior の合計も従来どおり目標3に揃う。
    expect(result.rows.reduce((s, r) => s + r.prior, 0)).toBeCloseTo(3, 6);
  });

  it("取消の印がある8行の出馬表は、その馬の行が最初から無い7行の出馬表と、残る7頭の分析結果(行)が完全に一致すること", async () => {
    // 同じ出走馬を、取消馬の行が最初から存在しない出馬表(7行)として与えた場合と、
    // 8行のうち1頭が取消の出馬表として与えた場合で、残る7頭の分析結果が一致すること。
    const sevenRows = (umaban: number | null) => {
      const rows = Array.from({ length: 8 }, (_, i) => i + 1)
        .filter((n) => n !== umaban)
        .map((n) => row(n, false));
      return `
        <div class="RaceList_Item02">
          <h1 class="RaceName">合成レース</h1>
          <div class="RaceData01">09:50発走 / 芝1600m / 天候:晴 / 馬場:良</div>
        </div>
        <table><tbody>${rows.join("")}</tbody></table>`;
    };
    const saved: AnalysisRecord[] = [];
    const deps: AnalysisPipelineDeps = {
      scrape: (raceId) =>
        scrapeRace(raceId, {
          fetcher: {
            async fetchText(url: string): Promise<string> {
              if (url.includes("shutuba.html")) return sevenRows(6);
              if (url.includes("ajax_horse_results")) return RESULTS_FIXTURE;
              if (url.includes("oikiri.html")) throw new Error("調教(このテストでは使わない)");
              if (url.includes("api_get_jra_odds")) return oddsJson(6);
              throw new Error(`未知のURL: ${url}`);
            },
          },
          now: () => FIXED_NOW,
        }),
      analyze: null,
      saveAnalysis: (rec) => {
        saved.push(rec);
        return 1;
      },
      now: () => FIXED_NOW,
      llmSkipReason: "APIキー未設定",
      allocationSettings: PLACE_ONLY_SETTINGS,
    };
    const absent = await runAnalysis(parseRaceId(RACE_ID), parseKaisaiDate(KAISAI), deps);
    const marked = await analyze(6);

    expect(absent.rows).toHaveLength(7); // 前提固定。
    // 行(prior・補正後確率・EV・オッズ等)が完全一致する。
    expect(marked.result.rows).toEqual(absent.rows);
    // 警告だけが違う(取消の印がある側にだけ出走取消の警告が付く)。
    expect(absent.warnings.some((w) => w.includes("取消"))).toBe(false);
    expect(marked.result.warnings.some((w) => w.includes("取消"))).toBe(true);
  });
});
