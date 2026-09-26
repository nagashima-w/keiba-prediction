import { describe, expect, it } from "vitest";

import {
  ALLOCATION_BET_TYPE_UMABAN_COUNT,
  allocateGeneralBets,
  buildComboOddsKey,
  type AllocationCandidate,
} from "@keiba/core/ev/combo-bet-allocation";

import type {
  AnalysisRow,
  ComboOddsFetchDiagnosticsView,
  ComboOddsFetchOutcomeView,
} from "../src/shared/analysis-types.js";
import {
  ALL_MIXED_CANDIDATE_BET_TYPES,
  buildMixedCandidates,
  type MixedCandidateBetType,
  type MixedCandidateBuildInput,
} from "../src/shared/mixed-candidates.js";

// ============================================================================
// テストヘルパー(定義したヘルパーはすべて自己テストする。「テストを書くときの注意」参照)
// ============================================================================

/**
 * テスト用のAnalysisRowを組み立てる補助関数(bet-allocation-view.test.tsの流儀を踏襲)。
 *
 * boss メタレビュー指摘(入力フィールド→出力フィールドの写像の取り違え検知)対応:
 * `wakuban`/`prior`/`careerRunCount` を既定値のまま固定していると、これらが誤って
 * 読まれても(型は一致するため)テストで検知できない。個別にoverride可能にし、
 * 各フィールドの既定値を互いに異なる値にしておく(umaban≠wakuban、prior≠adjustedProb、
 * careerRunCount≠placeOddsMin≠ev)ことで、取り違えテストが「値が違う」ことを頼りに
 * 検知できるようにする。
 */
function row(overrides: Partial<AnalysisRow> & { umaban: number }): AnalysisRow {
  return {
    umaban: overrides.umaban,
    wakuban: overrides.wakuban ?? 90, // umaban(1〜18想定)と衝突しない値を既定にする。
    horseName: `${overrides.umaban}番`,
    prior: overrides.prior === undefined ? 0.3 : overrides.prior,
    adjustedProb: overrides.adjustedProb ?? 0.5,
    placeOddsMin: overrides.placeOddsMin === undefined ? 3 : overrides.placeOddsMin,
    winOdds: overrides.winOdds === undefined ? 10 : overrides.winOdds,
    ev: overrides.ev === undefined ? 1.5 : overrides.ev,
    isPositive: overrides.isPositive ?? true,
    reason: null,
    careerRunCount: overrides.careerRunCount === undefined ? 999 : overrides.careerRunCount,
    mark: null,
    evEstimated: overrides.evEstimated ?? false,
    conditionChangeTags: [],
  };
}

/** テスト用のMixedCandidateBuildInputを組み立てる補助関数。 */
function raceInput(
  overrides: Partial<MixedCandidateBuildInput> & { rows: readonly AnalysisRow[] },
): MixedCandidateBuildInput {
  return { oddsStatus: "result", ...overrides };
}

/** items(昇順)から要素数kの組合せを列挙する(テスト専用。本体のkCombinationsOfUmabansとは無関係の独立実装)。 */
function combinations<T>(items: readonly T[], k: number): T[][] {
  const results: T[][] = [];
  if (k <= 0 || k > items.length) {
    return results;
  }
  const current: T[] = [];
  const backtrack = (start: number): void => {
    if (current.length === k) {
      results.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      current.push(items[i]!);
      backtrack(i + 1);
      current.pop();
    }
  };
  backtrack(0);
  return results;
}

/** umabans(昇順)から comboSize の組合せをすべて列挙し、一律のオッズ値を割り当てたRecordを作る。 */
function fullOddsRecord(umabans: readonly number[], comboSize: number, odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const combo of combinations(umabans, comboSize)) {
    record[buildComboOddsKey(combo)] = odds;
  }
  return record;
}

/** ComboOddsFetchOutcomeViewを組み立てる補助関数(診断値の中身自体はテストの関心事ではないため最小構成)。 */
function comboOddsOutcome(
  betType: "wide" | "trio" | "quinella" | "exacta",
  state: ComboOddsFetchOutcomeView["state"],
): ComboOddsFetchOutcomeView {
  const diagnostics: ComboOddsFetchDiagnosticsView = {
    betType,
    requestCount: 0,
    expectedComboCount: 0,
    obtainedComboCount: 0,
    missingComboCount: 0,
    axisUmabans: [],
    attempts: [],
    numericConflictCount: 0,
    nullWinConflictCount: 0,
    conflictSamples: [],
  };
  return { state, diagnostics };
}

/** n頭ぶんの馬番配列(1..n)。 */
function umabansOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * umabansの順序付き全ペア(a≠b、順不同ではなく並びを区別する。P(n,2)通り)を列挙し、
 * 一律のオッズ値を割り当てたRecordを作る(`fullOddsRecord`の馬単版。テスト専用の独立実装
 * であり本体の`orderedPairsOfUmabans`〈combo-bet-allocation.ts〉とは無関係)。
 * キー形式は`buildOrderedComboOddsKey`と同じ(2桁ゼロ埋め・ソートしない連結)だが、
 * `@keiba/core/ev/combo-bet-allocation`はこの関数を再exportしていないため、本ファイルの
 * `combinations`と同じ流儀でキー生成自体もテスト内に持つ。
 */
function orderedKey(a: number, b: number): string {
  return `${String(a).padStart(2, "0")}${String(b).padStart(2, "0")}`;
}
function fullOrderedOddsRecord(umabans: readonly number[], odds: number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const a of umabans) {
    for (const b of umabans) {
      if (a !== b) {
        record[orderedKey(a, b)] = odds;
      }
    }
  }
  return record;
}

/** n頭立て・全馬EVプラス(複勝候補になる)行配列を作る。 */
function allCandidateRows(n: number): AnalysisRow[] {
  return umabansOf(n).map((umaban) => row({ umaban }));
}

// ============================================================================
// テストヘルパー自己テスト(必須)
// ============================================================================

