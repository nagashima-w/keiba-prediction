import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CONDITIONAL_BERNOULLI_MODEL } from "../../packages/core/src/ev/place-joint-model.js";
import { PLACKETT_LUCE_MODEL } from "../../packages/core/src/ev/plackett-luce-model.js";
import { DEFAULT_KELLY_FRACTION, resolveBankroll, resolveEffectivePerRaceCap, resolveMinHitProb, resolveKellyFraction } from "../../packages/core/src/ev/allocation-primitives.js";
import { collectProposedBetEvents, computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import { buildVerifySource, type VerifyReadRows } from "../../cloud/src/verify-read.js";
import {
  ALLOCATION_EXPORT_FORMAT,
  buildAllocationHead,
  buildAllocationRaceRow,
  encodeAllocationChunk,
  type AllocationBetInput,
  type AllocationExcludedCounts,
  type AllocationMetaInput,
  type AllocationRaceRow,
  type AllocationResultInput,
  type AllocationRowBet,
  type ChosenAllocationAnalysis,
} from "../../cloud/src/allocation-export-format.js";
import {
  classifyReplay,
  compareReplay,
  driftedConstants,
  judgeRaceBets,
  parseAllocationDataset,
  parseOverrides,
  payoutReport,
  replayableRows,
  replayedBets,
  describeOverrides,
  REPLAY_MODELS,
  replayRace,
  runCli,
  storedBets,
  summarize,
  summarizePayouts,
  summarizeReplay,
  type ReplayOutcome,
  type PayoutSummary,
  type ReplayOverrides,
} from "../allocation-dataset.js";

/**
 * Issue #463: 開発側のローダ(`scripts/allocation-dataset.ts`)。読み込みの検証(黙って捨てない)・払戻の判定が検証画面と同じ結果になること・計算し直しの比較の骨格。
 * 実データに近い往復(runAnalysis → D1 → 書き出し → ローダ → 計算し直し)は `cloud/test/allocation-export-roundtrip.test.ts`。ここは合成した行だけで、ネットワークにも D1 にも触れない。
 */

const EXCLUDED: AllocationExcludedCounts = { suspect: 0, unknown: 0, unchecked: 0, uncheckedRaces: 0, superseded: 0, estimated: 0 };
const RACE_ID = "202606030811";

const CHOSEN: ChosenAllocationAnalysis = {
  id: 7, raceId: RACE_ID, analyzedAt: "2026-07-05T00:00:00.000Z", kaisaiDate: "20260705", promptVersion: null, detailKey: "analyses/7.json.gz", promptLookaheadGuarded: true, leakClass: "guarded",
};

const META: AllocationMetaInput = {
  route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: "present", comboOddsTrio: "present",
  bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: 1, includeWide: 1, includeTrio: 1,
  includeQuinella: 1, includeExacta: 1, includeTrifecta: 1, includeBracketQuinella: 1, betUnit: 100, greedySteps: 1000, candidateCap: 2000,
  modelId: "plackett-luce", modelApproximate: 0, oddsStatus: "result", minHitProb: 0, belowFloorCount: null, missedJson: null,
};

const HORSES = Array.from({ length: 6 }, (_, k) => ({ umaban: k + 1, prior: 0.3, adjustedProb: 0.3, placeOddsMin: 2, ev: 1.1 }));
const SNAPSHOT = {
  present: true,
  race: { course_type: "芝", distance: 1600, grade: null },
  horses: new Map(HORSES.map((h) => [h.umaban, { wakuban: h.umaban, win_odds: 5 + h.umaban, ninki: h.umaban, place_min: 1.5, place_max: 2.5 }] as const)),
  combos: { wide: { "0102": 8, "0103": 9 } },
  comboStates: { wide: "available" as const },
};

function rowWith(over: Partial<Parameters<typeof buildAllocationRaceRow>[0]> = {}): AllocationRaceRow {
  return buildAllocationRaceRow({
    analysis: CHOSEN, horses: HORSES, snapshot: SNAPSHOT, meta: META,
    bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 2, ev: 1.1 }],
    results: HORSES.map((h) => ({ umaban: h.umaban, finishPosition: h.umaban, placePayout: null, winPayout: null, scratched: 0, wakuban: h.umaban, winOdds: null, ninki: null })),
    payouts: [], imports: [], ...over,
  });
}

/** 書き出しのファイルのバイト列(メタ行 + 塊)。 */
function fileOf(rows: readonly AllocationRaceRow[], metaOver: Record<string, unknown> = {}): Uint8Array {
  const head = buildAllocationHead({ generatedAt: "2026-10-26T03:00:00.000Z", rows: rows.length, races: rows.length, missingOdds: 0, noAllocation: 0, excluded: EXCLUDED });
  const chunk = encodeAllocationChunk(rows);
  if (Object.keys(metaOver).length === 0) return Buffer.concat([head, chunk]);
  const text = new TextDecoder().decode(gunzipSync(head)).trimEnd();
  const meta = JSON.parse(text) as { _meta: Record<string, unknown> };
  return Buffer.concat([gzipSync(`${JSON.stringify({ _meta: { ...meta._meta, ...metaOver } })}\n`), chunk]);
}

const gz = (text: string): Uint8Array => gzipSync(text);

describe("parseAllocationDataset(読み込みの検証。黙って捨てない)", () => {
  it("書き出しの形式のファイルを、型つきの行として読む(メタ行と、1 行 1 レースの行)。複数メンバーの gzip の連結を 1 回で読める", () => {
    const rows = [rowWith(), rowWith({ analysis: { ...CHOSEN, id: 8, raceId: "202606030812" } })];
    const loaded = parseAllocationDataset(fileOf(rows));
    expect(loaded.meta).toMatchObject({ format: ALLOCATION_EXPORT_FORMAT, rows: 2, races: 2 });
    expect(loaded.rows).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(loaded.rows))).toEqual(JSON.parse(JSON.stringify(rows)));
    expect(summarize(loaded.rows)).toEqual({ races: 2, byVenueKind: { central: 2, nar: 0 }, withoutOdds: 0, withoutAllocation: 0 });
  });

  it("読めない版・メタ行の無いファイル・壊れた行・件数の食い違いは、理由つきの例外にする", () => {
    const good = rowWith();
    expect(() => parseAllocationDataset(fileOf([good], { format: ALLOCATION_EXPORT_FORMAT + 1 }))).toThrow(/読めない版/);
    expect(() => parseAllocationDataset(gz(`${JSON.stringify(good)}\n`))).toThrow(/メタ行/);
    expect(() => parseAllocationDataset(gz(""))).toThrow(/メタ行/);
    expect(() => parseAllocationDataset(fileOf([good], { rows: 2 }))).toThrow(/件数が合いません/);
    const head = `${JSON.stringify({ _meta: { format: ALLOCATION_EXPORT_FORMAT, rows: 1 } })}\n`;
    expect(() => parseAllocationDataset(gz(`${head}{broken\n`))).toThrow(/2 行目が JSON ではありません/);
  });

  const metaLine = (rows: number): string => `${JSON.stringify({ _meta: { format: ALLOCATION_EXPORT_FORMAT, rows } })}\n`;
  const fileWithRow = (row: unknown): Uint8Array => gz(`${metaLine(1)}${JSON.stringify(row)}\n`);
  const mutate = (change: (row: Record<string, any>) => void): Record<string, any> => {
    const copy = JSON.parse(JSON.stringify(rowWith())) as Record<string, any>;
    change(copy);
    return copy;
  };

  it("列の過不足(どの階層でも)と型の違いは、行番号と列名つきの例外。前提として元の行は読める", () => {
    expect(() => parseAllocationDataset(fileWithRow(JSON.parse(JSON.stringify(rowWith()))))).not.toThrow();
    const cases: Array<[string, (row: Record<string, any>) => void, RegExp]> = [
      ["行に知らない列", (r) => { r["extra"] = 1; }, /2 行目: 行 に知らない列があります\(extra\)/],
      ["行の列が足りない", (r) => { delete r["grade"]; }, /行 の列が足りません\(grade\)/],
      ["race_id の型", (r) => { r["race_id"] = 1; }, /型が違います\(race_id\)/],
      ["venue_kind の値", (r) => { r["venue_kind"] = "x"; }, /型が違います\(venue_kind\)/],
      ["has_odds の型", (r) => { r["has_odds"] = 1; }, /型が違います\(has_odds\)/],
      ["combos の値", (r) => { r["combos"] = { wide: { "0102": "x" } }; }, /型が違います\(combos\)/],
      ["馬の列", (r) => { delete r["horses"][0]["prior"]; }, /horses\[0\] の列が足りません\(prior\)/],
      ["馬の型", (r) => { r["horses"][0]["adjusted_prob"] = "0.3"; }, /horses\[0\] の型が違います/],
      ["馬のオッズの型", (r) => { r["horses"][1]["win_odds"] = "5"; }, /horses\[1\]\.win_odds の型が違います/],
      ["allocation の列", (r) => { r["allocation"]["extra"] = 1; }, /allocation に知らない列があります\(extra\)/],
      ["settings の列", (r) => { delete r["allocation"]["settings"]["bankroll"]; }, /allocation\.settings の列が足りません\(bankroll\)/],
      ["settings の型", (r) => { r["allocation"]["settings"]["kelly_fraction"] = null; }, /allocation\.settings の数の列の型が違います/],
      ["codes の列", (r) => { r["allocation"]["codes"]["extra"] = 1; }, /allocation\.codes に知らない列があります\(extra\)/],
      ["買い目の型", (r) => { r["allocation"]["bets"][0]["stake"] = "300"; }, /allocation\.bets\[0\] の型が違います/],
      ["買い目の列", (r) => { r["allocation"]["bets"][0]["extra"] = 1; }, /allocation\.bets\[0\] に知らない列があります\(extra\)/],
      ["結果の馬の型", (r) => { r["result"]["horses"][0]["scratched"] = 1; }, /result\.horses\[0\] の型が違います/],
      ["払戻の形", (r) => { r["result"]["combo_payouts"] = { wide: [["0102"]] }; }, /result\.combo_payouts の形が違います/],
      ["取込印の形", (r) => { r["result"]["payout_imports"] = [1]; }, /result\.payout_imports の形が違います/],
    ];
    for (const [name, change, pattern] of cases) {
      expect(() => parseAllocationDataset(fileWithRow(mutate(change))), name).toThrow(pattern);
    }
  });

  it("allocation が null(配分の記録なし)の行は読める", () => {
    const row = rowWith({ meta: null, bets: [] });
    expect(parseAllocationDataset(fileOf([row])).rows[0]!.allocation).toBeNull();
    expect(summarize([row])).toMatchObject({ withoutAllocation: 1 });
  });
});

describe("replayRace(計算し直しの入口)", () => {
  it("配分のメタ行が無い分析は no-allocation-record、分析時点のオッズを再構成できない行は no-odds(どちらも計算せず、例外にもしない)", () => {
    expect(replayRace(rowWith({ meta: null, bets: [] }))).toEqual({ kind: "no-allocation-record" });
    expect(replayRace(rowWith({ snapshot: null }))).toEqual({ kind: "no-odds" });
  });
});

