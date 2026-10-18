import { describe, expect, it } from "vitest";
import { computeVerifyReport, PRODUCTION_VERIFY_CONFIG } from "../../packages/core/src/ev/verify";
import { buildTargetsLedger, getTargetsLedgerWire, ledgerFromWire, ledgerToWire, RESULT_GIVE_UP_AFTER_START_MS, shouldReadLedger, type LedgerRaceResult, type TargetsLedger } from "../src/targets-ledger";
import { buildVerifySource, type VerifyAnalysisRow, type VerifyBetRow, type VerifyComboImportRow, type VerifyComboPayoutRow, type VerifyReadRows, type VerifyResultRow } from "../src/verify-read";

/**
 * Issue #361: 「今日の狙い目」の収支の途中経過(`buildTargetsLedger`。純関数)。
 * 数字は検証画面と同じ規則(core の `computeVerifyReport`・`PRODUCTION_VERIFY_CONFIG`)で、その日の分析だけを対象に出す。
 * 確かめること: 状態の分類(確定・結果待ち・払戻待ち・結果なし・集計対象外・提案なし)・合計 = 検証画面と同じ関数の値・最新の選択(先読みを除いた clean の最新)・
 * 発走時刻の代替(D1 の `start_time` が NULL のとき計画の時刻)・結果なしの境界(発走 +70 分)。
 */

const DATE = "20261017";
const R1 = "202605050801"; // 計画の発走 14:00 JST(05:00Z)
const R2 = "202605050802"; // 14:30 JST(05:30Z)
const R3 = "202605050803"; // 15:00 JST(06:00Z)
const START: Record<string, string> = { [R1]: "14:00", [R2]: "14:30", [R3]: "15:00" };
const plan = (): { raceId: string; startTime: string | null }[] => Object.entries(START).map(([raceId, startTime]) => ({ raceId, startTime }));
/** 全レースが発走済みの時刻(15:30 JST = 06:30Z)。 */
const NOW = Date.parse("2026-10-17T06:30:00Z");
const BEFORE = "2026-10-17T00:30:00.000Z"; // 全レースの発走前の分析日時

/** D1 の `verify-read.ts` の SQL と同じ: `HH:MM` の形の start_time だけが、スナップショット(`{race:{startTime}}`)として渡る。 */
const snapshotOf = (startTime: string | null): string | null => (startTime !== null && /^[0-9]+:[0-9][0-9]$/.test(startTime) ? JSON.stringify({ race: { startTime } }) : null);

function analysisRow(id: number, raceId: string, overrides: Partial<VerifyAnalysisRow> = {}): VerifyAnalysisRow {
  const row: VerifyAnalysisRow = {
    id,
    raceId,
    analyzedAt: BEFORE,
    evEstimated: 0,
    promptVersion: "v-test",
    additionalInstruction: null,
    kaisaiDate: DATE,
    model: null,
    rawResponse: null,
    raceSnapshotJson: null,
    // 既定は先読みの遮断済み(clean。発走時刻を見ない)。
    historyCutoffDate: "20261016",
    promptLookaheadGuarded: 1,
    startTime: null,
    ...overrides,
  };
  return { ...row, raceSnapshotJson: snapshotOf(row.startTime) };
}

/** 検証画面が補完後に見る行(start_time が NULL の行に、同じ発走時刻を入れたもの)。 */
const withStartTime = (rows: VerifyReadRows, startTime: string): VerifyReadRows => ({
  ...rows,
  analyses: rows.analyses.map((a) => (a.startTime === null ? { ...a, startTime, raceSnapshotJson: snapshotOf(startTime) } : a)),
});

const bet = (analysisId: number, betType: string, comboKey: string, stake: number): VerifyBetRow => ({ analysisId, betType, comboKey, stake });

/** 8 頭の結果。1着=1番・2着=2番・3着=3番。複勝は 1〜3 番に払戻(100 円あたり)。 */
function resultRows(raceId: string, overrides: Partial<VerifyResultRow>[] = []): VerifyResultRow[] {
  return Array.from({ length: 8 }, (_, i) => {
    const umaban = i + 1;
    return { raceId, umaban, finishPosition: umaban, placePayout: umaban <= 3 ? 150 + umaban * 10 : null, winPayout: umaban === 1 ? 300 : null, scratched: 0, wakuban: umaban, ...overrides[i] };
  });
}

