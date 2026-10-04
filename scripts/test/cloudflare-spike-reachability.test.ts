import { describe, expect, it } from "vitest";
import {
  judgeReachability,
  summarizeReachability,
  type NetkeibaProbeRecord,
} from "../cloudflare-spike/reachability.js";
import {
  ALLOWED_HOSTS,
  buildTargets,
  isAllowedUrl,
} from "../cloudflare-spike/targets.js";
import { MAX_NETKEIBA_REQUESTS } from "../cloudflare-spike/request-guard.js";
import {
  horseResultsApiUrl,
  horseUrl,
  oddsApiUrl,
  shutubaUrl,
  parseHorseId,
  parseRaceId,
} from "../../packages/core/src/index.js";

/**
 * #159 到達性(netkeiba が Cloudflare Workers から読めるか)の判定と、取得対象の定義。
 */

function rec(partial: Partial<NetkeibaProbeRecord> = {}): NetkeibaProbeRecord {
  return {
    targetId: "central-shutuba",
    url: "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211",
    status: 200,
    bodyLength: 270000,
    charset: "UTF-8",
    parsedKind: "shutuba",
    parsedCount: 16,
    parseError: null,
    replacementChars: 0,
    headers: {},
    bodyHead: null,
    error: null,
    ...partial,
  };
}

describe("judgeReachability", () => {
  it("200 で、パーサが1件以上読めて、文字化けがなければ ok", () => {
    const j = judgeReachability(rec());
    expect(j.verdict).toBe("ok");
    expect(j.reason).not.toBe("");
  });

  it.each([
    { label: "パース件数0", partial: { parsedCount: 0 } },
    { label: "パース未実施(null)", partial: { parsedCount: null } },
    { label: "パース例外", partial: { parsedCount: null, parseError: "出馬表テーブルが見つかりません" } },
  ])("200 でも $label なら reachable-but-unparsed(到達はしたが中身を読めない)", ({ partial }) => {
    expect(judgeReachability(rec(partial)).verdict).toBe("reachable-but-unparsed");
  });

  it("パースできても置換文字(U+FFFD)が混じっていれば reachable-but-unparsed とし、理由に文字化けを書く", () => {
    const j = judgeReachability(rec({ replacementChars: 3 }));
    expect(j.verdict).toBe("reachable-but-unparsed");
    expect(j.reason).toContain("文字化け");
  });

  it("置換文字0ならば EUC-JP の馬ページも ok", () => {
    const j = judgeReachability(
      rec({ targetId: "db-horse-page", parsedKind: "horse-page", parsedCount: 1, charset: "EUC-JP", replacementChars: 0 }),
    );
    expect(j.verdict).toBe("ok");
  });

  it.each([400, 403, 429])("%i は blocked", (status) => {
    const j = judgeReachability(rec({ status, parsedCount: null }));
    expect(j.verdict).toBe("blocked");
    expect(j.reason).toContain(String(status));
  });

  it("cf-mitigated: challenge のヘッダがあれば、403 でも challenge(Cloudflare のチャレンジ)", () => {
    const j = judgeReachability(rec({ status: 403, parsedCount: null, headers: { "cf-mitigated": "challenge" } }));
    expect(j.verdict).toBe("challenge");
  });

  it("403 で本文の先頭に『Just a moment』があれば challenge", () => {
    const j = judgeReachability(rec({ status: 403, parsedCount: null, bodyHead: "<title>Just a moment...</title>" }));
    expect(j.verdict).toBe("challenge");
  });

  it("200 でも本文の先頭がチャレンジページで、パースできていなければ challenge", () => {
    const j = judgeReachability(rec({ status: 200, parsedCount: null, bodyHead: "<title>Just a moment...</title>" }));
    expect(j.verdict).toBe("challenge");
  });

  it.each([404, 500, 502, 301])("%i は http-error で、理由にステータスを含める", (status) => {
    const j = judgeReachability(rec({ status, parsedCount: null }));
    expect(j.verdict).toBe("http-error");
    expect(j.reason).toContain(String(status));
  });

  it("status が null(fetch が例外)なら network-error で、理由に例外メッセージを含める", () => {
    const j = judgeReachability(rec({ status: null, bodyLength: null, parsedCount: null, error: "connection reset" }));
    expect(j.verdict).toBe("network-error");
    expect(j.reason).toContain("connection reset");
  });
});