describe("compareReplay(計算し直した配分と、分析時に保存した提案の完全一致の比較)", () => {
  /** 計算し直しの結果の代役(比較に使う部分だけ)。保存した提案と同じにして、1 項目ずつ変える。 */
  function fakeReplay(row: AllocationRaceRow, patch: { bets?: AllocationBetInput[]; meta?: Record<string, unknown> } = {}): Extract<ReplayOutcome, { kind: "replayed" }> {
    const stored = row.allocation!;
    const meta = {
      route: stored.codes.route, unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: stored.codes.combo_odds_wide, comboOddsTrio: stored.codes.combo_odds_trio,
      betUnit: stored.codes.bet_unit, greedySteps: stored.codes.greedy_steps, candidateCap: stored.codes.candidate_cap, modelId: stored.codes.model_id, modelApproximate: stored.codes.model_approximate,
      belowFloorCount: stored.codes.below_floor_count, ...patch.meta,
    };
    const bets = patch.bets ?? stored.bets.map((b) => ({ betType: b.bet_type, comboKey: b.combo_key, stake: b.stake, odds: b.odds, ev: b.ev }));
    return {
      kind: "replayed",
      result: {
        allocation: { meta, bets },
        rows: row.horses.map((h) => ({ umaban: h.umaban, placeOddsMin: h.place_odds_min, ev: h.ev })),
      },
    } as unknown as Extract<ReplayOutcome, { kind: "replayed" }>;
  }

  const row = rowWith({
    bets: [{ betType: "place", comboKey: "01", stake: 300, odds: 2, ev: 1.1 }, { betType: "exacta", comboKey: "0201", stake: 100, odds: 15, ev: 1.3 }],
  });

  it("同じなら一致(差分なし)。前提として比べる提案は 2 件ある", () => {
    expect(row.allocation!.bets).toHaveLength(2);
    expect(compareReplay(row, fakeReplay(row))).toEqual({ same: true, differences: [] });
  });

  it("金額・券種のキー(馬単の逆順は別の買い目)・オッズ・EV・配分のコード・馬の EV の食い違いを、それぞれ検出する", () => {
    const bets = (patch: (b: AllocationBetInput[]) => AllocationBetInput[]): AllocationBetInput[] =>
      patch(row.allocation!.bets.map((b) => ({ betType: b.bet_type, comboKey: b.combo_key, stake: b.stake, odds: b.odds, ev: b.ev })));
    const cases: Array<[string, ReturnType<typeof fakeReplay>, RegExp]> = [
      ["金額", fakeReplay(row, { bets: bets((b) => b.map((x, i) => (i === 0 ? { ...x, stake: 400 } : x))) }), /place:01 の金額が違う\(300 → 400\)/],
      ["買い目が足りない", fakeReplay(row, { bets: bets((b) => b.slice(0, 1)) }), /exacta:0201 が計算し直しに無い/],
      ["買い目が多い", fakeReplay(row, { bets: bets((b) => [...b, { betType: "win", comboKey: "03", stake: 100, odds: 9, ev: 1.2 }]) }), /win:03 が分析時に無い/],
      ["馬単の逆順", fakeReplay(row, { bets: bets((b) => b.map((x) => (x.betType === "exacta" ? { ...x, comboKey: "0102" } : x))) }), /exacta:0201 が計算し直しに無い/],
      ["オッズ", fakeReplay(row, { bets: bets((b) => b.map((x, i) => (i === 1 ? { ...x, odds: 16 } : x))) }), /exacta:0201 のオッズか EV が違う/],
      ["EV", fakeReplay(row, { bets: bets((b) => b.map((x, i) => (i === 1 ? { ...x, ev: 1.31 } : x))) }), /exacta:0201 のオッズか EV が違う/],
      ["route", fakeReplay(row, { meta: { route: "invalid" } }), /route が違う\(mixed → invalid\)/],
      ["bet_unit", fakeReplay(row, { meta: { betUnit: 10 } }), /bet_unit が違う\(100 → 10\)/],
      ["model_id", fakeReplay(row, { meta: { modelId: "conditional-bernoulli" } }), /model_id が違う/],
    ];
    for (const [name, replay, pattern] of cases) {
      const cmp = compareReplay(row, replay);
      expect(cmp.same, name).toBe(false);
      expect(cmp.differences.join("\n"), name).toMatch(pattern);
    }
    const horseOff = fakeReplay(row);
    (horseOff.result.rows as unknown as Array<{ ev: number | null }>)[0]!.ev = 9;
    expect(compareReplay(row, horseOff).differences.join("\n")).toMatch(/馬 1 の複勝下限か EV が違う/);
  });
});

describe("judgeRaceBets(払戻の判定。検証画面と同じ規則〈createRaceBetJudge〉)", () => {
  // 6 頭・各馬が別の枠。6 番は取消(6 枠は出走馬が尽きる)。複勝・単勝の払戻は 1・2・3 着の馬だけ。ワイドは取込済み、馬単は取込済みで 0 件、三連複は未取込。
  const resultHorses: AllocationResultInput[] = HORSES.map((h) => ({
    umaban: h.umaban, finishPosition: h.umaban === 6 ? null : h.umaban, placePayout: h.umaban <= 3 ? 110 + h.umaban * 10 : null, winPayout: h.umaban === 1 ? 420 : null,
    scratched: h.umaban === 6 ? 1 : 0, wakuban: h.umaban, winOdds: null, ninki: null,
  }));
  const payouts = [{ betType: "wide", comboKey: "0102", payout: 180 }, { betType: "bracketQuinella", comboKey: "0203", payout: 640 }];
  const imports = ["wide", "exacta", "bracketQuinella"];
  const bets: AllocationBetInput[] = [
    { betType: "place", comboKey: "01", stake: 300, odds: 2, ev: 1.1 }, // 複勝の的中
    { betType: "place", comboKey: "04", stake: 200, odds: 2, ev: 1.1 }, // 複勝の外れ
    { betType: "place", comboKey: "06", stake: 100, odds: 2, ev: 1.1 }, // 取消の馬 → 返還
    { betType: "win", comboKey: "01", stake: 500, odds: 4, ev: 1.1 }, // 単勝の的中
    { betType: "win", comboKey: "02", stake: 100, odds: 4, ev: 1.1 }, // 単勝の外れ
    { betType: "wide", comboKey: "0102", stake: 200, odds: 8, ev: 1.1 }, // ワイドの的中
    { betType: "wide", comboKey: "0103", stake: 100, odds: 8, ev: 1.1 }, // ワイドの外れ(取込済みで払戻がある表に無い)
    { betType: "wide", comboKey: "0106", stake: 100, odds: 8, ev: 1.1 }, // 取消の馬を含む → 返還
    { betType: "exacta", comboKey: "0102", stake: 100, odds: 8, ev: 1.1 }, // 取込済みだが払戻 0 件 → 判定不能
    { betType: "trio", comboKey: "010203", stake: 100, odds: 8, ev: 1.1 }, // 未取込 → 判定不能
    { betType: "bracketQuinella", comboKey: "0203", stake: 100, odds: 8, ev: 1.1 }, // 枠連の的中
    { betType: "bracketQuinella", comboKey: "0106", stake: 100, odds: 8, ev: 1.1 }, // 6 枠の出走馬が尽きた → 返還
  ];

  /** 同じ入力を、検証画面の読み取り口(`buildVerifySource`)にも入れる。 */
  function verifyRows(): VerifyReadRows {
    return {
      analyses: [{
        id: 7, raceId: RACE_ID, analyzedAt: CHOSEN.analyzedAt, evEstimated: 0, promptVersion: null, additionalInstruction: null, kaisaiDate: "20260705", model: null, rawResponse: null,
        raceSnapshotJson: null, historyCutoffDate: "20260704", promptLookaheadGuarded: 1, startTime: "15:45",
      }],
      horses: [],
      allocationMeta: [{ analysisId: 7, route: "mixed", skipReasonCode: null }],
      bets: bets.map((b) => ({ analysisId: 7, betType: b.betType, comboKey: b.comboKey, stake: b.stake })),
      results: resultHorses.map((r) => ({ raceId: RACE_ID, umaban: r.umaban, finishPosition: r.finishPosition, placePayout: r.placePayout, winPayout: r.winPayout, scratched: r.scratched, wakuban: r.wakuban })),
      comboPayouts: payouts.map((p) => ({ raceId: RACE_ID, betType: p.betType, comboKey: p.comboKey, payout: p.payout })),
      comboImports: imports.map((betType) => ({ raceId: RACE_ID, betType })),
    };
  }

  const row = rowWith({ bets, results: resultHorses, payouts, imports });
  const judged = judgeRaceBets(row, row.allocation!.bets);

  it("前提(空振り防止): 判定が的中・外れ・返還・判定不能の 4 種類すべてを含み、的中の払戻が 0 でない", () => {
    expect(judged).toHaveLength(bets.length);
    const outcomes = new Set(judged.map((j) => j.judgment.outcome));
    expect([...outcomes].sort()).toEqual(["hit", "miss", "refund", "unjudged"]);
    expect(judged.filter((j) => j.judgment.outcome === "hit").every((j) => j.payout > 0)).toBe(true);
    expect(judged.filter((j) => j.judgment.outcome === "refund")).toHaveLength(3);
  });

  it("買い目ごとの判定と払戻が、検証画面(collectProposedBetEvents。本番の設定)の事象と一致する", () => {
    const events = collectProposedBetEvents(buildVerifySource(verifyRows()), PRODUCTION_VERIFY_CONFIG);
    expect(events).toHaveLength(bets.length);
    const byKey = new Map(events.map((e) => [`${e.betType}:${e.comboKey}`, e] as const));
    for (const j of judged) {
      const e = byKey.get(`${j.bet.bet_type}:${j.bet.combo_key}`);
      expect(e, `${j.bet.bet_type}:${j.bet.combo_key} の事象がある`).toBeDefined();
      expect(j.judgment.outcome, `${j.bet.bet_type}:${j.bet.combo_key}`).toBe(e!.outcome);
      expect(j.payout, `${j.bet.bet_type}:${j.bet.combo_key}`).toBe(e!.payout);
    }
  });

  it("入力が効いている: 取消の記録(scratched)を NULL に落とすと返還の判定が変わり、取込印を落とすと判定不能に変わる", () => {
    const unknownScratch = rowWith({ bets, results: resultHorses.map((r) => ({ ...r, scratched: null })), payouts, imports });
    const refunds = (r: AllocationRaceRow): number => judgeRaceBets(r, r.allocation!.bets).filter((j) => j.judgment.outcome === "refund").length;
    expect(refunds(row)).toBe(3);
    expect(refunds(unknownScratch)).toBe(0); // 取消の記録が無ければ、返還とは決めない(外れとして数える)
    const noImports = rowWith({ bets, results: resultHorses, payouts, imports: [] });
    const unjudged = (r: AllocationRaceRow): number => judgeRaceBets(r, r.allocation!.bets).filter((j) => j.judgment.outcome === "unjudged").length;
    expect(unjudged(row)).toBe(2);
    expect(unjudged(noImports)).toBeGreaterThan(unjudged(row));
  });
});

// ---------------------------------------------------------------------------

// 計算し直しの試験用の合成の 1 レース(8 頭・全 6 券種の組合せオッズつき)。NULL の解釈・上書き・理由の分類の各テストで共有する。
// 8 頭・全 6 券種の組合せオッズつきの合成の1レース。確率は大穴(0.03・0.02)まで含め、EV が 1 を超える馬が複数いるので、
// 下限・券種の ON/OFF・枠番が配分を実際に変える(下の前提のテストで固定している)。
const P = [0.9, 0.8, 0.7, 0.25, 0.2, 0.1, 0.03, 0.02];
const PLACE = [1.1, 1.15, 1.2, 4.5, 6.5, 12, 50, 80];
const pad = (n: number): string => String(n).padStart(2, "0");
const combos = (() => {
  const out: Record<string, Record<string, number>> = { wide: {}, trio: {}, quinella: {}, exacta: {}, trifecta: {}, bracketQuinella: {} };
  for (let a = 1; a <= 8; a += 1) {
    for (let b = 1; b <= 8; b += 1) {
      if (a < b) out["wide"]![pad(a) + pad(b)] = 30;
      if (a < b) out["quinella"]![pad(a) + pad(b)] = 30;
      if (a !== b) out["exacta"]![pad(a) + pad(b)] = 60;
      if (a <= b) out["bracketQuinella"]![pad(a) + pad(b)] = 40;
      for (let c = 1; c <= 8; c += 1) {
        if (a < b && b < c) out["trio"]![pad(a) + pad(b) + pad(c)] = 100;
        if (a !== b && b !== c && a !== c) out["trifecta"]![pad(a) + pad(b) + pad(c)] = 400;
      }
    }
  }
  return out;
})();