interface Fixture {
  analyses: VerifyAnalysisRow[];
  allocationMeta: { analysisId: number; route: string; skipReasonCode: string | null }[];
  bets: VerifyBetRow[];
  results: VerifyResultRow[];
  comboPayouts: VerifyComboPayoutRow[];
  comboImports: VerifyComboImportRow[];
}

const emptyFixture = (): Fixture => ({ analyses: [], allocationMeta: [], bets: [], results: [], comboPayouts: [], comboImports: [] });
const toRows = (f: Fixture): VerifyReadRows => ({ ...f, horses: [] });

/** 分析 1 件(配分あり)を足す。 */
function addAnalysis(f: Fixture, id: number, raceId: string, bets: VerifyBetRow[], overrides: Partial<VerifyAnalysisRow> = {}, meta: { route: string; skipReasonCode: string | null } = { route: "mixed", skipReasonCode: null }): void {
  f.analyses.push(analysisRow(id, raceId, overrides));
  f.allocationMeta.push({ analysisId: id, ...meta });
  f.bets.push(...bets);
}

/** 結果(着順・単勝/複勝払戻)と、ワイドの払戻(取込済み)を足す。 */
function addResult(f: Fixture, raceId: string, options: { widePayouts?: { comboKey: string; payout: number }[] | "not-imported"; scratched?: number[] } = {}): void {
  f.results.push(...resultRows(raceId, Array.from({ length: 8 }, (_, i) => (options.scratched?.includes(i + 1) === true ? { scratched: 1, finishPosition: null, placePayout: null, winPayout: null } : {}))));
  const wide = options.widePayouts ?? [{ comboKey: "0102", payout: 1500 }];
  if (wide !== "not-imported") {
    f.comboImports.push({ raceId, betType: "wide" });
    f.comboPayouts.push(...wide.map((p) => ({ raceId, betType: "wide", comboKey: p.comboKey, payout: p.payout })));
  }
}

function ledgerOf(f: Fixture, options: { nowMs?: number; importStates?: ReadonlyMap<string, string> | null; plan?: { raceId: string; startTime: string | null }[] | null } = {}): TargetsLedger {
  return buildTargetsLedger({ kaisaiDate: DATE, nowMs: options.nowMs ?? NOW, rows: toRows(f), plan: options.plan === undefined ? plan() : options.plan, importStates: options.importStates === undefined ? new Map() : options.importStates });
}

function race(ledger: TargetsLedger, raceId: string): LedgerRaceResult {
  const found = ledger.races.get(raceId);
  expect(found, `${raceId} の結果がある`).toBeDefined();
  return found!;
}

describe("確定したレース(settled)の金額", () => {
  it("的中: ワイド 0102 に 300 円・払戻 1,500 円(100 円あたり) → 払戻 4,500・差額 +4,200・的中", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    addResult(f, R1);
    const r = race(ledgerOf(f), R1);
    expect(r).toMatchObject({ state: "settled", stake: 300, payout: 4500, hit: true, refundedStake: 0 });
    expect(r.payout - r.stake).toBe(4200);
  });

  it("不的中: 払戻表に買い目のキーが無ければ払戻 0・差額 −300・的中でない(判定不能とは別。払戻表は取り込み済み)", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0103", 300)]);
    addResult(f, R1);
    const r = race(ledgerOf(f), R1);
    expect(r).toMatchObject({ state: "settled", stake: 300, payout: 0, hit: false });
  });

  it("的中でも損: 2 点(0102 に 100 円・0103 に 900 円)で当たった 0102 の払戻が 900 円 → 賭け金 1,000・払戻 900 で差額は負だが的中", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 100), bet(1, "wide", "0103", 900)]);
    addResult(f, R1, { widePayouts: [{ comboKey: "0102", payout: 900 }] });
    const r = race(ledgerOf(f), R1);
    expect(r.stake).toBe(1000);
    expect(r.payout).toBe(900);
    expect(r.hit).toBe(true);
    expect(r.payout - r.stake).toBeLessThan(0);
  });

  it("返還のみ: 取消の馬(2 番)を含むワイド 0102 は返還(払戻 = 賭け金)。的中ではなく、返還の賭け金を持つ", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    addResult(f, R1, { scratched: [2], widePayouts: [{ comboKey: "0103", payout: 500 }] });
    const r = race(ledgerOf(f), R1);
    expect(r).toMatchObject({ state: "settled", stake: 300, payout: 300, refundedStake: 300, hit: false });
  });

  it("複勝(place)も判定する: 1 番の複勝 200 円・払戻 160 円(100 円あたり)→ 払戻 320", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "place", "01", 200)]);
    addResult(f, R1);
    expect(race(ledgerOf(f), R1)).toMatchObject({ state: "settled", stake: 200, payout: 320, hit: true });
  });
});