describe("テストヘルパー自己テスト", () => {
  it("row(): overridesのplaceOddsMin=null/ev=null/isPositive=falseを既定値へフォールバックさせず反映すること", () => {
    // 前提固定: 既定値(overrides省略時)はnull/falseではない。
    expect(row({ umaban: 1 }).placeOddsMin).not.toBeNull();
    expect(row({ umaban: 1 }).ev).not.toBeNull();
    expect(row({ umaban: 1 }).isPositive).toBe(true);
    // 明示的なnull/falseはフォールバックされず反映されること(??による意図しない上書きが無いことの自己テスト)。
    expect(row({ umaban: 1, placeOddsMin: null }).placeOddsMin).toBeNull();
    expect(row({ umaban: 1, ev: null }).ev).toBeNull();
    expect(row({ umaban: 1, isPositive: false }).isPositive).toBe(false);
  });

  it("row(): 既定値はumaban/wakuban/prior/adjustedProb/placeOddsMin/ev/careerRunCountが型グループを跨いでも互いに異なること(取り違え検知の前提)", () => {
    const r = row({ umaban: 1 });
    // 前提固定: 数値系フィールド7個すべてが互いに異なる既定値を持つこと。
    // boss指摘: `number`型同士・`number|null`型同士だけでなく、`AllocationCandidate.odds`は
    // `number`型なので `odds: row.adjustedProb` のような**型グループを跨ぐ**取り違えも
    // 型検査を通過する。グループ単位の相異(numberグループ内だけ・number|nullグループ内だけ)
    // では「たまたま2グループ間でも値がかぶっていない」ことまでは保証しないため、7個まとめて
    // 1つのSetで相異を固定する(将来いずれかの既定値を変更しても、この1行が検知する)。
    const allNumeric = [r.umaban, r.wakuban, r.prior, r.adjustedProb, r.placeOddsMin, r.ev, r.careerRunCount];
    expect(new Set(allNumeric).size).toBe(7);
  });

  it("row(): wakuban/prior/careerRunCountもoverridesで個別に上書きできること", () => {
    expect(row({ umaban: 1, wakuban: 7 }).wakuban).toBe(7);
    expect(row({ umaban: 1, prior: 0.77 }).prior).toBe(0.77);
    expect(row({ umaban: 1, careerRunCount: 42 }).careerRunCount).toBe(42);
    // 明示的なnullも既定値へフォールバックしないこと。
    expect(row({ umaban: 1, careerRunCount: null }).careerRunCount).toBeNull();
  });

  it("raceInput(): 既定はoddsStatus='result'であり、overridesで上書きできること", () => {
    const rows = [row({ umaban: 1 })];
    expect(raceInput({ rows }).oddsStatus).toBe("result");
    expect(raceInput({ rows, oddsStatus: "yoso" }).oddsStatus).toBe("yoso");
  });

  it("combinations(): C(n,k)通りの組合せを昇順で列挙し、k>nは空配列を返すこと", () => {
    expect(combinations([1, 2, 3], 2)).toEqual([
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    expect(combinations([1, 2, 3], 4)).toEqual([]);
    expect(combinations([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it("fullOddsRecord(): 列挙した全組合せキーに指定オッズを割り当てること(件数と代表キーの両方を固定)", () => {
    const record = fullOddsRecord([1, 2, 3], 2, 5);
    expect(Object.keys(record)).toHaveLength(3);
    expect(record[buildComboOddsKey([1, 2])]).toBe(5);
    expect(record["0102"]).toBe(5);
  });

  it("comboOddsOutcome(): stateごとに異なる値を返し、betTypeが正しく反映されること", () => {
    const unavailable = comboOddsOutcome("wide", "unavailable");
    const failed = comboOddsOutcome("wide", "failed");
    expect(unavailable.state).toBe("unavailable");
    expect(failed.state).toBe("failed");
    expect(unavailable.state).not.toBe(failed.state);
    expect(comboOddsOutcome("trio", "available").diagnostics.betType).toBe("trio");
  });

  it("allCandidateRows(): 指定頭数ぶんの行を、馬番1始まりの連番で生成すること", () => {
    const rows = allCandidateRows(3);
    expect(rows.map((r) => r.umaban)).toEqual([1, 2, 3]);
    expect(rows).toHaveLength(3);
  });
});

// ============================================================================
// 頭数境界(4/5/7/8頭)
// ============================================================================

describe("頭数境界(複勝候補が載るのは8頭のみ。ワイド・3連複は5・7・4頭でも候補が載る=反証B)", () => {
  it.each([4, 5, 7, 8])("%i頭: 複勝候補は8頭のときだけ載り、ワイド・3連複は頭数を理由に除外されないこと", (n) => {
    const rows = allCandidateRows(n);
    const umabans = umabansOf(n);
    const race = raceInput({
      rows,
      wideCombo: fullOddsRecord(umabans, 2, 100000),
      trioCombo: fullOddsRecord(umabans, 3, 100000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    // betTypesをplace/wide/trioに絞る(本テストの関心事は#90より前からの反証Bであり、
    // winは`umabans.length===1`の候補も産むため絞らないと下記のumabans.length判定が汚染される)。
    const result = buildMixedCandidates(race, { betTypes: ["place", "wide", "trio"] });

    // 複勝: 8頭のときだけ候補が載る(判定結果の中身も無条件で固定する)。
    if (n === 8) {
      expect(result.diagnostics.place).toEqual({
        kind: "judged",
        judged: { positiveCount: 8, notPositiveCount: 0 },
        unjudged: { oddsMissingCount: 0 },
      });
      expect(result.candidates.filter((c) => c.umabans.length === 1)).toHaveLength(8);
    } else {
      expect(result.diagnostics.place.kind).toBe("unavailable");
      expect(result.candidates.filter((c) => c.umabans.length === 1)).toHaveLength(0);
    }

    // ワイド・3連複: 頭数に関わらず(オッズが揃っていれば)候補が載ること。
    const expectedWideCount = combinations(umabans, 2).length;
    const expectedTrioCount = combinations(umabans, 3).length;
    expect(result.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(expectedWideCount);
    expect(result.candidates.filter((c) => c.umabans.length === 3)).toHaveLength(expectedTrioCount);
    if (result.diagnostics.wide.kind === "built") {
      expect(result.diagnostics.wide.build.judged.positiveCount).toBe(expectedWideCount);
      expect(result.diagnostics.wide.build.unjudged).toEqual({
        oddsMissingCount: 0,
        oddsUnfetchedCount: 0,
        oddsMalformedCount: 0,
      });
    } else {
      throw new Error("wide診断値はkind='built'のはず");
    }
    if (result.diagnostics.trio.kind === "built") {
      expect(result.diagnostics.trio.build.judged.positiveCount).toBe(expectedTrioCount);
    } else {
      throw new Error("trio診断値はkind='built'のはず");
    }

    // topFinishCountは頭数・複勝可用性に関わらず常に3(受け入れ条件4)。
    expect(result.topFinishCount).toBe(3);
  });

  it("4頭: 診断値が「発売なし」と断定しないこと(未取得なら未取得、{}+failedなら取得失敗と区別する)", () => {
    const rows = allCandidateRows(4);

    // (i) オッズ未取得(キー自体が無い): 診断値は「未取得」であり、頭数由来の「発売なし」を意味する
    // 理由コードは一切登場しないこと(反証Bの核心: 未確認を判定結果として報告しない)。
    const unfetched = buildMixedCandidates(raceInput({ rows }));
    if (unfetched.diagnostics.wide.kind !== "built") {
      throw new Error("wide診断値はkind='built'のはず(yosoではない)");
    }
    expect(unfetched.diagnostics.wide.fieldPresence).toBe("absent");
    expect(unfetched.diagnostics.wide.comboOddsState).toBe("unknown");
    expect(unfetched.diagnostics.wide.build.unjudged.oddsUnfetchedCount).toBe(combinations(umabansOf(4), 2).length);
    expect(unfetched.diagnostics.wide.build.judged.positiveCount).toBe(0);
    expect(unfetched.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(0);

    // (ii) {} + state="failed": 「取得失敗」であり、「発売なし(unavailable)」とは診断値上で区別される。
    const failed = buildMixedCandidates(
      raceInput({
        rows,
        wideCombo: {},
        comboOdds: { wide: comboOddsOutcome("wide", "failed") },
      }),
    );
    if (failed.diagnostics.wide.kind !== "built") {
      throw new Error("wide診断値はkind='built'のはず");
    }
    expect(failed.diagnostics.wide.fieldPresence).toBe("empty");
    expect(failed.diagnostics.wide.comboOddsState).toBe("failed");
    expect(failed.diagnostics.wide.comboOddsState).not.toBe("unavailable");
  });
});

// ============================================================================
// オッズ状態4×2((a)キー不在 (b){}+unavailable (c){}+failed (d)値あり)
// ============================================================================

describe("オッズ状態4×2(wide/trioそれぞれ4状態。(b)と(c)を診断値で区別する)", () => {
  // n=3・トリオ1組・ワイド3組という、同時分布が決定的(topFinishCount=3=頭数なので
  // 「3頭全員が確率1で複勝圏内」になる)構成を使い、EVを手計算できる状態でテストする。
  const rows = allCandidateRows(3).map((r) => row({ umaban: r.umaban, isPositive: false, ev: null, placeOddsMin: null }));
  const umabans = umabansOf(3);

  it.each([
    { label: "(a) キー不在", overrides: {}, expectPresence: "absent", expectState: "unknown" },
    {
      label: "(b) {}+state=unavailable",
      overrides: { wideCombo: {}, trioCombo: {}, comboOdds: { wide: comboOddsOutcome("wide", "unavailable"), trio: comboOddsOutcome("trio", "unavailable") } },
      expectPresence: "empty",
      expectState: "unavailable",
    },
    {
      label: "(c) {}+state=failed",
      overrides: { wideCombo: {}, trioCombo: {}, comboOdds: { wide: comboOddsOutcome("wide", "failed"), trio: comboOddsOutcome("trio", "failed") } },
      expectPresence: "empty",
      expectState: "failed",
    },
  ])("$label: 候補ゼロ・fieldPresence=$expectPresence・comboOddsState=$expectStateであること", ({ overrides, expectPresence, expectState }) => {
    const result = buildMixedCandidates(raceInput({ rows, ...overrides }));
    for (const betType of ["wide", "trio"] as const) {
      const diag = result.diagnostics[betType];
      if (diag.kind !== "built") {
        throw new Error(`${betType}診断値はkind='built'のはず`);
      }
      expect(diag.fieldPresence).toBe(expectPresence);
      expect(diag.comboOddsState).toBe(expectState);
      expect(diag.build.judged.positiveCount).toBe(0);
    }
    expect(result.candidates.filter((c) => c.umabans.length >= 2)).toHaveLength(0);
  });

  it("(d) 値あり: 候補が載り、fieldPresence=present・comboOddsState=availableであること(EVは手計算で厳密一致)", () => {
    // n=3・k=3のため、どの組も「3頭が確率1で複勝圏内」の1点に含まれる → hitProb=1固定。odds=2ならev=2。
    const result = buildMixedCandidates(
      raceInput({
        rows,
        wideCombo: fullOddsRecord(umabans, 2, 2),
        trioCombo: fullOddsRecord(umabans, 3, 2),
        comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
      }),
    );
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    expect(result.diagnostics.wide.fieldPresence).toBe("present");
    expect(result.diagnostics.wide.comboOddsState).toBe("available");
    expect(result.diagnostics.trio.fieldPresence).toBe("present");
    expect(result.diagnostics.trio.comboOddsState).toBe("available");

    const wideCandidates = result.candidates.filter((c) => c.umabans.length === 2);
    const trioCandidates = result.candidates.filter((c) => c.umabans.length === 3);
    expect(wideCandidates).toHaveLength(3);
    expect(trioCandidates).toHaveLength(1);
    for (const c of [...wideCandidates, ...trioCandidates]) {
      expect(c.ev).toBe(2);
      expect(c.odds).toBe(2);
      expect(c.isPositive).toBe(true);
    }
  });
});

// ============================================================================
// wide/trioの非対称入力(交差配線バグの検知。code-reviewer指摘・要修正1対応)
//
// 「オッズ状態4×2」describeの3ケースはいずれも wide と trio に**同じ** state を与えていたため、
// `comboOddsState` の実装が `betType` を無視して常に `race.comboOdds?.["wide"]?.state` を
// 読んでいても(=trio側にwideの値を誤って流用しても)44件全緑のまま検知できなかった
// (code-reviewer実測。`fetchComboBetTypeOdds` はワイド・3連複を独立した2回の呼び出しで取得し、
// それぞれ独立に例外をcatchするため、`comboOdds.wide.state !== comboOdds.trio.state` は
// `includeComboOdds` が有効化される次段で実際に発生しうる。production-reachable)。
// wide/trioのペアを持つ出力(fieldPresence・comboOddsState)について、意図的に非対称な状態を
// 与えたときに互いを取り違えないことを個別に固定する。
// ============================================================================

describe("wide/trioの非対称入力(取り違え検知。code-reviewer指摘)", () => {
  it("comboOddsStateが非対称(wide=available/trio=failed)のとき、互いを取り違えず個別に反映されること", () => {
    const rows = allCandidateRows(3).map((r) =>
      row({ umaban: r.umaban, isPositive: false, ev: null, placeOddsMin: null }),
    );
    const umabans = umabansOf(3);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        wideCombo: fullOddsRecord(umabans, 2, 2),
        trioCombo: fullOddsRecord(umabans, 3, 2),
        comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "failed") },
      }),
    );
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    // 前提固定: wideとtrioで異なるstate値を与えていること(対称値だと検知できない=本describeの主眼)。
    expect(result.diagnostics.wide.comboOddsState).not.toBe(result.diagnostics.trio.comboOddsState);
    expect(result.diagnostics.wide.comboOddsState).toBe("available");
    expect(result.diagnostics.trio.comboOddsState).toBe("failed");
  });

  it("comboOddsStateが逆向きに非対称(wide=unavailable/trio=available)でも、それぞれ正しく反映されること(片方向だけの固定を避ける)", () => {
    const rows = allCandidateRows(3).map((r) =>
      row({ umaban: r.umaban, isPositive: false, ev: null, placeOddsMin: null }),
    );
    const umabans = umabansOf(3);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        wideCombo: fullOddsRecord(umabans, 2, 2),
        trioCombo: fullOddsRecord(umabans, 3, 2),
        comboOdds: { wide: comboOddsOutcome("wide", "unavailable"), trio: comboOddsOutcome("trio", "available") },
      }),
    );
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    expect(result.diagnostics.wide.comboOddsState).toBe("unavailable");
    expect(result.diagnostics.trio.comboOddsState).toBe("available");
  });

  it("fieldPresenceが非対称(wideCombo=値あり/trioComboキー不在)のとき、互いを取り違えず個別に反映されること", () => {
    const rows = allCandidateRows(3).map((r) =>
      row({ umaban: r.umaban, isPositive: false, ev: null, placeOddsMin: null }),
    );
    const umabans = umabansOf(3);
    // trioComboは意図的に省略(キー不在=absent)。comboOddsも省略し、comboOddsStateは
    // 両者とも"unknown"になる(本ケースの主眼はfieldPresenceの取り違え検知のため、
    // comboOddsStateは意図的に対称〈unknown/unknown〉のままにする)。
    const result = buildMixedCandidates(raceInput({ rows, wideCombo: fullOddsRecord(umabans, 2, 2) }));
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    // 前提固定: wideとtrioで異なるfieldPresence値を与えていること。
    expect(result.diagnostics.wide.fieldPresence).not.toBe(result.diagnostics.trio.fieldPresence);
    expect(result.diagnostics.wide.fieldPresence).toBe("present");
    expect(result.diagnostics.trio.fieldPresence).toBe("absent");
    // fieldPresence="present"側(wide)は実際に候補が載り、"absent"側(trio)は0件であること
    // (取り違えていれば、trioの候補にwideのオッズが誤って使われ0件にならない、または
    // wideの候補がtrioComboの不在に引きずられて0件になる、のいずれかで検知できる)。
    expect(result.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(3);
    expect(result.candidates.filter((c) => c.umabans.length === 3)).toHaveLength(0);
  });

  it("fieldPresenceが逆向きに非対称(wideComboキー不在/trioCombo=値あり)でも、それぞれ正しく反映されること", () => {
    const rows = allCandidateRows(3).map((r) =>
      row({ umaban: r.umaban, isPositive: false, ev: null, placeOddsMin: null }),
    );
    const umabans = umabansOf(3);
    const result = buildMixedCandidates(raceInput({ rows, trioCombo: fullOddsRecord(umabans, 3, 2) }));
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    expect(result.diagnostics.wide.fieldPresence).toBe("absent");
    expect(result.diagnostics.trio.fieldPresence).toBe("present");
    expect(result.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(0);
    expect(result.candidates.filter((c) => c.umabans.length === 3)).toHaveLength(1);
  });
});

// ============================================================================
// 入力フィールド→出力フィールドの写像(取り違え検知。bossメタレビュー指摘)
//
// wide/trioという「出力どうしの対」の水平展開(前段)だけでは、「入力フィールド→出力
// フィールドの写像」の取り違えは検知できなかった(adjustedProb→prior、placeOddsMin↔ev)。
// 同じ型(number同士・number|null同士・boolean同士)の隣接フィールドは型検査を通過するため、
// テストでしか固定できない(boss指摘)。mixed-candidates.tsが実際にAnalysisRowから読む
// フィールドと、取り違えても型検査を通過する「同じ型の他フィールド」を対応表にして洗い出す。
//
// | 読む位置(mixed-candidates.ts) | 読んでいるフィールド | 同じ型で取り違えうる他フィールド | 検知テスト |
// |---|---|---|---|
// | horses[].umaban | umaban (number) | wakuban (number) | 「umaban→umabansへの写像」 |
// | horses[].placeProb | adjustedProb (number) | prior/umaban/wakuban (number) | 「combo EVはadjustedProbに感応・priorに絶縁」 |
// | place候補 umabans[0] | umaban (number) | wakuban (number) | 「umaban→umabansへの写像」 |
// | place候補 odds | placeOddsMin (number\|null) | ev/careerRunCount (number\|null) | 「place候補のodds/evの写像」 |
// | place候補 ev | ev (number\|null) | placeOddsMin/careerRunCount (number\|null) | 「place候補のodds/evの写像」 |
// | place候補化条件 | isPositive (boolean) | evEstimated (boolean) | 「isPositiveのみに従うこと」 |
//
// (umaban↔wakuban・isPositive↔evEstimatedはboss指摘の2件そのものではないが、同じ理由で
// 型検査を素通りしうる隣接フィールドとして本段で洗い出し、追加で潰した)
// ============================================================================

/** candidatesからumabansが完全一致する候補を1件取り出す(見つからなければ例外)。 */
function findCandidateByUmabans(
  candidates: readonly AllocationCandidate[],
  umabans: readonly number[],
): AllocationCandidate {
  const found = candidates.find(
    (c) => c.umabans.length === umabans.length && c.umabans.every((u, i) => u === umabans[i]),
  );
  if (!found) {
    throw new Error(`候補が見つかりません(umabans=${umabans.join(",")})`);
  }
  return found;
}

describe("入力フィールド→出力フィールドの写像(取り違え検知)", () => {
  it("findCandidateByUmabans(): 完全一致する候補を返し、無ければ例外を投げること(自己テスト)", () => {
    const candidates: AllocationCandidate[] = [
      { umabans: [1, 2], odds: 3, ev: 2, isPositive: true, betType: "wide" },
      { umabans: [1, 3], odds: 5, ev: 4, isPositive: true, betType: "wide" },
    ];
    expect(findCandidateByUmabans(candidates, [1, 3]).odds).toBe(5);
    expect(() => findCandidateByUmabans(candidates, [2, 3])).toThrow();
  });

  // umaban1の確率だけを可変にし、他3頭(umaban2〜4)は固定の非対称な確率を持たせる。
  // 全頭を一様確率にすると「条件付きベルヌーイモデルの対称性」により、共通の確率値を
  // 変えてもペアの的中確率が変化しない退化ケースになる(実測: 4頭一様0.9と一様0.1で
  // ペア[1,2]のhitProbが厳密に一致した。対称な入力では差が出ないことを先に確認したうえで
  // 非対称な確率設定に直した)。
  const FIXED_OTHER_PROBS = [0.6, 0.5, 0.4]; // umaban2・3・4に固定で割り当てる非対称な確率。

  /** umaban1の確率だけをvaryingProbで差し替え、他3頭は固定確率を持つ4頭のワイド候補結果を作る。 */
  function buildWideWithVaryingUmaban1(varyingAdjustedProb: number, varyingPrior: number) {
    const umabans = [1, 2, 3, 4];
    const rows = umabans.map((umaban, i) =>
      row({
        umaban,
        adjustedProb: i === 0 ? varyingAdjustedProb : FIXED_OTHER_PROBS[i - 1]!,
        prior: i === 0 ? varyingPrior : FIXED_OTHER_PROBS[i - 1]!,
        isPositive: false,
        ev: null,
        placeOddsMin: null,
      }),
    );
    return buildMixedCandidates(raceInput({ rows, wideCombo: fullOddsRecord(umabans, 2, 100000) }));
  }

  it("【boss要修正1】ワイド・3連複のevはadjustedProbを変えると変化すること(prior固定・他頭の確率は非対称に固定)", () => {
    const high = buildWideWithVaryingUmaban1(0.95, 0.1);
    const low = buildWideWithVaryingUmaban1(0.05, 0.1); // priorは固定、adjustedProbだけを変える。
    const evHigh = findCandidateByUmabans(high.candidates, [1, 2]).ev;
    const evLow = findCandidateByUmabans(low.candidates, [1, 2]).ev;
    // 前提固定: 両者とも候補化されていること(比較対象が両方とも存在する)。
    expect(Number.isFinite(evHigh)).toBe(true);
    expect(Number.isFinite(evLow)).toBe(true);
    expect(evHigh).not.toBe(evLow);
    expect(evHigh).toBeGreaterThan(evLow); // umaban1の複勝圏内確率が高いほどhitProbも高くなるはず。
  });

  it("【boss要修正1】ワイド・3連複のevはpriorを変えても変化しないこと(adjustedProb固定・他頭の確率は非対称に固定)", () => {
    const priorLow = buildWideWithVaryingUmaban1(0.5, 0.1);
    const priorHigh = buildWideWithVaryingUmaban1(0.5, 0.9); // adjustedProbは固定、priorだけを変える。
    const evA = findCandidateByUmabans(priorLow.candidates, [1, 2]).ev;
    const evB = findCandidateByUmabans(priorHigh.candidates, [1, 2]).ev;
    // 前提固定: 有限値であること(NaN同士はObject.isによるtoBe比較を素通りするため、
    // 兄弟テスト〈adjustedProb感応性テスト〉と同様に有限性を先に固定する。boss非ブロッキング指摘2)。
    expect(Number.isFinite(evA)).toBe(true);
    expect(Number.isFinite(evB)).toBe(true);
    expect(evA).toBe(evB); // priorは同時分布に一切影響しないため厳密に一致する。
  });

  /**
   * 【boss要修正】: 「place候補のodds/evはplaceOddsMin/ev由来」の写像テストが、実際には
   * 「odds/evが互いに異なるplace候補が2件以上存在する入力」を1つも使っていなかった
   * (boss実測: フィクスチャ全体でplaceOddsMinを明示している箇所は1件だけで、しかも
   * row()の既定値〈3〉と同じだった)。そのため次の3変異がいずれも56件全緑のまま検知できなかった:
   *   - D8: 全候補のodds/evを「race.rows[0]」(最初の行)の値に固定する
   *     (ループ変数・クロージャの取り違え相当。`.map()`へのリファクタ時に起こりやすい実務上の事故)
   *   - ev: row.ev を ev: 1.5(フィクスチャ既定値そのものの定数)に置換
   *   - odds: row.placeOddsMin を odds: 3(同上)に置換
   * 8頭ぶんのodds/evをすべて互いに異なる値にし、各候補を個別にassertすることで、
   * 上記3種いずれの変異も「その馬番の候補だけ値が食い違う」形で検知できるようにする
   * (定数置換・先頭行固定のどちらであっても、8頭中7頭は値が変わってしまうため必ず落ちる)。
   */
  it("【boss要修正2】place候補のoddsはplaceOddsMin由来・evはev由来であること(8頭ぶん互いに異なる値で個別にassert)", () => {
    // umaban→[placeOddsMin, ev]。全8組が互いに異なる値になるよう設計する。
    const oddsEvByUmaban: ReadonlyMap<number, readonly [number, number]> = new Map([
      [1, [2.1, 1.05]],
      [2, [3.4, 2.1]],
      [3, [5.0, 3.3]],
      [4, [1.8, 1.2]],
      [5, [9.9, 5.5]],
      [6, [4.4, 2.9]],
      [7, [6.6, 3.9]],
      [8, [7.7, 2.2]],
    ]);
    // 前提固定: oddsが8件とも互いに異なり、evも8件とも互いに異なること(「odds/evが互いに
    // 異なるplace候補が2件以上」というboss要求の最低条件を満たしたうえで、より強く8件全異にする)。
    const allOdds = [...oddsEvByUmaban.values()].map(([o]) => o);
    const allEv = [...oddsEvByUmaban.values()].map(([, e]) => e);
    expect(new Set(allOdds).size).toBe(8);
    expect(new Set(allEv).size).toBe(8);

    const rows = [...oddsEvByUmaban.entries()].map(([umaban, [placeOddsMin, ev]]) =>
      row({ umaban, placeOddsMin, ev, careerRunCount: 900 + umaban, isPositive: true }),
    );
    const result = buildMixedCandidates(raceInput({ rows }));

    for (const [umaban, [placeOddsMin, ev]] of oddsEvByUmaban) {
      const candidate = result.candidates.find((c) => c.umabans.length === 1 && c.umabans[0] === umaban);
      expect(candidate).toBeDefined();
      expect(candidate!.odds).toBe(placeOddsMin);
      expect(candidate!.ev).toBe(ev);
    }
  });

  it("umaban→umabansの写像はwakuban(同じnumber型の隣接フィールド)を読まないこと", () => {
    // umaban=[11,12,13]・wakuban=[91,92,93]と、値域が重ならない形で明確に区別する。
    const rows = [11, 12, 13].map((umaban, i) => row({ umaban, wakuban: 91 + i, isPositive: false, ev: null, placeOddsMin: null }));
    const umabans = [11, 12, 13];
    const wakubans = [91, 92, 93];
    const result = buildMixedCandidates(
      raceInput({ rows, wideCombo: fullOddsRecord(umabans, 2, 100000), trioCombo: fullOddsRecord(umabans, 3, 100000) }),
    );
    // 前提固定: 候補が実際に生成されていること(空振り防止)。
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      for (const u of c.umabans) {
        expect(umabans).toContain(u);
        expect(wakubans).not.toContain(u);
      }
    }
  });

  it("place候補化の判定はisPositiveに従い、evEstimated(同じboolean型の隣接フィールド)には従わないこと", () => {
    // isPositive=true・evEstimated=falseの馬(8番)と、isPositive=false・evEstimated=trueの馬(1〜7番)。
    // evEstimatedを読んでいれば1〜7番が候補化され8番が除外される(逆転)はずだが、
    // isPositiveに従うなら8番だけが候補化される。
    const rows = [
      ...allCandidateRows(7).map((r) => row({ umaban: r.umaban, isPositive: false, evEstimated: true })),
      row({ umaban: 8, isPositive: true, evEstimated: false }),
    ];
    const result = buildMixedCandidates(raceInput({ rows }));
    const placeUmabans = result.candidates.filter((c) => c.betType === "place").map((c) => c.umabans[0]);
    expect(placeUmabans).toEqual([8]);
  });
});

// ============================================================================
// 複勝の除外境界(各単独条件で、その馬だけが除外され他馬に波及しないこと)
// ============================================================================

describe("複勝の除外境界(placeOddsMin===null / ev===null / isPositive===falseの単独ケース)", () => {
  it("placeOddsMin===nullの馬だけが除外され、他7頭は候補のまま(unjudged.oddsMissingCountに計上)", () => {
    const rows = [...allCandidateRows(7), row({ umaban: 8, placeOddsMin: null })];
    const result = buildMixedCandidates(raceInput({ rows }));
    if (result.diagnostics.place.kind !== "judged") {
      throw new Error("place診断値はkind='judged'のはず");
    }
    expect(result.diagnostics.place.judged).toEqual({ positiveCount: 7, notPositiveCount: 0 });
    expect(result.diagnostics.place.unjudged).toEqual({ oddsMissingCount: 1 });
    const placeUmabans = result.candidates.filter((c) => c.betType === "place").map((c) => c.umabans[0]);
    expect(placeUmabans).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("ev===nullの馬だけが除外され、他7頭は候補のまま(unjudged.oddsMissingCountに計上)", () => {
    const rows = [...allCandidateRows(7), row({ umaban: 8, ev: null })];
    const result = buildMixedCandidates(raceInput({ rows }));
    if (result.diagnostics.place.kind !== "judged") {
      throw new Error("place診断値はkind='judged'のはず");
    }
    expect(result.diagnostics.place.judged).toEqual({ positiveCount: 7, notPositiveCount: 0 });
    expect(result.diagnostics.place.unjudged).toEqual({ oddsMissingCount: 1 });
    const placeUmabans = result.candidates.filter((c) => c.betType === "place").map((c) => c.umabans[0]);
    expect(placeUmabans).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("isPositive===falseの馬だけが除外され、他7頭は候補のまま(judged.notPositiveCountに計上、unjudgedには計上されない)", () => {
    const rows = [...allCandidateRows(7), row({ umaban: 8, isPositive: false })];
    const result = buildMixedCandidates(raceInput({ rows }));
    if (result.diagnostics.place.kind !== "judged") {
      throw new Error("place診断値はkind='judged'のはず");
    }
    expect(result.diagnostics.place.judged).toEqual({ positiveCount: 7, notPositiveCount: 1 });
    expect(result.diagnostics.place.unjudged).toEqual({ oddsMissingCount: 0 });
    const placeUmabans = result.candidates.filter((c) => c.betType === "place").map((c) => c.umabans[0]);
    expect(placeUmabans).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

// ============================================================================
// yoso×複勝(boss裁定(a): 推定EVが非nullでも複勝候補は0件)
// ============================================================================

describe("yoso×複勝(boss裁定。推定EVが非nullでも複勝候補は0件、理由コードはyoso)", () => {
  it("oddsStatus='yoso'かつ推定EVが非null・isPositive=trueでも複勝候補は0件、理由コードはyoso(頭数由来のコードとは別値)", () => {
    // 18頭・全馬 placeOddsMin/ev 非null・isPositive:true(推定EVを想定した「非nullで健全に見える」状態)。
    const rows = allCandidateRows(18).map((r) => row({ ...r, umaban: r.umaban, evEstimated: true }));
    const result = buildMixedCandidates(raceInput({ rows, oddsStatus: "yoso" }));
    expect(result.diagnostics.place).toEqual({ kind: "unavailable", reason: "yoso" });
    expect(result.candidates.filter((c) => c.umabans.length === 1)).toHaveLength(0);
  });

  it("yosoガードの独立性: oddsStatusだけを'result'に変えると同じ行データで複勝候補が生成されること", () => {
    const rows = allCandidateRows(18).map((r) => row({ ...r, umaban: r.umaban, evEstimated: true }));
    const result = buildMixedCandidates(raceInput({ rows, oddsStatus: "result" }));
    expect(result.diagnostics.place.kind).toBe("judged");
    expect(result.candidates.filter((c) => c.umabans.length === 1)).toHaveLength(18);
  });

  it("理由コードの優先順位: yosoかつ5頭(two-place-onlyにも該当)のとき、理由コードはyoso側に決まること", () => {
    const rows = allCandidateRows(5);
    const result = buildMixedCandidates(raceInput({ rows, oddsStatus: "yoso" }));
    expect(result.diagnostics.place).toEqual({ kind: "unavailable", reason: "yoso" });
  });
});

// ============================================================================
// yoso×組合せ(第2段の既知の限界: 「未取得」と「yoso」を誤ラベルしない)
// ============================================================================

describe("yoso×組合せ(候補ゼロの理由が「未取得」か「yoso」かを診断値で区別する)", () => {
  it("yosoかつオッズフィールド未取得(第2段の実運用と同じ状態): 理由はyoso(未取得ではない)", () => {
    const rows = allCandidateRows(8);
    const result = buildMixedCandidates(raceInput({ rows, oddsStatus: "yoso" }));
    expect(result.diagnostics.wide).toEqual({ kind: "yoso" });
    expect(result.diagnostics.trio).toEqual({ kind: "yoso" });
    expect(result.candidates.filter((c) => c.umabans.length >= 2)).toHaveLength(0);
  });

  it("yosoでないときの同じ未取得状態は「未取得」(kind='built', fieldPresence='absent')であり、'yoso'とは異なる型に分類されること", () => {
    const rows = allCandidateRows(8);
    const result = buildMixedCandidates(raceInput({ rows, oddsStatus: "result" }));
    expect(result.diagnostics.wide.kind).toBe("built");
    expect(result.diagnostics.wide.kind).not.toBe("yoso");
  });

  it("yosoのときはオッズデータが実際に値を持っていても(防御的に)組合せ候補を出さないこと(データに依存しない決定)", () => {
    const rows = allCandidateRows(3);
    const umabans = umabansOf(3);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        oddsStatus: "yoso",
        wideCombo: fullOddsRecord(umabans, 2, 100000),
        trioCombo: fullOddsRecord(umabans, 3, 100000),
        comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
      }),
    );
    expect(result.diagnostics.wide).toEqual({ kind: "yoso" });
    expect(result.diagnostics.trio).toEqual({ kind: "yoso" });
    expect(result.candidates.filter((c) => c.umabans.length >= 2)).toHaveLength(0);
  });
});

// ============================================================================
// 券種フィルタ(省略時=ALL_MIXED_CANDIDATE_BET_TYPES。一部指定時は非対象の列挙自体を行わない)
// ============================================================================

describe("券種フィルタ(options.betTypes)", () => {
  it("省略時はALL_MIXED_CANDIDATE_BET_TYPES(place/win/wide/quinella/exacta/trio。Issue #117で馬連、Issue #125で馬単を追加)が対象になること", () => {
    expect(ALL_MIXED_CANDIDATE_BET_TYPES).toEqual(["place", "win", "wide", "quinella", "exacta", "trio"]);
    const rows = allCandidateRows(8);
    const umabans = umabansOf(8);
    const result = buildMixedCandidates(
      raceInput({ rows, wideCombo: fullOddsRecord(umabans, 2, 100000), trioCombo: fullOddsRecord(umabans, 3, 100000) }),
    );
    expect(result.diagnostics.place.kind).toBe("judged");
    expect(result.diagnostics.wide.kind).toBe("built");
    expect(result.diagnostics.trio.kind).toBe("built");
  });

  it("['place']のみ指定時: wide/trioの列挙自体が走らず(診断値kind='not-requested')、候補も0件であること", () => {
    const rows = allCandidateRows(8);
    const umabans = umabansOf(8);
    // wide/trioに大量のオッズを渡していても(列挙されれば候補になるはずの状態でも)、
    // betTypesで対象外にした以上、候補・診断値のいずれにも一切現れないこと。
    const result = buildMixedCandidates(
      raceInput({ rows, wideCombo: fullOddsRecord(umabans, 2, 100000), trioCombo: fullOddsRecord(umabans, 3, 100000) }),
      { betTypes: ["place"] },
    );
    expect(result.diagnostics.wide).toEqual({ kind: "not-requested" });
    expect(result.diagnostics.trio).toEqual({ kind: "not-requested" });
    expect(result.candidates.filter((c) => c.umabans.length >= 2)).toHaveLength(0);
    // 操作していない側(place)は通常どおり機能すること。
    expect(result.diagnostics.place.kind).toBe("judged");
    expect(result.candidates.filter((c) => c.umabans.length === 1)).toHaveLength(8);
  });

  it("['wide']のみ指定時: placeとtrioが対象外(候補0件・kind='not-requested'相当)であること", () => {
    const rows = allCandidateRows(8);
    const umabans = umabansOf(8);
    const result = buildMixedCandidates(
      raceInput({ rows, wideCombo: fullOddsRecord(umabans, 2, 100000) }),
      { betTypes: ["wide"] },
    );
    expect(result.diagnostics.place).toEqual({ kind: "not-requested" });
    expect(result.diagnostics.trio).toEqual({ kind: "not-requested" });
    expect(result.candidates.filter((c) => c.umabans.length === 1)).toHaveLength(0);
    expect(result.candidates.filter((c) => c.umabans.length === 3)).toHaveLength(0);
    expect(result.diagnostics.wide.kind).toBe("built");
    expect(result.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(combinations(umabans, 2).length);
  });

  it("MixedCandidateBuildOptionsは妙味度に類する値を受け取れない(型レベル)", () => {
    const rows = allCandidateRows(8);
    // @ts-expect-error: betTypes以外のフィールド(妙味度等)は型エラーになること。
    buildMixedCandidates(raceInput({ rows }), { betTypes: ["place"], opportunityThreshold: 1 });
  });

  /**
   * ★構造的な再発防止(#91・boss裁定。#90でwinを追加した後の状態を固定・
   * #112〈#24-D1〉で馬連〈quinella〉が除外に加わった状態に更新・Issue #117で
   * 再びAllocationBetTypeの全メンバーと一致する状態に更新・Issue #120で馬単〈exacta〉が
   * 除外に加わった状態に更新・Issue #125で再びAllocationBetTypeの全メンバーと一致する
   * 状態に更新)。
   *
   * `ALL_MIXED_CANDIDATE_BET_TYPES`が`AllocationBetType`(core)の全メンバーを含むとは
   * 限らない設計を、「意図的に除外している券種の集合」としてリテラルで固定していた。
   * #90でwinの候補ビルダー(`buildWinCandidates`)が新設されたため、当時は除外が無かった
   * (`AllocationBetType`の全メンバーと一致していた)。**#112で`AllocationBetType`に
   * `quinella`(馬連)が加わったが、`buildMixedCandidates`(app側)はまだそれを参照しない
   * (app側の候補組み立ては#24-D3のスコープ)ため、`quinella`が一時的に除外へ加わった。**
   * **Issue #117(#24-D3b-2)で`resolveMixedBetTypes`〈shared/mixed-race-allocation.ts〉が
   * 実際に`"quinella"`を渡すよう接続し、`ALL_MIXED_CANDIDATE_BET_TYPES`にも`quinella`を
   * 加えたため、除外集合は再び空になった。**
   * **Issue #120(#24-E1)で`AllocationBetType`に`exacta`(馬単)が加わったが、
   * `mixed-candidates.ts`から馬単の候補を作る経路はまだ無かった(オッズ配線は#122・
   * 配分接続は#125のスコープ)ため、`exacta`が一時的に除外へ加わった(`quinella`のときと
   * 同じ理由: app側候補ビルダーが未接続の券種を対象集合に含めると`resolveMixedBetTypes`
   * 経由でも実際には評価されない=常に「¥0 0点」相当になるため)。**
   * **Issue #125(#24-E3b)で`resolveMixedBetTypes`が実際に`"exacta"`を渡すよう接続し、
   * `ALL_MIXED_CANDIDATE_BET_TYPES`にも`exacta`を加えたため、除外集合は再び空になった。**
   * `AllocationBetType`に新しいメンバーが増えたとき、この配列に足すべきかどうかの判断を
   * 人間が必ず一度は行うようにする(#91で「散文だけが古いまま残る」事故〈配列は3値のまま、
   * JSDocは「全券種」と言い続けた〉が起きたため、次に同じ事故が起きないよう機械的に検出する)。
   * 除外集合を空配列と直接固定することで、将来新しい券種が`AllocationBetType`に加わって
   * 除外へ紛れ込んでも(候補ビルダー未接続のまま)、このテストが赤くなり
   * 「足すかどうかの判断」を人間に強制する。
   */
  it("ALL_MIXED_CANDIDATE_BET_TYPESが意図的に除外している券種が無いこと(AllocationBetTypeの全メンバーと一致する。Issue #125で馬単の除外を解除した)", () => {
    const excluded = Object.keys(ALLOCATION_BET_TYPE_UMABAN_COUNT).filter(
      (t) => !ALL_MIXED_CANDIDATE_BET_TYPES.includes(t as MixedCandidateBetType),
    );
    expect(excluded).toEqual([]);
  });
});

// ============================================================================
// 退化入力(rows=空/1頭/3頭)
// ============================================================================

describe("退化入力(rows=空/1頭/3頭で例外を投げず候補ゼロで返ること)", () => {
  it.each([0, 1, 3])("%i頭: 例外を投げないこと", (n) => {
    const rows = allCandidateRows(n);
    expect(() => buildMixedCandidates(raceInput({ rows }))).not.toThrow();
  });

  it("0頭: 複勝は理由コード'unknown'、ワイド・3連複は列挙0件で候補0件であること", () => {
    const result = buildMixedCandidates(raceInput({ rows: [] }));
    expect(result.diagnostics.place).toEqual({ kind: "unavailable", reason: "unknown" });
    expect(result.candidates).toHaveLength(0);
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("wide/trio診断値はkind='built'のはず");
    }
    expect(result.diagnostics.wide.build.enumeratedCount).toBe(0);
    expect(result.diagnostics.trio.build.enumeratedCount).toBe(0);
  });

  it("1頭: 複勝は理由コード'not-sold'、ワイド・3連複は組合せを構成できず列挙0件であること", () => {
    const result = buildMixedCandidates(raceInput({ rows: allCandidateRows(1) }));
    expect(result.diagnostics.place).toEqual({ kind: "unavailable", reason: "not-sold" });
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("wide/trio診断値はkind='built'のはず");
    }
    expect(result.diagnostics.wide.build.enumeratedCount).toBe(0);
    expect(result.diagnostics.trio.build.enumeratedCount).toBe(0);
  });

  it("3頭: 3連複は列挙1件(頭数=comboSize)、ワイドは列挙3件になること(オッズ未取得のため候補は0件)", () => {
    const result = buildMixedCandidates(raceInput({ rows: allCandidateRows(3) }));
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("wide/trio診断値はkind='built'のはず");
    }
    expect(result.diagnostics.wide.build.enumeratedCount).toBe(3);
    expect(result.diagnostics.trio.build.enumeratedCount).toBe(1);
    expect(result.candidates.filter((c) => c.umabans.length >= 2)).toHaveLength(0);
  });
});

// ============================================================================
// 契約適合(生成したcandidatesをallocateGeneralBetsに渡して例外を投げないこと。実際に呼ぶ)
// ============================================================================

describe("契約適合(allocateGeneralBetsに実際に渡して例外を投げないこと)", () => {
  it("8頭・複勝+ワイド+3連複が混在した候補をallocateGeneralBetsへ渡しても例外を投げないこと", () => {
    const n = 8;
    const rows = allCandidateRows(n);
    const umabans = umabansOf(n);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        wideCombo: fullOddsRecord(umabans, 2, 100000),
        trioCombo: fullOddsRecord(umabans, 3, 100000),
      }),
    );
    // 前提固定: 券種混在(3種類のumabans長)が実際に生成されていること(空振り防止)。
    const arities = new Set(result.candidates.map((c) => c.umabans.length));
    expect(arities).toEqual(new Set([1, 2, 3]));

    const horses = rows.map((r) => ({ umaban: r.umaban, placeProb: r.adjustedProb }));
    let allocation: ReturnType<typeof allocateGeneralBets> | undefined;
    expect(() => {
      allocation = allocateGeneralBets(horses, result.topFinishCount, result.candidates, {
        bankroll: 100000,
        perRaceCap: 10000,
        kellyFraction: 0.5,
        betUnit: 100,
        greedySteps: 200,
        candidateCap: 2000,
      });
    }).not.toThrow();
    expect(allocation?.diagnostics.candidateCount).toBe(result.candidates.length);
  });

  it("候補0件(退化入力)でもallocateGeneralBetsが例外を投げないこと", () => {
    const result = buildMixedCandidates(raceInput({ rows: [] }));
    const candidates: readonly AllocationCandidate[] = result.candidates;
    expect(() => allocateGeneralBets([], result.topFinishCount, candidates)).not.toThrow();
  });
});

// ============================================================================
// topFinishCountの独立性(常に3。resolvePlaceBetTarget().placeCountに由来しない)
// ============================================================================

describe("topFinishCount(常に3。複勝可用性・頭数に関わらず定数)", () => {
  it.each([0, 1, 3, 4, 5, 7, 8, 18])("%i頭でもtopFinishCount===3であること", (n) => {
    const result = buildMixedCandidates(raceInput({ rows: allCandidateRows(n) }));
    expect(result.topFinishCount).toBe(3);
  });
});

// ============================================================================
// EV閾値の統一(options.evConfig。機能D-2c第4段・Issue #28・D-4)
//
// n=3・k=3構成(頭数境界のdescribeと同じ)を使い、hitProb=1が手計算で厳密に確定する状態で
// odds=1.1のワイド・3連複候補を用意する。ev = hitProb × odds = 1.1 は「閾値1.0では通り、
// 閾値1.2では落ちる」境界値そのもの(boss指示)。evConfigを渡し忘れて既定(閾値1.0)のまま
// 動いてしまう回帰を、閾値1.2のケースだけで検知できる設計にする。
// ============================================================================

describe("EV閾値の統一(options.evConfig。渡し忘れると既定1.0のまま動くため、閾値1.2のケースで検知する)", () => {
  // 複勝を候補外にして(isPositive=false等)、この境界値テストがワイド・3連複だけに反応するようにする。
  const rows = allCandidateRows(3).map((r) =>
    row({ umaban: r.umaban, isPositive: false, ev: null, placeOddsMin: null }),
  );
  const umabans = umabansOf(3);
  // odds=1.1・hitProb=1(n=k=3で確定)なので ev=1.1。閾値1.0では ev>1.0 でisPositive、
  // 閾値1.2では ev>1.2 が成立せずnotPositiveになる「ちょうど境界」の候補。
  const boundaryOddsRecord = { wideCombo: fullOddsRecord(umabans, 2, 1.1), trioCombo: fullOddsRecord(umabans, 3, 1.1) };

  it("前提固定: ev=1.1は閾値1.0を上回り、閾値1.2を上回らないこと(境界値そのものの検算)", () => {
    // これはbuildMixedCandidatesの結果ではなく、境界値設計そのものが正しいことを先に固定する
    // (「差が0でないこと」を先に固定する、というテスト作成上の注意に対応)。
    expect(1.1).toBeGreaterThan(1.0);
    expect(1.1).toBeLessThanOrEqual(1.2);
  });

  it("evConfig省略時(既定閾値1.0)は境界値(ev=1.1)の候補が採用されること", () => {
    const result = buildMixedCandidates(raceInput({ rows, ...boundaryOddsRecord }));
    const wideCandidates = result.candidates.filter((c) => c.umabans.length === 2);
    const trioCandidates = result.candidates.filter((c) => c.umabans.length === 3);
    // 前提固定: 候補が実際に生成されていること(空振り防止)。
    expect(wideCandidates.length).toBeGreaterThan(0);
    expect(trioCandidates.length).toBeGreaterThan(0);
    expect(wideCandidates).toHaveLength(3);
    expect(trioCandidates).toHaveLength(1);
  });

  it("evConfig.threshold=1.0を明示指定しても境界値(ev=1.1)の候補が採用されること", () => {
    const result = buildMixedCandidates(raceInput({ rows, ...boundaryOddsRecord }), {
      evConfig: { threshold: 1.0 },
    });
    expect(result.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(3);
    expect(result.candidates.filter((c) => c.umabans.length === 3)).toHaveLength(1);
  });

  it("evConfig.threshold=1.2を指定すると境界値(ev=1.1)の候補が0件になること(evConfigが実際にbuildComboCandidatesへ渡っていることの証拠)", () => {
    const result = buildMixedCandidates(raceInput({ rows, ...boundaryOddsRecord }), {
      evConfig: { threshold: 1.2 },
    });
    expect(result.candidates.filter((c) => c.umabans.length >= 2)).toHaveLength(0);
    if (result.diagnostics.wide.kind !== "built" || result.diagnostics.trio.kind !== "built") {
      throw new Error("wide/trio診断値はkind='built'のはず");
    }
    // 判定結果(notPositiveCount)に落ちていること(判定不能=unjudgedに紛れ込んでいないこと)。
    expect(result.diagnostics.wide.build.judged).toEqual({ positiveCount: 0, notPositiveCount: 3 });
    expect(result.diagnostics.trio.build.judged).toEqual({ positiveCount: 0, notPositiveCount: 1 });
  });

  it("wide/trioで異なる閾値の影響を受けないこと(両方に同じevConfigが渡ること。取り違え検知)", () => {
    // 閾値1.2で両方0件になることは前段で確認済み。ここでは片方だけ計算しても同じ結果になる
    // (betTypesで絞ってもevConfigの適用先が変わらない)ことを確認し、evConfigがwide/trioの
    // どちらか一方にしか渡っていない配線ミスを検知する。
    const wideOnly = buildMixedCandidates(
      raceInput({ rows, ...boundaryOddsRecord }),
      { betTypes: ["wide"], evConfig: { threshold: 1.2 } },
    );
    const trioOnly = buildMixedCandidates(
      raceInput({ rows, ...boundaryOddsRecord }),
      { betTypes: ["trio"], evConfig: { threshold: 1.2 } },
    );
    expect(wideOnly.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(0);
    expect(trioOnly.candidates.filter((c) => c.umabans.length === 3)).toHaveLength(0);
  });
});

// ============================================================================
// Issue #76 AC-A6: 挙動不変の実質的な担保(旧写像との等価性)
// ============================================================================

describe("Issue #76 AC-A6: production から消えた「umabans.length→券種」の旧写像との等価性", () => {
  it("実際の候補生成経路(buildMixedCandidates)で複勝・ワイド・3連複が同時に立つフィクスチャに対し、betTypeとumabans.lengthが{place:1, wide:2, trio:3}の対応どおりであること", () => {
    // production からは「長さ→券種」の逆写像を完全に削除した(Issue #76)。この対応表は
    // テスト側にのみリテラルとして残し、実際の候補生成経路(buildMixedCandidates。頭数境界
    // describeで使用実績のあるn=8全EVプラスフィクスチャを流用)が今も同じ対応を守っている
    // ことを固定する。これが「挙動不変」の実質的な担保である。
    const OLD_LENGTH_TO_BET_TYPE: Record<number, "place" | "wide" | "trio"> = {
      1: "place",
      2: "wide",
      3: "trio",
    };
    const n = 8;
    const umabans = umabansOf(n);
    const race = raceInput({
      rows: allCandidateRows(n),
      wideCombo: fullOddsRecord(umabans, 2, 100000),
      trioCombo: fullOddsRecord(umabans, 3, 100000),
      comboOdds: { wide: comboOddsOutcome("wide", "available"), trio: comboOddsOutcome("trio", "available") },
    });
    // betTypesをplace/wide/trioの3券種に絞る(#90でwinが既定対象に加わり、winもumabans.length===1の
    // 候補を産むため、絞らないとOLD_LENGTH_TO_BET_TYPE[1]="place"の前提〈umabans.length===1は
    // placeのみ〉が崩れる。本テストの関心事は#76時代の3券種の対応表であり、winとの区別は
    // 下記「win候補(#90)」describeで別途検証する)。
    const result = buildMixedCandidates(race, { betTypes: ["place", "wide", "trio"] });

    // 前提固定(空振り防止): 複勝(8)・ワイド(C(8,2)=28)・3連複(C(8,3)=56)の3券種すべてが
    // 実際に候補として生成されていること(1種類にしか到達していなければ以下の対応検査が空振りする)。
    expect(result.candidates.filter((c) => c.umabans.length === 1)).toHaveLength(8);
    expect(result.candidates.filter((c) => c.umabans.length === 2)).toHaveLength(28);
    expect(result.candidates.filter((c) => c.umabans.length === 3)).toHaveLength(56);

    for (const candidate of result.candidates) {
      expect(candidate.betType).toBe(OLD_LENGTH_TO_BET_TYPE[candidate.umabans.length]);
    }
  });
});

// ============================================================================
// win候補(単勝・Issue #90・#23-B2)
// ============================================================================

describe("win候補(#90・#23-B2)", () => {
  it("betTypesにwinを含めない場合: kind='not-requested'、候補も0件", () => {
    const rows = allCandidateRows(8);
    const result = buildMixedCandidates(raceInput({ rows }), { betTypes: ["place", "wide", "trio"] });
    expect(result.diagnostics.win).toEqual({ kind: "not-requested" });
    expect(result.candidates.filter((c) => c.betType === "win")).toHaveLength(0);
  });

  it("yosoガード(D-4): oddsStatus='yoso'のときwinOddsが供給されていてもkind='unavailable'(reason='yoso')で候補0件", () => {
    const rows = allCandidateRows(8).map((r) => row({ ...r, winOdds: 100 }));
    const result = buildMixedCandidates(raceInput({ rows, oddsStatus: "yoso" }), {
      betTypes: ["place", "win"],
    });
    expect(result.diagnostics.win).toEqual({ kind: "unavailable", reason: "yoso" });
    expect(result.candidates.filter((c) => c.betType === "win")).toHaveLength(0);
  });

  it("yosoガードの独立性: oddsStatusだけを'result'に変えると同じ行データでwin候補が生成されること", () => {
    const rows = allCandidateRows(8).map((r) => row({ ...r, winOdds: 100 }));
    const result = buildMixedCandidates(raceInput({ rows, oddsStatus: "result" }), {
      betTypes: ["win"],
    });
    expect(result.diagnostics.win.kind).toBe("judged");
    expect(result.candidates.filter((c) => c.betType === "win").length).toBeGreaterThan(0);
  });

  it("オッズ状態(judged): winOdds=null→oddsMissingCount、malformed(0.5)→oddsMalformedCount、EV非プラス→notPositiveCount、EVプラス→positiveCountかつ候補に出ること", () => {
    const rows: AnalysisRow[] = [
      row({ umaban: 1, winOdds: null }), // 欠損
      row({ umaban: 2, winOdds: 0.5 }), // malformed(1.0未満)
      row({ umaban: 3, winOdds: 1.01 }), // 正常だがEV非プラス(1着確率が低いため)
      row({ umaban: 4, winOdds: 1000 }), // 正常・EVプラス
      row({ umaban: 5, winOdds: 1000 }),
      row({ umaban: 6, winOdds: 1000 }),
      row({ umaban: 7, winOdds: 1000 }),
      row({ umaban: 8, winOdds: 1000 }),
    ];
    const result = buildMixedCandidates(raceInput({ rows }), { betTypes: ["win"] });
    expect(result.diagnostics.win.kind).toBe("judged");
    if (result.diagnostics.win.kind !== "judged") throw new Error("kind='judged'のはず");
    expect(result.diagnostics.win.unjudged.oddsMissingCount).toBe(1);
    expect(result.diagnostics.win.unjudged.oddsMalformedCount).toBe(1);
    expect(result.diagnostics.win.judged.notPositiveCount).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.win.judged.positiveCount).toBeGreaterThanOrEqual(1);
    const winCandidates = result.candidates.filter((c) => c.betType === "win");
    expect(winCandidates.every((c) => c.isPositive)).toBe(true);
    expect(winCandidates.find((c) => c.umabans[0] === 1)).toBeUndefined();
    expect(winCandidates.find((c) => c.umabans[0] === 2)).toBeUndefined();
  });

  /**
   * 反証B相当(頭数による門前払いをしない。AC3): 1〜4頭・5〜7頭でもwin候補が
   * 「頭数」を理由に除外されないこと(resolvePlaceBetTargetをwinには適用しない)。
   * n=2・3はPLACKETT_LUCE_MODEL自身の構造的縮退(topFinishCount=3が出走頭数を覆う)により
   * buildOrderedDistributionがnullを返し候補が0件になるが、これは「頭数門前払い」ではなく
   * モデルの数学的な性質である(診断値がkind='judged'のまま〈'unavailable'にならない〉
   * ことで、本コードが独自の頭数ゲートを追加していないことを区別して固定する)。
   */
  describe.each([1, 2, 3, 4, 5, 6, 7])("頭数=%i頭でも「頭数」を理由にwin候補が除外されないこと", (n) => {
    it(`n=${n}: diagnostics.win.kindは常に'judged'(unavailableにならない)`, () => {
      const rows = allCandidateRows(n).map((r) => row({ ...r, winOdds: 1000 }));
      const result = buildMixedCandidates(raceInput({ rows }), { betTypes: ["win"] });
      expect(result.diagnostics.win.kind).toBe("judged");
    });
  });

  it("n=1・4〜7では実際にwin候補が1件以上生成されること(モデルが解ける頭数での実証)", () => {
    for (const n of [1, 4, 5, 6, 7]) {
      const rows = allCandidateRows(n).map((r) => row({ ...r, winOdds: 1000 }));
      const result = buildMixedCandidates(raceInput({ rows }), { betTypes: ["win"] });
      expect(result.candidates.filter((c) => c.betType === "win").length).toBeGreaterThan(0);
    }
  });

  it("n=2・3ではモデルの構造的縮退によりwin候補が0件になること(頭数門前払いではない証拠として、診断値は'judged'のまま)", () => {
    for (const n of [2, 3]) {
      const rows = allCandidateRows(n).map((r) => row({ ...r, winOdds: 1000 }));
      const result = buildMixedCandidates(raceInput({ rows }), { betTypes: ["win"] });
      expect(result.candidates.filter((c) => c.betType === "win")).toHaveLength(0);
      expect(result.diagnostics.win).toEqual({
        kind: "judged",
        judged: { positiveCount: 0, notPositiveCount: 0 },
        unjudged: { oddsMissingCount: 0, oddsMalformedCount: 0 },
      });
    }
  });

  it("既定(betTypes省略)でもwinが対象に含まれること(ALL_MIXED_CANDIDATE_BET_TYPESにwinが入ったため)", () => {
    const rows = allCandidateRows(8).map((r) => row({ ...r, winOdds: 1000 }));
    const result = buildMixedCandidates(raceInput({ rows }));
    expect(result.diagnostics.win.kind).toBe("judged");
    expect(result.candidates.filter((c) => c.betType === "win").length).toBeGreaterThan(0);
  });
});

/**
 * 馬連(quinella)候補(Issue #116・#24-D3b-1)。
 *
 * n=4を使う理由: `buildQuinellaCandidates`は`buildOrderedDistribution`(順序付きoutcome空間)に
 * 委譲するため、`topFinishCount`(常に3)が出走頭数を覆う縮退(n<=3)ではnullが返り候補が
 * 常に0件になる(win候補と同じ制約。「頭数=%i頭でも…」describe参照)。n=4以上で意味のある
 * 候補が得られることを事前に実行して確認済み(n=4・placeProb一律0.5・全ペアオッズ999で
 * hitProb=1/6・ev=166.5になることを実測)。
 */
describe("馬連(quinella)候補(#116・#24-D3b-1)", () => {
  it("既定(betTypes省略)でも馬連が対象に含まれること(Issue #117でALL_MIXED_CANDIDATE_BET_TYPESに馬連が入ったため。#116時点は既定でnot-requestedだったが反転した)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({ rows, quinellaCombo: fullOddsRecord(umabans, 2, 999) }),
    );
    expect(result.diagnostics.quinella.kind).toBe("built");
    expect(result.candidates.filter((c) => c.betType === "quinella").length).toBeGreaterThan(0);
  });

  it("betTypesを明示的に馬連以外に絞った場合: kind='not-requested'、候補も0件であること(not-requested分岐自体は引き続き到達可能であることの確認)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({ rows, quinellaCombo: fullOddsRecord(umabans, 2, 999) }),
      { betTypes: ["place"] },
    );
    expect(result.diagnostics.quinella).toEqual({ kind: "not-requested" });
    expect(result.candidates.filter((c) => c.betType === "quinella")).toHaveLength(0);
  });

  it("betTypesに明示的にquinellaを含めれば候補が構築されること(kind='built')", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({ rows, quinellaCombo: fullOddsRecord(umabans, 2, 999) }),
      { betTypes: ["quinella"] },
    );
    expect(result.diagnostics.quinella.kind).toBe("built");
    const quinellaCandidates = result.candidates.filter((c) => c.betType === "quinella");
    expect(quinellaCandidates).toHaveLength(6); // C(4,2)
    expect(quinellaCandidates.every((c) => c.odds === 999)).toBe(true);
  });

  it("yosoガード: oddsStatus='yoso'のときquinellaComboが供給されていてもkind='yoso'で候補0件", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        oddsStatus: "yoso",
        quinellaCombo: fullOddsRecord(umabans, 2, 999),
      }),
      { betTypes: ["quinella"] },
    );
    expect(result.diagnostics.quinella).toEqual({ kind: "yoso" });
    expect(result.candidates.filter((c) => c.betType === "quinella")).toHaveLength(0);
  });

  it("fieldPresence・comboOddsStateがwide/trioと同じ形で反映されること(quinellaComboキー不在=absent・comboOdds未設定=unknown)", () => {
    const rows = allCandidateRows(4);
    const result = buildMixedCandidates(raceInput({ rows }), { betTypes: ["quinella"] });
    if (result.diagnostics.quinella.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    expect(result.diagnostics.quinella.fieldPresence).toBe("absent");
    expect(result.diagnostics.quinella.comboOddsState).toBe("unknown");
    expect(result.candidates.filter((c) => c.betType === "quinella")).toHaveLength(0);
  });

  it("comboOdds.quinella.stateが反映されること(wide/trioと独立)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        quinellaCombo: fullOddsRecord(umabans, 2, 999),
        comboOdds: { quinella: comboOddsOutcome("quinella", "available") },
      }),
      { betTypes: ["quinella"] },
    );
    if (result.diagnostics.quinella.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    expect(result.diagnostics.quinella.fieldPresence).toBe("present");
    expect(result.diagnostics.quinella.comboOddsState).toBe("available");
  });

  /**
   * 殺すべき変異(Issue #116 AC-5・ブリーフ明記): 「馬連の候補にwideComboのオッズを使う」。
   * wideComboとquinellaComboに同じキー(組)で異なる値を与え、馬連候補のoddsが
   * quinellaCombo側の値(999)であって、wideCombo側の値(5)ではないことを固定する。
   * 値も分けて設計(999→ev=166.5でEVプラス、5→ev=0.8335でEV非プラスかつ閾値1.0を下回る)
   * ため、混同する変異は「候補が0件になる」「oddsの値が違う」の両方向で検知できる
   * (事前にscripts配下のスクリプトで実測済み。core buildComboCandidatesはbetType="quinella"を
   * 専用にthrowする安全装置を持つため〈#112〉、この変異はbuildComboCandidatesForBetTypeを
   * 誤ってquinellaへ流用する形では起こり得ず、race.wideComboを読む形でのみ起こりうる)。
   */
  it("馬連候補のオッズはquinellaComboの値であり、wideComboの値と混同されないこと(殺すべき変異の直接検知)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        wideCombo: fullOddsRecord(umabans, 2, 5), // ev=0.8335(EV非プラス)になる値
        quinellaCombo: fullOddsRecord(umabans, 2, 999), // ev=166.5(EVプラス)になる値
      }),
      { betTypes: ["quinella"] }, // wideは対象外にし、quinella側の値だけを見る。
    );
    // 前提固定: wideComboとquinellaComboで異なる値を与えていること。
    expect(result.diagnostics.quinella.kind).toBe("built");
    const quinellaCandidates = result.candidates.filter((c) => c.betType === "quinella");
    expect(quinellaCandidates.length).toBeGreaterThan(0); // 空振り防止(wideの値〈ev非プラス〉が混入すると0件になる)。
    expect(quinellaCandidates).toHaveLength(6); // C(4,2)
    for (const c of quinellaCandidates) {
      expect(c.odds).toBe(999);
      expect(c.odds).not.toBe(5);
    }
  });
});