type Settings = Partial<AllocationMetaInput>;
/** 分析時に保存した値(買い目・配分のコード・馬ごとの複勝下限と EV・分析の識別)の差し替え。`settings` で作った行に、保存側だけ別の値を持たせるときに使う。 */
interface RowOverride {
  readonly meta?: Partial<AllocationMetaInput>;
  readonly bets?: AllocationBetInput[];
  readonly horseValues?: ReadonlyMap<number, { readonly placeOddsMin: number | null; readonly ev: number | null }>;
  readonly analysis?: ChosenAllocationAnalysis;
  /** 結果・払戻・取込印の差し替え(回収額のテスト用)。 */
  readonly results?: AllocationResultInput[];
  readonly payouts?: Array<{ betType: string; comboKey: string; payout: number }>;
  readonly imports?: string[];
}

/** `wakuban.snapshot`: 分析時のスナップショットの枠番(false なら NULL)。`wakuban.result`: 結果の枠番(false なら NULL)。 */
function raceRow(settings: Settings, wakuban: { snapshot?: boolean; result?: boolean } = {}, stored: RowOverride = {}): AllocationRaceRow {
  const meta: AllocationMetaInput = {
    ...META, comboOddsWide: "present", comboOddsTrio: null, bankroll: 100_000, perRaceCap: 20_000, kellyFraction: 0.5, evThreshold: 1, includeComboOdds: 1,
    includeWide: 0, includeTrio: 0, includeQuinella: 0, includeExacta: 0, includeTrifecta: 0, includeBracketQuinella: 0, minHitProb: 0, ...settings, ...stored.meta,
  };
  return buildAllocationRaceRow({
    analysis: stored.analysis ?? CHOSEN,
    horses: P.map((p, i) => ({ umaban: i + 1, prior: p, adjustedProb: p, placeOddsMin: stored.horseValues?.get(i + 1)?.placeOddsMin ?? PLACE[i]!, ev: stored.horseValues?.get(i + 1)?.ev ?? null })),
    snapshot: {
      present: true,
      race: { course_type: "芝", distance: 1600, grade: null },
      horses: new Map(P.map((_, i) => [i + 1, { wakuban: wakuban.snapshot === false ? null : i + 1, win_odds: 10, ninki: i + 1, place_min: PLACE[i]!, place_max: PLACE[i]! + 1 }] as const)),
      combos,
      comboStates: {},
    },
    meta,
    bets: stored.bets ?? [],
    results: stored.results ?? P.map((_, i) => ({ umaban: i + 1, finishPosition: i + 1, placePayout: null, winPayout: null, scratched: 0, wakuban: wakuban.result === false ? null : i + 1, winOdds: null, ninki: null })),
    payouts: stored.payouts ?? [],
    imports: stored.imports ?? [],
  });
}

/** 計算し直した提案(route と買い目の券種・キー・金額)。 */
function replayed(row: AllocationRaceRow, overrides?: ReplayOverrides): { route: string; bets: string[] } {
  const outcome = replayRace(row, overrides);
  expect(outcome.kind).toBe("replayed");
  const allocation = (outcome as Extract<ReplayOutcome, { kind: "replayed" }>).result.allocation;
  return { route: allocation.meta.route, bets: allocation.bets.map((b) => `${b.betType}:${b.comboKey}=${b.stake}`) };
}

const INCLUDE_COLUMNS = ["includeWide", "includeTrio", "includeQuinella", "includeExacta", "includeTrifecta", "includeBracketQuinella"] as const;
const KIND_OF: Record<(typeof INCLUDE_COLUMNS)[number], string> = {
  includeWide: "wide", includeTrio: "trio", includeQuinella: "quinella", includeExacta: "exacta", includeTrifecta: "trifecta", includeBracketQuinella: "bracketQuinella",
};

describe("replayRace が D1 の NULL を読む規則(書き出しは NULL のまま。読み手が解釈する): min_hit_prob の NULL は 0、include_* の NULL は OFF、枠番は結果の枠番で補う", () => {
  it("前提(空振り防止): 下限 0 / 0.05 / 0.25 で提案が互いに違い、券種を ON にすると、その券種の買い目が出て提案が変わり、枠連が配分に入る設定の route は mixed", () => {
    const floors = [0, 0.05, 0.25].map((minHitProb) => replayed(raceRow({ includeComboOdds: 0, minHitProb })).bets.join(","));
    expect(new Set(floors).size).toBe(3);
    expect(floors.every((f) => f.length > 0)).toBe(true);
    for (const column of INCLUDE_COLUMNS) {
      const off = replayed(raceRow({ [column]: 0 }));
      const on = replayed(raceRow({ [column]: 1 }));
      expect(on.route, column).toBe("mixed");
      expect(on.bets.some((b) => b.startsWith(`${KIND_OF[column]}:`)), column).toBe(true);
      expect(off.bets.some((b) => b.startsWith(`${KIND_OF[column]}:`)), column).toBe(false);
      expect(on.bets.join(","), column).not.toBe(off.bets.join(","));
    }
    expect(replayed(raceRow({ includeWide: 1, includeComboOdds: 0 })).route).toBe("place-only"); // 組合せオッズを取得しない設定では、組合せ券種が ON でも複勝だけの経路
  });

  it("min_hit_prob が NULL(Issue #470 より前の行)は、下限なし(0)として計算し直す。0.05 とも 0.25 とも違う", () => {
    for (const include of [{ includeComboOdds: 0 }, { includeWide: 1 }] as const) {
      const asNull = replayed(raceRow({ ...include, minHitProb: null }));
      expect(asNull).toEqual(replayed(raceRow({ ...include, minHitProb: 0 })));
      expect(asNull.bets.join(",")).not.toBe(replayed(raceRow({ ...include, minHitProb: 0.05 })).bets.join(","));
      expect(asNull.bets.join(",")).not.toBe(replayed(raceRow({ ...include, minHitProb: 0.25 })).bets.join(","));
    }
  });

  it("include_* の NULL(旧い行)は OFF として計算し直す(6 券種それぞれ。ON とは違う)。include_combo_odds の NULL も OFF(組合せ券種が ON でも複勝だけの経路)", () => {
    for (const column of INCLUDE_COLUMNS) {
      expect(replayed(raceRow({ [column]: null })), column).toEqual(replayed(raceRow({ [column]: 0 })));
      expect(replayed(raceRow({ [column]: null })).bets.join(","), column).not.toBe(replayed(raceRow({ [column]: 1 })).bets.join(","));
    }
    const comboNull = replayed(raceRow({ includeWide: 1, includeComboOdds: null }));
    expect(comboNull).toEqual(replayed(raceRow({ includeWide: 1, includeComboOdds: 0 })));
    expect(comboNull.route).toBe("place-only");
    expect(comboNull.bets.join(",")).not.toBe(replayed(raceRow({ includeWide: 1, includeComboOdds: 1 })).bets.join(","));
  });

  it("分析時のスナップショットに枠番が無い馬は、結果の枠番で補って計算し直す(枠連の買い目が出て、枠番が入っているときと同じ提案)。どちらにも無ければ、枠連が配分に入る設定のときだけ route が invalid", () => {
    const withBoth = replayed(raceRow({ includeBracketQuinella: 1 }));
    expect(withBoth.route).toBe("mixed");
    expect(withBoth.bets.some((b) => b.startsWith("bracketQuinella:"))).toBe(true);
    const filled = replayed(raceRow({ includeBracketQuinella: 1 }, { snapshot: false }));
    expect(filled).toEqual(withBoth);
    const neither = replayed(raceRow({ includeBracketQuinella: 1 }, { snapshot: false, result: false }));
    expect(neither.route).toBe("invalid");
    expect(neither.bets).toEqual([]);
    // 枠連が配分に入らない設定では、枠番は結果に影響しない
    expect(replayed(raceRow({ includeWide: 1 }, { snapshot: false, result: false }))).toEqual(replayed(raceRow({ includeWide: 1 })));
  });
});

// ---------------------------------------------------------------------------
// Issue #494: 設定の上書き・理由別の一致率・回収額・CLI
// ---------------------------------------------------------------------------

const ALL_ON: Settings = { includeWide: 1, includeTrio: 1, includeQuinella: 1, includeExacta: 1, includeTrifecta: 1, includeBracketQuinella: 1 };
const NAR_ANALYSIS: ChosenAllocationAnalysis = { ...CHOSEN, id: 20, raceId: "202654071210", kaisaiDate: null, detailKey: "analyses/20.json.gz" };
const betString = (r: { bets: string[] }): string => r.bets.join(",");

/**
 * 分析時の提案が、計算し直しと完全に一致する行。`settings` で計算し直した提案(買い目・配分のコード・馬ごとの複勝下限と EV)を保存側に写す。
 * `stored` で保存側だけ変える(設定の NULL・配分のコードの食い違い・買い目の改変)。
 */
function consistentRow(settings: Settings, wakuban: { snapshot?: boolean; result?: boolean } = {}, stored: RowOverride = {}): AllocationRaceRow {
  const outcome = replayRace(raceRow(settings, wakuban, stored.analysis === undefined ? {} : { analysis: stored.analysis }));
  if (outcome.kind !== "replayed") throw new Error("前提: 計算し直せる行でなければならない");
  const { allocation, rows } = outcome.result;
  const m = allocation.meta;
  return raceRow(settings, wakuban, {
    ...stored,
    meta: {
      route: m.route, unavailableReason: m.unavailableReason, fallbackReason: m.fallbackReason, skipReasonCode: m.skipReasonCode, comboOddsWide: m.comboOddsWide, comboOddsTrio: m.comboOddsTrio,
      betUnit: m.betUnit, greedySteps: m.greedySteps, candidateCap: m.candidateCap, modelId: m.modelId, modelApproximate: m.modelApproximate === null ? null : m.modelApproximate ? 1 : 0,
      belowFloorCount: m.belowFloorCount ?? null, ...stored.meta,
    },
    bets: stored.bets ?? allocation.bets.map((b) => ({ betType: b.betType, comboKey: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev })),
    horseValues: new Map(rows.map((r) => [r.umaban, { placeOddsMin: r.placeOddsMin, ev: r.ev }] as const)),
  });
}

