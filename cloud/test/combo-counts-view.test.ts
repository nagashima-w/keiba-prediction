import { describe, expect, it } from "vitest";
import type { StoredAllocation } from "../../packages/core/src/ev/analysis-store-types";
import { buildComboCountLines } from "../src/combo-counts-view";

/**
 * Issue #296: 「配分の提案」の下に出す、組合せの券種ごとの行(オッズの取得点数・EV プラスの点数・配分の点数)。
 * スナップショット(R2。`comboOdds` の状態と各 `*Combo`、書き込み側が残す `comboStats`)と、D1 の配分(`StoredAllocation`)から作る純関数。
 *
 * 「オッズ n 点」は、`*Combo` の写像のうち**数値のオッズが入っているセル**の数(値が null のセルは数えない)。`obtainedComboCount` ではない。
 */

type BetTypeKey = "wide" | "quinella" | "bracketQuinella" | "exacta" | "trio" | "trifecta";
const COMBO_FIELD: Record<BetTypeKey, string> = {
  wide: "wideCombo",
  quinella: "quinellaCombo",
  bracketQuinella: "bracketQuinellaCombo",
  exacta: "exactaCombo",
  trio: "trioCombo",
  trifecta: "trifectaCombo",
};
const LABEL: Record<BetTypeKey, string> = { wide: "ワイド", quinella: "馬連", bracketQuinella: "枠連", exacta: "馬単", trio: "三連複", trifecta: "三連単" };

type Attempt = { axis: number | null; state: "available" | "unavailable" | "fetchFailed" | "parseError" };

/** 組合せの写像: 数値 `numeric` 個 + null `nulls` 個。 */
function comboMap(numeric: number, nulls = 0): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  for (let i = 0; i < numeric; i++) m[`k${i}`] = 10 + i;
  for (let i = 0; i < nulls; i++) m[`n${i}`] = null;
  return m;
}

function outcomeOf(betType: BetTypeKey, state: "available" | "unavailable" | "failed", expected: number, attempts: Attempt[] = []): unknown {
  return {
    state,
    diagnostics: { betType, requestCount: attempts.length || 1, expectedComboCount: expected, obtainedComboCount: 0, missingComboCount: 0, axisUmabans: [], attempts, numericConflictCount: 0, nullWinConflictCount: 0, conflictSamples: [] },
  };
}

interface TypeSpec {
  readonly state: "available" | "unavailable" | "failed";
  readonly numeric?: number;
  readonly nulls?: number;
  readonly expected?: number;
  readonly attempts?: Attempt[];
}

function snapshotOf(specs: Partial<Record<BetTypeKey, TypeSpec>>, comboStats?: unknown): Record<string, unknown> {
  const comboOdds: Record<string, unknown> = {};
  const snap: Record<string, unknown> = { race: { raceName: "テスト" }, horses: [] };
  for (const [type, spec] of Object.entries(specs) as Array<[BetTypeKey, TypeSpec]>) {
    comboOdds[type] = outcomeOf(type, spec.state, spec.expected ?? spec.numeric ?? 0, spec.attempts);
    if (spec.state === "available") snap[COMBO_FIELD[type]] = comboMap(spec.numeric ?? 0, spec.nulls ?? 0);
  }
  snap["comboOdds"] = comboOdds;
  if (comboStats !== undefined) snap["comboStats"] = comboStats;
  return snap;
}

function allocationOf(over: Partial<StoredAllocation> = {}): StoredAllocation {
  return {
    route: "mixed",
    unavailableReason: null,
    fallbackReason: null,
    skipReasonCode: null,
    bankroll: 10000,
    perRaceCap: 300,
    kellyFraction: 0.5,
    evThreshold: 1,
    includeComboOdds: true,
    includeWide: true,
    includeTrio: true,
    includeQuinella: true,
    includeExacta: true,
    includeTrifecta: true,
    includeBracketQuinella: true,
    betUnit: 100,
    oddsStatus: "middle",
    bets: [{ betType: "win", comboKey: "04", stake: 100, odds: 5, ev: 1.2 }],
    ...over,
  };
}

