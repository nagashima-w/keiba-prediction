import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collectProposedBetEvents, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
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
  type ChosenAllocationAnalysis,
} from "../../cloud/src/allocation-export-format.js";
import { compareReplay, judgeRaceBets, parseAllocationDataset, replayRace, summarize, type ReplayOutcome } from "../allocation-dataset.js";

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

describe("replayRace が D1 の NULL を読む規則(書き出しは NULL のまま。読み手が解釈する): min_hit_prob の NULL は 0、include_* の NULL は OFF、枠番は結果の枠番で補う", () => {
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
  /** `snapshotWakuban`: 分析時のスナップショットの枠番(false なら NULL)。`resultWakuban`: 結果の枠番(false なら NULL)。 */
  function raceRow(settings: Settings, wakuban: { snapshot?: boolean; result?: boolean } = {}): AllocationRaceRow {
    const meta: AllocationMetaInput = {
      ...META, comboOddsWide: "present", comboOddsTrio: null, bankroll: 100_000, perRaceCap: 20_000, kellyFraction: 0.5, evThreshold: 1, includeComboOdds: 1,
      includeWide: 0, includeTrio: 0, includeQuinella: 0, includeExacta: 0, includeTrifecta: 0, includeBracketQuinella: 0, minHitProb: 0, ...settings,
    };
    return buildAllocationRaceRow({
      analysis: CHOSEN,
      horses: P.map((p, i) => ({ umaban: i + 1, prior: p, adjustedProb: p, placeOddsMin: PLACE[i]!, ev: null })),
      snapshot: {
        present: true,
        race: { course_type: "芝", distance: 1600, grade: null },
        horses: new Map(P.map((_, i) => [i + 1, { wakuban: wakuban.snapshot === false ? null : i + 1, win_odds: 10, ninki: i + 1, place_min: PLACE[i]!, place_max: PLACE[i]! + 1 }] as const)),
        combos,
        comboStates: {},
      },
      meta,
      bets: [],
      results: P.map((_, i) => ({ umaban: i + 1, finishPosition: i + 1, placePayout: null, winPayout: null, scratched: 0, wakuban: wakuban.result === false ? null : i + 1, winOdds: null, ninki: null })),
      payouts: [],
      imports: [],
    });
  }

  /** 計算し直した提案(route と買い目の券種・キー・金額)。 */
  function replayed(row: AllocationRaceRow): { route: string; bets: string[] } {
    const outcome = replayRace(row);
    expect(outcome.kind).toBe("replayed");
    const allocation = (outcome as Extract<ReplayOutcome, { kind: "replayed" }>).result.allocation;
    return { route: allocation.meta.route, bets: allocation.bets.map((b) => `${b.betType}:${b.comboKey}=${b.stake}`) };
  }

  const INCLUDE_COLUMNS = ["includeWide", "includeTrio", "includeQuinella", "includeExacta", "includeTrifecta", "includeBracketQuinella"] as const;
  const KIND_OF: Record<(typeof INCLUDE_COLUMNS)[number], string> = {
    includeWide: "wide", includeTrio: "trio", includeQuinella: "quinella", includeExacta: "exacta", includeTrifecta: "trifecta", includeBracketQuinella: "bracketQuinella",
  };

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
