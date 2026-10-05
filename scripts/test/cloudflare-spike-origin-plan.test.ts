import { describe, expect, it } from "vitest";
import {
  baselineReproduced,
  buildOriginPlan,
  concludeOrigin,
  describeConclusion,
  outcomeOf,
  type Outcome,
  type OriginExperiment,
  type OriginRecord,
} from "../cloudflare-spike/origin-plan.js";
import { MAX_NETKEIBA_REQUESTS } from "../cloudflare-spike/request-guard.js";

/**
 * #160 実験の計画(E0/E2/E3)と、結果の読み(結論の型)。
 * 結論の組合せ表を固定する: E0 の再現(前提ゲート)× E2 × E3。拒否と数えるのは blocked(400/403/429)と
 * challenge だけで、それ以外は判定不能(`compareSources` と同じ)。
 */

function rec(experiment: OriginExperiment, status: number | null, over: Partial<OriginRecord> = {}): OriginRecord {
  const place = experiment === "E3" ? "worker" : "runner";
  return {
    experiment,
    place,
    via: experiment === "E3" ? "socket" : "fetch",
    sourceKey: experiment === "E3" ? "worker:socket" : "runner:fetch",
    targetId: "central-shutuba",
    url: "https://race.netkeiba.com/race/shutuba.html?race_id=202603020211",
    status,
    bodyLength: status === 200 ? 1000 : status === null ? null : 0,
    charset: null,
    parsedKind: "shutuba",
    parsedCount: status === 200 ? 16 : null,
    parseError: null,
    replacementChars: status === 200 ? 0 : null,
    headers: {},
    bodyHead: null,
    error: status === null ? "boom" : null,
    ...over,
  };
}

describe("buildOriginPlan(送信計画)", () => {
  const plan = buildOriginPlan();

  it("netkeiba へは6本(E0 が2本・E3 が2本・E2 が2本)で、1回の実行の上限 10 本以内", () => {
    expect(plan).toHaveLength(6);
    expect(plan.length).toBeLessThanOrEqual(MAX_NETKEIBA_REQUESTS);
    expect(plan.filter((s) => s.experiment === "E0")).toHaveLength(2);
    expect(plan.filter((s) => s.experiment === "E2")).toHaveLength(2);
    expect(plan.filter((s) => s.experiment === "E3")).toHaveLength(2);
  });

  it("順序は E0(Worker → ランナー)→ E3(race → db)→ E2(race → db)", () => {
    expect(plan.map((s) => `${s.experiment}:${s.sourceKey}:${s.target.id}`)).toEqual([
      "E0:worker:fetch:central-shutuba",
      "E0:runner:fetch:central-shutuba",
      "E3:worker:socket:central-shutuba",
      "E3:worker:socket:db-horse-page",
      "E2:runner:fetch+worker-headers:central-shutuba",
      "E2:runner:fetch+worker-headers:db-horse-page",
    ]);
  });

  it("E0 は同じ対象(race の出馬表)を Worker とランナーから(変えるのは送信元だけ)", () => {
    const e0 = plan.filter((s) => s.experiment === "E0");
    expect(e0[0]!.target).toEqual(e0[1]!.target);
    expect(e0.map((s) => s.place)).toEqual(["worker", "runner"]);
    expect(e0.every((s) => s.via === "fetch")).toBe(true);
  });

  it("E2 は送信元がランナー、E3 は Worker のソケット。E2 と E3 は同じ2対象(race と db の馬ページ)", () => {
    const e2 = plan.filter((s) => s.experiment === "E2");
    const e3 = plan.filter((s) => s.experiment === "E3");
    expect(e2.every((s) => s.place === "runner" && s.via === "fetch+worker-headers")).toBe(true);
    expect(e3.every((s) => s.place === "worker" && s.via === "socket")).toBe(true);
    expect(e2.map((s) => s.target.id)).toEqual(e3.map((s) => s.target.id));
    expect(e3.map((s) => s.target.id)).toEqual(["central-shutuba", "db-horse-page"]);
    expect(e3.map((s) => s.target.encoding)).toEqual(["utf-8", "euc-jp"]);
  });

  it("送信元キーは『場所:手段』の4種類", () => {
    expect([...new Set(plan.map((s) => s.sourceKey))].sort()).toEqual([
      "runner:fetch",
      "runner:fetch+worker-headers",
      "worker:fetch",
      "worker:socket",
    ]);
  });

  it("対象の URL は許可ホスト(race / db の netkeiba.com)だけ", () => {
    for (const s of plan) {
      expect(["race.netkeiba.com", "db.netkeiba.com"]).toContain(new URL(s.target.url).hostname);
    }
  });
});

