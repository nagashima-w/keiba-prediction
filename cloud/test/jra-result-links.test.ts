import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { decodeShiftJis } from "../src/jra-http";
import { monthCname, parseDayRaces, parseMonthDays, parseParamTable, PAST_SEARCH_CNAME } from "../src/jra-result-links";

/** Issue #698: 過去検索の頁・月の頁・場日の頁から、次の頁の cname を拾う(純関数)。保存済みの本物の頁に対して確かめる。 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const page = (name: string): string => decodeShiftJis(new Uint8Array(readFileSync(path.join(ROOT, "fixtures", name))));
const PAST = page("jra_695_skl_past_search_20261109.html");
const MONTH = page("jra_695_skl_month_202101.html");
const DAY = page("jra_695_srl_nakayama_20210105.html");

describe("過去検索の頁: 月の頁の cname の末尾の 2 桁の表", () => {
  it("固定の cname は pw01skl00999999/B3。表は 41 年 × 12 か月 = 492 組で、2101(2021 年 1 月)は 0F、2611 は 91", () => {
    expect(PAST_SEARCH_CNAME).toBe("pw01skl00999999/B3");
    const r = parseParamTable(PAST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.size).toBe(492);
    expect(r.table.get("2101")).toBe("0F");
    expect(r.table.get("2611")).toBe("91");
    expect(r.table.get("2001")).toBe("83");
  });

  it("表が無い頁・誤りの頁は読めない(ok=false)", () => {
    expect(parseParamTable("<html><head><title>パラメータエラー　JRA</title></head></html>").ok).toBe(false);
    expect(parseParamTable("<html><head><title>過去レース結果検索　JRA</title></head><body>表なし</body></html>").ok).toBe(false);
  });
});

describe("monthCname: 月の頁の cname", () => {
  it("2026-10 までは pw01skl10、2026-11 以降は pw01skl00(過去検索の頁の JS の分岐 yearMonth = 202611 と同じ)", () => {
    expect(monthCname("202101", "0F")).toBe("pw01skl10202101/0F");
    expect(monthCname("202610", "AA")).toBe("pw01skl10202610/AA");
    expect(monthCname("202611", "91")).toBe("pw01skl00202611/91");
    expect(monthCname("202701", "11")).toBe("pw01skl00202701/11");
  });
});

describe("月の頁: その月の場日(pw01srl10…)", () => {
  it("2021-01 は 26 場日。すべて 2021 年 1 月の開催日で、重複が無い。中山 1 回 1 日(1/5)の cname を含む", () => {
    const r = parseMonthDays(MONTH, "202101");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.days).toHaveLength(26);
    expect(new Set(r.days.map((d) => d.cname)).size).toBe(26);
    expect(r.days.every((d) => d.date.startsWith("202101"))).toBe(true);
    expect(r.days.map((d) => d.cname)).toContain("pw01srl10062021010120210105/C6");
    // 開催日の昇順(同じ日は cname 順)
    const keys = r.days.map((d) => `${d.date}${d.cname}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("別の月を指定すると、その月の開催日だけが残る(月の頁に別の月の場日が混ざっても拾わない)", () => {
    const mixed = MONTH + `<a onclick="return doAction('/JRADB/accessS.html', 'pw01srl10052020121020201227/AA');">x</a>`;
    const r = parseMonthDays(mixed, "202101");
    expect(r.ok && r.days).toHaveLength(26);
    const other = parseMonthDays(mixed, "202012");
    expect(other.ok && other.days.map((d) => d.cname)).toEqual(["pw01srl10052020121020201227/AA"]);
    expect(parseMonthDays(MONTH, "202102")).toEqual({ ok: false, reason: "no-days" });
  });

  it("今月(2026-11)の月の頁は、過去検索の頁と同じバイト列(pw01skl00202611/91 を POST すると返る。調査 §11)。2026-11 の 8 場日(11/1 東京・京都、11/7・8 の東京・京都・福島)を読める", () => {
    const r = parseMonthDays(PAST, "202611");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.days.map((d) => d.date)).toEqual(["20261101", "20261101", "20261107", "20261107", "20261107", "20261108", "20261108", "20261108"]);
  });

  it("場日が 1 つも無い頁は no-days。パラメータエラーは param-error", () => {
    expect(parseMonthDays(PAST, "202612")).toEqual({ ok: false, reason: "no-days" });
    expect(parseMonthDays(page("jra_698_skl_month_202611_skl10_error.html"), "202611")).toEqual({ ok: false, reason: "param-error" });
  });
});

describe("場日の頁: その場日の 12 レースの結果の cname", () => {
  it("2021-01-05 中山は 12 レース(1R〜12R の順)。race_id は 202106010101〜202106010112。同じ頁にある中京の場日のリンクや他の cname は混ぜない", () => {
    const r = parseDayRaces(DAY, "pw01srl10062021010120210105/C6");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.races).toHaveLength(12);
    expect(r.races.map((x) => x.raceId)).toEqual(Array.from({ length: 12 }, (_, i) => `2021060101${String(i + 1).padStart(2, "0")}`));
    expect(r.races[0]!.cname).toBe("pw01sde1006202101010120210105/4F");
    expect(r.races.every((x) => x.cname.startsWith("pw01sde1006202101"))).toBe(true);
  });

  it("別の場日(中京)の cname を渡すと、中山の結果は拾わず、レースが無い(no-races)", () => {
    expect(parseDayRaces(DAY, "pw01srl10072021010120210105/10")).toEqual({ ok: false, reason: "no-races" });
  });

  it("日が違う同じ場の結果(開催日の部分が違う)は拾わない", () => {
    expect(parseDayRaces(DAY, "pw01srl10062021010220210106/00")).toEqual({ ok: false, reason: "no-races" });
  });

  it("誤りの頁は param-error。day の cname が場日の形でなければ no-races", () => {
    expect(parseDayRaces("<html><head><title>パラメータエラー　JRA</title></head></html>", "pw01srl10062021010120210105/C6")).toEqual({ ok: false, reason: "param-error" });
    expect(parseDayRaces(DAY, "pw01skl10202101/0F")).toEqual({ ok: false, reason: "no-races" });
  });
});
