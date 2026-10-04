import { describe, expect, it } from "vitest";
import {
  compareSources,
  judgeReachability,
  summarizeReachability,
  type NetkeibaProbeRecord,
} from "../cloudflare-spike/reachability.js";
import {
  ALLOWED_HOSTS,
  buildRequestPlan,
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

  it.each([404, 500, 502])("%i は http-error で、理由にステータスを含める", (status) => {
    const j = judgeReachability(rec({ status, parsedCount: null }));
    expect(j.verdict).toBe("http-error");
    expect(j.reason).toContain(String(status));
  });

  it.each([301, 302, 307])(
    "%i は redirect(到達したが転送された)で、理由に転送先(location)を含める。http-error とは区別する",
    (status) => {
      const j = judgeReachability(
        rec({ status, parsedCount: null, headers: { location: "https://example.com/moved" } }),
      );
      expect(j.verdict).toBe("redirect");
      expect(j.reason).toContain(String(status));
      expect(j.reason).toContain("https://example.com/moved");
    },
  );

  it("location ヘッダが無い 3xx でも redirect(理由に『不明』と書く)", () => {
    const j = judgeReachability(rec({ status: 302, parsedCount: null, headers: {} }));
    expect(j.verdict).toBe("redirect");
    expect(j.reason).toContain("不明");
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
      redirect: 0,
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
    "https://race.netkeiba.com:8443/race/shutuba.html",
    "https://race.netkeiba.com:443@evil.example/",
    "ftp://race.netkeiba.com/",
    "not a url",
    "",
  ])("拒否: %s", (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });
});

describe("buildTargets の順序(ホストが交互)", () => {
  it("race → db → nar → race → db の順で、隣り合う対象のホストは必ず違う", () => {
    const hosts = buildTargets().map((t) => new URL(t.url).hostname);
    expect(hosts).toEqual([
      "race.netkeiba.com",
      "db.netkeiba.com",
      "nar.netkeiba.com",
      "race.netkeiba.com",
      "db.netkeiba.com",
    ]);
    for (let i = 1; i < hosts.length; i += 1) {
      expect(hosts[i]).not.toBe(hosts[i - 1]);
    }
  });

  it("先頭の3本で3ホストが一巡する(2回連続の拒否で打ち切られても、別ホストの結果が残る)", () => {
    const firstThree = buildTargets().slice(0, 3).map((t) => new URL(t.url).hostname);
    expect(new Set(firstThree).size).toBe(3);
  });
});

describe("buildRequestPlan(Worker とランナーの対照)", () => {
  const plan = buildRequestPlan();
  const targets = buildTargets();

  it("対象ごとに『Worker → ランナー』の順で、同じ対象を連続して送る(合計10本)", () => {
    expect(plan).toHaveLength(10);
    expect(plan).toHaveLength(targets.length * 2);
    for (let i = 0; i < targets.length; i += 1) {
      expect(plan[i * 2]!.source).toBe("worker");
      expect(plan[i * 2 + 1]!.source).toBe("runner");
      expect(plan[i * 2]!.target).toEqual(targets[i]);
      expect(plan[i * 2 + 1]!.target).toEqual(targets[i]); // 同じ URL・同じ設定。変えるのは送信元だけ
    }
  });

  it("合計は1回の実行の上限(10本)ちょうどで、上限を超えない", () => {
    expect(plan.length).toBe(MAX_NETKEIBA_REQUESTS);
  });

  it("送信元ごとに5本ずつ", () => {
    expect(plan.filter((p) => p.source === "worker")).toHaveLength(5);
    expect(plan.filter((p) => p.source === "runner")).toHaveLength(5);
  });
});

describe("source と bySource", () => {
  it("source を持たない記録は worker として数える。bySource に送信元ごとの ok 数/総数を出す", () => {
    const s = summarizeReachability([
      rec({ targetId: "a" }),
      rec({ targetId: "a", source: "runner" }),
      rec({ targetId: "b", source: "runner", status: 400, parsedCount: null }),
      rec({ targetId: "b", source: "worker", status: 400, parsedCount: null }),
    ]);
    expect(s.bySource).toEqual({ worker: { ok: 1, total: 2 }, runner: { ok: 1, total: 2 } });
  });
});

describe("compareSources(対照実験の読み)", () => {
  const bad = (targetId: string, source: "worker" | "runner") =>
    rec({ targetId, source, status: 400, parsedCount: null });
  const good = (targetId: string, source: "worker" | "runner") => rec({ targetId, source });

  it("同じ対象の Worker とランナーの判定を並べる", () => {
    const c = compareSources([good("a", "worker"), bad("a", "runner"), bad("b", "worker")]);
    expect(c.pairs).toEqual([
      { targetId: "a", worker: "ok", runner: "blocked", workerStatus: 200, runnerStatus: 400 },
      { targetId: "b", worker: "blocked", runner: null, workerStatus: 400, runnerStatus: null },
    ]);
  });

  it.each([
    { label: "どちらでも読めた", records: [good("a", "worker"), good("a", "runner")], expected: "both-ok" },
    { label: "どちらでも拒否された(Cloudflare 固有ではない)", records: [bad("a", "worker"), bad("a", "runner")], expected: "both-blocked" },
    { label: "Worker だけ拒否された(Cloudflare 固有の疑い)", records: [bad("a", "worker"), good("a", "runner")], expected: "worker-only-blocked" },
    { label: "ランナーだけ拒否された", records: [good("a", "worker"), bad("a", "runner")], expected: "runner-only-blocked" },
    { label: "対象によって違う", records: [bad("a", "worker"), good("a", "runner"), good("b", "worker"), bad("b", "runner")], expected: "mixed" },
    { label: "ホストによって Worker だけの拒否と両方拒否が混在", records: [bad("a", "worker"), good("a", "runner"), bad("b", "worker"), bad("b", "runner")], expected: "mixed" },
    { label: "片方の送信元しか測れていない(対がない)", records: [bad("a", "worker")], expected: "no-pairs" },
    { label: "記録が空", records: [], expected: "no-pairs" },
  ])("$label → $expected", ({ records, expected }) => {
    expect(compareSources(records).conclusion).toBe(expected);
  });

  it("対がある対象だけで結論を出す(対のない対象は結論に影響しない)", () => {
    const c = compareSources([bad("a", "worker"), good("a", "runner"), bad("z", "worker")]);
    expect(c.pairs).toHaveLength(2);
    expect(c.conclusion).toBe("worker-only-blocked");
  });
});