describe("合計(検証画面と同じ関数の値)", () => {
  function threeRaceDay(): Fixture {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]); // 的中 +4,200
    addAnalysis(f, 2, R2, [bet(2, "wide", "0103", 300), bet(2, "place", "01", 200)]); // 複勝が当たる
    addAnalysis(f, 3, R3, [bet(3, "wide", "0405", 500)]); // 不的中
    for (const raceId of [R1, R2, R3]) addResult(f, raceId);
    return f;
  }

  it("全レースが確定: 合計 = 各レースの賭け金・払戻の和 = computeVerifyReport(PRODUCTION・all)の proposedBet.overall", () => {
    const f = threeRaceDay();
    const ledger = ledgerOf(f);
    const verify = computeVerifyReport(buildVerifySource(toRows(f)), PRODUCTION_VERIFY_CONFIG, "all").proposedBet.overall;
    // 前提: 検証側の値が自明でない(賭け金も払戻も正。的中と不的中の両方がある)
    expect(verify.totalStake).toBe(1300);
    expect(verify.totalReturn).toBeGreaterThan(0);
    expect(verify.totalReturn).toBeLessThan(verify.totalStake * 10);
    expect(ledger.total).toMatchObject({ raceCount: 3, stake: verify.totalStake, payout: verify.totalReturn, recoveryRate: verify.recoveryRate });
    const rows = [...ledger.races.values()].filter((r) => r.state === "settled");
    expect(rows).toHaveLength(3);
    expect(rows.reduce((s, r) => s + r.stake, 0)).toBe(ledger.total.stake);
    expect(rows.reduce((s, r) => s + r.payout, 0)).toBe(ledger.total.payout);
  });

  it("結果待ちのレースは合計に入らない(件数だけ出る)。確定したレースだけの合計になる", () => {
    const f = threeRaceDay();
    f.results = f.results.filter((r) => r.raceId !== R3);
    const ledger = ledgerOf(f);
    expect(race(ledger, R3).state).toBe("pending");
    expect(ledger.total.raceCount).toBe(2);
    expect(ledger.total.stake).toBe(800);
    expect(ledger.waitingCount).toBe(1);
  });

  it("払戻の未取込(ワイドの取込印なし)のレースは「結果待ち(払戻)」で合計から外れる。取り込み後は検証画面と一致する", () => {
    const f = threeRaceDay();
    // R2 のワイドの取込印と払戻を外す(複勝は取込済み=判定できる買い目と、判定不能の買い目が同じレースに混ざる)。
    f.comboImports = f.comboImports.filter((i) => i.raceId !== R2);
    f.comboPayouts = f.comboPayouts.filter((p) => p.raceId !== R2);
    const before = ledgerOf(f);
    const verifyBefore = computeVerifyReport(buildVerifySource(toRows(f)), PRODUCTION_VERIFY_CONFIG, "all").proposedBet.overall;
    expect(race(before, R2).state).toBe("pending_payout");
    expect(before.total.raceCount).toBe(2);
    expect(before.total.stake).toBe(800); // R1 の 300 と R3 の 500。R2 の判定できた複勝 200 円も入れない
    // 前提: 検証画面は、判定できた複勝 200 円ぶんを集計に入れている(この時点では食い違う=外した効果が見える)
    expect(verifyBefore.totalStake).toBe(1000);
    expect(before.waitingCount).toBe(1);
    // 取り込み後(ワイドの取込印と払戻が入った状態=最初の組み立てそのもの)
    const done = threeRaceDay();
    const after = ledgerOf(done);
    const verifyAfter = computeVerifyReport(buildVerifySource(toRows(done)), PRODUCTION_VERIFY_CONFIG, "all").proposedBet.overall;
    expect(race(after, R2).state).toBe("settled");
    expect(after.total).toMatchObject({ raceCount: 3, stake: verifyAfter.totalStake, payout: verifyAfter.totalReturn, recoveryRate: verifyAfter.recoveryRate });
    expect(after.total.stake).toBeGreaterThan(before.total.stake); // 前提: 取り込み前後で合計が実際に変わっている
  });

  it("確定が 0 件: 合計は 0 件・賭け金 0・払戻 0・回収率 null(0 除算にならない)", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    const ledger = ledgerOf(f, { nowMs: Date.parse("2026-10-17T05:20:00Z") }); // 発走(14:00 JST)の 20 分後=まだ結果なしにはしない
    expect(race(ledger, R1).state).toBe("pending");
    expect(ledger.total).toEqual({ raceCount: 0, stake: 0, payout: 0, recoveryRate: null });
  });
});

