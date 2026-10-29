import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { HttpError } from "../../packages/core/src/scraper/http-client.js";
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

const RESULT_OK = `<html><div class="RaceData02"><span>1頭</span></div><table id="All_Result_Table"><thead><tr><th>着順</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table></html>`;

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

  it("一覧のコンテナが無いページは保存せず errors に残す", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211106"]),
      [listUrl("20211106")]: "<html>なにもない</html>",
    });
    await runFetch(baseOpts(out, site.fetchText));
    expect(existsSync(rawFilePath(out, "central", "list", "20211106"))).toBe(false);
    expect(errorsOf(out)).toHaveLength(1);
    expect(errorsOf(out)[0]).toMatchObject({ stage: "list", id: "20211106" });
  });

  it("中央の一覧に race_id が 0 件のとき(カレンダーには開催日しか載らないので異常)は保存せず errors に残し、再実行で取り直す", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: `<div class="RaceList_Body"></div>`,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(existsSync(rawFilePath(out, "central", "list", "20211107"))).toBe(false);
    expect(stats.errors).toBe(1);
    expect(errorsOf(out)[0]).toMatchObject({ kind: "central", stage: "list", id: "20211107" });
    expect(String(errorsOf(out)[0]!.reason)).toContain("0 件");
    // 再実行で取り直す(カレンダーは過去の月なので使い回し、一覧だけもう一度取る)
    const site2 = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList([{ id: "202105050201" }]),
      [resultUrl("202105050201")]: RESULT_OK,
    });
    await runFetch(baseOpts(out, site2.fetchText));
    expect(site2.calls).toEqual([listUrl("20211107"), resultUrl("202105050201")]);
    expect(existsSync(rawFilePath(out, "central", "list", "20211107"))).toBe(true);
  });

  it("中央の保存済みの一覧が 0 件だった場合も(古い実行の名残)、結果は取らず errors に残す", async () => {
    const out = tmp();
    mkdirSync(path.join(out, "raw", "list"), { recursive: true });
    writeFileSync(rawFilePath(out, "central", "list", "20211107"), gzipSync(`<div class="RaceList_Body"></div>`));
    const site = fakeSite({ [CAL_CENTRAL]: mkCalendar(["20211107"]) });
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls).toEqual([CAL_CENTRAL]);
    expect(stats.errors).toBe(1);
    expect(errorsOf(out)[0]).toMatchObject({ stage: "list", id: "20211107" });
  });

  it("地方の一覧が 0 件のページは保存して errors にしない(件数を数え、日付をログに出す)", async () => {
    const out = tmp();
    const lines: string[] = [];
    const site = fakeSite({
      [CAL_NAR]: mkCalendar(["20211104"]),
      [listUrl("20211104", true)]: `<div class="RaceList_Body"></div>`,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText, { kinds: ["nar"], log: (m) => lines.push(m) }));
    expect(existsSync(rawFilePath(out, "nar", "list", "20211104"))).toBe(true);
    expect(stats.errors).toBe(0);
    expect(stats.emptyLists).toBe(1);
    expect(lines.some((l) => l.includes("[nar 20211104]") && l.includes("レース 0 件"))).toBe(true);
  });
});