/**
 * 馬単(exacta)候補(Issue #122・#24-E2)。core自体の的中確率・候補ビルダー・配分の門番は
 * Issue #120・#24-E1で先行済み(`buildExactaCandidates`)。本ブロックは`mixed-candidates.ts`の
 * `buildExactaCandidatesForBetType`を通した配線を検証する(`buildQuinellaCandidates`と
 * 同型の骨格)。
 *
 * 【Issue #125(#24-E3b)で改訂】旧版(#122時点)は馬単が`ALL_MIXED_CANDIDATE_BET_TYPES`に
 * 含まれない〈#125まで〉ため、「既定でも対象になる」quinellaの1本目のテストとは対称的に
 * 「既定では対象外(kind='not-requested')」を確認していた。#125で`ALL_MIXED_CANDIDATE_BET_TYPES`
 * に`exacta`を加えたため、以下の1本目はquinellaの1本目と対称な「既定でも対象に含まれる」形に
 * 反転する。
 * 何を保証していたか(新旧対応表):
 *   旧: 既定(betTypes省略)呼び出しでkind='not-requested'・候補0件であること
 *       (=未接続の確認)
 *   新: 既定(betTypes省略)呼び出しでkind='built'・候補12件(P(4,2))であること
 *       (=接続されたことの確認。券種を明示指定する2本目のテストと結果が同じになる)
 *
 * オッズ値の実測(4頭・adjustedProb=0.5均等・topFinishCount=3。`buildExactaCandidates`を
 * 直接呼んで確認済み): 各順序付きペアの的中確率は1/12(P(4,2)=12通りに均等分配される)。
 * odds=999 → ev=83.25(EVプラス)、odds=5 → ev=0.4167(EV非プラス、閾値1.0未満)。
 */