describe("結果待ちと結果なし(取り込みの状態と発走からの経過)", () => {
  const started = (importStates: ReadonlyMap<string, string> | null, nowMs = NOW, startTime: string | null = "14:00"): LedgerRaceResult => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    return race(ledgerOf(f, { nowMs, importStates, plan: [{ raceId: R1, startTime }] }), R1);
  };

  it("定数: 結果なしにするのは発走 +70 分を超えたとき(取り込みの上限が発走 +60 分なので、その後の余裕を 10 分見る)", () => {
    expect(RESULT_GIVE_UP_AFTER_START_MS).toBe(70 * 60_000);
  });

  it("取り込みの行が queued: 結果待ち(発走からどれだけ経っていても、DO が取り込みを続けている間は待つ)", () => {
    expect(started(new Map([[R1, "queued"]]), Date.parse("2026-10-17T05:00:00Z") + 3 * 3_600_000).state).toBe("pending");
  });

  it("gave_up: 結果なし(経過時間に依らない。発走の 1 分後でも)", () => {
    expect(started(new Map([[R1, "gave_up"]]), Date.parse("2026-10-17T05:01:00Z")).state).toBe("none");
  });

  it("行が無い(取り込みの依頼がまだ来ていない): 発走 +70 分ちょうどは結果待ち、+70 分と 1ms で結果なし", () => {
    const start = Date.parse("2026-10-17T05:00:00Z"); // 14:00 JST
    expect(started(new Map(), start + RESULT_GIVE_UP_AFTER_START_MS).state).toBe("pending");
    expect(started(new Map(), start + RESULT_GIVE_UP_AFTER_START_MS + 1).state).toBe("none");
  });

  it("取り込みの状態が取れない(null)でも、発走時刻が分かれば経過で決まる(5 時間後は結果なし)。発走時刻が不明なら経過で決められないので結果待ち", () => {
    expect(started(null, Date.parse("2026-10-17T05:00:00Z") + 5 * 3_600_000).state).toBe("none");
    expect(started(null, Date.parse("2026-10-17T05:00:00Z") + 60_000).state).toBe("pending");
    expect(started(new Map(), NOW, null).state).toBe("pending");
  });

  it("結果なしは合計に入らず、件数(noneCount)に数える。結果待ちの件数(waitingCount)には入らない", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    addAnalysis(f, 2, R2, [bet(2, "wide", "0102", 300)]);
    const ledger = ledgerOf(f, { importStates: new Map([[R1, "gave_up"], [R2, "queued"]]) });
    expect(race(ledger, R1).state).toBe("none");
    expect(race(ledger, R2).state).toBe("pending");
    expect(ledger.noneCount).toBe(1);
    expect(ledger.waitingCount).toBe(1);
    expect(ledger.total.raceCount).toBe(0);
  });

  it("未発走のレースの結果待ちは waitingCount に入らない(発走済みのものだけ数える)", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    const before = ledgerOf(f, { nowMs: Date.parse("2026-10-17T04:59:00Z") }); // 発走 1 分前
    expect(race(before, R1).state).toBe("pending");
    expect(before.waitingCount).toBe(0);
    const after = ledgerOf(f, { nowMs: Date.parse("2026-10-17T05:00:00Z") }); // 発走の瞬間
    expect(after.waitingCount).toBe(1);
  });
});

