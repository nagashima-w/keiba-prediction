import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parseKaisaiDate, parseRaceId } from "../../packages/core/src/scraper/ids.js";
import { narRaceListSubUrl, raceListSubUrl, raceResultUrl } from "../../packages/core/src/scraper/urls.js";
import { parseFetchArgs, runFetch, type FetchOptions } from "../history-results/fetch-lib.js";
import { rawFilePath } from "../history-results/layout.js";

/**
 * Issue #532 段階 1: 取得(fetch)のテスト。ネットワークには出ない(偽の fetchText を差し込む)。
 */

const fx = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "history-results-"));
  dirs.push(d);
  return d;
};

const CAL_CENTRAL = "https://race.netkeiba.com/top/calendar.html?year=2021&month=11";
const CAL_NAR = "https://nar.netkeiba.com/top/calendar.html?year=2021&month=11";
const listUrl = (d: string, nar = false): string => (nar ? narRaceListSubUrl(parseKaisaiDate(d)) : raceListSubUrl(parseKaisaiDate(d)));
const resultUrl = (id: string): string => raceResultUrl(parseRaceId(id));

function mkCalendar(dates: string[]): string {
  const cells = dates
    .map((d) => `<td class="RaceCellBox"><a href="../top/race_list.html?kaisai_date=${d}" tile="" target="_blank">x</a></td>`)
    .join("");
  return `<html><div class="Race_Calendar_Main"><table class="Calendar_Table"><tbody><tr>${cells}</tr></tbody></table></div></html>`;
}

const RESULT_OK = `<html><table id="All_Result_Table"><thead><tr><th>着順</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></html>`;

/** 実物に倣った一覧の 1 件(距離を持たない項目は parseRaceList が捨てる)。 */
function mkList(items: { id: string; distance?: boolean; grade?: string }[]): string {
  const lis = items
    .map(
      (it) => `<li class="RaceList_DataItem ">
<a href="../race/result.html?race_id=${it.id}&rf=race_list" class="">
<div class="Race_Num Race_Fixed"><span>1R</span></div>
<div class="RaceList_ItemContent"><div class="RaceList_ItemTitle"><span class="ItemTitle">テスト</span>${
        it.grade ? `<span class="Icon_Grade_None_Text Icon_GradeType Icon_GradeType21 Icon_GradePos01">${it.grade}</span>` : ""
      }</div>
<div class="RaceData"><span>12:20</span><span class="Dart">${it.distance === false ? "" : "ダ1200m"}</span>12頭</div></div>
</a></li>`,
    )
    .join("");
  return `<div class="RaceList_Body"><dl class="RaceList_DataList"><dt><p class="RaceList_DataTitle"><small>1回</small>テスト場<small>1日目</small></p></dt><dd><ul>${lis}</ul></dd></dl></div>`;
}