describe("compareSources: 『判定できなかった』を『拒否された』と読まない", () => {
  const blocked = (targetId: string, source: "worker" | "runner") => rec({ targetId, source, status: 403, parsedCount: null });
  const good = (targetId: string, source: "worker" | "runner") => rec({ targetId, source });
  const netErr = (targetId: string, source: "worker" | "runner") =>
    rec({ targetId, source, status: null, bodyLength: null, parsedCount: null, error: "boom" });
  const unparsed = (targetId: string, source: "worker" | "runner") => rec({ targetId, source, status: 200, parsedCount: 0 });
  const http502 = (targetId: string, source: "worker" | "runner") => rec({ targetId, source, status: 502, parsedCount: null });
  const redirected = (targetId: string, source: "worker" | "runner") =>
    rec({ targetId, source, status: 302, parsedCount: null, headers: { location: "https://x/" } });
  const challenge = (targetId: string, source: "worker" | "runner") =>
    rec({ targetId, source, status: 403, parsedCount: null, headers: { "cf-mitigated": "challenge" } });

  it("Worker が network-error(netkeiba に届いていない)でランナーが ok でも、worker-only-blocked にしない(inconclusive)", () => {
    const c = compareSources([netErr("a", "worker"), good("a", "runner")]);
    expect(c.conclusion).toBe("inconclusive");
    expect(c.conclusion).not.toBe("worker-only-blocked");
  });

  it("Worker が reachable-but-unparsed(200 で0件)でランナーが blocked(403)でも、both-blocked にしない", () => {
    const c = compareSources([unparsed("a", "worker"), blocked("a", "runner")]);
    expect(c.conclusion).toBe("inconclusive");
    expect(c.conclusion).not.toBe("both-blocked");
  });

  it("両方とも http-error(502)でも、both-blocked にしない", () => {
    const c = compareSources([http502("a", "worker"), http502("a", "runner")]);
    expect(c.conclusion).toBe("inconclusive");
    expect(c.conclusion).not.toBe("both-blocked");
  });

  it.each([
    { label: "network-error", make: netErr },
    { label: "http-error", make: http502 },
    { label: "reachable-but-unparsed", make: unparsed },
    { label: "redirect", make: redirected },
  ])("$label は判定不能: ランナーが ok の対と組んでも inconclusive", ({ make }) => {
    expect(compareSources([make("a", "worker"), good("a", "runner")]).conclusion).toBe("inconclusive");
    expect(compareSources([good("a", "worker"), make("a", "runner")]).conclusion).toBe("inconclusive");
  });

  it("拒否として数えるのは blocked(400/403/429)と challenge だけ: challenge の Worker と ok のランナーは worker-only-blocked", () => {
    expect(compareSources([challenge("a", "worker"), good("a", "runner")]).conclusion).toBe("worker-only-blocked");
    expect(compareSources([blocked("a", "worker"), good("a", "runner")]).conclusion).toBe("worker-only-blocked");
    expect(compareSources([challenge("a", "worker"), blocked("a", "runner")]).conclusion).toBe("both-blocked");
  });

  it("判定不能の対は結論の集計から外し、除外した件数を返す(判定できた対だけで結論を出す)", () => {
    const c = compareSources([
      blocked("a", "worker"), good("a", "runner"), // 判定できた(worker-only)
      netErr("b", "worker"), good("b", "runner"), // 判定不能
      http502("c", "worker"), http502("c", "runner"), // 判定不能
    ]);
    expect(c.conclusion).toBe("worker-only-blocked");
    expect(c.indeterminatePairs).toBe(2);
    expect(c.pairs).toHaveLength(3);
  });

  it("判定できた対が1つも無ければ inconclusive。除外件数は対の数と一致する", () => {
    const c = compareSources([netErr("a", "worker"), good("a", "runner"), http502("b", "worker"), good("b", "runner")]);
    expect(c.conclusion).toBe("inconclusive");
    expect(c.indeterminatePairs).toBe(2);
  });

  it("対がない(片方の送信元だけ)は、これまでどおり no-pairs で、除外件数は 0", () => {
    const c = compareSources([netErr("a", "worker")]);
    expect(c.conclusion).toBe("no-pairs");
    expect(c.indeterminatePairs).toBe(0);
  });
});