describe("fetch: 結果は頭数と行数が合うものだけ保存する(途中の結果を確定として保存しない)", () => {
  const oneRace = (resultBody: string) =>
    fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList([{ id: "202105050201" }]),
      [resultUrl("202105050201")]: resultBody,
    });

  it("実物の途中のページ(15 頭中 3 行)は保存せず errors に残す", async () => {
    const out = tmp();
    const partial = fx("nar_result_partial_202644100810.html");
    const stats = await runFetch(baseOpts(out, oneRace(partial).fetchText));
    expect(existsSync(rawFilePath(out, "central", "result", "202105050201"))).toBe(false);
    expect(stats.errors).toBe(1);
    expect(errorsOf(out)[0]).toMatchObject({ stage: "result", id: "202105050201" });
    expect(String(errorsOf(out)[0]!.reason)).toMatch(/頭数 15.*行 3|行数 3.*頭数 15/);
  });

  it("頭数が読めないページは保存しない", async () => {
    const out = tmp();
    const stats = await runFetch(baseOpts(out, oneRace(RESULT_OK.replace("<span>1頭</span>", "")).fetchText));
    expect(existsSync(rawFilePath(out, "central", "result", "202105050201"))).toBe(false);
    expect(stats.errors).toBe(1);
    expect(String(errorsOf(out)[0]!.reason)).toContain("頭数が読めません");
  });

  it("実物の発売前のページ(表に行なし)は保存しない", async () => {
    const out = tmp();
    const stats = await runFetch(baseOpts(out, oneRace(fx("nar_result_presale_202642071612.html")).fetchText));
    expect(existsSync(rawFilePath(out, "central", "result", "202105050201"))).toBe(false);
    expect(stats.errors).toBe(1);
  });

  it("実物の全頭そろったページ(15 頭 15 行)・取消や除外を含むページ(行に数えられる)は保存する", async () => {
    for (const name of ["nar_result_202644100810.html", "result_202606040901.html", "result_202605040205.html"]) {
      const out = tmp();
      const stats = await runFetch(baseOpts(out, oneRace(fx(name)).fetchText));
      expect(stats.errors, name).toBe(0);
      expect(existsSync(rawFilePath(out, "central", "result", "202105050201")), name).toBe(true);
    }
  });
});

describe("fetch: 今日以降の開催日・今月以降のカレンダー", () => {
  it("今日の開催日は取らない(途中のページを確定として保存しない)。件数だけ数える", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211106", "20211107", "20211113"]),
      [listUrl("20211106")]: mkList([{ id: "202105050101" }]),
      [resultUrl("202105050101")]: RESULT_OK,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText, { today: "20211107" }));
    expect(site.calls).toEqual([CAL_CENTRAL, listUrl("20211106"), resultUrl("202105050101")]);
    expect(stats.skippedFuture).toBe(2);
    expect(errorsOf(out)).toEqual([]);
  });

  it("今月(today の月)以降のカレンダーは、raw があっても毎回取り直して上書きする", async () => {
    const out = tmp();
    mkdirSync(path.join(out, "raw", "calendar"), { recursive: true });
    writeFileSync(rawFilePath(out, "central", "calendar", "2021-11"), gzipSync(mkCalendar(["20211101"])));
    const fresh = mkCalendar(["20211102"]);
    const site = fakeSite({
      [CAL_CENTRAL]: fresh,
      [listUrl("20211102")]: mkList([{ id: "202105050101" }]),
      [resultUrl("202105050101")]: RESULT_OK,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText, { today: "20211110" }));
    expect(site.calls).toEqual([CAL_CENTRAL, listUrl("20211102"), resultUrl("202105050101")]);
    expect(readGz(rawFilePath(out, "central", "calendar", "2021-11"))).toBe(fresh);
    expect(stats.skippedExisting.calendar).toBe(0);
  });

  it("取り直しに失敗した今月のカレンダーは、古い raw を消さず errors に残して、その月は飛ばす", async () => {
    const out = tmp();
    mkdirSync(path.join(out, "raw", "calendar"), { recursive: true });
    const old = mkCalendar(["20211101"]);
    writeFileSync(rawFilePath(out, "central", "calendar", "2021-11"), gzipSync(old));
    const site = fakeSite({ [CAL_CENTRAL]: new Error("HTTPエラー(503): x") });
    const stats = await runFetch(baseOpts(out, site.fetchText, { today: "20211110" }));
    expect(readGz(rawFilePath(out, "central", "calendar", "2021-11"))).toBe(old);
    expect(site.calls).toEqual([CAL_CENTRAL]);
    expect(stats.errors).toBe(1);
  });

  it("過去の月のカレンダーは従来どおり使い回す(月が today の月より前)", async () => {
    const out = tmp();
    mkdirSync(path.join(out, "raw", "calendar"), { recursive: true });
    writeFileSync(rawFilePath(out, "central", "calendar", "2021-11"), gzipSync(mkCalendar(["20211101"])));
    const site = fakeSite({
      [listUrl("20211101")]: mkList([{ id: "202105050101" }]),
      [resultUrl("202105050101")]: RESULT_OK,
    });
    await runFetch(baseOpts(out, site.fetchText, { today: "20211201" }));
    expect(site.calls).toEqual([listUrl("20211101"), resultUrl("202105050101")]);
  });
});