describe("replayRace の設定の上書き(Issue #494。#468 の試算で、本番の配分の関数を変えずに設定だけ変えて計算し直す)", () => {
  const base = raceRow(ALL_ON);

  it("前提(空振り防止): 全券種 ON の基準の提案は、多点(5 点以上)で、組合せの券種が 2 種類以上に分かれる", () => {
    const r = replayed(base);
    expect(r.route).toBe("mixed");
    expect(r.bets.length).toBeGreaterThanOrEqual(5);
    expect(new Set(r.bets.map((b) => b.split(":")[0])).size).toBeGreaterThanOrEqual(2);
  });

  it("上書きなし(undefined・空)は、上書きの口が無いときと同じ結果。入力の行は書き換えない", () => {
    const before = JSON.stringify(base);
    const plain = replayed(base);
    expect(replayed(base, undefined)).toEqual(plain);
    expect(replayed(base, {})).toEqual(plain);
    expect(replayed(base, { include: {} })).toEqual(plain);
    replayed(base, { bankroll: 50_000, evThreshold: 1.3, include: { wide: false }, adjustProb: (h) => h.adjusted_prob * 0.5 });
    expect(JSON.stringify(base)).toBe(before);
  });

  it("数の設定(総資金・1 レースの上限・ケリー係数・EV 閾値・的中確率の下限)は、それぞれ単独で提案を変える", () => {
    const plain = betString(replayed(base));
    const cases: Array<[string, ReplayOverrides]> = [
      ["bankroll", { bankroll: 30_000 }],
      ["perRaceCap", { perRaceCap: 3_000 }],
      ["kellyFraction", { kellyFraction: 0.1 }],
      ["evThreshold", { evThreshold: 1.3 }],
      ["minHitProb", { minHitProb: 0.1 }],
    ];
    for (const [name, overrides] of cases) {
      expect(betString(replayed(base, overrides)), name).not.toBe(plain);
    }
  });

  it("総資金 0 の上書きは『総資金が未設定』の経路(unset。買い目なし)になる", () => {
    const r = replayed(base, { bankroll: 0 });
    expect(r.route).toBe("unset");
    expect(r.bets).toEqual([]);
  });

  it("券種の上書き: 6 券種それぞれ、OFF の行を ON にするとその券種の買い目が出て、ON の行を OFF にすると消える(券種どうしの取り違えを検出できる)", () => {
    const KINDS = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
    for (const column of INCLUDE_COLUMNS) {
      const kind = KIND_OF[column];
      expect(KINDS).toContain(kind);
      const forcedOn = replayed(raceRow({ [column]: 0 }), { include: { [kind]: true } });
      expect(forcedOn.bets.some((b) => b.startsWith(`${kind}:`)), `${kind} を ON に`).toBe(true);
      expect(forcedOn).toEqual(replayed(raceRow({ [column]: 1 })));
      const forcedOff = replayed(raceRow({ [column]: 1 }), { include: { [kind]: false } });
      expect(forcedOff.bets.some((b) => b.startsWith(`${kind}:`)), `${kind} を OFF に`).toBe(false);
      expect(forcedOff).toEqual(replayed(raceRow({ [column]: 0 })));
    }
  });

  it("組合せオッズの取得の上書き(includeComboOdds)は、false で複勝だけの経路(place-only)、true で組合せが入る経路(mixed)", () => {
    expect(replayed(base, { includeComboOdds: false }).route).toBe("place-only");
    const off = raceRow({ ...ALL_ON, includeComboOdds: 0 });
    expect(replayed(off).route).toBe("place-only");
    expect(replayed(off, { includeComboOdds: true })).toEqual(replayed(base));
  });

  it("上書きは D1 の NULL の解釈より後に当たる(min_hit_prob が NULL の行に 0.05 を上書きすると、0.05 の行と同じ。include_* の NULL にも効く)", () => {
    const nullFloor = raceRow({ ...ALL_ON, minHitProb: null });
    expect(betString(replayed(nullFloor, { minHitProb: 0.05 }))).toBe(betString(replayed(raceRow({ ...ALL_ON, minHitProb: 0.05 }))));
    expect(betString(replayed(nullFloor, { minHitProb: 0.05 }))).not.toBe(betString(replayed(nullFloor)));
    const nullWide = raceRow({ includeWide: null });
    expect(replayed(nullWide, { include: { wide: true } }).bets.some((b) => b.startsWith("wide:"))).toBe(true);
    expect(replayed(nullWide).bets.some((b) => b.startsWith("wide:"))).toBe(false);
  });

  it("確率の上書き(adjustProb): 馬ごとの補正後の確率を差し替えて計算し直せる。恒等なら変わらない。関数には馬と行が渡る", () => {
    const seen: number[] = [];
    const identity = replayed(base, { adjustProb: (h, row) => { seen.push(h.umaban); expect(row.race_id).toBe(base.race_id); return h.adjusted_prob; } });
    expect(identity).toEqual(replayed(base));
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(betString(replayed(base, { adjustProb: (h) => h.adjusted_prob * 0.5 }))).not.toBe(betString(replayed(base)));
    // 複勝だけの経路で、8 番の確率だけを 0 にすると、8 番の複勝の買い目が消え、ほかの馬の買い目は残る(馬ごとに別の値を返せている)
    const placeOnly = raceRow({ includeComboOdds: 0 });
    expect(replayed(placeOnly).bets.some((b) => b.startsWith("place:08"))).toBe(true);
    const zeroed = replayed(placeOnly, { adjustProb: (h) => (h.umaban === 8 ? 0 : h.adjusted_prob) });
    expect(zeroed.bets.some((b) => b.startsWith("place:08"))).toBe(false);
    expect(zeroed.bets.some((b) => b.startsWith("place:05"))).toBe(true);
  });

  it("非有限の数・範囲外の確率は、黙って通さず例外にする(adjustProb の負の値も)", () => {
    expect(() => replayRace(base, { bankroll: Number.NaN })).toThrow(/bankroll/);
    expect(() => replayRace(base, { evThreshold: Number.POSITIVE_INFINITY })).toThrow(/evThreshold/);
    expect(() => replayRace(base, { adjustProb: () => Number.NaN })).toThrow(/adjustProb/);
    expect(() => replayRace(base, { adjustProb: () => 1.5 })).toThrow(/adjustProb/);
    expect(() => replayRace(base, { adjustProb: () => -0.1 })).toThrow(/adjustProb/);
    // 境界(0 と 1)は通る
    expect(() => replayRace(base, { adjustProb: (h) => (h.umaban === 1 ? 0 : 1) })).not.toThrow();
  });

  it("本番の関数が黙って別の値に置き換える範囲の上書きは、例外にする(指定した値で計算したように見せない)。境界の値は通る", () => {
    // 前提: 本番の関数は、これらを黙って置き換える(置き換えが無くなったらこのテストが知らせる)
    expect(resolveKellyFraction(1.5)).toBe(DEFAULT_KELLY_FRACTION);
    expect(resolveKellyFraction(-0.1)).toBe(DEFAULT_KELLY_FRACTION);
    expect(resolveMinHitProb(1.2)).toBe(1);
    expect(resolveMinHitProb(-0.1)).toBe(0);
    expect(resolveBankroll(-1)).toBe(0);
    expect(resolveEffectivePerRaceCap(-100, 100)).toBe(0);
    const bad: Array<[string, ReplayOverrides]> = [
      ["kellyFraction が 1 超", { kellyFraction: 1.5 }],
      ["kellyFraction が負", { kellyFraction: -0.1 }],
      ["minHitProb が 1 超", { minHitProb: 1.2 }],
      ["minHitProb が負", { minHitProb: -0.1 }],
      ["bankroll が負", { bankroll: -1 }],
      ["perRaceCap が負", { perRaceCap: -100 }],
    ];
    for (const [name, overrides] of bad) {
      expect(() => replayRace(base, overrides), name).toThrow(new RegExp(Object.keys(overrides)[0]!));
    }
    // 境界: 0・1・総資金 0(未設定の経路)・負の EV 閾値(本番の関数もそのまま使う)は例外にしない
    for (const overrides of [{ kellyFraction: 0 }, { kellyFraction: 1 }, { minHitProb: 0 }, { minHitProb: 1 }, { bankroll: 0 }, { perRaceCap: 0 }, { evThreshold: -0.5 }] as ReplayOverrides[]) {
      expect(() => replayRace(base, overrides), JSON.stringify(overrides)).not.toThrow();
    }
  });
});

describe("replayRace の同時分布のモデルの上書き(Issue #524。3 着内率から単勝・組合せの確率を出すモデルを差し替えて、買い目の見積もりの当たり具合を試算する)", () => {
  const mixedRow = raceRow(ALL_ON);
  // EV 閾値 0.9: 条件付きベルヌーイでも買い目が残る(閾値 1 では「妙味なし」の見送りになり、比べられない)
  const placeOnlyRow = raceRow({ includeComboOdds: 0, evThreshold: 0.9 });

  it("前提(空振り防止): 全券種 ON は混在の経路で多点、組合せオッズ取得 OFF は複勝だけの経路で多点", () => {
    expect(replayed(mixedRow).route).toBe("mixed");
    expect(replayed(mixedRow).bets.length).toBeGreaterThanOrEqual(5);
    expect(replayed(placeOnlyRow).route).toBe("place-only");
    expect(replayed(placeOnlyRow).bets.length).toBeGreaterThanOrEqual(3);
  });

  it("登録表は、本番の既定(plackett-luce)と条件付きベルヌーイ(conditional-bernoulli)の 2 つ", () => {
    expect(Object.keys(REPLAY_MODELS)).toEqual(["plackett-luce", "conditional-bernoulli"]);
    expect(REPLAY_MODELS["plackett-luce"]).toBe(PLACKETT_LUCE_MODEL);
    expect(REPLAY_MODELS["conditional-bernoulli"]).toBe(CONDITIONAL_BERNOULLI_MODEL);
  });

  it("PLACKETT_LUCE_MODEL の指定は、上書きなしと同じ提案(混在・複勝だけの 2 経路)", () => {
    for (const row of [mixedRow, placeOnlyRow]) {
      expect(replayed(row, { model: PLACKETT_LUCE_MODEL })).toEqual(replayed(row));
    }
  });

  it("複勝だけの経路: 条件付きベルヌーイに替えると、メタの modelId が変わり、買い目の賭け金が変わる(差が 0 でない)", () => {
    const pl = replayed(placeOnlyRow);
    const cb = replayed(placeOnlyRow, { model: CONDITIONAL_BERNOULLI_MODEL });
    expect(cb.route).toBe("place-only");
    const modelIdOf = (row: AllocationRaceRow, model?: ReplayOverrides["model"]): string | null => {
      const outcome = replayRace(row, model === undefined ? {} : { model }) as Extract<ReplayOutcome, { kind: "replayed" }>;
      return outcome.result.allocation.meta.modelId;
    };
    expect(modelIdOf(placeOnlyRow)).toBe("plackett-luce");
    expect(modelIdOf(placeOnlyRow, CONDITIONAL_BERNOULLI_MODEL)).toBe("conditional-bernoulli");
    expect(cb.bets.length).toBeGreaterThan(0);
    expect(cb.bets).not.toEqual(pl.bets);
  });

  it("混在の経路: 条件付きベルヌーイ(順序なし)は route=invalid・買い目なしになる(本番の「順序のないモデルは例外」を保つ)", () => {
    const cb = replayed(mixedRow, { model: CONDITIONAL_BERNOULLI_MODEL });
    expect(cb.route).toBe("invalid");
    expect(cb.bets).toEqual([]);
  });

  it("replayedBets: モデルを上書きして route=invalid になった行は null(計算し直せなかった行。回収額の集計に入れない)。上書きなし・モデルの上書きなしの invalid は、これまでどおり買い目なし(空配列)", () => {
    expect(replayedBets(mixedRow, { model: CONDITIONAL_BERNOULLI_MODEL })).toBeNull();
    // 前提: 同じ行は、モデルを上書きしなければ多点の買い目を返す(null になる原因がモデルの上書きだけ)
    expect(replayedBets(mixedRow)!.length).toBeGreaterThanOrEqual(5);
    expect(replayedBets(mixedRow, { model: PLACKETT_LUCE_MODEL })!.length).toBeGreaterThanOrEqual(5);
    // 複勝だけの経路は、条件付きベルヌーイでも計算し直せる
    expect(replayedBets(placeOnlyRow, { model: CONDITIONAL_BERNOULLI_MODEL })!.length).toBeGreaterThan(0);
    // モデルの上書きなしで invalid になる行(枠連が ON で枠番が無い)は、これまでどおり空配列
    const noWaku = raceRow({ includeBracketQuinella: 1 }, { snapshot: false, result: false });
    expect(replayRace(noWaku)).toMatchObject({ kind: "replayed" });
    expect((replayRace(noWaku) as Extract<ReplayOutcome, { kind: "replayed" }>).result.allocation.meta.route).toBe("invalid");
    expect(replayedBets(noWaku)).toEqual([]);
    // 他の設定の上書きだけで invalid になる場合も、これまでどおり(null にしない)
    expect(replayedBets(noWaku, { evThreshold: 1.1 })).toEqual([]);
  });
});