describe("集計対象外(検証画面と同じ除外)と提案なし", () => {
  it("発走後の分析(遮断の印なし・計画の発走時刻より後)は集計対象外(lookahead-suspect)。結果があっても合計に入らない", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)], { historyCutoffDate: null, promptLookaheadGuarded: null, analyzedAt: "2026-10-17T05:10:00.000Z" });
    addResult(f, R1);
    const ledger = ledgerOf(f);
    expect(race(ledger, R1)).toMatchObject({ state: "excluded", reason: "lookahead-suspect" });
    expect(ledger.total.raceCount).toBe(0);
  });

  it("D1 の start_time が NULL(未確認)のときは計画の発走時刻で判定する: 発走前の分析なら集計に入る(clean)", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)], { historyCutoffDate: null, promptLookaheadGuarded: null, analyzedAt: "2026-10-17T04:30:00.000Z" });
    addResult(f, R1);
    expect(race(ledgerOf(f), R1).state).toBe("settled");
  });

  it("発走時刻がどこにも無い(D1 が NULL・計画にも無い)分析は集計対象外(lookahead-unknown)。検証画面の判定不能と同じ", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)], { historyCutoffDate: null, promptLookaheadGuarded: null });
    addResult(f, R1);
    expect(race(ledgerOf(f, { plan: null }), R1)).toMatchObject({ state: "excluded", reason: "lookahead-unknown" });
  });

  it("D1 の start_time が確認済み('HH:MM')なら、それを使う(計画の時刻と違っても D1 の値)", () => {
    const f = emptyFixture();
    // D1 は 16:00(07:00Z)。分析は 06:00Z=計画(14:00)より後・D1(16:00)より前 → D1 を使えば clean。
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)], { historyCutoffDate: null, promptLookaheadGuarded: null, analyzedAt: "2026-10-17T06:00:00.000Z", startTime: "16:00" });
    addResult(f, R1);
    expect(race(ledgerOf(f), R1).state).toBe("settled");
  });

  it("印が '' (詳細に発走時刻が無い)・'?' (確認できなかった)は計画の時刻で上書きしない(検証画面の補完後と同じ判定にする)", () => {
    for (const startTime of ["", "?"]) {
      const f = emptyFixture();
      addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)], { historyCutoffDate: null, promptLookaheadGuarded: null, analyzedAt: "2026-10-17T04:30:00.000Z", startTime });
      addResult(f, R1);
      // 検証画面と同じ判定(行をそのまま渡した core の判定)と一致する
      const verifyIncluded = computeVerifyReport(buildVerifySource(toRows(f)), PRODUCTION_VERIFY_CONFIG, "all").includedAnalysisCount;
      expect(verifyIncluded, `startTime=${JSON.stringify(startTime)}`).toBe(0); // 前提: 検証画面は集計に入れない
      expect(race(ledgerOf(f), R1).state, `startTime=${JSON.stringify(startTime)}`).toBe("excluded");
    }
  });

  it("推定 EV の分析は集計対象外(estimated)", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)], { evEstimated: 1 });
    addResult(f, R1);
    expect(race(ledgerOf(f), R1)).toMatchObject({ state: "excluded", reason: "estimated" });
  });

  it("最新の選択は先読みを除いた clean の最新: 発走後の再分析(suspect)が最新でも、発走前の分析が採られる(一覧の最新とは違う)", () => {
    const f = emptyFixture();
    const unguarded = { historyCutoffDate: null, promptLookaheadGuarded: null };
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)], { ...unguarded, analyzedAt: "2026-10-17T04:30:00.000Z" }); // 発走前
    addAnalysis(f, 2, R1, [bet(2, "wide", "0103", 700)], { ...unguarded, analyzedAt: "2026-10-17T05:30:00.000Z" }); // 発走後(より新しい)
    addResult(f, R1);
    const r = race(ledgerOf(f), R1);
    expect(r).toMatchObject({ state: "settled", stake: 300, payout: 4500 });
    const verify = computeVerifyReport(buildVerifySource(withStartTime(toRows(f), "14:00")), PRODUCTION_VERIFY_CONFIG, "all").proposedBet.overall;
    expect(verify.totalStake).toBe(300); // 検証画面も古い方を採る
  });

  it("配分が見送り(skipReasonCode あり)・配分メタ無し・買い目なしの分析は「提案なし」で、合計にも件数にも入らない", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [], {}, { route: "mixed", skipReasonCode: "no-positive-ev" });
    addAnalysis(f, 2, R2, []); // 配分は計算したが買い目が 0 点
    f.analyses.push(analysisRow(3, R3)); // 配分メタの行が無い(旧い分析)
    for (const raceId of [R1, R2, R3]) addResult(f, raceId);
    const ledger = ledgerOf(f);
    for (const raceId of [R1, R2, R3]) expect(race(ledger, raceId).state, raceId).toBe("no_proposal");
    expect(ledger.total.raceCount).toBe(0);
    expect(ledger.waitingCount).toBe(0);
  });

  it("買い目のあるレースの結果が無くても、買い目が無いレースは「結果待ち」にならない(提案なし)", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, []);
    expect(race(ledgerOf(f), R1).state).toBe("no_proposal");
    expect(ledgerOf(f).waitingCount).toBe(0);
  });
});