const bet = (betType: string, stake = 100) => ({ betType, comboKey: "x", stake, odds: 5, ev: 1.2 });

describe("buildComboCountLines: 券種ごとの行(Issue #296)", () => {
  it("取得できた券種は「オッズ n 点取得・EV プラス m 点・配分 k 点」。EV プラスがあるのに配分 0 点なら理由を添える", () => {
    const lines = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 2184 } }, { trifecta: { positive: 37, judged: 2184 } }), allocationOf());
    expect(lines).toEqual(["三連単: オッズ 2,184 点取得・EV プラス 37 点・配分 0 点(他の買い目が優先、または 100 円未満)"]);
  });

  it("オッズの点数は数値のセルの数。null のセルは数えず、期待の点数に満たなければ「n/m」(obtainedComboCount ではない)", () => {
    const lines = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 2180, nulls: 4, expected: 2184 } }, { trifecta: { positive: 0, judged: 2180 } }), allocationOf());
    expect(lines).toEqual(["三連単: オッズ 2,180/2,184 点取得・EV プラス 0 点・配分 0 点"]);
  });

  it("期待の点数と同じ(満たしている)なら「n/m」にせず n だけ", () => {
    const lines = buildComboCountLines(snapshotOf({ wide: { state: "available", numeric: 28 } }, { wide: { positive: 3, judged: 28 } }), allocationOf({ bets: [bet("wide")] }));
    expect(lines).toEqual(["ワイド: オッズ 28 点取得・EV プラス 3 点・配分 1 点"]);
  });

  it("軸ごとの取得で、取得できなかった軸(available でない試行)の本数を添える。軸のない試行(中央)は数えない", () => {
    const attempts: Attempt[] = [
      { axis: 1, state: "available" },
      { axis: 2, state: "fetchFailed" },
      { axis: 3, state: "parseError" },
      { axis: 4, state: "unavailable" },
      { axis: null, state: "fetchFailed" },
    ];
    const [line] = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 1500, expected: 2184, attempts } }), undefined)!;
    expect(line).toBe("三連単: オッズ 1,500/2,184 点取得(取得できなかった軸 3 本)");
    const [none] = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 60, expected: 60, attempts: [{ axis: 1, state: "available" }] } }), undefined)!;
    expect(none).toBe("三連単: オッズ 60 点取得");
  });

  it("取得できなかった(failed)・発売なし(unavailable)は、その状態だけの行(EV・配分の点数は出さない)", () => {
    const lines = buildComboCountLines(snapshotOf({ exacta: { state: "failed" }, bracketQuinella: { state: "unavailable" } }, { exacta: { positive: 5, judged: 5 } }), allocationOf());
    expect(lines).toEqual(["枠連: オッズなし(未発売・発売なし・読み取れず)", "馬単: オッズを取得できませんでした"]);
  });

  it("券種の並びは ワイド → 馬連 → 枠連 → 馬単 → 三連複 → 三連単、ラベルは券種ごと", () => {
    const specs: Partial<Record<BetTypeKey, TypeSpec>> = {};
    for (const t of ["trifecta", "trio", "exacta", "bracketQuinella", "quinella", "wide"] as const) specs[t] = { state: "unavailable" };
    const lines = buildComboCountLines(snapshotOf(specs), undefined)!;
    expect(lines.map((l) => l.split(":")[0])).toEqual(["ワイド", "馬連", "枠連", "馬単", "三連複", "三連単"]);
  });

  it("comboOdds に無い券種(券種を足す前の分析)は行を出さない。comboOdds 自体が無い・スナップショットが不正なら null", () => {
    const lines = buildComboCountLines(snapshotOf({ wide: { state: "unavailable" } }), undefined)!;
    expect(lines).toHaveLength(1);
    expect(buildComboCountLines({ race: {}, horses: [] }, allocationOf())).toBeNull();
    for (const bad of [null, undefined, "x", 3, []]) expect(buildComboCountLines(bad, allocationOf()), String(bad)).toBeNull();
    expect(buildComboCountLines({ comboOdds: { wide: { state: "unknown" }, trio: null, trifecta: "x" } }, undefined)).toBeNull();
  });
});