describe("fetch: 新しい順にたどる(--newest-first)", () => {
  it("月は新しい順、月の中の開催日も新しい順。カレンダー → 一覧 → 結果の順は同じ", async () => {
    const out = tmp();
    const cal12 = "https://race.netkeiba.com/top/calendar.html?year=2021&month=12";
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211106", "20211107"]),
      [cal12]: mkCalendar(["20211204", "20211205"]),
      [listUrl("20211106")]: mkList([{ id: "202105050101" }]),
      [listUrl("20211107")]: mkList([{ id: "202105050201" }]),
      [listUrl("20211204")]: mkList([{ id: "202105050301" }]),
      [listUrl("20211205")]: mkList([{ id: "202105050401" }]),
      [resultUrl("202105050101")]: RESULT_OK,
      [resultUrl("202105050201")]: RESULT_OK,
      [resultUrl("202105050301")]: RESULT_OK,
      [resultUrl("202105050401")]: RESULT_OK,
    });
    await runFetch(baseOpts(out, site.fetchText, { to: "2021-12", newestFirst: true }));
    expect(site.calls).toEqual([
      cal12,
      listUrl("20211205"),
      resultUrl("202105050401"),
      listUrl("20211204"),
      resultUrl("202105050301"),
      CAL_CENTRAL,
      listUrl("20211107"),
      resultUrl("202105050201"),
      listUrl("20211106"),
      resultUrl("202105050101"),
    ]);
  });

  it("指定しなければ古い順のまま", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211106", "20211107"]),
      [listUrl("20211106")]: mkList([{ id: "202105050101" }]),
      [listUrl("20211107")]: mkList([{ id: "202105050201" }]),
      [resultUrl("202105050101")]: RESULT_OK,
      [resultUrl("202105050201")]: RESULT_OK,
    });
    await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls.filter((u) => u.includes("race_list_sub"))).toEqual([listUrl("20211106"), listUrl("20211107")]);
  });
});

describe("fetch: アクセスを制限されたらその場で打ち切る(HTTP 400・403・429)", () => {
  const httpErr = (status: number, url: string) => new HttpError(`HTTPエラー(${status})が発生しました: ${url}`, { url, status });

  for (const status of [400, 403, 429]) {
    it(`HTTP ${status} は 1 件目でも打ち切り、errors に残し、終了コード用の aborted と restricted を立てる`, async () => {
      const out = tmp();
      const lines: string[] = [];
      const site = fakeSite({ [CAL_CENTRAL]: httpErr(status, CAL_CENTRAL) });
      const stats = await runFetch(baseOpts(out, site.fetchText, { log: (m) => lines.push(m) }));
      expect(stats.aborted).toBe(true);
      expect(stats.restricted).toBe(true);
      expect(stats.requests).toBe(1);
      expect(stats.errors).toBe(1);
      expect(errorsOf(out)[0]).toMatchObject({ stage: "calendar", id: "2021-11" });
      expect(String(errorsOf(out)[0]!.reason)).toContain(`HTTPエラー(${status})`);
      expect(lines.join("\n")).toMatch(new RegExp(`アクセスを制限された可能性.*直近の失敗: .*HTTP ${status}`));
    });
  }

  it("結果ページの途中で 400 が返ったら、そこで止まり、あとの結果は取りに行かない(取れた分は残る)", async () => {
    const out = tmp();
    const ids = ["202105050101", "202105050102", "202105050103"];
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList(ids.map((id) => ({ id }))),
      [resultUrl(ids[0]!)]: RESULT_OK,
      [resultUrl(ids[1]!)]: httpErr(400, resultUrl(ids[1]!)),
      [resultUrl(ids[2]!)]: RESULT_OK,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(stats.restricted).toBe(true);
    expect(site.calls.filter((u) => u.includes("result.html"))).toEqual([resultUrl(ids[0]!), resultUrl(ids[1]!)]);
    expect(existsSync(rawFilePath(out, "central", "result", ids[0]!))).toBe(true);
    expect(existsSync(rawFilePath(out, "central", "result", ids[2]!))).toBe(false);
    // 再実行(制限が解けた)で続きから
    const site2 = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [resultUrl(ids[1]!)]: RESULT_OK,
      [resultUrl(ids[2]!)]: RESULT_OK,
    });
    const stats2 = await runFetch(baseOpts(out, site2.fetchText));
    expect(stats2.aborted).toBe(false);
    expect(site2.calls).toEqual([resultUrl(ids[1]!), resultUrl(ids[2]!)]);
  });

  it("404 や 5xx は制限とみなさず、従来どおり連続失敗の数え方(上限まで続ける)", async () => {
    const out = tmp();
    const ids = ["202105050101", "202105050102", "202105050103"];
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList(ids.map((id) => ({ id }))),
      [resultUrl(ids[0]!)]: httpErr(404, resultUrl(ids[0]!)),
      [resultUrl(ids[1]!)]: httpErr(503, resultUrl(ids[1]!)),
      [resultUrl(ids[2]!)]: RESULT_OK,
    });
    const stats = await runFetch(baseOpts(out, site.fetchText));
    expect(stats.aborted).toBe(false);
    expect(stats.restricted).toBe(false);
    expect(stats.errors).toBe(2);
    expect(stats.saved.result).toBe(1);
  });
});