describe("入力の取り扱い", () => {
  it("分析が 1 件も無い日: レースの結果は空・合計は 0 件", () => {
    const ledger = ledgerOf(emptyFixture());
    expect(ledger.races.size).toBe(0);
    expect(ledger.total).toEqual({ raceCount: 0, stake: 0, payout: 0, recoveryRate: null });
  });

  it("別の開催日の分析が混ざっていても、渡された行だけを集計する(日の絞りは読み出しの側)。レースの結果のキーは race_id", () => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    addResult(f, R1);
    expect([...ledgerOf(f).races.keys()]).toEqual([R1]);
  });
});

describe("収支を読むかどうか(shouldReadLedger。発走前の取得で読み取りを増やさない)", () => {
  const r1Start = Date.parse("2026-10-17T05:00:00Z"); // R1 の 14:00 JST
  const decide = (nowMs: number, planRows: { raceId: string; startTime: string | null }[] | null): boolean => shouldReadLedger({ kaisaiDate: DATE, nowMs, plan: planRows });

  it("計画の全レースが未来なら読まない。最初のレースの発走の瞬間から読む(1ms 前は読まない)", () => {
    expect(decide(r1Start - 1, plan())).toBe(false);
    expect(decide(r1Start, plan())).toBe(true);
    expect(decide(r1Start + 3_600_000, plan())).toBe(true);
  });

  it("計画が取れなかった(null)・計画が空(その日の計画の行が無い)ときは読む(発走済みかどうか分からない。分析のある日にだけ呼ばれる)", () => {
    expect(decide(r1Start - 3_600_000, null)).toBe(true);
    expect(decide(r1Start - 3_600_000, [])).toBe(true);
  });

  it("発走時刻の無い(または壊れた)行が 1 つでもあれば読む(その行が発走済みか分からない)", () => {
    expect(decide(r1Start - 3_600_000, [{ raceId: R1, startTime: null }])).toBe(true);
    expect(decide(r1Start - 3_600_000, [{ raceId: R1, startTime: "25:99" }])).toBe(true);
    expect(decide(r1Start - 3_600_000, [{ raceId: R1, startTime: "14:00" }])).toBe(false); // 対照: 時刻があって未来なら読まない
  });
});

/**
 * 日単位の DO の RPC(`getTargetsLedger`)の中身(`getTargetsLedgerWire`。Issue #361)。収支の計算は Worker Free の CPU 10ms に収まらないおそれがある(最悪の日に 72 レースが一度に確定する)ので、
 * Worker ではなく日単位の DO で行い、Worker は結果を応答に載せるだけにする。DO の RPC は structured clone を通るので、結果は素の配列・数値にして渡す(`ledgerToWire`・`ledgerFromWire`)。
 */
