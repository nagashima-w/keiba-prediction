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
  fetchComboOdds,
  type ComboOddsFetcher,
} from "../../src/scraper/fetch-combo-odds.js";
import { parseRaceId } from "../../src/scraper/ids.js";
import {
  narTrioOddsAxisUrl,
  narWideOddsPageUrl,
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
