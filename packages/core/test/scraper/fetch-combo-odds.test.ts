/**
 * fetch-combo-odds(組合せオッズ取得のオーケストレーション。中央/地方 × ワイド/三連複)の
 * テスト(機能D-2b-B・Issue #33第3段。boss着手前ゲート2026-08-07裁定)。
 *
 * `OddsSnapshot`/`scrapeRace`配線は第4段のスコープであり、本ファイルは触れない。
 * 実ネットワークは使わない。フェイクフェッチャ + 実フィクスチャ/最小限の合成HTMLで検証する。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CachedFetchTextOptions } from "../../src/scraper/cache.js";
import { buildComboOddsKey } from "../../src/scraper/combo-odds-key.js";
import {
  expectedBracketQuinellaComboCount,
  fetchBracketQuinellaOdds,
  fetchComboOdds,
  fetchNarTrifectaAxisOdds,
  type ComboOddsFetcher,
} from "../../src/scraper/fetch-combo-odds.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import { parseRaceResult } from "../../src/scraper/parse-race-result.js";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";
import {
  bracketQuinellaOddsApiUrl,
  exactaOddsApiUrl,
  narBracketQuinellaOddsPageUrl,
  narExactaOddsPageUrl,
  narQuinellaOddsPageUrl,
  narTrifectaOddsAxisUrl,
  narTrioOddsAxisUrl,
  narWideOddsPageUrl,
  quinellaOddsApiUrl,
  trifectaOddsApiUrl,
  trioOddsApiUrl,
} from "../../src/scraper/urls.js";

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む(既存テストと同じ解決方法)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/**
 * 最小限の合成NAR3連複オッズHTML(検証対象の構造〈#odds_view_form・td.Oddsのid規約〉だけを持つ)。
 * `parse-nar-combo-odds.ts`の「自分たちの防御的不変条件は合成データで良い」線引きに沿い、
 * 本ファイルは「オーケストレーション(取得の束ね方)」の検証が主目的のため、サイト構造の主張は
 * 実フィクスチャ側のテスト(`parse-nar-combo-odds.test.ts`)に委ね、ここでは意図した組合せ集合を
 * 正確に制御するために合成HTMLを使う。
 */
function narTrioHtml(
  entries: ReadonlyArray<readonly [number, number, number, string]>,
): string {
  const cells = entries
    .map(
      ([a, b, c, value]) =>
        `<tr><td class="Odds" id="chk_x_b7_c0_${a}_${b}_${c}">${value}</td></tr>`,
    )
    .join("");
  return `<div id="odds_view_form"><table class="Odds_Table">${cells}</table></div>`;
}

/** 発売前などで組合せセルが1件も無い(構造は正当な)合成NARオッズHTML。 */
const NAR_UNAVAILABLE_HTML = `<div id="odds_view_form"></div>`;

interface RecordedCall {
  readonly url: string;
  readonly options?: CachedFetchTextOptions;
}

/** URL(と呼び出し順)を記録しつつ、渡された関数でレスポンス(文字列またはError)を返すフェイクフェッチャ。 */
function createFakeFetcher(
  respond: (url: string, callIndex: number) => string | Error,
): {
  readonly fetcher: ComboOddsFetcher;
  readonly calls: RecordedCall[];
  readonly maxConcurrent: () => number;
} {
  const calls: RecordedCall[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  return {
    fetcher: {
      async fetchText(url: string, options?: CachedFetchTextOptions): Promise<string> {
        calls.push({ url, options });
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        // 複数回マイクロタスクをまたぐことで、実装が誤って並行発行していれば検出しやすくする。
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        const result = respond(url, calls.length - 1);
        if (result instanceof Error) throw result;
        return result;
      },
    },
    calls,
    maxConcurrent: () => maxConcurrent,
  };
}

const NAR_RACE_ID = parseRaceId("202654071210"); // 実フィクスチャと同一の地方レース(12頭)
const CENTRAL_RACE_ID = parseRaceId("202603020211"); // 実フィクスチャと同一の中央レース(16頭)
const CENTRAL_PRESALE_RACE_ID = parseRaceId("202604020511"); // 実フィクスチャと同一の中央発売前レース(18頭)

describe("fetchComboOdds(地方3連複: 軸走査のリクエスト順序・直列性。テスト観点2)", () => {
  it("12頭→軸10件、URLがjiku=1..10の順で直列に発行されること", async () => {
    const html = loadFixture("nar_odds_b7_jiku1_202654071210.html");
    const { fetcher, calls, maxConcurrent } = createFakeFetcher(() => html);
    const startingUmabans = Array.from({ length: 12 }, (_, i) => i + 1);

    const result = await fetchComboOdds(NAR_RACE_ID, "trio", startingUmabans, fetcher);

    expect(result.diagnostics.axisUmabans).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // 前提固定
    expect(calls.map((c) => c.url)).toEqual(
      Array.from({ length: 10 }, (_, i) => narTrioOddsAxisUrl(NAR_RACE_ID, i + 1)),
    );
    expect(maxConcurrent()).toBe(1); // 直列であること(並行実行が無いこと)
    expect(result.diagnostics.requestCount).toBe(10);
  });
});

describe("fetchComboOdds(境界値: 頭数nと軸数の対応。テスト観点8・9・10)", () => {
  it.each([
    ["n=0", [] as number[]],
    ["n=1", [5]],
    ["n=2", [3, 7]],
  ])("%s: 軸0件・HTTPを1回も発行せずunavailableになること", async (_label, startingUmabans) => {
    const { fetcher, calls } = createFakeFetcher(() => {
      throw new Error("呼ばれてはいけない(軸0件のはず)");
    });
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", startingUmabans, fetcher);
    expect(calls.length).toBe(0);
    expect(result.diagnostics.requestCount).toBe(0);
    expect(result.state).toBe("unavailable");
    expect(result.odds.size).toBe(0);
  });

  it("n=3: 軸1件を発行すること", async () => {
    const html = narTrioHtml([[1, 3, 5, "10.0"]]);
    const { fetcher, calls } = createFakeFetcher(() => html);
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [5, 1, 3], fetcher);
    expect(calls.length).toBe(1);
    expect(result.diagnostics.axisUmabans).toEqual([1]);
    expect(result.state).toBe("available");
  });

  it("非連番{2,3,5,7,9,11}(n=6)→軸[2,3,5,7]であること(値がn-2以下ではなく、昇順先頭n-2頭)", async () => {
    const html = narTrioHtml([[2, 3, 5, "10.0"]]);
    const { fetcher } = createFakeFetcher(() => html);
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [2, 3, 5, 7, 9, 11], fetcher);
    expect(result.diagnostics.axisUmabans).toEqual([2, 3, 5, 7]);
  });
});