describe("馬単(exacta)候補(#122・#24-E2。Issue #125で既定でも対象になった)", () => {
  it("既定(betTypes省略)でも馬単が対象に含まれること(Issue #125でALL_MIXED_CANDIDATE_BET_TYPESに馬単が入ったため。#122時点は既定でnot-requestedだったが反転した)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({ rows, exactaCombo: fullOrderedOddsRecord(umabans, 999) }),
    );
    expect(result.diagnostics.exacta.kind).toBe("built");
    expect(result.candidates.filter((c) => c.betType === "exacta").length).toBeGreaterThan(0);
  });

  it("betTypesに明示的にexactaを含めれば候補が構築されること(kind='built'。P(4,2)=12件)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({ rows, exactaCombo: fullOrderedOddsRecord(umabans, 999) }),
      { betTypes: ["exacta"] },
    );
    expect(result.diagnostics.exacta.kind).toBe("built");
    const exactaCandidates = result.candidates.filter((c) => c.betType === "exacta");
    expect(exactaCandidates).toHaveLength(12); // P(4,2)
    expect(exactaCandidates.every((c) => c.odds === 999)).toBe(true);
  });

  it("yosoガード: oddsStatus='yoso'のときexactaComboが供給されていてもkind='yoso'で候補0件", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        oddsStatus: "yoso",
        exactaCombo: fullOrderedOddsRecord(umabans, 999),
      }),
      { betTypes: ["exacta"] },
    );
    expect(result.diagnostics.exacta).toEqual({ kind: "yoso" });
    expect(result.candidates.filter((c) => c.betType === "exacta")).toHaveLength(0);
  });

  it("fieldPresence・comboOddsStateがwide/trio/quinellaと同じ形で反映されること(exactaComboキー不在=absent・comboOdds未設定=unknown)", () => {
    const rows = allCandidateRows(4);
    const result = buildMixedCandidates(raceInput({ rows }), { betTypes: ["exacta"] });
    if (result.diagnostics.exacta.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    expect(result.diagnostics.exacta.fieldPresence).toBe("absent");
    expect(result.diagnostics.exacta.comboOddsState).toBe("unknown");
    expect(result.candidates.filter((c) => c.betType === "exacta")).toHaveLength(0);
  });

  it("comboOdds.exacta.stateが反映されること(wide/trio/quinellaと独立)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        exactaCombo: fullOrderedOddsRecord(umabans, 999),
        comboOdds: { exacta: comboOddsOutcome("exacta", "available") },
      }),
      { betTypes: ["exacta"] },
    );
    if (result.diagnostics.exacta.kind !== "built") {
      throw new Error("診断値はkind='built'のはず");
    }
    expect(result.diagnostics.exacta.fieldPresence).toBe("present");
    expect(result.diagnostics.exacta.comboOddsState).toBe("available");
  });

  /**
   * 殺すべき変異(Issue #122 AC-5・ブリーフ明記): 「馬単の候補にquinellaCombo(または
   * wideCombo)のオッズを使う」。quinellaComboとexactaComboに同じキー(組)で異なる値を
   * 与え、馬単候補のoddsがexactaCombo側の値(999)であって、quinellaCombo側の値(5)では
   * ないことを固定する。値も分けて設計(999→ev=83.25でEVプラス、5→ev=0.4167でEV非プラス
   * かつ閾値1.0を下回る。上記モジュールJSDocで実測済み)ため、混同する変異は
   * 「候補が0件になる」「oddsの値が違う」の両方向で検知できる(core `buildComboCandidates`
   * はbetType="exacta"を専用にthrowする安全装置を持つため〈#120〉、この変異は
   * `buildComboCandidatesForBetType`を誤ってexactaへ流用する形では起こり得ず、
   * `race.quinellaCombo`/`race.wideCombo`を読む形でのみ起こりうる)。
   */
  it("馬単候補のオッズはexactaComboの値であり、quinellaComboの値と混同されないこと(殺すべき変異の直接検知)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({
        rows,
        quinellaCombo: fullOddsRecord(umabans, 2, 5), // ev非プラスになる値(馬連の組合せキー)
        exactaCombo: fullOrderedOddsRecord(umabans, 999), // ev=83.25(EVプラス)になる値
      }),
      { betTypes: ["exacta"] }, // quinellaは対象外にし、exacta側の値だけを見る。
    );
    expect(result.diagnostics.exacta.kind).toBe("built");
    const exactaCandidates = result.candidates.filter((c) => c.betType === "exacta");
    expect(exactaCandidates.length).toBeGreaterThan(0); // 空振り防止(quinellaの値〈ev非プラス〉が混入すると0件になる)。
    expect(exactaCandidates).toHaveLength(12); // P(4,2)
    for (const c of exactaCandidates) {
      expect(c.odds).toBe(999);
      expect(c.odds).not.toBe(5);
    }
  });

  it("馬単候補のumabansは順序付きのまま(昇順に潰されない)であること(馬単固有の回帰観点)", () => {
    const rows = allCandidateRows(4);
    const umabans = umabansOf(4);
    const result = buildMixedCandidates(
      raceInput({ rows, exactaCombo: fullOrderedOddsRecord(umabans, 999) }),
      { betTypes: ["exacta"] },
    );
    const exactaCandidates = result.candidates.filter((c) => c.betType === "exacta");
    // 前提固定: [2,1](降順)が候補として存在すること。
    const descending = exactaCandidates.find((c) => c.umabans[0] === 2 && c.umabans[1] === 1);
    expect(descending).toBeDefined();
    const ascending = exactaCandidates.find((c) => c.umabans[0] === 1 && c.umabans[1] === 2);
    expect(ascending).toBeDefined();
    // 両方が別々の候補として存在する(昇順ソートで片方に潰されていない)。
    expect(exactaCandidates.length).toBe(12);
  });
});