describe("日単位の DO の RPC の中身(getTargetsLedgerWire)", () => {
  const baseFixture = (): Fixture => {
    const f = emptyFixture();
    addAnalysis(f, 1, R1, [bet(1, "wide", "0102", 300)]);
    addResult(f, R1);
    addAnalysis(f, 2, R2, [bet(2, "wide", "0102", 200)]); // 結果待ち
    return f;
  };
  const deps = (f: Fixture, calls: string[] = [], states: { raceId: string; state: string }[] = []) => ({
    plan: () => {
      calls.push("plan");
      return plan();
    },
    importProgress: () => {
      calls.push("importProgress");
      return states;
    },
    readRows: async (date: string) => {
      calls.push(`readRows:${date}`);
      return toRows(f);
    },
  });

  it("発走後: 計画・取り込み状態・D1 の行から、buildTargetsLedger と同じ値を素のデータで返す(行の配列・合計・件数)", async () => {
    const f = baseFixture();
    const wire = await getTargetsLedgerWire(deps(f), { kaisaiDate: DATE, nowMs: NOW });
    expect(wire).not.toBeNull();
    const direct = buildTargetsLedger({ kaisaiDate: DATE, nowMs: NOW, rows: toRows(f), plan: plan(), importStates: new Map() });
    expect(wire).toEqual(ledgerToWire(direct));
    // 前提: 値が自明でない(確定と結果待ちの両方がある・Map ではなく配列)
    expect(wire!.races.map((r) => [r.raceId, r.state])).toEqual([[R1, "settled"], [R2, "pending"]]);
    expect(Array.isArray(wire!.races)).toBe(true);
    expect(wire!.total.stake).toBe(300);
    expect(wire!.waitingCount).toBe(1);
  });

  it("取り込みの状態が反映される(gave_up → 結果なし)", async () => {
    const wire = await getTargetsLedgerWire(deps(baseFixture(), [], [{ raceId: R2, state: "gave_up" }]), { kaisaiDate: DATE, nowMs: NOW });
    expect(wire!.races.find((r) => r.raceId === R2)!.state).toBe("none");
    expect(wire!.noneCount).toBe(1);
  });

  it("まだどのレースも発走していない: null を返し、D1 を読まない(読み取りを増やさない)", async () => {
    const calls: string[] = [];
    const wire = await getTargetsLedgerWire(deps(baseFixture(), calls), { kaisaiDate: DATE, nowMs: Date.parse("2026-10-17T04:00:00Z") });
    expect(wire).toBeNull();
    expect(calls).toEqual(["plan"]); // 前提: 計画は見た(空振りでない)。D1 の読みも取り込み状態の読みも流していない
  });

  it("読む日付を D1 の読み取りに渡す。読み取りの失敗は握らず投げる(呼び出し側が収支なしにする)", async () => {
    const calls: string[] = [];
    await getTargetsLedgerWire(deps(baseFixture(), calls), { kaisaiDate: DATE, nowMs: NOW });
    expect(calls).toContain(`readRows:${DATE}`);
    await expect(getTargetsLedgerWire({ ...deps(baseFixture()), readRows: async () => { throw new Error("D1_ERROR: injected"); } }, { kaisaiDate: DATE, nowMs: NOW })).rejects.toThrow("injected");
  });

  it("ledgerFromWire(ledgerToWire(x)) は元の台帳と同じ(行の Map・合計・件数)。配列の順は入力の順", () => {
    const f = baseFixture();
    const ledger = buildTargetsLedger({ kaisaiDate: DATE, nowMs: NOW, rows: toRows(f), plan: plan(), importStates: new Map() });
    const back = ledgerFromWire(ledgerToWire(ledger));
    expect(back.races).toEqual(ledger.races);
    expect(back.total).toEqual(ledger.total);
    expect([back.waitingCount, back.noneCount]).toEqual([ledger.waitingCount, ledger.noneCount]);
    expect(back.races.size).toBe(2); // 前提: 行がある
  });
});