describe("fetchComboOdds(地方3連複: 券種の結末3値。boss裁定Q2・AC-4。テスト観点11・12・13)", () => {
  it('全軸unavailable→state="unavailable"であること("failed"にならない)', async () => {
    const { fetcher } = createFakeFetcher(() => NAR_UNAVAILABLE_HTML);
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher);
    expect(result.diagnostics.attempts.length).toBe(3); // 前提固定(n=5→軸3件)
    expect(result.diagnostics.attempts.every((a) => a.state === "unavailable")).toBe(true);
    expect(result.state).toBe("unavailable");
    expect(result.odds.size).toBe(0);
  });

  it('全軸HTTP失敗→state="failed"であること("unavailable"に丸めない)', async () => {
    const { fetcher } = createFakeFetcher(() => new Error("network down"));
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher);
    expect(result.diagnostics.attempts.length).toBe(3); // 前提固定
    expect(result.diagnostics.attempts.every((a) => a.state === "fetchFailed")).toBe(true);
    expect(result.state).toBe("failed");
    expect(result.odds.size).toBe(0);
  });

  it('一部だけ成功→state="available"(部分被覆)。失敗軸にしか属さない組はMapに存在せず(AC-5b)、診断値から部分被覆が読み取れること', async () => {
    // n=5、軸=[1,2,3]。軸1・軸2は成功、軸3はHTTP失敗とする。
    // 全10トリオのうち「345」だけが1も2も含まない=軸3にしか属さない組。
    const axis1Html = narTrioHtml([
      [1, 2, 3, "10.0"],
      [1, 2, 4, "11.0"],
      [1, 2, 5, "12.0"],
      [1, 3, 4, "13.0"],
      [1, 3, 5, "14.0"],
      [1, 4, 5, "15.0"],
    ]);
    const axis2Html = narTrioHtml([
      [1, 2, 3, "10.0"],
      [1, 2, 4, "11.0"],
      [1, 2, 5, "12.0"],
      [2, 3, 4, "16.0"],
      [2, 3, 5, "17.0"],
      [2, 4, 5, "18.0"],
    ]);
    const { fetcher, calls } = createFakeFetcher((url) => {
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 1)) return axis1Html;
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 2)) return axis2Html;
      return new Error("軸3は失敗する");
    });

    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher);

    expect(calls.length).toBe(3); // 前提固定: 軸1・2・3すべて発行される
    expect(result.state).toBe("available");
    const key345 = buildComboOddsKey([3, 4, 5]);
    // {3,4,5}は軸3にしか属さない組。軸3が失敗したため値nullで存在するのではなく、
    // キーごと不在であること(AC-5b。#14の missing と unfetched の区別と同じ)。
    expect(result.odds.has(key345)).toBe(false);
    // 診断値から部分被覆が読み取れること。
    expect(result.diagnostics.expectedComboCount).toBe(10); // C(5,3)=10、前提固定
    expect(result.diagnostics.obtainedComboCount).toBe(9); // 10件中「345」の1件だけが欠落
    expect(result.diagnostics.missingComboCount).toBe(1);
    expect(
      result.diagnostics.attempts.some((a) => a.axis === 3 && a.state === "fetchFailed"),
    ).toBe(true);
  });

  it('一部unavailable・一部fetchFailed(取得0件)の混在→state="failed"であること("unavailable"に丸めない。code-reviewer指摘2)', async () => {
    // n=5、軸=[1,2,3]。軸1・軸3はunavailable(市場が首尾一貫して未発売/発売なしに見える)、
    // 軸2だけHTTP失敗。取得できた組合せは0件だが、②③(市場が無い)と④(取得できず分からない)を
    // 混同してはならない核心の境界(AC7b)。attempts.every(...)をsome(...)に壊すと
    // 「1件でもunavailableがあれば即unavailableと誤判定」してしまい、この境界を検知できない。
    const { fetcher } = createFakeFetcher((url) => {
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 2)) return new Error("軸2はHTTP失敗する");
      return NAR_UNAVAILABLE_HTML;
    });
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher);

    expect(result.diagnostics.attempts.length).toBe(3); // 前提固定(n=5→軸3件)
    // 前提固定(空振り防止): 混在の内訳そのものを先に固定する。
    expect(
      result.diagnostics.attempts.filter((a) => a.state === "unavailable").length,
    ).toBe(2);
    expect(
      result.diagnostics.attempts.filter((a) => a.state === "fetchFailed").length,
    ).toBe(1);
    expect(result.odds.size).toBe(0);
    expect(result.state).toBe("failed");
  });

  it('一部unavailable・一部parseError(取得0件)の混在→state="failed"であること("unavailable"に丸めない)', async () => {
    // 軸2は構造異常(#odds_select・#odds_view_formのいずれも持たない)でparseErrorになる。
    const malformedHtml = `<html><body>no markers here</body></html>`;
    const { fetcher } = createFakeFetcher((url) => {
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 2)) return malformedHtml;
      return NAR_UNAVAILABLE_HTML;
    });
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher);

    expect(result.diagnostics.attempts.length).toBe(3); // 前提固定
    expect(
      result.diagnostics.attempts.filter((a) => a.state === "unavailable").length,
    ).toBe(2);
    expect(
      result.diagnostics.attempts.filter((a) => a.state === "parseError").length,
    ).toBe(1);
    expect(result.odds.size).toBe(0);
    expect(result.state).toBe("failed");
  });
});