describe("outcomeOf(実験ごとの集約)", () => {
  it("全対象が ok なら good", () => {
    expect(outcomeOf([rec("E3", 200), rec("E3", 200)], "E3", 2)).toBe("good");
  });
  it.each([400, 403, 429])("全対象が HTTP %d(blocked)なら bad", (status) => {
    expect(outcomeOf([rec("E3", status), rec("E3", status)], "E3", 2)).toBe("bad");
  });
  it("challenge(cf-mitigated)も拒否として数える", () => {
    const c = rec("E3", 403, { headers: { "cf-mitigated": "challenge" } });
    expect(outcomeOf([c, c], "E3", 2)).toBe("bad");
  });
  it("対象によって結果が違う(ok と blocked)なら unknown", () => {
    expect(outcomeOf([rec("E3", 200), rec("E3", 400)], "E3", 2)).toBe("unknown");
  });
  it.each([
    ["通信エラー(status=null)", rec("E3", null)],
    ["想定外のステータス(500)", rec("E3", 500)],
    ["転送(301。追従しない)", rec("E3", 301)],
    ["2xx だがパースできない", rec("E3", 200, { parsedCount: 0 })],
  ])("%s が混じれば、拒否とは数えず unknown", (_name, bad) => {
    expect(outcomeOf([rec("E3", 200), bad], "E3", 2)).toBe("unknown");
    expect(outcomeOf([bad, bad], "E3", 2)).toBe("unknown");
  });
  it("計画の本数に満たなければ(未実施・途中で止まった)unknown。良い結果1本だけで good にしない", () => {
    expect(outcomeOf([], "E3", 2)).toBe("unknown");
    expect(outcomeOf([rec("E3", 200)], "E3", 2)).toBe("unknown");
    expect(outcomeOf([rec("E3", 400)], "E3", 2)).toBe("unknown");
  });
  it("他の実験の記録は数えない", () => {
    expect(outcomeOf([rec("E2", 200), rec("E2", 200), rec("E3", 400)], "E3", 2)).toBe("unknown");
    expect(outcomeOf([rec("E2", 400), rec("E2", 400), rec("E3", 200), rec("E3", 200)], "E3", 2)).toBe("good");
  });
});

describe("baselineReproduced(E0 の再現。前提ゲート)", () => {
  const worker = (status: number | null, over: Partial<OriginRecord> = {}): OriginRecord =>
    rec("E0", status, { place: "worker", via: "fetch", sourceKey: "worker:fetch", ...over });
  const runner = (status: number | null): OriginRecord => rec("E0", status);

  it("Worker が拒否(400)で、ランナーが ok(200)なら再現した", () => {
    expect(baselineReproduced([worker(400), runner(200)])).toBe(true);
  });
  it("Worker が challenge でも再現とみなす(拒否の一種)", () => {
    expect(baselineReproduced([worker(403, { headers: { "cf-mitigated": "challenge" } }), runner(200)])).toBe(true);
  });
  it.each([
    ["Worker も 200(今回は拒否されなかった)", worker(200), runner(200)],
    ["ランナーも 400", worker(400), runner(400)],
    ["Worker が通信エラー", worker(null), runner(200)],
    ["ランナーが通信エラー", worker(400), runner(null)],
    ["Worker が 500(判定不能)", worker(500), runner(200)],
  ])("%s なら再現していない", (_name, w, r) => {
    expect(baselineReproduced([w, r])).toBe(false);
  });
  it("どちらかの記録が無ければ再現していない", () => {
    expect(baselineReproduced([])).toBe(false);
    expect(baselineReproduced([worker(400)])).toBe(false);
    expect(baselineReproduced([runner(200)])).toBe(false);
  });
});