describe("summarizeReachability", () => {
  it("判定ごとの件数と、ホストごとの ok 数/総数を数える", () => {
    const records = [
      rec({ targetId: "a", url: "https://race.netkeiba.com/race/shutuba.html?race_id=1" }),
      rec({ targetId: "b", url: "https://race.netkeiba.com/api/api_get_jra_odds.html?x=1", status: 403, parsedCount: null }),
      rec({ targetId: "c", url: "https://db.netkeiba.com/horse/2021105857/" }),
      rec({ targetId: "d", url: "https://nar.netkeiba.com/race/shutuba.html?race_id=2", status: 500, parsedCount: null }),
    ];
    const s = summarizeReachability(records);
    expect(s.total).toBe(4);
    expect(s.counts).toEqual({
      ok: 2,
      "reachable-but-unparsed": 0,
      blocked: 1,
      challenge: 0,
      "http-error": 1,
      "network-error": 0,
    });
    expect(s.byHost).toEqual({
      "race.netkeiba.com": { ok: 1, total: 2 },
      "db.netkeiba.com": { ok: 1, total: 1 },
      "nar.netkeiba.com": { ok: 0, total: 1 },
    });
  });

  it("0件でも壊れない(件数は全部0)", () => {
    const s = summarizeReachability([]);
    expect(s.total).toBe(0);
    expect(Object.values(s.counts).every((n) => n === 0)).toBe(true);
    expect(s.byHost).toEqual({});
  });
});

describe("buildTargets / isAllowedUrl", () => {
  const targets = buildTargets();

  it("対象は1回の実行の上限(10本)以内で、実際には1本以上ある", () => {
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.length).toBeLessThanOrEqual(MAX_NETKEIBA_REQUESTS);
  });

  it("race / db / nar の3ホストをいずれも1本以上含み、許可ホスト以外は含まない", () => {
    const hosts = new Set(targets.map((t) => new URL(t.url).hostname));
    expect([...hosts].sort()).toEqual(["db.netkeiba.com", "nar.netkeiba.com", "race.netkeiba.com"]);
    expect([...ALLOWED_HOSTS].sort()).toEqual([...hosts].sort());
    for (const t of targets) {
      expect(isAllowedUrl(t.url)).toBe(true);
    }
  });

  it("race.netkeiba.com は出馬表とオッズ API、db.netkeiba.com は馬ページ(EUC-JP)と戦績 API、nar は出馬表", () => {
    const byId = new Map(targets.map((t) => [t.id, t]));
    expect(byId.get("central-shutuba")?.url).toBe(shutubaUrl(parseRaceId("202603020211")));
    expect(byId.get("central-odds")?.url).toBe(oddsApiUrl(parseRaceId("202603020211")));
    expect(byId.get("db-horse-page")?.url).toBe(horseUrl(parseHorseId("2021105857")));
    expect(byId.get("db-horse-results")?.url).toBe(horseResultsApiUrl(parseHorseId("2021105857")));
    expect(byId.get("nar-shutuba")?.url).toBe(shutubaUrl(parseRaceId("202654071210")));
    expect(targets).toHaveLength(5);
  });

  it("エンコーディング指定は馬ページだけが euc-jp(fixture-plan.ts と同じ慣行)、他は utf-8", () => {
    for (const t of targets) {
      expect(t.encoding).toBe(t.id === "db-horse-page" ? "euc-jp" : "utf-8");
    }
    expect(targets.some((t) => t.encoding === "euc-jp")).toBe(true);
  });

  it("id は重複しない", () => {
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
  });

  it.each([
    "https://race.netkeiba.com/race/shutuba.html?race_id=1",
    "https://db.netkeiba.com/horse/1/",
    "https://nar.netkeiba.com/race/shutuba.html?race_id=1",
  ])("許可: %s", (url) => {
    expect(isAllowedUrl(url)).toBe(true);
  });

  it.each([
    "http://race.netkeiba.com/race/shutuba.html",
    "https://example.com/",
    "https://race.netkeiba.com.evil.example/",
    "https://evil.example/?u=https://race.netkeiba.com/",
    "https://user@race.netkeiba.com@evil.example/",
    "https://netkeiba.com/",
    "ftp://race.netkeiba.com/",
    "not a url",
    "",
  ])("拒否: %s", (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });
});