describe("fetch: 取得の失敗が続いたら打ち切る(アクセス制限のときに叩き続けない)", () => {
  const dates30 = Array.from({ length: 30 }, (_, i) => `202111${String(i + 1).padStart(2, "0")}`);

  it("連続 20 件の失敗で打ち切り、理由をログに出す。再実行で続きから取る", async () => {
    const out = tmp();
    const lines: string[] = [];
    // カレンダーは取れるが、一覧がすべて 503
    const down = fakeSite({
      [CAL_CENTRAL]: mkCalendar(dates30),
      ...Object.fromEntries(dates30.map((d) => [listUrl(d), new Error(`HTTPエラー(503): ${listUrl(d)}`)])),
    });
    const stats = await runFetch(baseOpts(out, down.fetchText, { log: (m) => lines.push(m) }));
    expect(stats.aborted).toBe(true);
    expect(stats.errors).toBe(20);
    expect(stats.requests).toBe(1 + 20);
    expect(down.calls).toHaveLength(21);
    expect(lines.join("\n")).toMatch(/連続 20 件.*打ち切/);
    expect(lines.join("\n")).toContain("HTTPエラー(503)");
    // 復旧後の再実行は、カレンダーを使い回して続きから(取れた一覧はまだ無いので 1 日目から)
    const up = fakeSite({
      ...Object.fromEntries(dates30.map((d) => [listUrl(d), mkList([{ id: "202105050101" }])])),
      [resultUrl("202105050101")]: RESULT_OK,
    });
    const stats2 = await runFetch(baseOpts(out, up.fetchText));
    expect(stats2.aborted).toBe(false);
    expect(up.calls[0]).toBe(listUrl("20211101"));
    expect(stats2.saved.list).toBe(30);
  });

  it("成功が 1 件あれば数え直す(失敗 2・成功 1・失敗 2 は、上限 3 では止まらない)", async () => {
    const out = tmp();
    const ids = ["202105050101", "202105050102", "202105050103", "202105050104", "202105050105"];
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList(ids.map((id) => ({ id }))),
      [resultUrl(ids[0]!)]: new Error("HTTPエラー(500): x"),
      [resultUrl(ids[1]!)]: new Error("HTTPエラー(500): x"),
      [resultUrl(ids[2]!)]: RESULT_OK,
      [resultUrl(ids[3]!)]: new Error("HTTPエラー(500): x"),
      [resultUrl(ids[4]!)]: new Error("HTTPエラー(500): x"),
    });
    const stats = await runFetch(baseOpts(out, site.fetchText, { maxConsecutiveFailures: 3 }));
    expect(stats.aborted).toBe(false);
    expect(stats.errors).toBe(4);
    expect(stats.saved.result).toBe(1);
  });

  it("保存前の検査の不合格(0 バイト)も失敗として数える。上限に達したら残りは取らない", async () => {
    const out = tmp();
    const ids = ["202105050101", "202105050102", "202105050103", "202105050104"];
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211107"]),
      [listUrl("20211107")]: mkList(ids.map((id) => ({ id }))),
      ...Object.fromEntries(ids.map((id) => [resultUrl(id), ""])),
    });
    const stats = await runFetch(baseOpts(out, site.fetchText, { maxConsecutiveFailures: 3 }));
    expect(stats.aborted).toBe(true);
    expect(site.calls.filter((u) => u.includes("result.html"))).toHaveLength(3);
  });
});

