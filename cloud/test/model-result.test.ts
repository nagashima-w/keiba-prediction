import { describe, expect, it } from "vitest";
import {
  attachCourse,
  attachModel,
  buildModelColumn,
  loadModelColumn,
  loadModelResult,
  parseModelCourse,
  MODEL_NONE_LABELS,
  MODEL_READ_TIMEOUT_MS,
  parseModelResponse,
  type ModelColumn,
} from "../src/model-result";

/**
 * Issue #796: 別の Worker が計算した確率の読み取り(`GET /v1/races/{race_id}`)の検証と、確率 × 5 分前の単勝の掛け算。
 * 形が違うもの・範囲外は全体を「計算なし(unavailable)」にする(一部だけ出さない)。理由は固定の語彙だけを表示する。
 */

const RACE = "202603020211";
const okBody = (horses: unknown[] = [{ umaban: 1, p_win: 0.25 }, { umaban: 2, p_win: 0.5 }], extra: Record<string, unknown> = {}) => ({
  race_id: RACE,
  status: "ok",
  model_version: "v",
  computed_at: "2026-11-26T00:00:00Z",
  odds_minutes_before: 5,
  horses,
  ...extra,
});

describe("parseModelResponse", () => {
  it("正しい ok は馬番 → 確率の表にする", () => {
    const r = parseModelResponse(200, okBody(), RACE);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect([...r.probs.entries()]).toEqual([[1, 0.25], [2, 0.5]]);
    }
  });

  it("p_win の 0 と 1 は有効(境界)", () => {
    const r = parseModelResponse(200, okBody([{ umaban: 1, p_win: 0 }, { umaban: 2, p_win: 1 }]), RACE);
    expect(r.kind).toBe("ok");
  });

  it.each([
    ["p_win が 1 を超える", okBody([{ umaban: 1, p_win: 1.01 }])],
    ["p_win が負", okBody([{ umaban: 1, p_win: -0.01 }])],
    ["p_win が文字列", okBody([{ umaban: 1, p_win: "0.2" }])],
    ["p_win が null", okBody([{ umaban: 1, p_win: null }])],
    ["umaban が小数", okBody([{ umaban: 1.5, p_win: 0.2 }])],
    ["umaban が文字列", okBody([{ umaban: "1", p_win: 0.2 }])],
    ["umaban が 0", okBody([{ umaban: 0, p_win: 0.2 }])],
    ["umaban が重複", okBody([{ umaban: 1, p_win: 0.2 }, { umaban: 1, p_win: 0.3 }])],
    ["一部だけ不正(正しい馬があっても全体を捨てる)", okBody([{ umaban: 1, p_win: 0.2 }, { umaban: 2, p_win: 2 }])],
    ["horses が配列でない", okBody([], { horses: "x" })],
    ["horses が空", okBody([])],
    ["odds_minutes_before が 10", okBody(undefined, { odds_minutes_before: 10 })],
    ["odds_minutes_before が無い", okBody(undefined, { odds_minutes_before: undefined })],
    ["race_id が違う", okBody(undefined, { race_id: "202603020212" })],
    ["本文がオブジェクトでない", "oops"],
    ["本文が null", null],
    ["status が未知", { race_id: RACE, status: "weird" }],
  ])("%s は unavailable", (_name, body) => {
    expect(parseModelResponse(200, body, RACE)).toEqual({ kind: "none", reason: "unavailable" });
  });

  it.each([404, 500, 502, 503])("HTTP %i は unavailable", (code) => {
    expect(parseModelResponse(code, okBody(), RACE)).toEqual({ kind: "none", reason: "unavailable" });
  });

  it.each(["not_ready", "no_odds", "no_card", "failed"] as const)("status none の理由 %s は受け付ける", (reason) => {
    expect(parseModelResponse(200, { race_id: RACE, status: "none", reason }, RACE)).toEqual({ kind: "none", reason });
  });

  it("status none の unavailable は相手から受け付けない(理由不明に倒す)", () => {
    expect(parseModelResponse(200, { race_id: RACE, status: "none", reason: "unavailable" }, RACE)).toEqual({ kind: "none", reason: "unknown" });
  });

  it("未知の理由・理由なし・文字列以外は理由不明(外の文字列を引き継がない)", () => {
    for (const reason of ["<script>alert(1)</script>", "", undefined, 5, null]) {
      expect(parseModelResponse(200, { race_id: RACE, status: "none", reason }, RACE)).toEqual({ kind: "none", reason: "unknown" });
    }
  });
});