describe("parseOverrides(CLI の --override key=value)", () => {
  it("数・真偽・券種を解釈する。同じキーが複数あれば後が勝つ", () => {
    expect(parseOverrides(["evThreshold=1.2", "kellyFraction=0.1", "includeComboOdds=false", "include.wide=on", "include.trifecta=off", "minHitProb=0.1", "bankroll=50000", "perRaceCap=3000"])).toEqual({
      evThreshold: 1.2, kellyFraction: 0.1, includeComboOdds: false, include: { wide: true, trifecta: false }, minHitProb: 0.1, bankroll: 50000, perRaceCap: 3000,
    });
    expect(parseOverrides(["evThreshold=1.2", "evThreshold=1.5"])).toEqual({ evThreshold: 1.5 });
    expect(parseOverrides([])).toEqual({});
  });

  it("model=<id> は登録表のモデルに解釈する(plackett-luce・conditional-bernoulli)。知らない id は、選べる id を添えた例外。describeOverrides に model=<id> が出る", () => {
    expect(parseOverrides(["model=conditional-bernoulli"]).model).toBe(CONDITIONAL_BERNOULLI_MODEL);
    expect(parseOverrides(["model=plackett-luce"]).model).toBe(PLACKETT_LUCE_MODEL);
    expect(parseOverrides(["model=plackett-luce", "model=conditional-bernoulli"]).model).toBe(CONDITIONAL_BERNOULLI_MODEL); // 後が勝つ
    expect(() => parseOverrides(["model=henery"])).toThrow(/model.*henery.*plackett-luce.*conditional-bernoulli/);
    expect(() => parseOverrides(["model="])).toThrow(/model/);
    expect(describeOverrides(parseOverrides(["model=conditional-bernoulli", "minHitProb=0.1"]))).toBe("minHitProb=0.1, model=conditional-bernoulli");
  });

  it("知らないキー・値のない指定・数でない値・真偽でない値・知らない券種は、理由つきの例外", () => {
    expect(() => parseOverrides(["foo=1"])).toThrow(/foo/);
    expect(() => parseOverrides(["evThreshold"])).toThrow(/evThreshold/);
    expect(() => parseOverrides(["evThreshold="])).toThrow(/evThreshold/);
    expect(() => parseOverrides(["evThreshold=abc"])).toThrow(/evThreshold/);
    expect(() => parseOverrides(["includeComboOdds=maybe"])).toThrow(/includeComboOdds/);
    expect(() => parseOverrides(["include.place=on"])).toThrow(/place/);
    expect(() => parseOverrides(["include.wide=2"])).toThrow(/include\.wide/);
  });

  it("範囲外の値(kellyFraction・minHitProb が 0〜1 の外、bankroll・perRaceCap が負)は、replayRace に渡す前に例外(CLI は終了コード 1)", () => {
    for (const pair of ["kellyFraction=1.5", "kellyFraction=-0.1", "minHitProb=2", "minHitProb=-0.5", "bankroll=-1", "perRaceCap=-100"]) {
      expect(() => parseOverrides([pair]), pair).toThrow(new RegExp(pair.split("=")[0]!));
    }
    expect(() => parseOverrides(["kellyFraction=0", "minHitProb=1", "bankroll=0", "evThreshold=-0.5"])).not.toThrow();
  });
});

describe("classifyReplay(一致しない理由の分類。Issue #494)", () => {
  /** 一致する行を作ったときの前提(買い目が多点で空でない。空の提案どうしが一致する空振りを防ぐ)。 */
  const matchRow = consistentRow({ includeWide: 1 });

  it("前提: 一致する行は、保存した提案が空でなく、完全一致(差分なし)", () => {
    expect(matchRow.allocation!.bets.length).toBeGreaterThan(1);
    const outcome = replayRace(matchRow) as Extract<ReplayOutcome, { kind: "replayed" }>;
    expect(compareReplay(matchRow, outcome).differences).toEqual([]);
    expect(driftedConstants(matchRow, outcome)).toEqual([]);
    expect(classifyReplay(matchRow)).toMatchObject({ reason: "match", nullSettings: [] });
  });

  it("配分の記録が無い行は no-allocation-record、分析時のオッズを再構成できない行は no-odds(計算し直さない)", () => {
    expect(classifyReplay(rowWith({ meta: null, bets: [] })).reason).toBe("no-allocation-record");
    expect(classifyReplay(rowWith({ snapshot: null })).reason).toBe("no-odds");
    // 配分の記録も詳細も無いときは、先に判定する no-allocation-record
    expect(classifyReplay(rowWith({ meta: null, bets: [], snapshot: null })).reason).toBe("no-allocation-record");
  });

  it("実効値の食い違い(bet_unit・greedy_steps・candidate_cap・model_id・model_approximate)は、5 つそれぞれ code-drift。食い違った実効値の名前を返す", () => {
    const cases: Array<[string, Partial<AllocationMetaInput>]> = [
      ["bet_unit", { betUnit: 10 }],
      ["greedy_steps", { greedySteps: 20 }],
      ["candidate_cap", { candidateCap: 100 }],
      ["model_id", { modelId: "conditional-bernoulli" }],
      ["model_approximate", { modelApproximate: 1 }],
    ];
    expect(cases).toHaveLength(5);
    for (const [name, meta] of cases) {
      const row = consistentRow({ includeWide: 1 }, {}, { meta });
      const outcome = replayRace(row) as Extract<ReplayOutcome, { kind: "replayed" }>;
      expect(compareReplay(row, outcome).same, `${name}: 前提(不一致)`).toBe(false);
      expect(driftedConstants(row, outcome), name).toEqual([name]);
      expect(classifyReplay(row).reason, name).toBe("code-drift");
    }
  });

  it("実効値以外のコード(下限で外した件数など)や買い目の食い違いは、code-drift ではなく mismatch(設定の NULL も無い)", () => {
    const belowFloor = consistentRow({ includeWide: 1 }, {}, { meta: { belowFloorCount: 7 } });
    const stake = consistentRow({ includeWide: 1 }, {}, { bets: matchRow.allocation!.bets.map((b, i) => ({ betType: b.bet_type, comboKey: b.combo_key, stake: i === 0 ? b.stake + 100 : b.stake, odds: b.odds, ev: b.ev })) });
    for (const [name, row] of [["下限で外した件数", belowFloor], ["金額", stake]] as const) {
      const outcome = replayRace(row) as Extract<ReplayOutcome, { kind: "replayed" }>;
      expect(compareReplay(row, outcome).same, `${name}: 前提(不一致)`).toBe(false);
      expect(driftedConstants(row, outcome), name).toEqual([]);
      expect(classifyReplay(row), name).toMatchObject({ reason: "mismatch", nullSettings: [] });
    }
  });

  it("設定に NULL があって一致しない行は legacy-settings(NULL の列を返す)。min_hit_prob の NULL・include_* の NULL のどちらも", () => {
    // include_wide が NULL: 保存の買い目はワイドを含む(ON で計算した)が、NULL は OFF と解釈するので計算し直しにワイドが無い
    const wideNull = consistentRow({ includeWide: 1 }, {}, { meta: { includeWide: null } });
    expect(wideNull.allocation!.bets.some((b) => b.bet_type === "wide")).toBe(true);
    // 前提: NULL を OFF と解釈すると route が変わり(mixed → place-only)、candidate_cap などの実効値も(経路が違うので)食い違って見える。それでも code-drift にはしない
    const wideNullOutcome = replayRace(wideNull) as Extract<ReplayOutcome, { kind: "replayed" }>;
    expect([wideNull.allocation!.codes.route, wideNullOutcome.result.allocation.meta.route]).toEqual(["mixed", "place-only"]);
    expect(wideNull.allocation!.codes.candidate_cap).not.toBe(wideNullOutcome.result.allocation.meta.candidateCap);
    expect(classifyReplay(wideNull)).toMatchObject({ reason: "legacy-settings", nullSettings: ["include_wide"], driftedConstants: [] });
    // min_hit_prob が NULL: 保存の提案は下限 0.25 で計算した(下限なしと違う)。NULL は 0 と解釈する
    const floorNull = consistentRow({ includeComboOdds: 0, minHitProb: 0.25 }, {}, { meta: { minHitProb: null } });
    expect(classifyReplay(floorNull)).toMatchObject({ reason: "legacy-settings", nullSettings: ["min_hit_prob"] });
  });

  it("NULL を解釈する 8 列(include_combo_odds・6 券種の include_*・min_hit_prob)は、どれが NULL でも legacy-settings(列の取りこぼしが無い)", () => {
    // 列ごとに、NULL を解釈すると提案が変わる行を作る(保存の提案は、その列が ON・下限ありで計算したもの)
    const cases: Array<[string, Settings, Partial<AllocationMetaInput>]> = [
      ["include_combo_odds", { includeWide: 1, includeComboOdds: 1 }, { includeComboOdds: null }],
      ["include_wide", { includeWide: 1 }, { includeWide: null }],
      ["include_trio", { includeTrio: 1 }, { includeTrio: null }],
      ["include_quinella", { includeQuinella: 1 }, { includeQuinella: null }],
      ["include_exacta", { includeExacta: 1 }, { includeExacta: null }],
      ["include_trifecta", { includeTrifecta: 1 }, { includeTrifecta: null }],
      ["include_bracket_quinella", { includeBracketQuinella: 1 }, { includeBracketQuinella: null }],
      ["min_hit_prob", { includeComboOdds: 0, minHitProb: 0.25 }, { minHitProb: null }],
    ];
    expect(cases).toHaveLength(8);
    for (const [column, settings, meta] of cases) {
      const row = consistentRow(settings, {}, { meta });
      expect(row.allocation!.bets.length, `${column}: 前提(保存の提案が空でない)`).toBeGreaterThan(0);
      expect(row.allocation!.settings[column as keyof NonNullable<AllocationRaceRow["allocation"]>["settings"]], `${column}: 前提(保存の設定が NULL)`).toBeNull();
      const outcome = replayRace(row) as Extract<ReplayOutcome, { kind: "replayed" }>;
      expect(compareReplay(row, outcome).same, `${column}: 前提(NULL の解釈で提案が変わる)`).toBe(false);
      expect(classifyReplay(row), column).toMatchObject({ reason: "legacy-settings", nullSettings: [column] });
    }
  });

  it("設定に NULL があっても、解釈どおりで一致する行は match(NULL があるだけでは legacy-settings にしない)。NULL の列は返す", () => {
    const row = consistentRow({ includeWide: 1 }, {}, { meta: { includeTrifecta: null, includeComboOdds: 1 } });
    expect(row.allocation!.settings.include_trifecta).toBeNull();
    expect(classifyReplay(row)).toMatchObject({ reason: "match", nullSettings: ["include_trifecta"] });
  });

  it("実効値の食い違いと設定の NULL が両方ある不一致は code-drift(観測できる方を先にする)。alsoLegacySettings で両方に当てはまることも返す", () => {
    // 経路が変わらない NULL(三連単は元から OFF)にしておく。経路が変わる NULL の行では、実効値を比べない
    const row = consistentRow({ includeWide: 1 }, {}, { meta: { includeTrifecta: null, greedySteps: 20 } });
    expect(classifyReplay(row)).toMatchObject({ reason: "code-drift", nullSettings: ["include_trifecta"], driftedConstants: ["greedy_steps"], alsoLegacySettings: true });
    // 実効値の食い違いだけなら alsoLegacySettings は false
    expect(classifyReplay(consistentRow({ includeWide: 1 }, {}, { meta: { greedySteps: 20 } }))).toMatchObject({ reason: "code-drift", alsoLegacySettings: false });
  });

  it("invalid: 計算し直しが invalid になって分析時と食い違う行、分析時が invalid で計算し直しは通る行、計算し直しが例外を投げる行。両方 invalid で一致するなら match", () => {
    // 枠番がスナップショットにも結果にも無く、枠連が配分に入る設定: 計算し直しは invalid。保存は mixed(枠番がある条件で計算した提案)
    const stored = consistentRow({ includeBracketQuinella: 1 });
    expect(stored.allocation!.codes.route).toBe("mixed");
    const noWaku = { ...stored, horses: stored.horses.map((h) => ({ ...h, wakuban: null })), result: { ...stored.result, horses: stored.result.horses.map((h) => ({ ...h, wakuban: null })) } };
    expect((replayRace(noWaku) as Extract<ReplayOutcome, { kind: "replayed" }>).result.allocation.meta.route).toBe("invalid");
    expect(classifyReplay(noWaku).reason).toBe("invalid");
    // 分析時が invalid(枠番が無かった)で、いまは結果の枠番で補えて通る
    const wasInvalid = consistentRow({ includeBracketQuinella: 1 }, { snapshot: false, result: false });
    expect(wasInvalid.allocation!.codes.route).toBe("invalid");
    const filled = { ...wasInvalid, result: { ...wasInvalid.result, horses: wasInvalid.result.horses.map((h) => ({ ...h, wakuban: h.umaban })) } };
    expect((replayRace(filled) as Extract<ReplayOutcome, { kind: "replayed" }>).result.allocation.meta.route).toBe("mixed");
    expect(classifyReplay(filled).reason).toBe("invalid");
    // 両方 invalid で完全一致(同じ入力のまま)
    expect(classifyReplay(wasInvalid).reason).toBe("match");
    // 例外: 計算し直しの関数を差し替えて投げさせる
    expect(classifyReplay(matchRow, () => { throw new Error("計算不能"); }).reason).toBe("invalid");
  });
});