describe("fetchComboOdds(地方3連複: 軸間衝突の診断値配線。code-reviewer指摘1)", () => {
  it("数値衝突1件のみ→numericConflictCount=1・nullWinConflictCount=0(両方を無条件に固定。入れ替えミューテーションの検知)", async () => {
    // n=5、軸=[1,2,3]。軸1・軸2が同じ組{1,2,3}に異なる数値を返す(数値衝突)。
    // 軸3は無関係な組を1件返す(衝突には関与しない)。
    const axis1Html = narTrioHtml([[1, 2, 3, "5.0"]]);
    const axis2Html = narTrioHtml([[1, 2, 3, "3.0"]]);
    const axis3Html = narTrioHtml([[3, 4, 5, "8.0"]]);
    const { fetcher } = createFakeFetcher((url) => {
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 1)) return axis1Html;
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 2)) return axis2Html;
      return axis3Html;
    });
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher);

    expect(result.diagnostics.numericConflictCount).toBe(1);
    expect(result.diagnostics.nullWinConflictCount).toBe(0);
    expect(result.diagnostics.conflictSamples.length).toBe(1);
    expect(result.diagnostics.conflictSamples[0]!.kind).toBe("numeric");
    // 保守側(小さい方)が採られていること(Q1裁定の一貫性確認)。
    expect(result.odds.get(buildComboOddsKey([1, 2, 3]))).toEqual({
      oddsMin: 3.0,
      oddsMax: null,
      ninki: null,
    });
  });

  it("null採用衝突1件のみ→nullWinConflictCount=1・numericConflictCount=0(両方を無条件に固定。入れ替えミューテーションの検知)", async () => {
    // 軸1が非数値("---.-"→oddsMin=null)、軸2が数値を返す組{1,2,3}(null採用衝突)。
    const axis1Html = narTrioHtml([[1, 2, 3, "---.-"]]);
    const axis2Html = narTrioHtml([[1, 2, 3, "3.0"]]);
    const axis3Html = narTrioHtml([[3, 4, 5, "8.0"]]);
    const { fetcher } = createFakeFetcher((url) => {
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 1)) return axis1Html;
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 2)) return axis2Html;
      return axis3Html;
    });
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher);

    expect(result.diagnostics.numericConflictCount).toBe(0);
    expect(result.diagnostics.nullWinConflictCount).toBe(1);
    expect(result.diagnostics.conflictSamples.length).toBe(1);
    expect(result.diagnostics.conflictSamples[0]!.kind).toBe("nullWin");
    expect(result.odds.get(buildComboOddsKey([1, 2, 3]))).toEqual({
      oddsMin: null,
      oddsMax: null,
      ninki: null,
    });
  });

  it("衝突11件→conflictSamples.length=10(打ち切り)だが、numericConflictCountは11のまま(打ち切りが件数に波及しないこと)", async () => {
    // n=13、軸=[1..11]。軸1・軸2が{1,2,c}(c=3..13の11通り)に異なる数値を返し、
    // 11件の数値衝突を作る。軸3..11はunavailable(衝突に無関係)。
    const conflictAnchors = Array.from({ length: 11 }, (_, i) => i + 3); // 3..13
    const axis1Html = narTrioHtml(conflictAnchors.map((c) => [1, 2, c, "5.0"] as const));
    const axis2Html = narTrioHtml(conflictAnchors.map((c) => [1, 2, c, "3.0"] as const));
    const { fetcher } = createFakeFetcher((url) => {
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 1)) return axis1Html;
      if (url === narTrioOddsAxisUrl(NAR_RACE_ID, 2)) return axis2Html;
      return NAR_UNAVAILABLE_HTML;
    });
    const startingUmabans = Array.from({ length: 13 }, (_, i) => i + 1);
    const result = await fetchComboOdds(NAR_RACE_ID, "trio", startingUmabans, fetcher);

    expect(result.diagnostics.axisUmabans.length).toBe(11); // 前提固定(n=13→軸11件)
    expect(result.diagnostics.numericConflictCount).toBe(11); // 打ち切りに関わらず正確な件数
    expect(result.diagnostics.nullWinConflictCount).toBe(0);
    expect(result.diagnostics.conflictSamples.length).toBe(10); // 表示用サンプルは上限で打ち切り
  });
});