describe("buildModelColumn(確率 × 5 分前の単勝)", () => {
  const ok = parseModelResponse(200, okBody([{ umaban: 1, p_win: 0.25 }, { umaban: 2, p_win: 0.5 }]), RACE);

  it("確率 × 単勝 を馬ごとに掛ける", () => {
    const col = buildModelColumn(ok, new Map([[1, 8], [2, 3]]));
    expect(col.status).toBe("ok");
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2, aux: null });
    expect(col.byUmaban.get(2)).toEqual({ prob: 0.5, ev: 1.5, aux: null });
  });

  it("5 分前の単勝が無い馬は確率だけで掛け算は null", () => {
    const col = buildModelColumn(ok, new Map([[1, 8]]));
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2, aux: null });
    expect(col.byUmaban.get(2)).toEqual({ prob: 0.5, ev: null, aux: null });
  });

  it("5 分前の記録が無い(null)ときは全馬で掛け算が null。注記に書く", () => {
    const col = buildModelColumn(ok, null);
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: null, aux: null });
    expect(col.note).toContain("5分前");
  });

  it("応答に無い馬は表に無い(セルは —)", () => {
    expect(buildModelColumn(ok, new Map()).byUmaban.has(3)).toBe(false);
  });

  it("計算なしは全馬の表が空で、注記に固定の語彙の理由が入る", () => {
    for (const reason of ["not_ready", "no_odds", "no_card", "failed", "unavailable", "unknown"] as const) {
      const col = buildModelColumn({ kind: "none", reason }, new Map());
      expect(col.status).toBe("none");
      expect(col.byUmaban.size).toBe(0);
      expect(col.note).toContain("計算なし");
      expect(col.note).toContain(MODEL_NONE_LABELS[reason]);
    }
    expect(MODEL_NONE_LABELS.unknown).toBe("理由不明");
  });
});

describe("attachModel", () => {
  const view = { id: 1, horses: [{ umaban: 1 }, { umaban: 2 }, { umaban: 3 }] } as never;

  it("列が無い(null)ときは何も足さない(キーも増えない)", () => {
    const out = attachModel(view, null) as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["horses", "id"]);
    expect(Object.keys((out["horses"] as object[])[0]!)).toEqual(["umaban"]);
  });

  it("馬ごとに modelProb・modelEv を足し、無い馬は null。注記と状態は 1 つ", () => {
    const col: ModelColumn = { status: "ok", stage: "final", note: "注記", byUmaban: new Map([[1, { prob: 0.2, ev: 1.6, aux: null }], [2, { prob: 0.3, ev: null, aux: null }]]) };
    const out = attachModel(view, col) as unknown as { horses: Record<string, unknown>[]; modelNote: string; modelStatus: string };
    expect(out.modelNote).toBe("注記");
    expect(out.modelStatus).toBe("ok");
    expect(out.horses.map((h) => [h["modelProb"], h["modelEv"]])).toEqual([[0.2, 1.6], [0.3, null], [null, null]]);
  });
});

