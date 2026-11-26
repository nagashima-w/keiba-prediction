import { describe, expect, it } from "vitest";
import {
  attachModel,
  buildModelColumn,
  loadModelColumn,
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
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2 });
    expect(col.byUmaban.get(2)).toEqual({ prob: 0.5, ev: 1.5 });
  });

  it("5 分前の単勝が無い馬は確率だけで掛け算は null", () => {
    const col = buildModelColumn(ok, new Map([[1, 8]]));
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2 });
    expect(col.byUmaban.get(2)).toEqual({ prob: 0.5, ev: null });
  });

  it("5 分前の記録が無い(null)ときは全馬で掛け算が null。注記に書く", () => {
    const col = buildModelColumn(ok, null);
    expect(col.byUmaban.get(1)).toEqual({ prob: 0.25, ev: null });
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
    const col: ModelColumn = { status: "ok", note: "注記", byUmaban: new Map([[1, { prob: 0.2, ev: 1.6 }], [2, { prob: 0.3, ev: null }]]) };
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
    expect(col!.byUmaban.get(1)).toEqual({ prob: 0.25, ev: 2 });
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
    expect(col!.byUmaban.get(1)).toEqual({ prob: 0.25, ev: null });
  });

  it("計算なし(none)のときは、列は全馬 —", async () => {
    const { fetcher } = fetcherOf(() => Response.json({ race_id: RACE, status: "none", reason: "not_ready" }));
    const col = await loadModelColumn({ model: fetcher, readWinOdds: winOdds }, RACE, () => undefined);
    expect(col!.status).toBe("none");
    expect(col!.byUmaban.size).toBe(0);
  });
});