describe("summarizeReplay(区分別の理由の集計。Issue #494)", () => {
  // 中央 5 行(一致 3〈うち 1 行は設定に NULL がある〉・実効値の食い違い 1・配分の記録なし 1)と、地方 5 行(一致 1・金額の食い違い 1・設定 NULL の不一致 1・設定 NULL かつ実効値の食い違い 1・オッズなし 1)。
  const central = (id: number, row: AllocationRaceRow): AllocationRaceRow => ({ ...row, analysis_id: id });
  const nar = (stored: RowOverride): RowOverride => ({ ...stored, analysis: NAR_ANALYSIS });
  const wideBets = consistentRow({ includeWide: 1 }).allocation!.bets;
  const rows: AllocationRaceRow[] = [
    central(1, consistentRow({ includeWide: 1 })),
    central(2, consistentRow({ includeWide: 1 })),
    central(3, consistentRow({ includeWide: 1 }, {}, { meta: { greedySteps: 20 } })),
    central(4, rowWith({ meta: null, bets: [] })),
    consistentRow({ includeWide: 1 }, {}, nar({})),
    consistentRow({ includeWide: 1 }, {}, nar({ bets: wideBets.map((b, i) => ({ betType: b.bet_type, comboKey: b.combo_key, stake: i === 0 ? b.stake + 100 : b.stake, odds: b.odds, ev: b.ev })) })),
    consistentRow({ includeWide: 1 }, {}, nar({ meta: { includeWide: null, includeTrio: null } })),
    consistentRow({ includeWide: 1 }, {}, nar({ meta: { includeTrio: null, includeTrifecta: null, greedySteps: 20 } })),
    { ...rowWith({ snapshot: null }), venue_kind: "nar", race_id: "202654071210" },
    // 設定に NULL があるが、解釈どおりで一致する行(NULL の列の件数には数えない)
    central(5, consistentRow({ includeWide: 1 }, {}, { meta: { includeTrifecta: null } })),
  ];

  it("前提: 行ごとの理由が想定どおり(集計の元の分類が合っている)。地方の行は venue_kind が nar", () => {
    expect(rows.map((r) => classifyReplay(r).reason)).toEqual([
      "match", "match", "code-drift", "no-allocation-record", "match", "mismatch", "legacy-settings", "code-drift", "no-odds", "match",
    ]);
    expect(rows.map((r) => r.venue_kind)).toEqual(["central", "central", "central", "central", "nar", "nar", "nar", "nar", "nar", "central"]);
    expect(rows[9]!.allocation!.settings.include_trifecta).toBeNull();
  });

  it("全体・中央・地方の理由別の件数、計算し直せた行数、一致率が、数えたとおりになる", () => {
    const report = summarizeReplay(rows);
    expect(report.total).toEqual({
      rows: 10, replayed: 8, matchRate: 4 / 8, invalidThrown: 0,
      reasons: { match: 4, "no-allocation-record": 1, "no-odds": 1, invalid: 0, "code-drift": 2, "legacy-settings": 1, mismatch: 1 },
    });
    expect(report.byVenueKind.central).toEqual({
      rows: 5, replayed: 4, matchRate: 3 / 4, invalidThrown: 0,
      reasons: { match: 3, "no-allocation-record": 1, "no-odds": 0, invalid: 0, "code-drift": 1, "legacy-settings": 0, mismatch: 0 },
    });
    expect(report.byVenueKind.nar).toEqual({
      rows: 5, replayed: 4, matchRate: 1 / 4, invalidThrown: 0,
      reasons: { match: 1, "no-allocation-record": 0, "no-odds": 1, invalid: 0, "code-drift": 1, "legacy-settings": 1, mismatch: 1 },
    });
  });

  it("不変条件: 理由の合計 = 行数、中央 + 地方 = 全体(各理由)、計算し直せた行 = 行数 − 配分の記録なし − オッズなし", () => {
    const report = summarizeReplay(rows);
    const sum = (t: { reasons: Record<string, number> }): number => Object.values(t.reasons).reduce((a, b) => a + b, 0);
    expect(sum(report.total)).toBe(report.total.rows);
    for (const key of Object.keys(report.total.reasons) as Array<keyof typeof report.total.reasons>) {
      expect(report.byVenueKind.central.reasons[key] + report.byVenueKind.nar.reasons[key], key).toBe(report.total.reasons[key]);
    }
    expect(report.total.replayed).toBe(report.total.rows - report.total.reasons["no-allocation-record"] - report.total.reasons["no-odds"]);
  });

  it("設定が NULL の列の件数(legacy-settings と、設定 NULL と実効値の食い違いの両方に当てはまる code-drift の行を数える)と、両方に当てはまる行の数", () => {
    const report = summarizeReplay(rows);
    // legacy-settings の行(include_wide・include_trio が NULL)と、code-drift かつ NULL の行(include_trio・include_trifecta が NULL)
    expect(report.nullSettingColumns).toEqual({ include_wide: 1, include_trio: 2, include_trifecta: 1 });
    expect(report.codeDriftAlsoLegacy).toBe(1);
  });

  it("計算し直せない行だけ・空の入力でも、一致率は null(0 除算にしない)", () => {
    expect(summarizeReplay([]).total).toMatchObject({ rows: 0, replayed: 0, matchRate: null });
    expect(summarizeReplay([rowWith({ meta: null, bets: [] })]).total).toMatchObject({ rows: 1, replayed: 0, matchRate: null });
  });

  it("計算し直しが例外を投げた行は invalid に数え、その件数を別に持つ(全体・区分別。route=invalid の記録との食い違いは数えない)", () => {
    const throwFor = new Set([rows[0]!, rows[4]!, rows[5]!]); // 中央 1 行・地方 2 行
    const report = summarizeReplay(rows, (row) => {
      if (throwFor.has(row)) throw new Error("計算不能");
      return replayRace(row);
    });
    expect(report.total.invalidThrown).toBe(3);
    expect(report.byVenueKind.central.invalidThrown).toBe(1);
    expect(report.byVenueKind.nar.invalidThrown).toBe(2);
    expect(report.total.reasons.invalid).toBe(3);
    // 例外でなく route=invalid になった行(枠番が無い)は、invalid だが例外には数えない
    const stored = consistentRow({ includeBracketQuinella: 1 });
    const noWaku = { ...stored, horses: stored.horses.map((h) => ({ ...h, wakuban: null })), result: { ...stored.result, horses: stored.result.horses.map((h) => ({ ...h, wakuban: null })) } };
    const invalidOnly = summarizeReplay([noWaku]);
    expect(invalidOnly.total.reasons.invalid).toBe(1);
    expect(invalidOnly.total.invalidThrown).toBe(0);
    expect(classifyReplay(noWaku).threw).toBe(false);
    expect(classifyReplay(rows[0]!, () => { throw new Error("x"); }).threw).toBe(true);
  });

  it("replayableRows は、配分の記録があってオッズを再構成できる行だけ", () => {
    expect(replayableRows(rows)).toHaveLength(8);
    expect(replayableRows(rows).every((r) => r.allocation !== null && r.has_odds)).toBe(true);
  });
});