describe("loadModelColumn", () => {
  function fetcherOf(handler: (req: Request) => Promise<Response> | Response): { fetcher: Fetcher; urls: string[]; signals: boolean[] } {
    const urls: string[] = [];
    const signals: boolean[] = [];
    const fetcher = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const req = new Request(input as string, init);
        urls.push(`${req.method} ${new URL(req.url).pathname}`);
        signals.push(init?.signal !== undefined && init.signal !== null);
        return handler(req);
      },
    } as unknown as Fetcher;
    return { fetcher, urls, signals };
  }
  const winOdds = async () => new Map([[1, 8], [2, 3]]);

  it("MODEL が無ければ何も呼ばず null(D1 の読み取りもしない)", async () => {
    let read = 0;
    const col = await loadModelColumn({ model: undefined, readWinOdds: async () => (read++, null) }, RACE, () => undefined);
    expect(col).toBeNull();
    expect(read).toBe(0);
  });

  it("地方のレースは何もしない(null。MODEL も呼ばない)", async () => {
    const { fetcher, urls } = fetcherOf(() => new Response("{}"));
    const col = await loadModelColumn({ model: fetcher, readWinOdds: winOdds }, "202644062911", () => undefined);
    expect(col).toBeNull();
    expect(urls).toEqual([]);
  });

  it("GET /v1/races/{race_id} を時間切れつきで 1 回呼び、確率と単勝を掛ける", async () => {
    const { fetcher, urls, signals } = fetcherOf(() => Response.json(okBody()));
    const col = await loadModelColumn({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
    expect(urls).toEqual([`GET /v1/races/${RACE}`]);
    expect(signals).toEqual([true]);
    expect(col!.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2, aux: null });
  });

  it("本文が JSON でなければ unavailable", async () => {
    const { fetcher } = fetcherOf(() => new Response("<html>", { status: 200 }));
    const col = await loadModelColumn({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
    expect(col!.status).toBe("none");
    expect(col!.note).toContain(MODEL_NONE_LABELS.unavailable);
  });

  it("例外は unavailable(投げない)。警告に例外の文面は出さない", async () => {
    const warns: string[] = [];
    const { fetcher } = fetcherOf(() => {
      throw new Error("SECRET");
    });
    const col = await loadModelColumn({ model: fetcher, readWinOdds: winOdds }, RACE, (m) => warns.push(m));
    expect(col!.status).toBe("none");
    expect(warns.join("")).not.toContain("SECRET");
  });

  it("時間切れは unavailable(既定は 2 秒)", async () => {
    const { fetcher } = fetcherOf((req) => new Promise<Response>((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason))));
    const col = await loadModelColumn({ model: fetcher, readWinOdds: winOdds, timeoutMs: 20 }, RACE, () => undefined);
    expect(col!.status).toBe("none");
    expect(MODEL_READ_TIMEOUT_MS).toBe(2000);
  });

  it("D1 の読み取りが失敗しても確率は出す(掛け算だけ null)", async () => {
    const { fetcher } = fetcherOf(() => Response.json(okBody()));
    const col = await loadModelColumn({ model: fetcher, readWinOdds: async () => { throw new Error("d1"); } }, RACE, () => undefined);
    expect(col!.status).toBe("ok");
    expect(col!.byUmaban.get(1)).toEqual({ prob: 0.25, ev: null, aux: null });
  });

  it("計算なし(none)のときは、列は全馬 —", async () => {
    const { fetcher } = fetcherOf(() => Response.json({ race_id: RACE, status: "none", reason: "not_ready" }));
    const col = await loadModelColumn({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
    expect(col!.status).toBe("none");
    expect(col!.byUmaban.size).toBe(0);
  });
});

// ===== Issue #800: 暫定の確率・補助の値の符号 =====

const provBody = (horses: unknown[] | undefined, extra: Record<string, unknown> = {}) => ({
  race_id: RACE,
  status: "none",
  reason: "not_ready",
  stage: "provisional",
  odds_source: "lead10",
  odds_lead_min: 10,
  odds_taken_at_ms: Date.UTC(2026, 10, 26, 5, 20), // JST 14:20
  model_version: "v2",
  computed_at: "2026-11-26T05:21:00Z",
  odds_minutes_before: null,
  ...(horses === undefined ? {} : { horses }),
  ...extra,
});
const provHorses = () => [
  { umaban: 1, p_win: 0.25, odds_win: 8, u_mat: 0.3 },
  { umaban: 2, p_win: 0.5, odds_win: 3, u_mat: -0.1 },
];

describe("#800 parseModelResponse(暫定)", () => {
  it("暫定の none は、馬番 → 確率・単勝・補助(値・順位・頭数)の表と、段階・オッズの出どころ・時刻にする", () => {
    const r = parseModelResponse(200, provBody(provHorses()), RACE);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.stage).toBe("provisional");
    expect([...r.probs.entries()]).toEqual([[1, 0.25], [2, 0.5]]);
    expect([...r.aux.entries()]).toEqual([[1, { value: 0.3, rank: 1, of: 2 }], [2, { value: -0.1, rank: 2, of: 2 }]]);
    expect(r.provisional).not.toBeNull();
    expect(r.provisional!.oddsSource).toBe("lead10");
    expect(r.provisional!.takenAtMs).toBe(Date.UTC(2026, 10, 26, 5, 20));
    expect([...r.provisional!.winOdds.entries()]).toEqual([[1, 8], [2, 3]]);
  });

  it("stage が preday でも受ける", () => {
    const r = parseModelResponse(200, provBody(provHorses(), { stage: "preday", odds_source: "lead-1", odds_lead_min: -1 }), RACE);
    expect(r.kind === "ok" && r.stage).toBe("preday");
  });

  it("確定(stage 無しの ok)は今までどおり final で、暫定の材料は持たない", () => {
    const r = parseModelResponse(200, okBody(), RACE);
    expect(r.kind === "ok" && r.stage).toBe("final");
    expect(r.kind === "ok" && r.provisional).toBeNull();
  });

  it("確定(stage final の ok)は補助を読む。u_mat が無い馬は無し(頭数にも数えない)", () => {
    const body = okBody([{ umaban: 1, p_win: 0.2, u_mat: 1 }, { umaban: 2, p_win: 0.3 }], { stage: "final", odds_source: "lead5", odds_lead_min: 5, odds_taken_at_ms: 1 });
    const r = parseModelResponse(200, body, RACE);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.stage).toBe("final");
    expect(r.aux.get(1)).toEqual({ value: 1, rank: 1, of: 1 });
    expect(r.aux.has(2)).toBe(false);
  });

  it.each([
    [0.5, 0.5],
    [-0.5, -0.5],
    [0, 0],
    [-0, 0],
    [-0.004, 0],
    [0.004, 0],
    [0.005, 0.01],
    [-0.005, -0.01],
    [0.424, 0.42],
    [-0.146, -0.15],
  ])("u_mat %s は小数 2 桁に丸めて %s(負の 0 は 0)", (u, value) => {
    const r = parseModelResponse(200, provBody([{ umaban: 1, p_win: 0.2, odds_win: 5, u_mat: u }]), RACE);
    expect(r.kind).toBe("ok");
    const v = r.kind === "ok" ? r.aux.get(1)!.value : NaN;
    expect(v).toBe(value);
    expect(Object.is(v, -0)).toBe(false);
  });

  it("順位は丸める前の値の大きい順。同じ値は同じ順位で次は飛ぶ(1,2,2,4)。丸めて同じでも元が違えば別の順位", () => {
    const hs = [0.3, 0.1, 0.1, -0.2, 0.004, 0.001].map((u, i) => ({ umaban: i + 1, p_win: 0.1, odds_win: 5, u_mat: u }));
    const r = parseModelResponse(200, provBody(hs), RACE);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect([...r.aux.values()].map((a) => a.rank)).toEqual([1, 2, 2, 6, 4, 5]);
    expect([...r.aux.values()].map((a) => a.of)).toEqual([6, 6, 6, 6, 6, 6]);
    expect([...r.aux.values()].map((a) => a.value)).toEqual([0.3, 0.1, 0.1, -0.2, 0, 0]);
  });

  it("値のある馬が 1 頭だけなら 1位/1頭。u_mat の無い馬・有限でない馬は順位にも頭数にも入らない", () => {
    const r = parseModelResponse(200, provBody([{ umaban: 1, p_win: 0.2, odds_win: 5, u_mat: -3 }, { umaban: 2, p_win: 0.2, odds_win: 5 }, { umaban: 3, p_win: 0.2, odds_win: 5, u_mat: Number.NaN }]), RACE);
    expect(r.kind === "ok" && [...r.aux.entries()]).toEqual([[1, { value: -3, rank: 1, of: 1 }]]);
  });

  it.each([["文字列", "1"], ["null", null], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY]])("u_mat が %s のとき、その馬の補助だけ無し(全体は捨てない)", (_n, u) => {
    const r = parseModelResponse(200, provBody([{ umaban: 1, p_win: 0.2, odds_win: 5, u_mat: u }, { umaban: 2, p_win: 0.2, odds_win: 5, u_mat: 1 }]), RACE);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.aux.has(1)).toBe(false);
    expect(r.aux.get(2)).toEqual({ value: 1, rank: 1, of: 1 });
  });

  it.each([
    ["0", 0],
    ["負", -3],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["文字列", "8"],
    ["null", null],
  ])("odds_win が %s の馬は単勝の表に載せない(確率は残る)", (_n, o) => {
    const r = parseModelResponse(200, provBody([{ umaban: 1, p_win: 0.2, odds_win: o }, { umaban: 2, p_win: 0.3, odds_win: 4 }]), RACE);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.probs.get(1)).toBe(0.2);
    expect(r.provisional!.winOdds.has(1)).toBe(false);
    expect(r.provisional!.winOdds.get(2)).toBe(4);
  });

  it("odds_win が無い馬も単勝の表に載せない", () => {
    const r = parseModelResponse(200, provBody([{ umaban: 1, p_win: 0.2 }]), RACE);
    expect(r.kind === "ok" && r.provisional!.winOdds.size).toBe(0);
  });

  it.each([
    ["stage が表に無い", { stage: "weird" }],
    ["stage が文字列でない", { stage: 1 }],
    ["stage が final(none では受けない)", { stage: "final" }],
    ["odds_source が表に無い", { odds_source: "lead5" }],
    ["odds_source が無い", { odds_source: undefined }],
    ["odds_source が <b>x</b>", { odds_source: "<b>x</b>" }],
  ])("暫定: %s のときは暫定の列を出さず、従来どおり計算なし(理由)", (_n, extra) => {
    const r = parseModelResponse(200, provBody(provHorses(), extra), RACE);
    expect(r).toEqual({ kind: "none", reason: "not_ready" });
  });

  it("暫定: horses が無い・空のときは従来どおり計算なし(理由)", () => {
    expect(parseModelResponse(200, provBody(undefined), RACE)).toEqual({ kind: "none", reason: "not_ready" });
    expect(parseModelResponse(200, provBody([]), RACE)).toEqual({ kind: "none", reason: "not_ready" });
  });

  it.each([
    ["p_win が 1 を超える", [{ umaban: 1, p_win: 1.1, odds_win: 5 }]],
    ["p_win が NaN", [{ umaban: 1, p_win: Number.NaN, odds_win: 5 }]],
    ["umaban が 0", [{ umaban: 0, p_win: 0.1, odds_win: 5 }]],
    ["umaban が小数", [{ umaban: 1.5, p_win: 0.1, odds_win: 5 }]],
    ["umaban が重複", [{ umaban: 1, p_win: 0.1, odds_win: 5 }, { umaban: 1, p_win: 0.1, odds_win: 5 }]],
    ["一部だけ不正", [{ umaban: 1, p_win: 0.1, odds_win: 5 }, { umaban: 2, p_win: -1, odds_win: 5 }]],
    ["馬がオブジェクトでない", ["x"]],
  ])("暫定: horses の %s は全体を unavailable にする", (_n, horses) => {
    expect(parseModelResponse(200, provBody(horses), RACE)).toEqual({ kind: "none", reason: "unavailable" });
  });

  it("暫定: horses が配列でないときは unavailable", () => {
    expect(parseModelResponse(200, provBody(undefined, { horses: "x" }), RACE)).toEqual({ kind: "none", reason: "unavailable" });
  });

  it("暫定: odds_taken_at_ms が null なら受ける(analysis)。文字列・NaN は unavailable", () => {
    const ok = parseModelResponse(200, provBody(provHorses(), { odds_source: "analysis", odds_lead_min: null, odds_taken_at_ms: null }), RACE);
    expect(ok.kind === "ok" && ok.provisional!.takenAtMs).toBeNull();
    expect(parseModelResponse(200, provBody(provHorses(), { odds_taken_at_ms: "1" }), RACE)).toEqual({ kind: "none", reason: "unavailable" });
    expect(parseModelResponse(200, provBody(provHorses(), { odds_taken_at_ms: Number.NaN }), RACE)).toEqual({ kind: "none", reason: "unavailable" });
  });

  it("ok の stage が final 以外(preday・未知)は unavailable", () => {
    expect(parseModelResponse(200, okBody(undefined, { stage: "provisional" }), RACE)).toEqual({ kind: "none", reason: "unavailable" });
    expect(parseModelResponse(200, okBody(undefined, { stage: "weird" }), RACE)).toEqual({ kind: "none", reason: "unavailable" });
  });

  it("暫定でない none(stage 無し)は今までどおり理由だけ", () => {
    expect(parseModelResponse(200, { race_id: RACE, status: "none", reason: "no_odds" }, RACE)).toEqual({ kind: "none", reason: "no_odds" });
  });
});