describe("buildComboCountLines: 配分の点数と設定(Issue #296)", () => {
  it("配分の点数は、その券種の stake>0 の明細の件数(円の合計ではない)。券種を取り違えない", () => {
    const specs: Partial<Record<BetTypeKey, TypeSpec>> = {};
    const stats: Record<string, unknown> = {};
    for (const t of ["wide", "quinella", "exacta", "trio", "trifecta", "bracketQuinella"] as const) {
      specs[t] = { state: "available", numeric: 10 };
      stats[t] = { positive: 9, judged: 10 };
    }
    const bets = [bet("wide", 500), bet("wide", 200), bet("quinella", 100), bet("trio", 100), bet("trio", 100), bet("trio", 100), bet("exacta", 100), bet("trifecta", 100), bet("trifecta", 100), bet("trifecta", 100), bet("trifecta", 100), bet("bracketQuinella", 100), bet("win"), bet("place")];
    const lines = buildComboCountLines(snapshotOf(specs, stats), allocationOf({ bets }))!;
    const counts = Object.fromEntries(lines.map((l) => [l.split(":")[0], Number(/配分 (\d+) 点/.exec(l)![1])]));
    expect(counts).toEqual({ ワイド: 2, 馬連: 1, 枠連: 1, 馬単: 1, 三連複: 3, 三連単: 4 });
  });

  it("配分に含めない設定(券種ごとの include)の券種は「配分に含めない設定」。ほかの券種に波及しない(券種と設定の対応を固定)", () => {
    const flag: Record<BetTypeKey, keyof StoredAllocation> = {
      wide: "includeWide",
      quinella: "includeQuinella",
      bracketQuinella: "includeBracketQuinella",
      exacta: "includeExacta",
      trio: "includeTrio",
      trifecta: "includeTrifecta",
    };
    const specs: Partial<Record<BetTypeKey, TypeSpec>> = {};
    for (const t of Object.keys(flag) as BetTypeKey[]) specs[t] = { state: "available", numeric: 10 };
    for (const off of Object.keys(flag) as BetTypeKey[]) {
      const lines = buildComboCountLines(snapshotOf(specs, { [off]: { positive: 1, judged: 1 } }), allocationOf({ [flag[off]]: false } as Partial<StoredAllocation>))!;
      const offLines = lines.filter((l) => l.includes("配分に含めない設定"));
      expect(offLines, off).toHaveLength(1);
      expect(offLines[0]!.startsWith(`${LABEL[off]}:`), off).toBe(true);
    }
  });

  it("EV を判定できた点数が 0 のときは「EV プラス 0 点」と書かず「EV 判定できず」(配分 0 点は出す)", () => {
    const [line] = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 60 } }, { trifecta: { positive: 0, judged: 0 } }), allocationOf())!;
    expect(line).toBe("三連単: オッズ 60 点取得・EV 判定できず・配分 0 点");
    const [zero] = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 60 } }, { trifecta: { positive: 0, judged: 60 } }), allocationOf())!;
    expect(zero).toBe("三連単: オッズ 60 点取得・EV プラス 0 点・配分 0 点");
  });

  it("理由は「EV プラスが 1 点以上あって配分が 0 点」のときだけ。配分があれば出さない", () => {
    const snap = snapshotOf({ trifecta: { state: "available", numeric: 60 } }, { trifecta: { positive: 5, judged: 60 } });
    expect(buildComboCountLines(snap, allocationOf({ bets: [bet("trifecta")] }))![0]).toBe("三連単: オッズ 60 点取得・EV プラス 5 点・配分 1 点");
    expect(buildComboCountLines(snap, allocationOf())![0]).toContain("(他の買い目が優先、または 100 円未満)");
  });

  it("理由の優先: 配分の計算に失敗(invalid)> レース全体が見送り(skipReasonCode)> 他の買い目が優先、または 100 円未満", () => {
    const snap = snapshotOf({ trifecta: { state: "available", numeric: 60 } }, { trifecta: { positive: 5, judged: 60 } });
    expect(buildComboCountLines(snap, allocationOf({ route: "invalid", skipReasonCode: "no-edge" }))![0]).toBe("三連単: オッズ 60 点取得・EV プラス 5 点・配分 0 点(配分の計算に失敗)");
    expect(buildComboCountLines(snap, allocationOf({ skipReasonCode: "cap-too-small", bets: [] }))![0]).toBe("三連単: オッズ 60 点取得・EV プラス 5 点・配分 0 点(レース全体が見送り)");
  });

  it("書き込み側の記録(comboStats)が無い分析(過去の分析)は、EV プラスと理由を出さず、取得の点数と配分の点数だけ", () => {
    const lines = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 60 }, wide: { state: "available", numeric: 10 } }), allocationOf({ bets: [bet("wide")] }))!;
    expect(lines).toEqual(["ワイド: オッズ 10 点取得・配分 1 点", "三連単: オッズ 60 点取得・配分 0 点"]);
    for (const l of lines) expect(l).not.toContain("EV");
  });

  it("comboStats が不正(形が違う)なら無いものとして扱う", () => {
    const [line] = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 60 } }, { trifecta: { positive: 9, judged: 3 } }), allocationOf())!;
    expect(line).toBe("三連単: オッズ 60 点取得・配分 0 点");
  });

  it("配分の記録が無い(undefined)なら取得の点数だけ。配分の経路が unset・yoso・unavailable なら配分の点数も出さない", () => {
    const snap = snapshotOf({ trifecta: { state: "available", numeric: 60 } });
    expect(buildComboCountLines(snap, undefined)).toEqual(["三連単: オッズ 60 点取得"]);
    for (const route of ["unset", "yoso", "unavailable"]) {
      expect(buildComboCountLines(snap, allocationOf({ route }))).toEqual(["三連単: オッズ 60 点取得"]);
    }
  });

  it("place-only(組合せの候補が 0 点でフォールバック)は配分 0 点を出す。EV プラスは comboStats の 0 点", () => {
    const snap = snapshotOf({ trifecta: { state: "available", numeric: 60 } }, { trifecta: { positive: 0, judged: 60 } });
    expect(buildComboCountLines(snap, allocationOf({ route: "place-only", fallbackReason: "no-combo-candidates" }))).toEqual(["三連単: オッズ 60 点取得・EV プラス 0 点・配分 0 点"]);
  });
});