describe("concludeOrigin(結論の組合せ表)", () => {
  // baseline=true の 3 x 3。行が E2、列が E3。
  const table: [Outcome, Outcome, string][] = [
    ["good", "good", "fetch-specific"],
    ["good", "bad", "ip-suspected"],
    ["good", "unknown", "inconclusive"],
    ["bad", "good", "header-suspected"],
    ["bad", "bad", "both-suspected"],
    ["bad", "unknown", "header-suspected"],
    ["unknown", "good", "fetch-specific"],
    ["unknown", "bad", "ip-suspected"],
    ["unknown", "unknown", "inconclusive"],
  ];
  it.each(table)("E0 が再現した場合: E2=%s かつ E3=%s → %s", (e2, e3, expected) => {
    expect(concludeOrigin({ baseline: true, e2, e3 })).toBe(expected);
  });

  it.each(table)("E0 が再現しなかった場合は、E2=%s かつ E3=%s でも baseline-not-reproduced(基準が再現しないと E3 の 200 は何も意味しない)", (e2, e3) => {
    expect(concludeOrigin({ baseline: false, e2, e3 })).toBe("baseline-not-reproduced");
  });

  it("9通りの組合せがすべて表に載っている(取りこぼしなし)", () => {
    const keys = new Set(table.map(([a, b]) => `${a}/${b}`));
    expect(keys.size).toBe(9);
  });
});