describe("#800 buildModelColumn(暫定)", () => {
  const prov = (extra: Record<string, unknown> = {}, horses: unknown[] = provHorses()) => parseModelResponse(200, provBody(horses, extra), RACE);

  it("暫定は応答の odds_win で掛ける。5 分前の単勝(別の値)は使わない", () => {
    const col = buildModelColumn(prov(), new Map([[1, 100], [2, 100]]));
    expect(col.status).toBe("ok");
    expect(col.stage).toBe("provisional");
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2, aux: { value: 0.3, rank: 1, of: 2 } });
    expect(col.byUmaban.get(2)).toEqual({ prob: 0.5, ev: 1.5, aux: { value: -0.1, rank: 2, of: 2 } });
  });

  it("暫定は 5 分前の記録が無い(null)でも掛ける", () => {
    expect(buildModelColumn(prov(), null).byUmaban.get(1)!.ev).toBe(2);
  });

  it("暫定: odds_win が正でない馬は掛け算だけ空欄", () => {
    const col = buildModelColumn(prov({}, [{ umaban: 1, p_win: 0.25, odds_win: 0, u_mat: 1 }, { umaban: 2, p_win: 0.5, odds_win: 3 }]), null);
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: null, aux: { value: 1, rank: 1, of: 1 } });
    expect(col.byUmaban.get(2)).toEqual({ prob: 0.5, ev: 1.5, aux: null });
  });

  it("確定は今までどおり 5 分前の単勝で掛け、補助を持つ", () => {
    const p = parseModelResponse(200, okBody([{ umaban: 1, p_win: 0.25, u_mat: -2 }]), RACE);
    const col = buildModelColumn(p, new Map([[1, 8]]));
    expect(col.stage).toBe("final");
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2, aux: { value: -2, rank: 1, of: 1 } });
  });

  it("計算なしの列の stage は null", () => {
    expect(buildModelColumn({ kind: "none", reason: "failed" }, null).stage).toBeNull();
  });

  it.each([
    ["lead-1", "前日の夜の単勝"],
    ["lead-2", "当日の朝の単勝"],
    ["lead10", "発走10分前の単勝"],
    ["analysis", "分析時の単勝"],
  ])("注記: odds_source %s は「%s」", (src, label) => {
    const col = buildModelColumn(prov({ odds_source: src }), null);
    expect(col.note).toContain(`計算に使ったオッズ: ${label}`);
    for (const [other, otherLabel] of [["lead-1", "前日の夜の単勝"], ["lead-2", "当日の朝の単勝"], ["lead10", "発走10分前の単勝"], ["analysis", "分析時の単勝"]]) {
      if (other !== src) expect(col.note).not.toContain(`計算に使ったオッズ: ${otherLabel}`);
    }
  });

  it("注記: 暫定であることと、取った時刻(JST)を書く", () => {
    const col = buildModelColumn(prov(), null);
    expect(col.note).toContain("暫定");
    expect(col.note).toContain("11/26 14:20");
  });

  it("注記: 時刻は JST に直す(UTC 15:30 は翌日 0:30)", () => {
    const col = buildModelColumn(prov({ odds_taken_at_ms: Date.UTC(2026, 10, 26, 15, 30) }), null);
    expect(col.note).toContain("11/27 00:30");
  });

  it("注記: 時刻が null なら時刻の部分を出さない", () => {
    const col = buildModelColumn(prov({ odds_source: "analysis", odds_taken_at_ms: null }), null);
    expect(col.note).toContain("分析時の単勝");
    expect(col.note).not.toMatch(/\d+\/\d+ \d+:\d+/);
  });

  it("注記: preday と provisional は文言が違う", () => {
    expect(buildModelColumn(prov({ stage: "preday" }), null).note).toContain("前日");
    expect(buildModelColumn(prov({ stage: "provisional" }), null).note).not.toContain("前日の計算");
  });
});