describe("fetch: 中央以外の race_id は取らない", () => {
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

  it("カレンダーにある月外の日付は無視する", async () => {
    const out = tmp();
    const site = fakeSite({
      [CAL_CENTRAL]: mkCalendar(["20211031", "20211107"]),
      [listUrl("20211107")]: mkList([{ id: "202105050201" }]),
      [resultUrl("202105050201")]: RESULT_OK,
    });
    await runFetch(baseOpts(out, site.fetchText));
    expect(site.calls).toEqual([CAL_CENTRAL, listUrl("20211107"), resultUrl("202105050201")]);
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

  it("地方の一覧で見えたグレード表記の種類と件数を、月の終わりと終了時にログへ出す(Jpn の表記ゆれに気づけるように)", async () => {
    const out = tmp();
    const lines: string[] = [];
    const stats = await runFetch(narOpts(out, narSite().fetchText, { log: (m) => lines.push(m) }));
    // 実物の一覧 40 件の内訳(cheerio で別に数えた値): グレード表記なし 35・Jpn1 3・Jpn3 1・OP 1
    expect(stats.gradeCounts).toEqual({ "(なし)": 35, Jpn1: 3, Jpn3: 1, OP: 1 });
    const monthLine = lines.find((l) => l.startsWith("[nar 2021-11] グレード表記"));
    expect(monthLine).toBe("[nar 2021-11] グレード表記の件数: (なし) 35・Jpn1 3・Jpn3 1・OP 1");
    expect(lines[lines.length - 1]).toContain("地方のグレード表記: (なし) 35・Jpn1 3・Jpn3 1・OP 1");
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
    expect(lines[lines.length - 1]).toMatch(/今日以降の開催日 0.*エラー 1$/);
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
      value: { from: "2021-11", to: "2026-10", outDir: "/x", kinds: ["central", "nar"], limit: 5, intervalMs: 10000, newestFirst: false },
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

  it("--interval-ms で最低間隔を指定できる(既定 10000、1500 未満・整数でない値は拒否)", () => {
    const base = ["--from", "2021-11", "--to", "2021-11", "--out", "/x"];
    expect(parseFetchArgs(base)).toMatchObject({ ok: true, value: { intervalMs: 10000 } });
    expect(parseFetchArgs([...base, "--interval-ms", "1500"])).toMatchObject({ ok: true, value: { intervalMs: 1500 } });
    expect(parseFetchArgs([...base, "--interval-ms", "3000"])).toMatchObject({ ok: true, value: { intervalMs: 3000 } });
    for (const bad of ["1499", "0", "abc", "1500.5", ""]) {
      expect(parseFetchArgs([...base, "--interval-ms", bad]).ok, bad).toBe(false);
    }
    expect(parseFetchArgs([...base, "--interval-ms"]).ok).toBe(false);
  });

  it("--newest-first を指定できる", () => {
    const base = ["--from", "2021-11", "--to", "2021-11", "--out", "/x"];
    expect(parseFetchArgs([...base, "--newest-first"])).toMatchObject({ ok: true, value: { newestFirst: true } });
    expect(parseFetchArgs(base)).toMatchObject({ ok: true, value: { newestFirst: false } });
  });

  it("--max-consecutive-failures で連続失敗の上限を変えられる", () => {
    expect(parseFetchArgs(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--max-consecutive-failures", "50"])).toMatchObject({
      ok: true,
      value: { maxConsecutiveFailures: 50 },
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
    bad(["--from", "2021-11", "--to", "2021-11", "--out", "/x", "--max-consecutive-failures", "0"]);
  });
});