describe("describeConclusion(結果の読み。分離できないものの併記)", () => {
  const same = { observed: true, service: "peet" as const, workerHttpVersion: "h2", runnerHttpVersion: "h2", workerJa4: "t13d_a", runnerJa4: "t13d_a" };

  it("fetch-specific: ソケットで回避できる、と読み、ヘッダと TLS が分離できないことを必ず書く", () => {
    const r = describeConclusion("fetch-specific", same);
    expect(r.summary).toMatch(/fetch/);
    expect(r.summary).toMatch(/ソケット/);
    expect(r.limitations.join("\n")).toMatch(/ヘッダ/);
    expect(r.limitations.join("\n")).toMatch(/TLS/);
    expect(r.limitations.join("\n")).toMatch(/分離できない/);
  });

  it("header-suspected: ヘッダが原因の疑いが強い。E2 は『付けたヘッダの追加で拒否される』ことを示す", () => {
    const r = describeConclusion("header-suspected", same);
    expect(r.summary).toMatch(/ヘッダ.*原因の疑いが強い/);
  });

  it("ip-suspected: 送信元(IP)が原因の疑いが強い", () => {
    expect(describeConclusion("ip-suspected", same).summary).toMatch(/送信元.*IP.*原因の疑いが強い/);
  });

  it("both-suspected: 判定不能で、ヘッダと送信元の両方が拒否に寄与している可能性を書く", () => {
    const r = describeConclusion("both-suspected", same);
    expect(r.summary).toMatch(/判定不能/);
    expect(r.summary).toMatch(/両方/);
  });

  it("baseline-not-reproduced: 判定不能で、基準(E0)が再現しなかったと書く", () => {
    const r = describeConclusion("baseline-not-reproduced", same);
    expect(r.summary).toMatch(/判定不能/);
    expect(r.summary).toMatch(/E0/);
  });

  it("inconclusive: 判定不能", () => {
    expect(describeConclusion("inconclusive", same).summary).toMatch(/判定不能/);
  });

  it("E2 が good の読みには、『ヘッダが原因でないとは言えない』限界(値・順序・大文字小文字・HTTP/2 は動かしていない)を併記する", () => {
    const r = describeConclusion("fetch-specific", same);
    expect(r.limitations.join("\n")).toMatch(/値|順序/);
  });

  it("HTTP バージョンが両側で違えば、分離できない要素に HTTP バージョンを加える(両側の値つき)", () => {
    const r = describeConclusion("fetch-specific", { ...same, workerHttpVersion: "h2", runnerHttpVersion: "HTTP/1.1" });
    const text = r.limitations.join("\n");
    expect(text).toMatch(/HTTP バージョン/);
    expect(text).toContain("h2");
    expect(text).toContain("HTTP/1.1");
  });

  it("HTTP バージョンが同じなら、HTTP バージョンを分離できない要素に加えない", () => {
    expect(describeConclusion("fetch-specific", same).limitations.join("\n")).not.toMatch(/HTTP バージョンも/);
  });

  it("TLS の指紋(JA4)が両側で違えば、その旨を書く。同じなら『E1 の範囲では同じだった』と書く", () => {
    const diff = describeConclusion("fetch-specific", { ...same, workerJa4: "t13d_a", runnerJa4: "t13d_b" }).limitations.join("\n");
    expect(diff).toMatch(/JA4/);
    expect(diff).toMatch(/違/);
    const eq = describeConclusion("fetch-specific", same).limitations.join("\n");
    expect(eq).toMatch(/JA4/);
    expect(eq).toMatch(/同じ/);
  });

  it("E1 が取れなかった(observed=false)場合は、TLS・HTTP バージョンが観測できていないと書く", () => {
    const r = describeConclusion("fetch-specific", { observed: false, service: null, workerHttpVersion: null, runnerHttpVersion: null, workerJa4: null, runnerJa4: null });
    expect(r.limitations.join("\n")).toMatch(/観測できていない|観測できなかった/);
  });

  it("エコーが httpbin(TLS・HTTP バージョンを返さない)なら、観測できていないと書く", () => {
    const r = describeConclusion("fetch-specific", { observed: true, service: "httpbin", workerHttpVersion: null, runnerHttpVersion: null, workerJa4: null, runnerJa4: null });
    expect(r.limitations.join("\n")).toMatch(/観測できていない|観測できなかった/);
  });

  it.each(["fetch-specific", "header-suspected", "ip-suspected", "both-suspected", "inconclusive", "baseline-not-reproduced"] as const)(
    "%s の限界にも、『分離できないもの』を併記する",
    (c) => {
      expect(describeConclusion(c, same).limitations.join("\n")).toMatch(/分離できない/);
    },
  );

  it.each([
    ["header-suspected", /どのヘッダ/],
    ["ip-suspected", /ソケット.*(実装|不備)/],
    ["both-suspected", /ヘッダ.*送信元/],
    ["inconclusive", /ヘッダ.*TLS.*IP|IP.*ヘッダ/],
    ["baseline-not-reproduced", /ヘッダ.*TLS.*IP|IP.*ヘッダ/],
  ] as const)("%s の『分離できないもの』は、その結論に固有の内容(定型文の流用ではない)", (c, pattern) => {
    const line = describeConclusion(c, same).limitations.find((l) => /分離できない/.test(l));
    expect(line).toBeDefined();
    expect(line!).toMatch(pattern);
  });

  it.each(["fetch-specific", "header-suspected", "ip-suspected", "both-suspected", "inconclusive", "baseline-not-reproduced"] as const)(
    "%s にも、標本が小さい(各実験は2対象)ことと、エコー宛ての観測である限界を併記する",
    (c) => {
      const text = describeConclusion(c, same).limitations.join("\n");
      expect(text).toMatch(/2 対象|2対象|標本/);
      expect(text).toMatch(/エコー/);
    },
  );
});