describe("#800 attachModel(暫定・補助)", () => {
  const view = { id: 1, horses: [{ umaban: 1 }, { umaban: 2 }] } as never;
  it("馬ごとに modelAux、全体に modelStage を足す", () => {
    const col: ModelColumn = { status: "ok", stage: "provisional", note: "n", byUmaban: new Map([[1, { prob: 0.2, ev: 1, aux: { value: 0.2, rank: 1, of: 3 } }]]) };
    const out = attachModel(view, col) as unknown as { horses: Record<string, unknown>[]; modelStage: string };
    expect(out.modelStage).toBe("provisional");
    expect(out.horses.map((h) => h["modelAux"])).toEqual([{ value: 0.2, rank: 1, of: 3 }, null]);
  });
  it("表に無い馬番の値も順位・頭数に数える(画面に出るのは表の馬だけ)", () => {
    const p = parseModelResponse(200, okBody([{ umaban: 1, p_win: 0.2, u_mat: 0.1 }, { umaban: 2, p_win: 0.2, u_mat: 0.5 }, { umaban: 9, p_win: 0.2, u_mat: 0.9 }]), RACE);
    const out = attachModel(view, buildModelColumn(p, null)) as unknown as { horses: Record<string, unknown>[] };
    expect(out.horses.map((h) => h["modelAux"])).toEqual([{ value: 0.1, rank: 3, of: 3 }, { value: 0.5, rank: 2, of: 3 }]);
  });
  it("計算なしは modelStage が null", () => {
    const col: ModelColumn = { status: "none", stage: null, note: "n", byUmaban: new Map() };
    expect((attachModel(view, col) as unknown as { modelStage: unknown }).modelStage).toBeNull();
  });
});

