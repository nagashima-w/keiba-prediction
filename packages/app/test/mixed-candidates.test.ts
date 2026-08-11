import { describe, expect, it } from "vitest";

import {
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
  type MixedCandidateBuildInput,
} from "../src/renderer/mixed-candidates.js";

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
  betType: "wide" | "trio",
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
    const result = buildMixedCandidates(race);

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
      { umabans: [1, 2], odds: 3, ev: 2, isPositive: true },
      { umabans: [1, 3], odds: 5, ev: 4, isPositive: true },
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
    const placeUmabans = result.candidates.filter((c) => c.umabans.length === 1).map((c) => c.umabans[0]);
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
    const placeUmabans = result.candidates.filter((c) => c.umabans.length === 1).map((c) => c.umabans[0]);
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
    const placeUmabans = result.candidates.filter((c) => c.umabans.length === 1).map((c) => c.umabans[0]);
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
    const placeUmabans = result.candidates.filter((c) => c.umabans.length === 1).map((c) => c.umabans[0]);
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
// 券種フィルタ(省略時=全券種。一部指定時は非対象の列挙自体を行わない)
// ============================================================================

describe("券種フィルタ(options.betTypes)", () => {
  it("省略時は全券種(ALL_MIXED_CANDIDATE_BET_TYPES)が対象になること", () => {
    expect(ALL_MIXED_CANDIDATE_BET_TYPES).toEqual(["place", "wide", "trio"]);
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