describe("buildComboCountLines: 画面の文言(リテラルで固定。原因を断定しない)", () => {
  it("EV プラスがあって配分 0 点の既定の理由は、2 つの原因を含む中立な文言(他の買い目が優先 / 連続配分は正でも 100 円の単位に届かず切り捨て。D1 には stake>0 しか残らず、画面からは見分けられない)", () => {
    const snap = snapshotOf({ wide: { state: "available", numeric: 28 } }, { wide: { positive: 3, judged: 28 } });
    const [line] = buildComboCountLines(snap, allocationOf())!;
    expect(line).toBe("ワイド: オッズ 28 点取得・EV プラス 3 点・配分 0 点(他の買い目が優先、または 100 円未満)");
    expect(line).not.toContain("(他の買い目が優先)"); // 旧の文言(原因を 1 つに断定)
  });

  it("取得できなかった軸の本数は「失敗」と書かない(その軸にオッズが無い unavailable も数えるため)", () => {
    const attempts: Attempt[] = [{ axis: 1, state: "unavailable" }, { axis: 2, state: "available" }];
    const [line] = buildComboCountLines(snapshotOf({ trifecta: { state: "available", numeric: 60, expected: 120, attempts } }), undefined)!;
    expect(line).toBe("三連単: オッズ 60/120 点取得(取得できなかった軸 1 本)");
    expect(line).not.toContain("失敗");
  });

  it("unavailable は、未発売・発売なし・パーサが読み取れなかった場合を区別せず、すべてを含む文言(「発売なし」と断定しない)", () => {
    const [line] = buildComboCountLines(snapshotOf({ trifecta: { state: "unavailable" } }), undefined)!;
    expect(line).toBe("三連単: オッズなし(未発売・発売なし・読み取れず)");
    expect(line).not.toContain("オッズが無い");
  });
});