describe("#800 loadModelColumn(暫定)", () => {
  it("暫定は D1 の 5 分前の値ではなく odds_win で掛ける(D1 の読みは並列のまま呼ぶ)", async () => {
    let read = 0;
    const fetcher = { async fetch() { return Response.json(provBody(provHorses())); } } as unknown as Fetcher;
    const col = await loadModelColumn({ model: fetcher, readWinOdds: async () => (read++, new Map([[1, 100], [2, 100]])) }, RACE, () => undefined);
    expect(read).toBe(1);
    expect(col!.byUmaban.get(1)!.ev).toBe(2);
  });
});

/**
 * Issue #802: コースの参考情報(`course`・`course_fit`)の読み取りと、分析の応答への足し方。
 * 確率の状態とは独立(計算なしでも、course が正しく来ていれば出す)。応答そのものが不正(HTTP が 200 でない・race_id の違い・JSON でない)なら何も出さない。
 */
describe("コースの参考情報(Issue #802)", () => {
  const COURSE = { key: "05-T-1600-out", name: "東京 芝1600", similar_shape: [{ key: "06-T-2000-out", name: "中山 芝2000", s: 0.5 }], similar_results: [{ key: "09-D-1800-in", name: "阪神 ダ1800", s: 0.25, n: 12 }] };
  const FIT = { runs: 5, wins: 1, top3: 2, best: 1 };
  const FITS = { same: FIT, similar: { ...FIT, courses: ["x"] }, unknown_ring: 2 };
  const withCourse = (extra: Record<string, unknown> = {}) => okBody([{ umaban: 1, p_win: 0.25, course_fit: FITS }, { umaban: 2, p_win: 0.5 }], { course: COURSE, ...extra });

  describe("parseModelCourse", () => {
    it("ok: course と、馬番 → course_fit の表を作る(course_fit の無い馬は載せない)", () => {
      const info = parseModelCourse(200, withCourse(), RACE)!;
      expect(info.course!.name).toBe("東京 芝1600");
      expect([...info.fits.keys()]).toEqual([1]);
      expect(info.fits.get(1)).toEqual({ same: FIT, similar: FIT, unknownRing: 2 });
    });

    it("確率の状態とは独立: none(理由つき)・暫定の none でも、course が正しければ出る", () => {
      expect(parseModelCourse(200, { race_id: RACE, status: "none", reason: "not_ready", course: COURSE }, RACE)!.course!.name).toBe("東京 芝1600");
      expect(parseModelCourse(200, { race_id: RACE, status: "none", reason: "weird", course: COURSE }, RACE)!.course).not.toBeNull();
      const prov = { race_id: RACE, status: "none", reason: "not_ready", stage: "preday", odds_source: "lead-1", horses: [{ umaban: 1, p_win: 0.1, course_fit: FITS }], course: COURSE };
      const info = parseModelCourse(200, prov, RACE)!;
      expect(info.course).not.toBeNull();
      expect(info.fits.size).toBe(1);
    });

    it("確率の馬が崩れていて unavailable でも、course が正しければ出る(欄ごとに独立)", () => {
      const body = okBody([{ umaban: 1, p_win: 5 }], { course: COURSE });
      expect(parseModelResponse(200, body, RACE).kind).toBe("none");
      expect(parseModelCourse(200, body, RACE)!.course).not.toBeNull();
    });

    it.each([
      ["HTTP が 200 でない", 500, () => withCourse()],
      ["404", 404, () => withCourse()],
      ["race_id が違う", 200, () => withCourse({ race_id: "202603020212" })],
      ["本文が null(JSON でない)", 200, () => null],
      ["本文が配列", 200, () => [withCourse()]],
    ])("応答そのものが不正なら null: %s", (_label, status, body) => {
      expect(parseModelCourse(status, body(), RACE)).toBeNull();
    });

    it("course も course_fit も無い応答(今の版)は null", () => {
      expect(parseModelCourse(200, okBody(), RACE)).toBeNull();
      expect(parseModelCourse(200, { race_id: RACE, status: "none", reason: "not_ready" }, RACE)).toBeNull();
    });

    it("course が崩れていても course_fit は残る。course_fit が崩れた馬だけ落ちる", () => {
      const body = okBody([{ umaban: 1, p_win: 0.2, course_fit: FITS }, { umaban: 2, p_win: 0.2, course_fit: { ...FITS, unknown_ring: -1 } }], { course: { ...COURSE, key: "bad" } });
      const info = parseModelCourse(200, body, RACE)!;
      expect(info.course).toBeNull();
      expect([...info.fits.keys()]).toEqual([1]);
    });

    it("馬の umaban が不正な要素の course_fit は載せない", () => {
      const body = okBody([{ umaban: 0, p_win: 0.2, course_fit: FITS }, { umaban: 1.5, course_fit: FITS }, "x"], { course: COURSE });
      const info = parseModelCourse(200, body, RACE)!;
      expect(info.fits.size).toBe(0);
      expect(info.course).not.toBeNull();
    });

    it("崩れだけで足せるものが何も無ければ null", () => {
      expect(parseModelCourse(200, okBody([{ umaban: 1, p_win: 0.2, course_fit: { runs: 1 } }], { course: "x" }), RACE)).toBeNull();
    });
  });

  describe("attachCourse", () => {
    const view = { horses: [{ umaban: 1, name: "a" }, { umaban: 2, name: "b" }], other: 1 };

    it("情報が null なら、同じ view をそのまま返す(キーを増やさない)", () => {
      expect(attachCourse(view, null)).toBe(view);
    });

    it("course と、course_fit を持つ馬の courseFit だけを足す(元の view は変えない)", () => {
      const info = parseModelCourse(200, withCourse(), RACE)!;
      const out = attachCourse(view, info) as unknown as { course: { name: string }; horses: Record<string, unknown>[] };
      expect(out.course.name).toBe("東京 芝1600");
      expect(out.horses[0]!["courseFit"]).toEqual({ same: FIT, similar: FIT, unknownRing: 2 });
      expect(out.horses[1]).not.toHaveProperty("courseFit");
      expect(view).not.toHaveProperty("course");
      expect(view.horses[0]).not.toHaveProperty("courseFit");
    });

    it("course が無く馬の欄だけあるとき: course のキーは足さない", () => {
      const out = attachCourse(view, parseModelCourse(200, okBody([{ umaban: 1, p_win: 0.1, course_fit: FITS }]), RACE)!);
      expect(out).not.toHaveProperty("course");
      expect((out.horses[0] as Record<string, unknown>)["courseFit"]).toBeDefined();
    });
  });

  describe("loadModelResult(1 回の GET で、列とコースの両方)", () => {
    const fetcherOf = (handler: () => Response | Promise<Response>) => {
      const urls: string[] = [];
      const fetcher = {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          urls.push(`${new Request(input as string, init).method} ${new URL(new Request(input as string, init).url).pathname}`);
          return handler();
        },
      } as unknown as Fetcher;
      return { fetcher, urls };
    };
    const winOdds = async () => new Map([[1, 8], [2, 3]]);

    it("GET は 1 回。列(確率 × 単勝)と、コースの両方が返る", async () => {
      const { fetcher, urls } = fetcherOf(() => Response.json(withCourse()));
      const r = await loadModelResult({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
      expect(urls).toEqual([`GET /v1/races/${RACE}`]);
      expect(r!.column.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2, aux: null });
      expect(r!.course!.course!.name).toBe("東京 芝1600");
    });

    it("計算なしでもコースは出る", async () => {
      const { fetcher } = fetcherOf(() => Response.json({ race_id: RACE, status: "none", reason: "not_ready", course: COURSE }));
      const r = await loadModelResult({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
      expect(r!.column.status).toBe("none");
      expect(r!.course!.course).not.toBeNull();
    });

    it("500・例外・JSON でない・時間切れは、コース無し(列は unavailable)", async () => {
      for (const handler of [() => Response.json(withCourse(), { status: 500 }), () => new Response("<html>"), () => { throw new Error("x"); }]) {
        const { fetcher } = fetcherOf(handler);
        const r = await loadModelResult({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
        expect(r!.column.status).toBe("none");
        expect(r!.course).toBeNull();
      }
    });

    it("MODEL が無い・地方は null(何も呼ばない)", async () => {
      expect(await loadModelResult({ model: undefined, readWinOdds: winOdds }, RACE, () => undefined)).toBeNull();
      const { fetcher, urls } = fetcherOf(() => Response.json(withCourse()));
      expect(await loadModelResult({ model: fetcher, readWinOdds: winOdds }, "202644062911", () => undefined)).toBeNull();
      expect(urls).toEqual([]);
    });

    it("欄の無い今の版の応答: course は null(従来と同じ)", async () => {
      const { fetcher } = fetcherOf(() => Response.json(okBody()));
      const r = await loadModelResult({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
      expect(r!.course).toBeNull();
      expect(r!.column.status).toBe("ok");
    });
  });
});