describe("回収額の集計(Issue #494。検証画面と同じ判定・同じ数え方)", () => {
  const horsesOf = (rows: Array<{ umaban: number; finish: number | null; place?: number; win?: number; scratched?: boolean }>): AllocationResultInput[] =>
    rows.map((r) => ({ umaban: r.umaban, finishPosition: r.finish, placePayout: r.place ?? null, winPayout: r.win ?? null, scratched: r.scratched === true ? 1 : 0, wakuban: r.umaban, winOdds: null, ninki: null }));
  const bet = (betType: string, comboKey: string, stake: number): AllocationBetInput => ({ betType, comboKey, stake, odds: 5, ev: 1.1 });

  // 中央 X: 6 番は取消。複勝は 1〜3 番、単勝は 1 番に払戻。ワイド・馬単・枠連は取込済み(馬単は払戻 0 件)、三連複は未取込。
  const raceX = rowWith({
    analysis: { ...CHOSEN, id: 7, raceId: RACE_ID },
    results: horsesOf([{ umaban: 1, finish: 1, place: 120, win: 420 }, { umaban: 2, finish: 2, place: 130 }, { umaban: 3, finish: 3, place: 140 }, { umaban: 4, finish: 4 }, { umaban: 5, finish: 5 }, { umaban: 6, finish: null, scratched: true }]),
    payouts: [{ betType: "wide", comboKey: "0102", payout: 180 }, { betType: "bracketQuinella", comboKey: "0203", payout: 640 }],
    imports: ["wide", "exacta", "bracketQuinella"],
    bets: [
      bet("place", "01", 300), bet("place", "04", 200), bet("place", "06", 100), bet("win", "01", 500), bet("win", "02", 100), bet("wide", "0102", 200), bet("wide", "0103", 100),
      bet("wide", "0106", 100), bet("exacta", "0102", 100), bet("trio", "010203", 100), bet("bracketQuinella", "0203", 100), bet("bracketQuinella", "0106", 100),
    ],
  });
  // 中央 Y: 全頭出走。3 番が勝つ。三連複・三連単は取込済み(三連単の逆順は外れ)、馬連は未取込。
  const raceY = rowWith({
    analysis: { ...CHOSEN, id: 8, raceId: "202606030812" },
    results: horsesOf([{ umaban: 3, finish: 1, place: 210, win: 650 }, { umaban: 1, finish: 2, place: 130 }, { umaban: 2, finish: 3, place: 160 }, { umaban: 4, finish: 4 }, { umaban: 5, finish: 5 }, { umaban: 6, finish: 6 }]),
    payouts: [{ betType: "trio", comboKey: "010203", payout: 2500 }, { betType: "trifecta", comboKey: "030102", payout: 14000 }],
    imports: ["trio", "trifecta"],
    bets: [
      bet("win", "03", 200), bet("win", "01", 100), bet("place", "01", 300), bet("place", "02", 100), bet("trio", "010203", 100), bet("trio", "010204", 100),
      bet("trifecta", "030102", 100), bet("trifecta", "010203", 100), bet("quinella", "0103", 100),
    ],
  });
  // 地方 Z。
  const raceZ = rowWith({
    analysis: NAR_ANALYSIS,
    results: horsesOf([{ umaban: 1, finish: 1, place: 110, win: 300 }, { umaban: 2, finish: 2, place: 150 }, { umaban: 3, finish: 3, place: 180 }, { umaban: 4, finish: 4 }, { umaban: 5, finish: 5 }, { umaban: 6, finish: 6 }]),
    payouts: [{ betType: "wide", comboKey: "0102", payout: 250 }],
    imports: ["wide"],
    bets: [bet("win", "01", 100), bet("place", "04", 200), bet("wide", "0102", 100), bet("wide", "0204", 100), bet("exacta", "0102", 100)],
  });
  const rows = [raceX, raceY, raceZ];

  it("前提(空振り防止): 判定が的中・外れ・返還・判定不能の 4 種類すべてを含み、買い目は 3 レース × 券種 8 種類にまたがる", () => {
    const outcomes = new Set(rows.flatMap((r) => judgeRaceBets(r, r.allocation!.bets).map((j) => j.judgment.outcome)));
    expect([...outcomes].sort()).toEqual(["hit", "miss", "refund", "unjudged"]);
    expect(new Set(rows.flatMap((r) => r.allocation!.bets.map((b) => b.bet_type))).size).toBe(8);
    expect(rows.map((r) => r.venue_kind)).toEqual(["central", "central", "nar"]);
  });

  it("summarizePayouts: 1 レース分を手で数えた値になる(判定不能は賭け金にも払戻にも入れない。返還は賭け金が両方に入る)", () => {
    // X: 判定できた 10 点・賭け金 300+200+100+500+100+200+100+100+100+100=1800、払戻 360+0+100+2100+0+360+0+100+640+100=3760、判定不能 2(馬単・三連複)、返還 3(賭け金 300)
    expect(summarizePayouts(judgeRaceBets(raceX, raceX.allocation!.bets))).toEqual({
      betCount: 10, totalStake: 1800, totalReturn: 3760, recoveryRate: 3760 / 1800, unjudgedCount: 2, unknownBetTypeCount: 0, refundedCount: 3, refundedStake: 300,
    });
    // 買い目なし: 回収率は null(0 除算にしない)
    expect(summarizePayouts([])).toEqual({ betCount: 0, totalStake: 0, totalReturn: 0, recoveryRate: null, unjudgedCount: 0, unknownBetTypeCount: 0, refundedCount: 0, refundedStake: 0 });
  });

  it("summarizePayouts: 知らない券種は、点数にも賭け金にも入れず、別に数える(検証画面と同じ)", () => {
    const unknownBets = [bet("place", "01", 100), bet("mystery", "01", 700)].map((b) => ({ bet_type: b.betType, combo_key: b.comboKey, stake: b.stake, odds: b.odds, ev: b.ev }));
    const summary = summarizePayouts(judgeRaceBets(raceX, unknownBets));
    expect(summary).toMatchObject({ betCount: 1, totalStake: 100, totalReturn: 120, unknownBetTypeCount: 1 });
  });

  it("payoutReport(分析時の提案): 全体・券種別・区分別が、手で数えた値になる。券種別の点数・賭け金・払戻の和が全体に一致する", () => {
    const report = payoutReport(rows, storedBets);
    // 全体: 10+8+4 点、賭け金 1800+1100+500、払戻 3760+18350+550、判定不能 2+1+1、返還 3
    expect(report.overall).toMatchObject({ betCount: 22, totalStake: 3400, totalReturn: 22660, unjudgedCount: 4, refundedCount: 3, refundedStake: 300 });
    expect(report.byVenueKind.central).toMatchObject({ betCount: 18, totalStake: 2900, totalReturn: 22110 });
    expect(report.byVenueKind.nar).toMatchObject({ betCount: 4, totalStake: 500, totalReturn: 550, recoveryRate: 550 / 500 });
    const by = report.byBetType;
    expect(by["place"]).toMatchObject({ betCount: 6, totalStake: 1200, totalReturn: 1010, refundedCount: 1 });
    expect(by["win"]).toMatchObject({ betCount: 5, totalStake: 1000, totalReturn: 3700 });
    expect(by["wide"]).toMatchObject({ betCount: 5, totalStake: 600, totalReturn: 710, refundedCount: 1 });
    expect(by["trio"]).toMatchObject({ betCount: 2, totalStake: 200, totalReturn: 2500, unjudgedCount: 1 });
    expect(by["trifecta"]).toMatchObject({ betCount: 2, totalStake: 200, totalReturn: 14000 });
    expect(by["bracketQuinella"]).toMatchObject({ betCount: 2, totalStake: 200, totalReturn: 740, refundedCount: 1 });
    expect(by["quinella"]).toMatchObject({ betCount: 0, unjudgedCount: 1, recoveryRate: null });
    expect(by["exacta"]).toMatchObject({ betCount: 0, unjudgedCount: 2 });
    expect(Object.keys(by).sort()).toEqual(["bracketQuinella", "exacta", "place", "quinella", "trifecta", "trio", "wide", "win"]);
    for (const field of ["betCount", "totalStake", "totalReturn", "unjudgedCount", "refundedCount", "refundedStake"] as const) {
      expect(Object.values(by).reduce((n, s) => n + s[field], 0), field).toBe(report.overall[field]);
      expect(report.byVenueKind.central[field] + report.byVenueKind.nar[field], field).toBe(report.overall[field]);
    }
  });

  /** 同じ行を、検証画面の読み取り口(`buildVerifySource`)にも入れる。 */
  function verifyRowsOf(target: readonly AllocationRaceRow[]): VerifyReadRows {
    return {
      analyses: target.map((r) => ({
        id: r.analysis_id, raceId: r.race_id, analyzedAt: r.analyzed_at, evEstimated: 0, promptVersion: null, additionalInstruction: null, kaisaiDate: r.kaisai_date, model: null, rawResponse: null,
        raceSnapshotJson: null, historyCutoffDate: "20260704", promptLookaheadGuarded: 1, startTime: "15:45",
      })),
      horses: [],
      allocationMeta: target.map((r) => ({ analysisId: r.analysis_id, route: r.allocation!.codes.route, skipReasonCode: null })),
      bets: target.flatMap((r) => r.allocation!.bets.map((b) => ({ analysisId: r.analysis_id, betType: b.bet_type, comboKey: b.combo_key, stake: b.stake }))),
      results: target.flatMap((r) =>
        r.result.horses.map((h) => ({ raceId: r.race_id, umaban: h.umaban, finishPosition: h.finish_position, placePayout: h.place_payout, winPayout: h.win_payout, scratched: h.scratched === null ? null : h.scratched ? 1 : 0, wakuban: h.wakuban })),
      ),
      comboPayouts: target.flatMap((r) => Object.entries(r.result.combo_payouts).flatMap(([betType, list]) => list.map(([comboKey, payout]) => ({ raceId: r.race_id, betType, comboKey, payout })))),
      comboImports: target.flatMap((r) => r.result.payout_imports.map((betType) => ({ raceId: r.race_id, betType }))),
    };
  }

  it("検証画面との照合: 分析時の提案の回収額が、computeVerifyReport の proposedBet(全体・中央・地方・券種別)と、点数・賭け金・払戻・回収率・判定不能・返還まで一致する", () => {
    const source = buildVerifySource(verifyRowsOf(rows));
    const report = payoutReport(rows, storedBets);
    const fields = ["betCount", "totalStake", "totalReturn", "recoveryRate", "unjudgedCount", "refundedCount", "refundedStake"] as const;
    const pick = (s: Pick<PayoutSummary, (typeof fields)[number]>): Record<string, unknown> => Object.fromEntries(fields.map((f) => [f, s[f]]));
    for (const [venue, mine] of [["all", report.overall], ["central", report.byVenueKind.central], ["nar", report.byVenueKind.nar]] as const) {
      const verify = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG, venue).proposedBet!;
      expect(verify.overall.betCount, `${venue} の前提(検証画面が買い目を数えている)`).toBeGreaterThan(0);
      expect(pick(mine), venue).toEqual(pick(verify.overall));
    }
    const verifyAll = computeVerifyReport(source, PRODUCTION_VERIFY_CONFIG).proposedBet!;
    for (const betType of ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const) {
      expect(pick(report.byBetType[betType]!), betType).toEqual(pick(verifyAll[betType]));
    }
  });

  it("replayedBets: 計算し直せない行(配分の記録なし・オッズなし)は null、計算し直せる行は買い目(券種・キー・金額)を返す。上書きが効く", () => {
    expect(replayedBets(rowWith({ meta: null, bets: [] }))).toBeNull();
    expect(replayedBets(rowWith({ snapshot: null }))).toBeNull();
    const row = raceRow(ALL_ON);
    const plain = replayedBets(row)!;
    expect(plain.length).toBeGreaterThan(1);
    expect(plain.every((b) => typeof b.bet_type === "string" && typeof b.combo_key === "string" && b.stake > 0)).toBe(true);
    expect(JSON.stringify(replayedBets(row, { minHitProb: 0.1 }))).not.toBe(JSON.stringify(plain));
    expect(JSON.stringify(replayedBets(row, {}))).toBe(JSON.stringify(plain));
  });

  it("計算し直した提案の回収額: 上書きで買い目が変われば変わる。複勝だけの経路で、的中した馬の賭け金 × 払戻を手で足した値に一致する", () => {
    // 4 番が 1 着・5 番が 2 着・1 番が 3 着。複勝の払戻は 4 番 450・5 番 650・1 番 110(100 円あたり)、単勝は 4 番 1000。組合せは取込なし。
    const settled: RowOverride = {
      results: P.map((_, i) => ({
        umaban: i + 1, finishPosition: [3, 4, 5, 1, 2, 6, 7, 8][i]!, placePayout: i === 3 ? 450 : i === 4 ? 650 : i === 0 ? 110 : null, winPayout: i === 3 ? 1000 : null, scratched: 0, wakuban: i + 1, winOdds: null, ninki: null,
      })),
    };
    const row = raceRow({ includeComboOdds: 0 }, {}, settled);
    const bets = replayedBets(row)!;
    expect(bets.length).toBeGreaterThanOrEqual(3);
    expect(bets.every((b) => b.bet_type === "place")).toBe(true);
    const unit: Record<string, number> = { "04": 450, "05": 650, "01": 110 };
    const expectedReturn = bets.reduce((n, b) => n + (unit[b.combo_key] === undefined ? 0 : (unit[b.combo_key]! * b.stake) / 100), 0);
    const expectedStake = bets.reduce((n, b) => n + b.stake, 0);
    expect(expectedReturn).toBeGreaterThan(0); // 前提: 的中した買い目がある
    expect(expectedReturn).not.toBe(expectedStake);
    const report = payoutReport([row], (r) => replayedBets(r) ?? []);
    expect(report.overall).toMatchObject({ betCount: bets.length, totalStake: expectedStake, totalReturn: expectedReturn });
    // 下限を上げて低い確率の買い目を外すと、賭け金が変わる
    const floored = payoutReport([row], (r) => replayedBets(r, { minHitProb: 0.15 }) ?? []);
    expect(floored.overall.totalStake).not.toBe(report.overall.totalStake);
  });
});

