import { describe, expect, it } from "vitest";
import { judgeBets, type RaceResultData } from "../src/daily-report-bets";
import { collectProposedBetEvents, computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify.js";
import type { RaceComboPayoutsReadResult, RaceResultEntry, StoredAnalysis, VerifyDataSource } from "../../packages/core/src/ev/analysis-store-types.js";

/**
 * Issue #398(R-7): 買い目の的中判定を 1 本にまとめる前の**特性テスト**。
 * 判定は 2 か所(core の `computeProposedBetReport`〈`collectProposedBetEvents` が事象を、`computeVerifyReport` が集計を出す〉と、
 * cloud の `judgeBets`)に別々にあった。同じ入力を両方に通して、(1) 旧の出力を固定したリテラルと一致すること、(2) 2 か所が買い目ごとに一致すること、を固定する。
 * 共通化の前後でこのファイルは書き換えない(共通化が出力を 1 つも変えないことの守り)。
 *
 * 入力は 2 種類:
 *  - 手書きの表(券種 × 的中/はずれ/返還/取込ゲート/キー不一致ほか)。期待値は旧コードの実出力をリテラルで書いたもの。
 *  - 固定の種の乱数で作った 1,500 レースぶん。券種 × 状態の度数表と払戻の総和を、旧コードで取ったリテラルとして固定し、買い目ごとの一致も見る。
 */

// ---------------------------------------------------------------------------
// 2 か所に同じ入力を通す
// ---------------------------------------------------------------------------
interface Horse {
  umaban: number;
  finishPosition: number | null;
  winPayout?: number | null;
  placePayout?: number | null;
  scratched?: boolean;
  wakuban?: number;
}
interface Combo {
  imported: boolean;
  payouts: { comboKey: string; payout: number }[];
}
interface Case {
  horses: Horse[];
  combos: Record<string, Combo>;
  bets: { betType: string; comboKey: string; stake: number }[];
}

const KNOWN_TYPES = ["place", "win", "wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"];

/** cloud の `ResultHorse` は払戻が `number | null`(リポジトリが `?? null` で正規化する)。`undefined` は null にして渡す。 */
function cloudResult(c: Case): RaceResultData {
  return {
    horses: c.horses.map((h) => ({
      umaban: h.umaban,
      finishPosition: h.finishPosition,
      winPayout: h.winPayout ?? null,
      placePayout: h.placePayout ?? null,
      ...(h.scratched === undefined ? {} : { scratched: h.scratched }),
      ...(h.wakuban === undefined ? {} : { wakuban: h.wakuban }),
    })),
    combos: c.combos,
  };
}

function coreSource(c: Case): VerifyDataSource {
  const raceId = "202606030811";
  const results: RaceResultEntry[] = c.horses.map((h) => ({ ...h }));
  const analysis = {
    id: 1, raceId, analyzedAt: "2026-06-07T05:00:00.000Z", evEstimated: false, promptVersion: "v1", additionalInstruction: null, kaisaiDate: "20260607",
    model: null, rawResponse: null, raceSnapshot: null, historyCutoffDate: "20260607", promptLookaheadGuarded: true, horses: [],
  } as unknown as StoredAnalysis;
  return {
    listAnalyses: () => [analysis],
    getResult: () => results,
    getComboPayouts: (_id: string, betType: string): RaceComboPayoutsReadResult => {
      const x = c.combos[betType];
      return x === undefined || !x.imported ? { state: "not_imported" } : { state: "imported", payouts: x.payouts };
    },
    getAllocationForVerify: () => ({ route: "mixed", skipReasonCode: null, bets: c.bets.map((b) => ({ ...b })) }),
  } as unknown as VerifyDataSource;
}

const CONFIG = { ...PRODUCTION_VERIFY_CONFIG, excludeLookaheadSuspects: false };

interface Judged {
  readonly status: string;
  readonly payout: number;
}

/** 買い目ごとの (status, payout)。core は未知の券種の行に事象を出さない(`unknownBetType` に数える)ので、その行は cloud の値(unjudged, 0)で埋め、cloud と同じと見なす。 */
function runBoth(c: Case): { core: Judged[]; cloud: Judged[] } {
  const events = collectProposedBetEvents(coreSource(c), CONFIG);
  let i = 0;
  const core = c.bets.map((b): Judged => {
    if (!KNOWN_TYPES.includes(b.betType)) {
      return { status: "unjudged", payout: 0 };
    }
    const e = events[i++]!;
    expect([e.betType, e.comboKey, e.stake]).toEqual([b.betType, b.comboKey, b.stake]);
    return { status: e.outcome, payout: e.payout };
  });
  expect(i, "既知の券種の買い目と事象の数が一致する").toBe(events.length);
  const cloud = judgeBets(c.bets.map((x) => ({ ...x, odds: null })), cloudResult(c)).map((o): Judged => ({ status: o.status, payout: o.payout }));
  return { core, cloud };
}

// ---------------------------------------------------------------------------
// 手書きの表
// ---------------------------------------------------------------------------
/** 6 頭立て。枠は 1 頭ずつ(umaban = wakuban)。取消・除外は無い。 */
const baseHorses = (): Horse[] => [
  { umaban: 1, finishPosition: 1, winPayout: 450, placePayout: 150, scratched: false, wakuban: 1 },
  { umaban: 2, finishPosition: 2, winPayout: null, placePayout: 210, scratched: false, wakuban: 2 },
  { umaban: 3, finishPosition: 3, winPayout: null, placePayout: 320, scratched: false, wakuban: 3 },
  { umaban: 4, finishPosition: 4, winPayout: null, placePayout: null, scratched: false, wakuban: 4 },
  { umaban: 5, finishPosition: 5, winPayout: null, placePayout: null, scratched: false, wakuban: 5 },
  { umaban: 6, finishPosition: 6, winPayout: null, placePayout: null, scratched: false, wakuban: 6 },
];
const baseCombos = (): Record<string, Combo> => ({
  wide: { imported: true, payouts: [{ comboKey: "0102", payout: 800 }, { comboKey: "0103", payout: 1500 }] },
  trio: { imported: true, payouts: [{ comboKey: "010203", payout: 2400 }] },
  quinella: { imported: true, payouts: [{ comboKey: "0102", payout: 1200 }] },
  exacta: { imported: true, payouts: [{ comboKey: "0102", payout: 3200 }] },
  trifecta: { imported: true, payouts: [{ comboKey: "010203", payout: 15000 }] },
  bracketQuinella: { imported: true, payouts: [{ comboKey: "0102", payout: 1100 }] },
});
const b = (betType: string, comboKey: string, stake = 100) => ({ betType, comboKey, stake });

type Row = readonly [name: string, build: () => Case, expected: readonly (readonly [string, number])[]];

const TABLE: readonly Row[] = [
  [
    "8 券種の的中・はずれ(払戻 × 賭け金 / 100)",
    () => ({
      horses: baseHorses(),
      combos: baseCombos(),
      bets: [
        b("win", "01", 300), b("win", "02", 200), b("place", "02", 500), b("place", "04", 100),
        b("wide", "0103", 200), b("wide", "0203", 100), b("trio", "010203", 150), b("trio", "010204", 100),
        b("quinella", "0102", 100), b("quinella", "0103", 100), b("exacta", "0102", 100), b("exacta", "0201", 100),
        b("trifecta", "010203", 100), b("trifecta", "010302", 100), b("bracketQuinella", "0102", 200), b("bracketQuinella", "0203", 100),
      ],
    }),
    [
      ["hit", 1350], ["miss", 0], ["hit", 1050], ["miss", 0], ["hit", 3000], ["miss", 0], ["hit", 3600], ["miss", 0],
      ["hit", 1200], ["miss", 0], ["hit", 3200], ["miss", 0], ["hit", 15000], ["miss", 0], ["hit", 2200], ["miss", 0],
    ],
  ],
  [
    "取込ゲート: 取込印なし(払戻の行があっても)・払戻 0 件・券種の行なしは判定不能。単勝・複勝の払戻が 1 頭にも無いレースも判定不能",
    () => {
      const horses = baseHorses().map((h) => ({ ...h, winPayout: null, placePayout: null }));
      const combos = baseCombos();
      combos.wide = { imported: false, payouts: [{ comboKey: "0102", payout: 800 }] };
      combos.trio = { imported: true, payouts: [] };
      delete combos.quinella;
      return { horses, combos, bets: [b("win", "01"), b("place", "01"), b("wide", "0102"), b("trio", "010203"), b("quinella", "0102"), b("exacta", "0102")] };
    },
    [["unjudged", 0], ["unjudged", 0], ["unjudged", 0], ["unjudged", 0], ["unjudged", 0], ["hit", 3200]],
  ],
  [
    "単勝だけ払戻が無い(複勝はある)レースでは、単勝は判定不能・複勝は判定できる。逆の場合も同じ",
    () => {
      const horses = baseHorses().map((h) => ({ ...h, winPayout: null }));
      return { horses, combos: baseCombos(), bets: [b("win", "01"), b("place", "01"), b("place", "02")] };
    },
    [["unjudged", 0], ["hit", 150], ["hit", 210]],
  ],
  [
    "複勝だけ払戻が無い(単勝はある)レース",
    () => {
      const horses = baseHorses().map((h) => ({ ...h, placePayout: null }));
      return { horses, combos: baseCombos(), bets: [b("win", "01"), b("win", "02"), b("place", "01")] };
    },
    [["hit", 450], ["miss", 0], ["unjudged", 0]],
  ],
  [
    "払戻 0 円の的中は hit(払戻 0)で、miss にしない。単勝の同着は 2 頭とも的中",
    () => {
      const horses = baseHorses();
      horses[1]!.winPayout = 0;
      horses[0]!.winPayout = 450;
      const combos = baseCombos();
      combos.wide = { imported: true, payouts: [{ comboKey: "0102", payout: 0 }] };
      return { horses, combos, bets: [b("win", "01", 100), b("win", "02", 100), b("wide", "0102", 100)] };
    },
    [["hit", 450], ["hit", 0], ["hit", 0]],
  ],
  [
    "キーの重複は最初の行を使う。キーの不一致(桁違い・空・順序違い)はすべて miss",
    () => {
      const combos = baseCombos();
      combos.wide = { imported: true, payouts: [{ comboKey: "0102", payout: 800 }, { comboKey: "0102", payout: 9999 }] };
      return { horses: baseHorses(), combos, bets: [b("wide", "0102"), b("wide", "102"), b("wide", ""), b("exacta", "0201"), b("trifecta", "020103")] };
    },
    [["hit", 800], ["miss", 0], ["miss", 0], ["miss", 0], ["miss", 0]],
  ],
  [
    "返還: 取消・除外の馬(scratched===true)を構成に含む買い目は賭け金そのものを払戻にする(馬単・三連単は順序に依らない)。構成に含まない買い目は通常の判定",
    () => {
      const horses = baseHorses();
      horses[2]!.scratched = true;
      horses[2]!.finishPosition = null;
      horses[2]!.placePayout = null;
      return {
        horses,
        combos: baseCombos(),
        bets: [b("win", "03", 200), b("place", "03", 300), b("wide", "0103", 400), b("trio", "010203", 500), b("exacta", "0301", 100), b("trifecta", "030102", 100), b("quinella", "0102", 100), b("win", "01", 100)],
      };
    },
    [["refund", 200], ["refund", 300], ["refund", 400], ["refund", 500], ["refund", 100], ["refund", 100], ["hit", 1200], ["hit", 450]],
  ],
  [
    "返還は取込ゲートより前: 払戻が未取込でも返還にする。取消が無い構成の買い目は判定不能のまま",
    () => {
      const horses = baseHorses().map((h) => ({ ...h, winPayout: null, placePayout: null }));
      horses[2]!.scratched = true;
      const combos = baseCombos();
      combos.wide = { imported: false, payouts: [] };
      combos.trio = { imported: true, payouts: [] };
      return { horses, combos, bets: [b("win", "03"), b("place", "03"), b("wide", "0103"), b("trio", "010203"), b("wide", "0102"), b("win", "01")] };
    },
    [["refund", 100], ["refund", 100], ["refund", 100], ["refund", 100], ["unjudged", 0], ["unjudged", 0]],
  ],
  [
    "scratched が false・未記録の着順なし(中止・失格・旧い行)は返還にしない",
    () => {
      const horses = baseHorses();
      horses[3]!.finishPosition = null;
      delete horses[4]!.scratched;
      horses[4]!.finishPosition = null;
      return { horses, combos: baseCombos(), bets: [b("win", "04"), b("place", "05"), b("wide", "0104"), b("trio", "010205")] };
    },
    [["miss", 0], ["miss", 0], ["miss", 0], ["miss", 0]],
  ],
  [
    "復元できないキーの買い目は、取消の馬がいても返還にしない(通常の判定へ進む)",
    () => {
      const horses = baseHorses();
      horses[2]!.scratched = true;
      return { horses, combos: baseCombos(), bets: [b("wide", "abcd"), b("wide", ""), b("win", "x")] };
    },
    [["miss", 0], ["miss", 0], ["miss", 0]],
  ],
  [
    "枠連の返還(枠 3 の馬が尽きた): 枠 3 を含む組は返還、ゾロ目も返還。含まない組は通常の判定。枠連のキーは馬番ではなく枠番として見る",
    () => {
      const horses = baseHorses();
      horses[2]!.scratched = true;
      return { horses, combos: baseCombos(), bets: [b("bracketQuinella", "0203", 100), b("bracketQuinella", "0303", 100), b("bracketQuinella", "0102", 200), b("bracketQuinella", "0104", 100)] };
    },
    [["refund", 100], ["refund", 100], ["hit", 2200], ["miss", 0]],
  ],
  [
    "枠連のゾロ目: 同枠に他馬が 1 頭残れば返還、2 頭残れば返還なし(その枠の取消が 1 頭)",
    () => {
      const horses = baseHorses();
      // 枠 6 に 6・7 番の 2 頭、枠 5 に 5・8・9 番の 3 頭。各枠で 1 頭取消
      horses.push({ umaban: 7, finishPosition: 7, winPayout: null, placePayout: null, scratched: true, wakuban: 6 });
      horses.push({ umaban: 8, finishPosition: 8, winPayout: null, placePayout: null, scratched: false, wakuban: 5 });
      horses.push({ umaban: 9, finishPosition: 9, winPayout: null, placePayout: null, scratched: true, wakuban: 5 });
      return { horses, combos: baseCombos(), bets: [b("bracketQuinella", "0606"), b("bracketQuinella", "0505"), b("bracketQuinella", "0105")] };
    },
    [["refund", 100], ["miss", 0], ["miss", 0]],
  ],
  [
    "枠連: 枠番か scratched が未記録の行があるレース、枠番が範囲外の行があるレースは返還を判定しない(不的中のまま)",
    () => {
      const horses = baseHorses();
      horses[2]!.scratched = true;
      delete horses[0]!.wakuban;
      return { horses, combos: baseCombos(), bets: [b("bracketQuinella", "0203"), b("bracketQuinella", "0102")] };
    },
    [["miss", 0], ["hit", 1100]],
  ],
  [
    "枠連: 取消のあるレースで枠連の買い目に使える枠番が範囲外(0・9)の組は返還にしない",
    () => {
      const horses = baseHorses();
      horses[2]!.scratched = true;
      return { horses, combos: baseCombos(), bets: [b("bracketQuinella", "0003"), b("bracketQuinella", "0309"), b("bracketQuinella", "0306")] };
    },
    [["miss", 0], ["miss", 0], ["refund", 100]],
  ],
  [
    "未知の券種は判定不能(賭け金は返す)。既知の券種の判定には影響しない",
    () => ({ horses: baseHorses(), combos: baseCombos(), bets: [b("mystery", "01", 700), b("win", "01", 100), b("mystery", "0102", 100), b("wide", "0102", 100)] }),
    [["unjudged", 0], ["hit", 450], ["unjudged", 0], ["hit", 800]],
  ],
  [
    "馬が 0 頭の結果: 単勝・複勝は判定不能、組合せは払戻表で判定する",
    () => ({ horses: [], combos: baseCombos(), bets: [b("win", "01"), b("place", "01"), b("wide", "0102"), b("bracketQuinella", "0102")] }),
    [["unjudged", 0], ["unjudged", 0], ["hit", 800], ["hit", 1100]],
  ],
];

describe("Issue #398 特性テスト: 手書きの表(旧コードの出力をリテラルで固定。core と cloud の両方)", () => {
  it.each(TABLE.map((r) => [r[0], r] as const))("%s", (_name, [, build, expected]) => {
    const c = build();
    expect(c.bets.length, "前提: 期待値の行数と買い目の数が一致する").toBe(expected.length);
    const { core, cloud } = runBoth(c);
    const want = expected.map(([status, payout]) => ({ status, payout }));
    expect(core, "core").toEqual(want);
    expect(cloud, "cloud").toEqual(want);
  });

  it("前提(空振り防止): 表全体で 4 つの状態(hit・miss・refund・unjudged)と 8 券種が出ている", () => {
    const statuses = new Set<string>();
    const types = new Set<string>();
    for (const [, build, expected] of TABLE) {
      const c = build();
      c.bets.forEach((bet, i) => {
        statuses.add(expected[i]![0]);
        types.add(bet.betType);
      });
    }
    expect([...statuses].sort()).toEqual(["hit", "miss", "refund", "unjudged"]);
    expect(KNOWN_TYPES.every((t) => types.has(t))).toBe(true);
  });

  it("手書きの表の全入力で、core の proposedBet 集計(判定できた点数・賭け金・払戻・判定不能)が、cloud の出力の合計と一致する", () => {
    let judgedTotal = 0;
    for (const [, build] of TABLE) {
      const c = build();
      const report = computeVerifyReport(coreSource(c), CONFIG).proposedBet;
      const out = judgeBets(c.bets.map((x) => ({ ...x, odds: null })), cloudResult(c));
      const known = out.filter((o) => KNOWN_TYPES.includes(o.betType));
      const judged = known.filter((o) => o.status !== "unjudged");
      judgedTotal += judged.length;
      expect(report.overall.betCount).toBe(judged.length);
      expect(report.overall.totalStake).toBe(judged.reduce((s, o) => s + o.stake, 0));
      expect(report.overall.totalReturn).toBeCloseTo(judged.reduce((s, o) => s + o.payout, 0), 6);
      expect(report.overall.unjudgedCount).toBe(known.length - judged.length);
      expect(report.overall.refundedCount).toBe(judged.filter((o) => o.status === "refund").length);
      expect(report.unknownBetType.count).toBe(out.length - known.length);
    }
    expect(judgedTotal).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// 固定の種の乱数(1,500 レース)
// ---------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMBO_TYPES = ["wide", "trio", "quinella", "exacta", "trifecta", "bracketQuinella"] as const;
const COMBO_SIZE: Record<string, number> = { wide: 2, trio: 3, quinella: 2, exacta: 2, trifecta: 3, bracketQuinella: 2 };
const ORDERED = new Set(["exacta", "trifecta"]);
const two = (n: number): string => String(n).padStart(2, "0");

function generate(seed: number): Case {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const head = 4 + Math.floor(r() * 15);
  const oldRows = r() < 0.15; // scratched / wakuban が未記録の旧い行
  const badWaku = r() < 0.1;
  const raceHasScratch = r() < 0.5;
  const horses: Horse[] = [];
  for (let u = 1; u <= head; u += 1) {
    const h: Horse = { umaban: u, finishPosition: r() < 0.9 ? u : null };
    if (!oldRows || r() < 0.5) h.scratched = raceHasScratch && r() < 0.25;
    if (r() < 0.05) delete h.scratched;
    if (!oldRows || r() < 0.5) h.wakuban = badWaku && r() < 0.3 ? pick([0, 9, -1, 1.5]) : r() < 0.6 ? Math.min(8, Math.ceil((u * 8) / head)) : 1 + Math.floor(r() * 8);
    horses.push(h);
  }
  const winMode = pick(["none", "one", "two", "undef"]);
  const placeMode = pick(["none", "three", "two", "undef"]);
  const payoutValue = (): number => (r() < 0.03 ? 0 : 100 + Math.floor(r() * 50) * 10);
  for (const h of horses) {
    if ((winMode === "one" && h.umaban === 1) || (winMode === "two" && h.umaban <= 2)) h.winPayout = payoutValue();
    else if (winMode === "none") h.winPayout = null;
    if ((placeMode === "three" && h.umaban <= 3) || (placeMode === "two" && h.umaban <= 2)) h.placePayout = payoutValue();
    else if (placeMode === "none") h.placePayout = null;
    if (h.winPayout === undefined && winMode === "one" && r() < 0.5) h.winPayout = null;
  }
  const keyOf = (type: string, ums: number[]): string => (ORDERED.has(type) ? ums : [...ums].sort((x, y) => x - y)).map(two).join("");
  const sample = (n: number, max: number): number[] => {
    const pool = Array.from({ length: max }, (_, i) => i + 1);
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
    return out;
  };
  const combos: Record<string, Combo> = {};
  for (const t of COMBO_TYPES) {
    const mode = pick(["missing", "notImportedWithRows", "empty", "rows", "rows", "rows"]);
    if (mode === "missing") continue;
    const rows: { comboKey: string; payout: number }[] = [];
    const n = mode === "empty" ? 0 : 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i += 1) rows.push({ comboKey: keyOf(t, sample(COMBO_SIZE[t]!, t === "bracketQuinella" ? 8 : head)), payout: payoutValue() });
    if (rows.length > 1 && r() < 0.1) rows.push({ ...rows[0]!, payout: payoutValue() });
    combos[t] = { imported: mode !== "notImportedWithRows", payouts: rows };
  }
  const bets: Case["bets"] = [];
  const nb = 1 + Math.floor(r() * 12);
  for (let i = 0; i < nb; i += 1) {
    const betType = r() < 0.04 ? "mystery" : pick(KNOWN_TYPES);
    const stake = pick([100, 100, 200, 300, 150, 1000, 7, 1, 12345]);
    const kind = r();
    let comboKey: string;
    const rows = combos[betType]?.payouts ?? [];
    if (betType === "win" || betType === "place") {
      comboKey = kind < 0.9 ? two(1 + Math.floor(r() * head)) : pick(["", "abc", "1", "001", "99"]);
    } else if (kind < 0.35 && rows.length > 0) {
      comboKey = pick(rows).comboKey;
    } else if (kind < 0.55 && betType !== "mystery") {
      comboKey = (pick(rows.length > 0 ? rows : [{ comboKey: "0102", payout: 0 }]).comboKey.match(/../g) ?? []).reverse().join("");
    } else if (kind < 0.95) {
      const t = betType === "mystery" ? "wide" : betType;
      comboKey = keyOf(t, sample(COMBO_SIZE[t]!, t === "bracketQuinella" ? 8 : head));
      if (t === "bracketQuinella" && r() < 0.3) comboKey = keyOf(t, [1, 1].map(() => 1 + Math.floor(r() * 8)));
    } else {
      comboKey = pick(["", "abc", "01", "010101", "0001", "00", "1"]);
    }
    bets.push({ betType, comboKey, stake });
  }
  return { horses, combos, bets };
}

describe("Issue #398 特性テスト: 固定の種の乱数 1,500 レース", () => {
  const RACES = 1500;
  const tally: Record<string, number> = {};
  let betCount = 0;
  let payoutSum = 0;
  let mismatches = 0;
  let firstMismatch = "";
  for (let seed = 1; seed <= RACES; seed += 1) {
    const c = generate(seed);
    const { core, cloud } = runBoth(c);
    c.bets.forEach((bet, i) => {
      betCount += 1;
      payoutSum += cloud[i]!.payout;
      const key = `${bet.betType}:${cloud[i]!.status}`;
      tally[key] = (tally[key] ?? 0) + 1;
      if (core[i]!.status !== cloud[i]!.status || core[i]!.payout !== cloud[i]!.payout) {
        mismatches += 1;
        firstMismatch ||= `seed ${seed} ${JSON.stringify(bet)} core=${JSON.stringify(core[i])} cloud=${JSON.stringify(cloud[i])}`;
      }
    });
  }

  it("core と cloud の判定は、全買い目で状態も払戻も(===)一致する", () => {
    expect(betCount).toBeGreaterThan(5000);
    expect(firstMismatch).toBe("");
    expect(mismatches).toBe(0);
  });

  it("前提(空振り防止): 8 券種 × 4 状態のセルがすべて 0 でない(未知の券種は判定不能のみ)", () => {
    for (const t of KNOWN_TYPES) {
      for (const s of ["hit", "miss", "refund", "unjudged"]) {
        expect(tally[`${t}:${s}`] ?? 0, `${t}:${s}`).toBeGreaterThan(0);
      }
    }
    expect(tally["mystery:unjudged"]).toBeGreaterThan(0);
    expect(Object.keys(tally).filter((k) => k.startsWith("mystery:"))).toEqual(["mystery:unjudged"]);
  });

  it("度数表と払戻の総和が、共通化の前(旧コード)に取った値と一致する", () => {
    expect({ betCount, payoutSum, tally: Object.fromEntries(Object.entries(tally).sort()) }).toEqual(EXPECTED_RANDOM);
  });
});

/** 旧コード(基点 46776b1)の `judgeBets` で取った値(上の `generate` の種 1〜1500)。共通化で変わってはならない。 */
const EXPECTED_RANDOM: { betCount: number; payoutSum: number; tally: Record<string, number> } = {
  betCount: 9711,
  payoutSum: 8279281.100000003,
  tally: {
    "bracketQuinella:hit": 205, "bracketQuinella:miss": 307, "bracketQuinella:refund": 42, "bracketQuinella:unjudged": 584,
    "exacta:hit": 163, "exacta:miss": 337, "exacta:refund": 276, "exacta:unjudged": 458,
    "mystery:unjudged": 379,
    "place:hit": 112, "place:miss": 381, "place:refund": 120, "place:unjudged": 478,
    "quinella:hit": 185, "quinella:miss": 287, "quinella:refund": 220, "quinella:unjudged": 468,
    "trifecta:hit": 140, "trifecta:miss": 265, "trifecta:refund": 306, "trifecta:unjudged": 487,
    "trio:hit": 165, "trio:miss": 276, "trio:refund": 287, "trio:unjudged": 451,
    "wide:hit": 182, "wide:miss": 320, "wide:refund": 205, "wide:unjudged": 482,
    "win:hit": 81, "win:miss": 430, "win:refund": 122, "win:unjudged": 510,
  },
};