describe("fetchComboOdds(軸馬番の契約違反はfail fast。boss裁定Q3・AC-6。テスト観点14)", () => {
  it("出走馬番に契約違反(0)が混入した場合、HTTPを1回も発行せずthrowすること", async () => {
    const { fetcher, calls } = createFakeFetcher(() => {
      throw new Error("呼ばれてはいけない");
    });
    // 昇順ソート後の先頭(軸として選ばれる側)に0が来るよう仕込む。
    await expect(fetchComboOdds(NAR_RACE_ID, "trio", [0, 2, 3, 4, 5], fetcher)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("出走馬番に契約違反(小数)が混入した場合も同様にfail fastすること", async () => {
    const { fetcher, calls } = createFakeFetcher(() => {
      throw new Error("呼ばれてはいけない");
    });
    await expect(
      fetchComboOdds(NAR_RACE_ID, "trio", [1.5, 2, 3, 4, 5], fetcher),
    ).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

describe("fetchComboOdds(中央: 1リクエストで軸ループを回さない。テスト観点15)", () => {
  it("中央3連複: 1リクエストのみ発行し、parseComboOddsのavailableがそのまま写ること", async () => {
    const json = loadFixture("odds_trio_202603020211.json");
    const { fetcher, calls } = createFakeFetcher(() => json);
    const startingUmabans = Array.from({ length: 16 }, (_, i) => i + 1);

    const result = await fetchComboOdds(CENTRAL_RACE_ID, "trio", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(trioOddsApiUrl(CENTRAL_RACE_ID));
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(560); // C(16,3)、実測(urls.ts JSDoc参照)
    expect(result.diagnostics.expectedComboCount).toBe(560);
    expect(result.diagnostics.requestCount).toBe(1);
    expect(result.diagnostics.axisUmabans).toEqual([]); // 中央は軸走査を行わない
  });

  it("中央3連複: 未発売(parseComboOddsのunavailable)がそのまま写ること", async () => {
    const json = loadFixture("odds_trio_presale_202604020511_20260806.json");
    const { fetcher, calls } = createFakeFetcher(() => json);
    const startingUmabans = Array.from({ length: 18 }, (_, i) => i + 1);

    const result = await fetchComboOdds(
      CENTRAL_PRESALE_RACE_ID,
      "trio",
      startingUmabans,
      fetcher,
    );

    expect(calls.length).toBe(1);
    expect(result.state).toBe("unavailable");
    expect(result.odds.size).toBe(0);
  });
});

describe("fetchComboOdds(地方ワイド: 1リクエストで軸ループを回さない。テスト観点16)", () => {
  it("地方ワイド: 1リクエストのみ発行し、parseNarComboOddsのavailableがそのまま写ること", async () => {
    const html = loadFixture("nar_odds_b5_202654071210.html");
    const { fetcher, calls } = createFakeFetcher(() => html);
    const startingUmabans = Array.from({ length: 12 }, (_, i) => i + 1);

    const result = await fetchComboOdds(NAR_RACE_ID, "wide", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(narWideOddsPageUrl(NAR_RACE_ID));
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(66); // C(12,2)、実測(urls.ts JSDoc参照)
    expect(result.diagnostics.axisUmabans).toEqual([]);
  });
});

/**
 * 馬単(exacta)のexpectedComboCountは順列P(n,2)で計算されること(Issue #106・#24-B AC-B3)。
 *
 * ★このdescribeは実装前(fetch-combo-odds.tsのexpectedComboCountがcombinationCount〈組合せ
 * C(n,r)〉のまま)ではRedになる: 16頭で期待されるのはP(16,2)=240だが、C(16,2)=120が返る。
 * 同じ16頭でワイド(unordered)がC(16,2)=120のままであることも同時に固定し、
 * 「同じヘルパでどちらも通る」形になっていないことを確認する(順列/組合せの分岐が
 * comboSize===2固定ではなく順序方針で決まっていることの証明)。
 *
 * ★用語注記: ブリーフは「馬連は120のまま」としていたが、`ComboBetType`に「馬連」
 * (umaren・quinella)は存在しない(#24-Bが追加するのは`exacta`のみ。馬連の追加は#24-D)。
 * 本テストでは既存の`wide`(comboSize=2・unordered)を対比対象として使う
 * (comboSize=2で順序方針だけが異なる型を比較する、という意図には合致すると判断した。
 * 解釈が違う場合は指摘してほしい)。
 */
describe("fetchComboOdds(中央: 馬単。expectedComboCountが順列で計算されること。Issue #106・#24-B AC-B3)", () => {
  it("16頭の馬単: expectedComboCountがP(16,2)=240になること(C(16,2)=120ではない)", async () => {
    const json = loadFixture("odds_exacta_202603020211.json");
    const { fetcher, calls } = createFakeFetcher(() => json);
    const startingUmabans = Array.from({ length: 16 }, (_, i) => i + 1);

    const result = await fetchComboOdds(CENTRAL_RACE_ID, "exacta", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(exactaOddsApiUrl(CENTRAL_RACE_ID));
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(240); // P(16,2)、実測(fixtures/odds_exacta_202603020211.json)
    expect(result.diagnostics.expectedComboCount).toBe(240);
  });

  it("同じ16頭でもワイド(unordered)はexpectedComboCountがC(16,2)=120のままであること(回帰・対比)", async () => {
    const json = loadFixture("odds_wide_202603020211.json");
    const { fetcher, calls } = createFakeFetcher(() => json);
    const startingUmabans = Array.from({ length: 16 }, (_, i) => i + 1);

    const result = await fetchComboOdds(CENTRAL_RACE_ID, "wide", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(120); // C(16,2)、実測
    expect(result.diagnostics.expectedComboCount).toBe(120);
  });

  it("地方馬単: 1リクエストのみ発行し、parseNarComboOddsのavailableがそのまま写ること(12頭・P(12,2)=132)", async () => {
    const html = loadFixture("nar_odds_b6_202654071210.html");
    const { fetcher, calls } = createFakeFetcher(() => html);
    const startingUmabans = Array.from({ length: 12 }, (_, i) => i + 1);

    const result = await fetchComboOdds(NAR_RACE_ID, "exacta", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(narExactaOddsPageUrl(NAR_RACE_ID));
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(132); // P(12,2)、実測
    expect(result.diagnostics.expectedComboCount).toBe(132);
    expect(result.diagnostics.axisUmabans).toEqual([]);
  });
});

/**
 * 馬連(quinella)の配線(Issue #113・#24-D2)。
 *
 * 馬連はワイドと同じ「順不同・単発リクエスト」の券種であり、`comboOddsUrlFor`の両switch
 * (中央/地方)に`case "quinella"`が無い場合はコンパイルエラー(exhaustiveCheck: never)に
 * なるため、実装前はビルド自体が通らない形でRedになる。
 */
describe("fetchComboOdds(馬連。Issue #113・#24-D2)", () => {
  it("中央馬連: 1リクエストのみ発行し、quinellaOddsApiUrlを叩き、parseComboOddsのavailableがそのまま写ること(16頭・C(16,2)=120)", async () => {
    const json = loadFixture("odds_quinella_202603020211.json");
    const { fetcher, calls } = createFakeFetcher(() => json);
    const startingUmabans = Array.from({ length: 16 }, (_, i) => i + 1);

    const result = await fetchComboOdds(CENTRAL_RACE_ID, "quinella", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(quinellaOddsApiUrl(CENTRAL_RACE_ID));
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(120); // C(16,2)、実測(fixtures/odds_quinella_202603020211.json)
    expect(result.diagnostics.expectedComboCount).toBe(120); // unorderedなのでC(16,2)。P(16,2)=240ではない
  });

  it("地方馬連: 1リクエストのみ発行し、narQuinellaOddsPageUrlを叩き、parseNarComboOddsのavailableがそのまま写ること(12頭・C(12,2)=66)", async () => {
    const html = loadFixture("nar_odds_b4_202654071210.html");
    const { fetcher, calls } = createFakeFetcher(() => html);
    const startingUmabans = Array.from({ length: 12 }, (_, i) => i + 1);

    const result = await fetchComboOdds(NAR_RACE_ID, "quinella", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(narQuinellaOddsPageUrl(NAR_RACE_ID));
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(66); // C(12,2)、実測
    expect(result.diagnostics.expectedComboCount).toBe(66);
    expect(result.diagnostics.axisUmabans).toEqual([]);
  });
});

/**
 * 三連単(trifecta)の配線(Issue #130・#25-D)。
 *
 * 中央は馬単・馬連と同じ「単発リクエスト」だが、キーは着順どおり(ordered)のためexpectedComboCountは
 * 組合せC(n,r)ではなく順列P(n,r)で計算される(#106のexactaと同じ式)。地方は3連複と同じ
 * 「軸馬別取得」が必要な券種だが、**全軸を回すオーケストレーション関数は本Issueでは作らない**
 * (オーケストレーター裁定Q2)。そのため`fetchComboOdds`の地方三連単経路は、3連複の
 * `case "trio": throw`と同じ理由で単発リクエストとしては扱えないことをthrowで示す
 * (`comboOddsUrlFor`の両switchに`case "trifecta"`が無い場合はコンパイルエラーになるため、
 * 実装前はビルド自体が通らない形でRedになる)。
 */
describe("fetchComboOdds(三連単。Issue #130・#25-D)", () => {
  it("中央三連単: 1リクエストのみ発行し、trifectaOddsApiUrlを叩き、expectedComboCountがP(16,3)=3360になること(C(16,3)=560ではない)", async () => {
    const json = loadFixture("odds_trifecta_202603020211.json");
    const { fetcher, calls } = createFakeFetcher(() => json);
    const startingUmabans = Array.from({ length: 16 }, (_, i) => i + 1);

    const result = await fetchComboOdds(CENTRAL_RACE_ID, "trifecta", startingUmabans, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(trifectaOddsApiUrl(CENTRAL_RACE_ID));
    expect(result.state).toBe("available");
    expect(result.odds.size).toBe(3360); // P(16,3)、実測(fixtures/odds_trifecta_202603020211.json)
    expect(result.diagnostics.expectedComboCount).toBe(3360);
  });

  it("地方三連単をfetchComboOdds(汎用オーケストレーター)経由で呼ぶとthrowすること(全軸を回す実装は#132のスコープであり本Issueでは提供しない)", async () => {
    const { fetcher } = createFakeFetcher(() => {
      throw new Error("呼ばれないはず");
    });
    const startingUmabans = Array.from({ length: 12 }, (_, i) => i + 1);

    await expect(
      fetchComboOdds(NAR_RACE_ID, "trifecta", startingUmabans, fetcher),
    ).rejects.toThrow();
  });
});

/**
 * fetchNarTrifectaAxisOdds(地方三連単の軸単位取得。Issue #130・#25-D Q2)。
 *
 * 3連複の`fetchNarTrioComboOdds`(全軸を内部でループするオーケストレーション関数)とは異なり、
 * **1軸ぶんだけを取得する関数**として提供する(オーケストレーター裁定Q2で合意した形)。
 * 全軸を束ねてマージするかどうか・何軸まで回すかは#132の判断に委ねる。
 */
describe("fetchNarTrifectaAxisOdds(地方三連単の軸単位取得。Issue #130・#25-D)", () => {
  it("軸5: narTrifectaOddsAxisUrlを1回叩き、availableな場合はattempt/oddsに正しく写ること(P(11,2)=110件)", async () => {
    const html = loadFixture("nar_odds_b8_jiku5_202654071210.html");
    const { fetcher, calls } = createFakeFetcher(() => html);

    const result = await fetchNarTrifectaAxisOdds(NAR_RACE_ID, 5, fetcher);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(narTrifectaOddsAxisUrl(NAR_RACE_ID, 5));
    expect(result.attempt).toEqual({ axis: 5, state: "available", comboCount: 110 });
    expect(result.odds.size).toBe(110);
  });

  it("presale(未発売)の場合はattemptがunavailableになり、oddsは空Mapのままであること", async () => {
    const html = loadFixture("nar_odds_b8_presale_202654092701_20260926.html");
    const { fetcher } = createFakeFetcher(() => html);

    const result = await fetchNarTrifectaAxisOdds(NAR_RACE_ID, 1, fetcher);

    expect(result.attempt.axis).toBe(1);
    expect(result.attempt.state).toBe("unavailable");
    expect(result.odds.size).toBe(0);
  });

  it("HTTP取得自体が失敗した場合はattemptがfetchFailedになり、oddsは空Mapのままであること", async () => {
    const { fetcher } = createFakeFetcher(() => new Error("模擬したHTTP失敗"));

    const result = await fetchNarTrifectaAxisOdds(NAR_RACE_ID, 3, fetcher);

    expect(result.attempt.axis).toBe(3);
    expect(result.attempt.state).toBe("fetchFailed");
    expect(result.odds.size).toBe(0);
  });

  it("オッズ文書として認識できない構造の場合はattemptがparseErrorになり、oddsは空Mapのままであること", async () => {
    const { fetcher } = createFakeFetcher(() => "<html><body>想定外の構造</body></html>");

    const result = await fetchNarTrifectaAxisOdds(NAR_RACE_ID, 2, fetcher);

    expect(result.attempt.axis).toBe(2);
    expect(result.attempt.state).toBe("parseError");
    expect(result.odds.size).toBe(0);
  });

  it("軸番号(axis)が契約違反(0・小数・上限超過等)の場合はHTTPを発行せずthrowすること(narTrifectaOddsAxisUrlと同じ契約)", async () => {
    const { fetcher, calls } = createFakeFetcher(() => {
      throw new Error("呼ばれないはず");
    });

    await expect(fetchNarTrifectaAxisOdds(NAR_RACE_ID, 0, fetcher)).rejects.toThrow();
    await expect(fetchNarTrifectaAxisOdds(NAR_RACE_ID, 1.5, fetcher)).rejects.toThrow();
    await expect(fetchNarTrifectaAxisOdds(NAR_RACE_ID, 19, fetcher)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

describe("fetchComboOdds(maxAgeMs/bypassCacheが全リクエストに一様伝播すること。AC-8。テスト観点17)", () => {
  it("地方3連複の軸ループで、全軸に同一のoptionsが渡ること", async () => {
    const html = narTrioHtml([[1, 2, 3, "10.0"]]);
    const { fetcher, calls } = createFakeFetcher(() => html);
    const options: CachedFetchTextOptions = { maxAgeMs: 12345, bypassCache: true };

    await fetchComboOdds(NAR_RACE_ID, "trio", [1, 2, 3, 4, 5], fetcher, options);

    expect(calls.length).toBe(3); // 前提固定(n=5→軸3件)
    for (const call of calls) {
      expect(call.options).toEqual(options);
    }
  });

  it("中央・地方ワイド(単発リクエスト)にもoptionsがそのまま渡ること", async () => {
    const json = loadFixture("odds_wide_202603020211.json");
    const { fetcher, calls } = createFakeFetcher(() => json);
    const options: CachedFetchTextOptions = { maxAgeMs: 999 };

    await fetchComboOdds(CENTRAL_RACE_ID, "wide", [1], fetcher, options);

    expect(calls.length).toBe(1);
    expect(calls[0]!.options).toEqual(options);
  });
});

/**
 * 枠連(bracketQuinella)の取得(Issue #143・#26-D)。
 *
 * 枠連の期待組合せ数は頭数nではなく**枠の構成**で決まる: C(相異なる枠の数,2) +
 * (2頭以上いる枠の数)(`docs/wakuren-odds-investigation.md` §2.2)。そのため`fetchComboOdds`
 * (出走馬番を受け取る)とは別の関数`fetchBracketQuinellaOdds`(出走馬の枠番を受け取る)にした。
 * 枠の構成は既存テストと同じく`parseShutuba`/`parseRaceResult`の`wakuban`から作る
 * (オッズ側から逆算しない)。**配線(scrapeRace・app)は#146のスコープで、ここでは呼ばない。**
 */
describe("expectedBracketQuinellaComboCount(枠の構成からの期待組合せ数。Issue #143・#26-D)", () => {
  const table: ReadonlyArray<readonly [string, readonly number[], number]> = [
    ["馬なし", [], 0],
    ["1頭のみ(枠1)", [1], 0],
    ["同じ枠に2頭(同枠だけ)", [1, 1], 1],
    ["別々の2枠に1頭ずつ(同枠なし)", [1, 2], 1],
    ["枠1に2頭・枠2に1頭: C(2,2)=1 + 同枠1", [1, 1, 2], 2],
    ["8枠すべて1頭(8頭。同枠なし): C(8,2)=28", [1, 2, 3, 4, 5, 6, 7, 8], 28],
    ["8枠すべて2頭(16頭): 28+8", [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8], 36],
    ["3頭枠でも同枠キーは1つ(枠1に3頭・枠2に1頭): 1+1", [1, 1, 1, 2], 2],
  ];
  for (const [name, wakubans, expected] of table) {
    it(`${name} → ${expected}`, () => {
      expect(expectedBracketQuinellaComboCount(wakubans)).toBe(expected);
    });
  }
});

describe("fetchBracketQuinellaOdds(Issue #143・#26-D)", () => {
  const shutubaWakubans = (name: string) =>
    parseShutuba(loadFixture(name)).horses.map((h) => h.wakuban);
  const resultWakubans = (name: string) =>
    parseRaceResult(loadFixture(name)).horses.map((h) => h.wakuban as number);

  const CENTRAL_16 = parseRaceId("202603020211");
  const CENTRAL_10 = parseRaceId("202602010607");
  const CENTRAL_9 = parseRaceId("202607020501");
  const CENTRAL_7 = parseRaceId("202607020502");
  const NAR_12 = parseRaceId("202654071210");
  const NAR_9 = parseRaceId("202654092706");
  const NAR_8 = parseRaceId("202654092711");

  const central: ReadonlyArray<{
    readonly name: string;
    readonly raceId: ReturnType<typeof parseRaceId>;
    readonly odds: string;
    readonly wakubans: () => readonly number[];
    readonly expected: number;
  }> = [
    { name: "中央16頭", raceId: CENTRAL_16, odds: "odds_wakuren_202603020211.json", wakubans: () => shutubaWakubans("shutuba_202603020211.html"), expected: 36 },
    { name: "中央10頭", raceId: CENTRAL_10, odds: "odds_wakuren_202602010607.json", wakubans: () => shutubaWakubans("shutuba_202602010607.html"), expected: 30 },
    { name: "中央9頭", raceId: CENTRAL_9, odds: "odds_wakuren_202607020501.json", wakubans: () => resultWakubans("result_202607020501.html"), expected: 29 },
  ];
  for (const c of central) {
    it(`${c.name}: 1リクエストで枠連APIを叩き、expectedComboCount=${c.expected}・全件取得(missing=0)であること`, async () => {
      const { fetcher, calls } = createFakeFetcher(() => loadFixture(c.odds));
      const result = await fetchBracketQuinellaOdds(c.raceId, c.wakubans(), fetcher);
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe(bracketQuinellaOddsApiUrl(c.raceId));
      expect(result.state).toBe("available");
      expect(result.diagnostics.betType).toBe("bracketQuinella");
      expect(result.diagnostics.requestCount).toBe(1);
      expect(result.diagnostics.expectedComboCount).toBe(c.expected);
      expect(result.diagnostics.obtainedComboCount).toBe(c.expected);
      expect(result.diagnostics.missingComboCount).toBe(0);
      expect(result.diagnostics.axisUmabans).toEqual([]);
      expect(result.odds.size).toBe(c.expected);
    });
  }

  const nar: ReadonlyArray<{
    readonly name: string;
    readonly raceId: ReturnType<typeof parseRaceId>;
    readonly odds: string;
    readonly wakubans: () => readonly number[];
    readonly expected: number;
  }> = [
    { name: "地方12頭", raceId: NAR_12, odds: "nar_odds_b3_202654071210.html", wakubans: () => shutubaWakubans("nar_shutuba_202654071210.html"), expected: 32 },
    { name: "地方9頭", raceId: NAR_9, odds: "nar_odds_b3_202654092706.html", wakubans: () => resultWakubans("nar_result_202654092706.html"), expected: 29 },
  ];
  for (const c of nar) {
    it(`${c.name}: 1リクエストで枠連ページを叩き(軸馬別取得ではない)、expectedComboCount=${c.expected}・全件取得(missing=0)であること`, async () => {
      const { fetcher, calls } = createFakeFetcher(() => loadFixture(c.odds));
      const result = await fetchBracketQuinellaOdds(c.raceId, c.wakubans(), fetcher);
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe(narBracketQuinellaOddsPageUrl(c.raceId));
      expect(result.state).toBe("available");
      expect(result.diagnostics.requestCount).toBe(1);
      expect(result.diagnostics.expectedComboCount).toBe(c.expected);
      expect(result.diagnostics.missingComboCount).toBe(0);
      expect(result.odds.size).toBe(c.expected);
    });
  }

  it("中央の頭数不足(7頭。封筒NG): state=unavailable・attemptsが1件のunavailableであること(failedにならない)", async () => {
    const { fetcher } = createFakeFetcher(() => loadFixture("odds_wakuren_unsold_202607020502.json"));
    const result = await fetchBracketQuinellaOdds(
      CENTRAL_7,
      resultWakubans("result_202607020502.html"),
      fetcher,
    );
    expect(result.diagnostics.attempts.length).toBe(1);
    expect(result.diagnostics.attempts[0]!.state).toBe("unavailable");
    expect(result.state).toBe("unavailable");
    expect(result.odds.size).toBe(0);
  });

  it("地方の頭数不足(8頭。全28セルが0.0): state=unavailable(available・全null28組にならない)であること", async () => {
    const { fetcher } = createFakeFetcher(() => loadFixture("nar_odds_b3_unsold_202654092711.html"));
    const result = await fetchBracketQuinellaOdds(
      NAR_8,
      resultWakubans("nar_result_202654092711.html"),
      fetcher,
    );
    expect(result.diagnostics.attempts.length).toBe(1);
    expect(result.diagnostics.attempts[0]!.state).toBe("unavailable");
    expect(result.state).toBe("unavailable");
    expect(result.odds.size).toBe(0);
  });

  it("HTTP取得失敗はthrowせず state=failed(fetchFailed。unavailableに丸めない)であること", async () => {
    const { fetcher } = createFakeFetcher(() => new Error("接続失敗"));
    const result = await fetchBracketQuinellaOdds(CENTRAL_16, [1, 1, 2, 2], fetcher);
    expect(result.state).toBe("failed");
    expect(result.diagnostics.attempts[0]!.state).toBe("fetchFailed");
  });

  it("構造異常(パース例外)はthrowせず state=failed(parseError)であること", async () => {
    const bad = JSON.stringify({ status: "result", data: { odds: { "3": { "0109": ["5.5", "0.0", "2"] } } } });
    const { fetcher } = createFakeFetcher(() => bad);
    const result = await fetchBracketQuinellaOdds(CENTRAL_16, [1, 1, 2, 2], fetcher);
    expect(result.state).toBe("failed");
    expect(result.diagnostics.attempts[0]!.state).toBe("parseError");
  });

  it("optionsがそのままフェッチャに渡ること", async () => {
    const { fetcher, calls } = createFakeFetcher(() => loadFixture("odds_wakuren_202603020211.json"));
    const options: CachedFetchTextOptions = { maxAgeMs: 4321, bypassCache: true };
    await fetchBracketQuinellaOdds(CENTRAL_16, [1, 1, 2, 2], fetcher, options);
    expect(calls.length).toBe(1);
    expect(calls[0]!.options).toEqual(options);
  });

  describe("枠番の契約違反はHTTPを1回も発行せずthrowすること(こちら側のバグ。fail fast)", () => {
    const bad: ReadonlyArray<readonly [string, readonly number[]]> = [
      ["0", [0, 1]],
      ["9(枠番の上限超過)", [1, 9]],
      ["小数", [1.5, 2]],
      ["NaN", [Number.NaN, 2]],
    ];
    for (const [name, wakubans] of bad) {
      it(`枠番に${name}が混入`, async () => {
        const { fetcher, calls } = createFakeFetcher(() => "");
        await expect(fetchBracketQuinellaOdds(CENTRAL_16, wakubans, fetcher)).rejects.toThrow();
        expect(calls.length).toBe(0);
      });
    }
  });

  it("fetchComboOdds(出走馬番を受け取る汎用関数)にbracketQuinellaを渡すと、HTTPを発行せずthrowすること(中央・地方とも。頭数の意味が違うため fetchBracketQuinellaOdds を使わせる)", async () => {
    for (const raceId of [CENTRAL_16, NAR_12]) {
      const { fetcher, calls } = createFakeFetcher(() => "");
      await expect(
        fetchComboOdds(raceId, "bracketQuinella", [1, 2, 3, 4], fetcher),
      ).rejects.toThrow(/fetchBracketQuinellaOdds/);
      expect(calls.length).toBe(0);
    }
  });
});