describe("runCli(--replay。Issue #494)", () => {
  // 一致 2(中央)・金額の食い違い 1(地方)・オッズなし 1(地方)。
  // ワイドは取込済みで、0102 だけが的中(払戻 300)。買い目は判定でき、回収額が 0 でない。
  // 結果: 4 番が 1 着・5 番が 2 着・1 番が 3 着。複勝の払戻は 4 番 450・5 番 650・1 番 110(100 円あたり)。
  const settled = {
    payouts: [{ betType: "wide", comboKey: "0102", payout: 300 }],
    imports: ["wide"],
    results: P.map((_, i) => ({
      umaban: i + 1, finishPosition: [3, 4, 5, 1, 2, 6, 7, 8][i]!, placePayout: i === 3 ? 450 : i === 4 ? 650 : i === 0 ? 110 : null, winPayout: i === 3 ? 1000 : null, scratched: 0, wakuban: i + 1, winOdds: null, ninki: null,
    })),
  };
  const matchA = consistentRow({ includeWide: 1 }, {}, { ...settled, analysis: { ...CHOSEN, id: 1, raceId: "202606030811" } });
  const matchB = consistentRow({ includeWide: 1 }, {}, { ...settled, analysis: { ...CHOSEN, id: 2, raceId: "202606030812" } });
  const wideBets = matchA.allocation!.bets;
  const narMismatch = consistentRow({ includeWide: 1 }, {}, {
    ...settled,
    analysis: NAR_ANALYSIS,
    bets: wideBets.map((b, i) => ({ betType: b.bet_type, comboKey: b.combo_key, stake: i === 0 ? b.stake + 100 : b.stake, odds: b.odds, ev: b.ev })),
  });
  const narNoOdds: AllocationRaceRow = { ...rowWith({ snapshot: null }), venue_kind: "nar", race_id: "202654071211" };
  const dataset = parseAllocationDataset(fileOf([matchA, matchB, narMismatch, narNoOdds]));
  const load = (): typeof dataset => dataset;

  it("使い方(ファイルなし)・--override だけ(--replay なし)・不正な --override は、理由つきで終了コード 1", () => {
    expect(runCli([], load)).toMatchObject({ exitCode: 1 });
    expect(runCli([], load).output).toMatch(/使い方/);
    const noReplay = runCli(["x.gz", "--override", "evThreshold=1.2"], load);
    expect(noReplay.exitCode).toBe(1);
    expect(noReplay.output).toMatch(/--replay/);
    const bad = runCli(["x.gz", "--replay", "--override", "foo=1"], load);
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toMatch(/foo/);
  });

  it("--replay なしは、これまでどおりの要約と、一致した件数だけ(理由の表は出さない)", () => {
    const r = runCli(["x.gz"], load);
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/要約: /);
    expect(r.output).not.toMatch(/## 計算し直しの一致率/);
  });

  it("--replay: 理由別・区分別の一致率と、分析時の提案の回収額、計算し直した提案の回収額を出す", () => {
    const r = runCli(["x.gz", "--replay"], load);
    expect(r.exitCode).toBe(0);
    const lines = r.output.split("\n");
    expect(lines).toContain("## 計算し直しの一致率(設定の上書きなし)");
    expect(lines).toContain("全体: 全 4 行・計算し直せた 3 行・一致 2 行(66.7%) [match 2, no-allocation-record 0, no-odds 1, invalid 0, code-drift 0, legacy-settings 0, mismatch 1]");
    expect(lines).toContain("中央: 全 2 行・計算し直せた 2 行・一致 2 行(100.0%) [match 2, no-allocation-record 0, no-odds 0, invalid 0, code-drift 0, legacy-settings 0, mismatch 0]");
    expect(lines).toContain("地方: 全 2 行・計算し直せた 1 行・一致 0 行(0.0%) [match 0, no-allocation-record 0, no-odds 1, invalid 0, code-drift 0, legacy-settings 0, mismatch 1]");
    expect(r.output).toMatch(/## 回収額/);
    expect(r.output).toMatch(/分析時の提案\(全 4 行\): 点数 \d+・賭け金 \d+・払戻 \d+・回収率 /);
    expect(r.output).toMatch(/分析時の提案\(計算し直せた 3 行\): 点数 /);
    expect(r.output).toMatch(/計算し直した提案\(計算し直せた 3 行\): 点数 /);
    expect(r.output).toMatch(/\n {2}place: 点数 /); // 券種別
    expect(r.output).toMatch(/\n {2}中央: 点数 /);
  });

  it("回収額の行は、payoutReport の値そのもの(賭け金・払戻・回収率の書式まで)", () => {
    const rows = dataset.rows;
    const stored = payoutReport(rows, storedBets).overall;
    expect(stored.betCount).toBeGreaterThan(0);
    const rate = stored.recoveryRate === null ? "なし" : `${(stored.recoveryRate * 100).toFixed(1)}%`;
    const expected = `分析時の提案(全 4 行): 点数 ${stored.betCount}・賭け金 ${stored.totalStake}・払戻 ${stored.totalReturn}・回収率 ${rate}・判定不能 ${stored.unjudgedCount}・返還 ${stored.refundedCount}`;
    expect(runCli(["x.gz", "--replay"], load).output.split("\n")).toContain(expected);
  });

  it("--override つき: 一致率は出さず(上書きすると一致しないのが当然)、上書きの内容と、計算し直した提案の回収額の変化を出す", () => {
    const plain = runCli(["x.gz", "--replay"], load).output;
    const r = runCli(["x.gz", "--replay", "--override", "minHitProb=0.5", "--override", "include.wide=off"], load);
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/## 設定の上書き: minHitProb=0\.5, include\.wide=false\(一致率は出さない\)/);
    expect(r.output).not.toMatch(/## 計算し直しの一致率/);
    const replayedLine = (text: string): string => text.split("\n").find((l) => l.startsWith("計算し直した提案("))!;
    expect(replayedLine(r.output)).not.toBe(replayedLine(plain));
  });
  it("--override が回収額の数字に効いている: 計算し直した提案の点数・賭け金・払戻を、手で数えた値で固定する(上書きを渡さないと赤)", () => {
    // 計算し直せる 3 行(中央 2・地方 1)は、同じ入力。1 行あたりの買い目の賭け金は、計算し直した提案(実測)で、払戻は結果から手で足した。
    // 上書きなし: ワイド 8 点(9600・5900・500・300・2700・200・100・100 = 19400)。的中は 0102(払戻 300)だけ → 9600 × 3 = 28800 → 3 行で 点数 24・賭け金 58200・払戻 86400。
    const plain = runCli(["x.gz", "--replay"], load).output.split("\n");
    expect(plain).toContain("計算し直した提案(計算し直せた 3 行): 点数 24・賭け金 58200・払戻 86400・回収率 148.5%・判定不能 0・返還 0");
    // ワイドを OFF: 複勝 5 点(04=2600・05=3200・06=1200・07=600・08=400 = 8000)。4 番(450)と 5 番(650)が的中 → 26 × 450 + 32 × 650 = 32500 → 3 行で 点数 15・賭け金 24000・払戻 97500。
    const wideOff = runCli(["x.gz", "--replay", "--override", "include.wide=off"], load).output.split("\n");
    expect(wideOff).toContain("計算し直した提案(計算し直せた 3 行・設定の上書きあり): 点数 15・賭け金 24000・払戻 97500・回収率 406.3%・判定不能 0・返還 0");
    // ケリー係数 0.1: ワイド 6 点(4800・2900・200・100・1300・100 = 9400)。的中は 0102 だけ → 4800 × 3 = 14400 → 3 行で 点数 18・賭け金 28200・払戻 43200。
    const kelly = runCli(["x.gz", "--replay", "--override", "kellyFraction=0.1"], load).output.split("\n");
    expect(kelly).toContain("計算し直した提案(計算し直せた 3 行・設定の上書きあり): 点数 18・賭け金 28200・払戻 43200・回収率 153.2%・判定不能 0・返還 0");
    // 分析時の提案の行は、上書きに左右されない
    // (地方の 1 行は、先頭の買い目の賭け金を 100 円増やしてある〈9600 → 9700〉ので、賭け金 19400 + 19400 + 19500 = 58300、払戻 28800 + 28800 + 29100 = 86700)
    const stored = "分析時の提案(計算し直せた 3 行): 点数 24・賭け金 58300・払戻 86700・回収率 148.7%・判定不能 0・返還 0";
    expect(plain).toContain(stored);
    expect(wideOff).toContain(stored);
    expect(kelly).toContain(stored);
  });

  it("範囲外の --override(kellyFraction が 1 超など)は、計算せず終了コード 1 で理由を出す", () => {
    for (const pair of ["kellyFraction=1.5", "minHitProb=-0.1", "bankroll=-5"]) {
      const r = runCli(["x.gz", "--replay", "--override", pair], load);
      expect(r.exitCode, pair).toBe(1);
      expect(r.output, pair).toMatch(new RegExp(pair.split("=")[0]!));
    }
  });

  it("invalid のうち計算し直しが例外を投げた行の件数を、表の下に出す(上書きなしの --replay のとき)", () => {
    const lines = runCli(["x.gz", "--replay"], load).output.split("\n");
    expect(lines).toContain("invalid のうち計算し直しが例外を投げた行(route=invalid の記録との食い違いではない): 全体 0・中央 0・地方 0");
  });

  describe("--override model=<id>(Issue #524)", () => {
    // 混在の経路(ワイド ON)の 3 行(中央 2・地方 1)と、複勝だけの経路の中央 1 行。条件付きベルヌーイでは、混在の 3 行が route=invalid になる。
    const placeOnly = consistentRow({ includeComboOdds: 0, evThreshold: 0.9 }, {}, { ...settled, analysis: { ...CHOSEN, id: 3, raceId: "202606030813" } });
    const withPlaceOnly = parseAllocationDataset(fileOf([matchA, matchB, narMismatch, narNoOdds, placeOnly]));
    const loadWith = (): typeof withPlaceOnly => withPlaceOnly;
    const cbLines = (): string[] => runCli(["x.gz", "--replay", "--override", "model=conditional-bernoulli"], loadWith).output.split("\n");

    it("上書きの内容に model=<id> を出し、一致率は出さない。invalid になった行数(全体・中央・地方)を必ず出す", () => {
      const r = runCli(["x.gz", "--replay", "--override", "model=conditional-bernoulli"], loadWith);
      expect(r.exitCode).toBe(0);
      const lines = r.output.split("\n");
      expect(lines).toContain("## 設定の上書き: model=conditional-bernoulli(一致率は出さない)");
      expect(r.output).not.toMatch(/## 計算し直しの一致率/);
      expect(lines).toContain("モデルの上書きで route=invalid になり計算し直せなかった行(回収額の集計に入れない): 全体 3・中央 2・地方 1");
    });

    it("invalid になった行は回収額の集計に入れない: 分析時の提案・計算し直した提案とも、残った行(複勝だけの 1 行)だけを数え、行数の表示もそれに合わせる", () => {
      const lines = cbLines();
      const kept = [placeOnly];
      expect(replayableRows(withPlaceOnly.rows)).toHaveLength(4); // 前提: 計算し直せる行は 4 行(オッズなし 1 行は対象外)
      const fmt = (label: string, row: AllocationRaceRow[], betsOf: (r: AllocationRaceRow) => readonly AllocationRowBet[]): string => {
        const o = payoutReport(row, betsOf).overall;
        const rate = o.recoveryRate === null ? "なし" : `${(o.recoveryRate * 100).toFixed(1)}%`;
        return `${label}: 点数 ${o.betCount}・賭け金 ${o.totalStake}・払戻 ${o.totalReturn}・回収率 ${rate}・判定不能 ${o.unjudgedCount}・返還 ${o.refundedCount}`;
      };
      const cbBets = replayedBets(placeOnly, { model: REPLAY_MODELS["conditional-bernoulli"] })!;
      expect(cbBets.length).toBeGreaterThan(0); // 前提: 残った行に買い目がある
      expect(lines).toContain(fmt("分析時の提案(計算し直せた 1 行)", kept, storedBets));
      expect(lines).toContain(fmt("計算し直した提案(計算し直せた 1 行・設定の上書きあり)", kept, () => cbBets));
      // 混ぜていたら変わる数: invalid の 3 行を足した分析時の提案は、残った 1 行だけの提案と点数が違う
      const all = payoutReport(replayableRows(withPlaceOnly.rows), storedBets).overall.betCount;
      expect(all).toBeGreaterThan(payoutReport(kept, storedBets).overall.betCount);
    });

    it("plackett-luce の指定は、invalid の行が 0 で、行数は計算し直せた 4 行すべて", () => {
      const lines = runCli(["x.gz", "--replay", "--override", "model=plackett-luce"], loadWith).output.split("\n");
      expect(lines).toContain("モデルの上書きで route=invalid になり計算し直せなかった行(回収額の集計に入れない): 全体 0・中央 0・地方 0");
      expect(lines.some((l) => l.startsWith("計算し直した提案(計算し直せた 4 行・設定の上書きあり)"))).toBe(true);
    });

    it("model を上書きしないとき(ほかの上書きだけ・上書きなし)は、invalid の行数の行を出さず、これまでの行数の表示のまま", () => {
      for (const argv of [["x.gz", "--replay"], ["x.gz", "--replay", "--override", "minHitProb=0.5"]]) {
        const out = runCli(argv, loadWith).output;
        expect(out, argv.join(" ")).not.toMatch(/モデルの上書きで route=invalid/);
        expect(out, argv.join(" ")).toMatch(/計算し直した提案\(計算し直せた 4 行/);
      }
    });
  });
});