type Route = string | Error;
function fakeSite(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchText = async (url: string): Promise<string> => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) throw new Error(`HTTPエラー(404): ${url}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetchText, routes };
}

const baseOpts = (outDir: string, fetchText: (u: string) => Promise<string>, over: Partial<FetchOptions> = {}): FetchOptions => ({
  from: "2021-11",
  to: "2021-11",
  outDir,
  kinds: ["central"],
  today: "20261029",
  fetchText,
  log: () => {},
  ...over,
});

const readGz = (p: string): string => gunzipSync(readFileSync(p)).toString("utf8");
const errorsOf = (outDir: string): Record<string, unknown>[] => {
  const p = path.join(outDir, "errors.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const CENTRAL_LIST = fx("history_central_list_20211107.html");
const NAR_LIST = fx("history_nar_list_20211103.html");

/** 中央の実物の一覧(36 件)から取れる race_id を、テスト自身が正規表現で数える(本体のコードを使わない)。 */
const CENTRAL_IDS = [...new Set([...CENTRAL_LIST.matchAll(/race_id=(\d{12})/g)].map((m) => m[1]!))];

function centralSite(extra: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    [CAL_CENTRAL]: mkCalendar(["20211107"]),
    [listUrl("20211107")]: CENTRAL_LIST,
    ...Object.fromEntries(CENTRAL_IDS.map((id) => [resultUrl(id), RESULT_OK])),
    ...extra,
  };
  return fakeSite(routes);
}

describe("fetch: 中央の流れ", () => {
  it("実物の一覧は 36 件・すべて中央の場コード", () => {
    expect(CENTRAL_IDS).toHaveLength(36);
    expect(CENTRAL_IDS.every((id) => /^2021(0[1-9]|10)/.test(id))).toBe(true);
  });

  it("カレンダー → 一覧 → 結果 の順に、中央のホストへ取りに行く", async () => {
    const out = tmp();
    const site = centralSite();
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls[0]).toBe(CAL_CENTRAL);
    expect(site.calls[1]).toBe(listUrl("20211107"));
    expect(site.calls.slice(2)).toEqual(CENTRAL_IDS.map(resultUrl));
    expect(site.calls.every((u) => u.startsWith("https://race.netkeiba.com/"))).toBe(true);
    expect(stats.requests).toBe(2 + 36);
    expect(stats.errors).toBe(0);
    expect(errorsOf(out)).toEqual([]);
  });

  it("取った HTML は gzip の UTF-8 で、置き場所は raw/{calendar,list,result}", async () => {
    const out = tmp();
    const site = centralSite();
    await runFetch(baseOpts(out, site.fetchText));
    expect(readGz(rawFilePath(out, "central", "calendar", "2021-11"))).toContain("Calendar_Table");
    expect(rawFilePath(out, "central", "calendar", "2021-11")).toBe(path.join(out, "raw", "calendar", "2021-11.html.gz"));
    expect(rawFilePath(out, "central", "list", "20211107")).toBe(path.join(out, "raw", "list", "20211107.html.gz"));
    expect(readGz(rawFilePath(out, "central", "list", "20211107"))).toBe(CENTRAL_LIST);
    expect(readGz(rawFilePath(out, "central", "result", CENTRAL_IDS[0]!))).toBe(RESULT_OK);
    expect(readdirSync(path.join(out, "raw", "result"))).toHaveLength(36);
  });

  it("すでにある raw は取りに行かない(途中から再実行できる)", async () => {
    const out = tmp();
    const site1 = centralSite();
    await runFetch(baseOpts(out, site1.fetchText, { limit: 10 }));
    expect(site1.calls).toHaveLength(10);
    const site2 = centralSite();
    const stats = await runFetch(baseOpts(out, site2.fetchText));
    // 1 回目に取ったカレンダー・一覧・結果 8 件は取り直さない。残りの結果 28 件だけ
    expect(site2.calls).toEqual(CENTRAL_IDS.slice(8).map(resultUrl));
    expect(stats.requests).toBe(28);
    expect(stats.skippedExisting.result).toBe(8);
    expect(stats.skippedExisting.calendar).toBe(1);
    expect(stats.skippedExisting.list).toBe(1);
    expect(readdirSync(path.join(out, "raw", "result"))).toHaveLength(36);
  });

  it("--limit は新しく取ったリクエストの数(スキップは数えない)", async () => {
    const out = tmp();
    const site = centralSite();
    const stats = await runFetch(baseOpts(out, site.fetchText, { limit: 5 }));
    expect(site.calls).toHaveLength(5);
    expect(stats.requests).toBe(5);
    expect(stats.limitReached).toBe(true);
    const stats2 = await runFetch(baseOpts(out, centralSite().fetchText, { limit: 5 }));
    expect(stats2.requests).toBe(5);
    expect(readdirSync(path.join(out, "raw", "result"))).toHaveLength(3 + 5);
  });
});

describe("fetch: 失敗は保存せず errors.ndjson に残し、再実行でもう一度試す", () => {
  it("0 バイト・HTTP エラー・表の無いページ・文字化けは保存しない", async () => {
    const out = tmp();
    const [a, b, c, d] = CENTRAL_IDS;
    const site = centralSite({
      [resultUrl(a!)]: "",
      [resultUrl(b!)]: new Error("HTTPエラー(500): x"),
      [resultUrl(c!)]: "<html>no table</html>",
      [resultUrl(d!)]: RESULT_OK.replace("1</td>", "�</td>"),
    });
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(stats.errors).toBe(4);
    for (const id of [a!, b!, c!, d!]) {
      expect(existsSync(rawFilePath(out, "central", "result", id))).toBe(false);
    }
    expect(readdirSync(path.join(out, "raw", "result"))).toHaveLength(32);
    const errs = errorsOf(out);
    expect(errs).toHaveLength(4);
    expect(errs.map((e) => [e.stage, e.id])).toEqual([a, b, c, d].map((id) => ["result", id]));
    expect(errs.map((e) => e.reason)).toEqual([
      expect.stringContaining("0 バイト"),
      expect.stringContaining("HTTPエラー(500)"),
      expect.stringContaining("結果の表"),
      expect.stringContaining("文字化け"),
    ]);
    expect(errs.every((e) => e.kind === "central" && typeof e.url === "string" && typeof e.at === "string")).toBe(true);

    // 直して再実行すると、取れなかった 4 件だけをもう一度試す
    const site2 = centralSite();
    const stats2 = await runFetch(baseOpts(out, site2.fetchText));
    expect(site2.calls).toEqual([a, b, c, d].map((id) => resultUrl(id!)));
    expect(stats2.errors).toBe(0);
    expect(readdirSync(path.join(out, "raw", "result"))).toHaveLength(36);
  });

  it("一時ファイルが残らない(失敗時も、成功時も)", async () => {
    const out = tmp();
    const site = centralSite({ [resultUrl(CENTRAL_IDS[0]!)]: "" });
    await runFetch(baseOpts(out, site.fetchText));
    for (const sub of ["calendar", "list", "result"]) {
      expect(readdirSync(path.join(out, "raw", sub)).every((f) => f.endsWith(".html.gz"))).toBe(true);
    }
  });

  it("カレンダーが 0 バイトの月は保存せず errors に残し、その月の取得は飛ばして次の月へ進む", async () => {
    const out = tmp();
    const cal12 = "https://race.netkeiba.com/top/calendar.html?year=2021&month=12";
    const site = fakeSite({
      [CAL_CENTRAL]: "",
      [cal12]: mkCalendar(["20211205"]),
      [listUrl("20211205")]: mkList([{ id: "202106050101" }]),
      [resultUrl("202106050101")]: RESULT_OK,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText, { to: "2021-12" }));
    expect(existsSync(rawFilePath(out, "central", "calendar", "2021-11"))).toBe(false);
    expect(existsSync(rawFilePath(out, "central", "result", "202106050101"))).toBe(true);
    expect(stats.errors).toBe(1);
    expect(errorsOf(out)[0]).toMatchObject({ stage: "calendar", id: "2021-11" });
  });

  it("一覧のコンテナが無いページは保存せず errors、コンテナがありレースが 0 件のページは保存して errors にしない", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211106", "20211107"]),
      [listUrl("20211106")]: "<html>なにもない</html>",
      [listUrl("20211107")]: `<div class="RaceList_Body"></div>`,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(existsSync(rawFilePath(out, "central", "list", "20211106"))).toBe(false);
    expect(existsSync(rawFilePath(out, "central", "list", "20211107"))).toBe(true);
    expect(errorsOf(out)).toHaveLength(1);
    expect(errorsOf(out)[0]).toMatchObject({ stage: "list", id: "20211106" });
    expect(stats.emptyLists).toBe(1);
  });
});

describe("fetch: 中央以外の race_id は取らない・未来日は取らない", () => {
  it("中央の一覧にあっても、場コードが 01〜10 でない race_id は結果を取りに行かない", async () => {
    const out = tmp();
    const ids = ["202105050201", "202144100810", "202165071311", "202130110301"];
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList(ids.map((id) => ({ id }))),
      [resultUrl("202105050201")]: RESULT_OK,
    });
    await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls.filter((u) => u.includes("result.html"))).toEqual([resultUrl("202105050201")]);
  });

  it("今日より後の開催日は一覧も取らず、errors にもしない(件数だけ数える)", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211106", "20211107"]),
      [listUrl("20211106")]: mkList([]),
    });
    const stats = await runFetch(baseOpts(out, site.fetchText, { today: "20211106" }));
    expect(site.calls).toEqual([CAL_CENTRAL, listUrl("20211106")]);
    expect(stats.skippedFuture).toBe(1);
    expect(errorsOf(out)).toEqual([]);
  });

  it("カレンダーにある月外の日付は無視する", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211031", "20211107"]),
      [listUrl("20211107")]: mkList([]),
    });
    await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls).toEqual([CAL_CENTRAL, listUrl("20211107")]);
  });

  it("一覧の解析から漏れる項目(距離なし)も、中央では結果を取りに行く(和集合)", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList([{ id: "202105050201" }, { id: "202105050202", distance: false }]),
      [resultUrl("202105050201")]: RESULT_OK,
      [resultUrl("202105050202")]: RESULT_OK,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls.filter((u) => u.includes("result.html"))).toEqual([resultUrl("202105050201"), resultUrl("202105050202")]);
    expect(stats.errors).toBe(0);
  });
});

describe("fetch: 地方は交流重賞(Jpn)だけ", () => {
  function narSite(extra: Record<string, Route> = {}) {
    return fakeSite({
      [CAL_NAR]: mkCalendar(["20211103"]),
      [listUrl("20211103", true)]: NAR_LIST,
      ...Object.fromEntries(
        ["202130110305", "202146110308", "202146110309", "202146110310"].map((id) => [resultUrl(id), RESULT_OK]),
      ),
      ...extra,
    });
  }
  const narOpts = (out: string, fetchText: (u: string) => Promise<string>, over: Partial<FetchOptions> = {}) =>
    baseOpts(out, fetchText, { kinds: ["nar"], ...over });

  it("実物の一覧は 40 件・うち Jpn の 4 件だけ結果を取る(地方のホスト)", async () => {
    const out = tmp();
    const all = [...new Set([...NAR_LIST.matchAll(/race_id=(\d{12})/g)].map((m) => m[1]!))];
    expect(all).toHaveLength(40);
    const site = narSite();
    const stats = await runFetch(narOpts(out, site.fetchText));
    expect(site.calls).toEqual([
      CAL_NAR,
      listUrl("20211103", true),
      resultUrl("202130110305"),
      resultUrl("202146110308"),
      resultUrl("202146110309"),
      resultUrl("202146110310"),
    ]);
    expect(site.calls.every((u) => u.startsWith("https://nar.netkeiba.com/"))).toBe(true);
    // Jpn でない 36 件(OP・重賞・一般戦)の結果は取っていない
    expect(readdirSync(path.join(out, "raw", "nar", "result")).sort()).toEqual([
      "202130110305.html.gz",
      "202146110308.html.gz",
      "202146110309.html.gz",
      "202146110310.html.gz",
    ]);
    expect(stats.errors).toBe(0);
  });

  it("raw の置き場所は中央と分かれる(raw/nar/…)", async () => {
    const out = tmp();
    await runFetch(narOpts(out, narSite().fetchText));
    expect(existsSync(path.join(out, "raw", "nar", "calendar", "2021-11.html.gz"))).toBe(true);
    expect(existsSync(path.join(out, "raw", "nar", "list", "20211103.html.gz"))).toBe(true);
    expect(existsSync(path.join(out, "raw", "calendar"))).toBe(false);
  });

  it("グレードが Jpn でない(重賞・L・OP・グレード無し)項目は、距離があっても取らない", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_NAR]: mkCalendar(["20211103"]),
      [listUrl("20211103", true)]: mkList([
        { id: "202144110301" },
        { id: "202144110302", grade: "重賞" },
        { id: "202144110303", grade: "L" },
        { id: "202144110304", grade: "Jpn2" },
        { id: "202144110305", grade: "Jpn3" },
      ]),
      [resultUrl("202144110304")]: RESULT_OK,
      [resultUrl("202144110305")]: RESULT_OK,
    });
    await runFetch(narOpts(out, site.fetchText));
    expect(site.calls.filter((u) => u.includes("result.html"))).toEqual([resultUrl("202144110304"), resultUrl("202144110305")]);
  });

  it("一覧の解析から漏れた項目(距離なし)は Jpn か判定できないので取らず、errors(list-unparsed)に残す。ばんえい(65)は数えない", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_NAR]: mkCalendar(["20211103"]),
      [listUrl("20211103", true)]: mkList([
        { id: "202144110301", grade: "Jpn1" },
        { id: "202144110302", distance: false, grade: "Jpn1" },
        { id: "202165110303" },
      ]),
      [resultUrl("202144110301")]: RESULT_OK,
    });
    await runFetch(narOpts(out, site.fetchText));
    expect(site.calls.filter((u) => u.includes("result.html"))).toEqual([resultUrl("202144110301")]);
    const errs = errorsOf(out);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ kind: "nar", stage: "list-unparsed", id: "202144110302" });
  });

  it("中央と地方を両方指定すると、それぞれ自分の raw に入る", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList([{ id: "202105050201" }]),
      [resultUrl("202105050201")]: RESULT_OK,
      [CAL_NAR]: mkCalendar(["20211103"]),
      [listUrl("20211103", true)]: NAR_LIST,
      [resultUrl("202146110310")]: RESULT_OK,
      [resultUrl("202130110305")]: RESULT_OK,
      [resultUrl("202146110308")]: RESULT_OK,
      [resultUrl("202146110309")]: RESULT_OK,
    });
    await runFetch(baseOpts(out, site.fetchText, { kinds: ["central", "nar"] }));
    expect(existsSync(rawFilePath(out, "central", "result", "202105050201"))).toBe(true);
    expect(existsSync(rawFilePath(out, "nar", "result", "202146110310"))).toBe(true);
    expect(existsSync(rawFilePath(out, "central", "result", "202146110310"))).toBe(false);
  });
});

describe("fetch: 進捗の出力", () => {
  it("取得した件数・残り・エラー数を出す", async () => {
    const out = tmp();
    const lines: string[] = [];
    const site = centralSite({ [resultUrl(CENTRAL_IDS[0]!)]: "" });
    await runFetch(baseOpts(out, site.fetchText, { log: (m) => lines.push(m) }));
    const joined = lines.join("\n");
    expect(joined).toContain("20211107");
    // 25 件目のリクエスト(カレンダーと一覧の 2 件のあとの 23 件目の結果)で途中経過が出る(この日の残り)。最後の行にはエラー数が出る。
    expect(joined).toMatch(/結果 23\/36\(この日の残り 13\)/);
    expect(joined).toContain("結果 36 件: 取得済み 0・今回保存 35・失敗 1");
    expect(lines[lines.length - 1]).toMatch(/未来日 0.*エラー 1$/);
  });
});

describe("fetch: すでにある壊れていない raw を尊重する", () => {
  it("手で置いた raw(カレンダー・一覧)があれば、それを使って結果だけ取る", async () => {
    const out = tmp();
    mkdirSync(path.join(out, "raw", "calendar"), { recursive: true });
    mkdirSync(path.join(out, "raw", "list"), { recursive: true });
    writeFileSync(rawFilePath(out, "central", "calendar", "2021-11"), gzipSync(mkCalendar(["20211107"])));
    writeFileSync(rawFilePath(out, "central", "list", "20211107"), gzipSync(CENTRAL_LIST));
    const site = centralSite();
    await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls).toEqual(CENTRAL_IDS.map(resultUrl));
  });
});

describe("parseFetchArgs", () => {
  it("--from/--to/--out/--limit と種別の指定", () => {
    expect(parseFetchArgs(["--from", "2021-11", "--to", "2026-10", "--out", "/x", "--limit", "5"])).toEqual({
      ok: true,
      value: { from: "2021-11", to: "2026-10", outDir: "/x", kinds: ["central", "nar"], limit: 5 },
    });
    expect(parseFetchArgs(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--central"])).toMatchObject({
      ok: true,
      value: { kinds: ["central"] },
    });
    expect(parseFetchArgs(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--nar-jpn"])).toMatchObject({
      ok: true,
      value: { kinds: ["nar"] },
    });
    expect(parseFetchArgs(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--central", "--nar-jpn"])).toMatchObject({
      ok: true,
      value: { kinds: ["central", "nar"] },
    });
  });

  it("--out が無い・月の形が違う・from が to より後・limit が正の整数でない は拒否する", () => {
    const bad = (a: string[]) => expect(parseFetchArgs(a).ok).toBe(false);
    bad(["--from", "2021-11", "--to", "2021-11"]);
    bad(["--from", "2021-13", "--to", "2021-11", "--out", "/x"]);
    bad(["--from", "202111", "--to", "2021-11", "--out", "/x"]);
    bad(["--from", "2021-12", "--to", "2021-11", "--out", "/x"]);
    bad(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--limit", "0"]);
    bad(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--limit", "abc"]);
    bad(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--unknown"]);
  });
});
