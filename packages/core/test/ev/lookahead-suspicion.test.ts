import { describe, expect, it } from "vitest";
import {
  classifyLookaheadSuspicion,
  type LookaheadSuspicionInput,
} from "../../src/ev/lookahead-suspicion.js";

/**
 * 先読みリーク疑いの分類(Issue #152 A)の純関数テスト。
 *
 * 時刻の基準(JST=UTC+9):
 * - 中央 2026-07-05 15:45 発走 = 2026-07-05T06:45:00Z
 * - 地方 2026-07-14 20:50 発走(ナイター)= 2026-07-14T11:50:00Z
 * - 中央 2026-07-05 の「当日 00:00 JST」= 2026-07-04T15:00:00Z、「翌日 00:00 JST」= 2026-07-05T15:00:00Z
 */

/** 実在形式の中央 raceId(2026年・場コード06・回次03・日次08・11R)。 */
const CENTRAL_RACE_ID = "202606030811";
/** 実在形式の地方 raceId(2026年・場コード44・7月14日・11R)。7〜10桁目が月日。 */
const NAR_RACE_ID = "202644071411";

/** 発走時刻を持つスナップショット。 */
function snapshotWith(startTime: unknown): unknown {
  return { race: { raceName: "テスト", startTime }, horses: [] };
}

/** 遮断マーカーが両方とも無い(=#39・#153より前に保存された)中央の分析を基準にする。 */
function input(overrides: Partial<LookaheadSuspicionInput> = {}): LookaheadSuspicionInput {
  return {
    raceId: CENTRAL_RACE_ID,
    analyzedAt: "2026-07-05T07:00:00.000Z", // 15:45 発走より後
    kaisaiDate: "20260705",
    promptVersion: "v1",
    historyCutoffDate: null,
    promptLookaheadGuarded: null,
    raceSnapshot: snapshotWith("15:45"),
    ...overrides,
  };
}

describe("classifyLookaheadSuspicion(先読みリーク疑いの分類)", () => {
  describe("ステップ1: 遮断済みか(発走の前後にかかわらず clean)", () => {
    // 発走後の分析で、マーカーの組合せだけを変える。期待値が suspect の行は
    // 「ステップ1で clean にならなかった行が、ステップ2で発走後と判定される」ことも兼ねて固定する。
    const cases: ReadonlyArray<{
      name: string;
      overrides: Partial<LookaheadSuspicionInput>;
      expected: "clean" | "suspect";
    }> = [
      {
        name: "history あり・LLM 使用・lookahead=true → clean",
        overrides: { historyCutoffDate: "20260705", promptVersion: "v1", promptLookaheadGuarded: true },
        expected: "clean",
      },
      {
        name: "history あり・LLM 未使用(promptVersion=null)・lookahead=null → clean(プロンプトを使っていない)",
        overrides: { historyCutoffDate: "20260705", promptVersion: null, promptLookaheadGuarded: null },
        expected: "clean",
      },
      {
        name: "history あり・LLM 使用・lookahead=null(v1.14.x の LLM 行)→ suspect",
        overrides: { historyCutoffDate: "20260705", promptVersion: "v1", promptLookaheadGuarded: null },
        expected: "suspect",
      },
      {
        name: "history あり・LLM 使用・lookahead=false(明示的に未遮断)→ suspect(null と区別せず true だけを遮断済みとする)",
        overrides: { historyCutoffDate: "20260705", promptVersion: "v1", promptLookaheadGuarded: false },
        expected: "suspect",
      },
      {
        name: "history あり・LLM 未使用・lookahead=false → clean(LLM 未使用ならプロンプト側の印は見ない)",
        overrides: { historyCutoffDate: "20260705", promptVersion: null, promptLookaheadGuarded: false },
        expected: "clean",
      },
      {
        name: "history なし・LLM 使用・lookahead=true → suspect(戦績が絞られていない)",
        overrides: { historyCutoffDate: null, promptVersion: "v1", promptLookaheadGuarded: true },
        expected: "suspect",
      },
      {
        name: "history なし・LLM 未使用・lookahead=true → suspect(戦績が絞られていない)",
        overrides: { historyCutoffDate: null, promptVersion: null, promptLookaheadGuarded: true },
        expected: "suspect",
      },
      {
        name: "両マーカーとも NULL(旧行)→ suspect",
        overrides: { historyCutoffDate: null, promptVersion: "v1", promptLookaheadGuarded: null },
        expected: "suspect",
      },
    ];

    it.each(cases)("$name", ({ overrides, expected }) => {
      // 前提: 発走(15:45 JST = 06:45Z)より後に分析した行である(ステップ2なら suspect になる行)。
      const base = input(overrides);
      expect(Date.parse(base.analyzedAt)).toBeGreaterThan(Date.parse("2026-07-05T06:45:00.000Z"));
      expect(classifyLookaheadSuspicion(base)).toBe(expected);
    });

    it("遮断済みの行は analyzedAt が読めなくても clean(ステップ1がステップ2より先に決まる)", () => {
      expect(
        classifyLookaheadSuspicion(
          input({
            analyzedAt: "壊れた日時",
            historyCutoffDate: "20260705",
            promptVersion: "v1",
            promptLookaheadGuarded: true,
            kaisaiDate: null,
            raceSnapshot: null,
          }),
        ),
      ).toBe("clean");
    });
  });

  describe("ステップ2: 発走時刻がある場合(JST を UTC に直して ms で比較)", () => {
    it("中央: 発走の1ms前は clean、発走ちょうどは suspect(境界は発走を含めて suspect)", () => {
      expect(classifyLookaheadSuspicion(input({ analyzedAt: "2026-07-05T06:44:59.999Z" }))).toBe("clean");
      expect(classifyLookaheadSuspicion(input({ analyzedAt: "2026-07-05T06:45:00.000Z" }))).toBe("suspect");
      expect(classifyLookaheadSuspicion(input({ analyzedAt: "2026-07-05T06:45:00.001Z" }))).toBe("suspect");
    });

    it("地方ナイター 20:50 JST(=11:50:00Z): 11:49:59Z は clean、11:50:00Z は suspect。開催日は raceId の月日から復元する", () => {
      const nar = (analyzedAt: string): LookaheadSuspicionInput =>
        input({
          raceId: NAR_RACE_ID,
          kaisaiDate: null, // 地方の旧行は開催日が無い。raceId の7〜10桁目(0714)から復元する
          analyzedAt,
          raceSnapshot: snapshotWith("20:50"),
        });
      expect(classifyLookaheadSuspicion(nar("2026-07-14T11:49:59.000Z"))).toBe("clean");
      expect(classifyLookaheadSuspicion(nar("2026-07-14T11:50:00.000Z"))).toBe("suspect");
    });

    it("JST と UTC の日付がずれる時刻でも、UTC 側の日付ではなく JST の発走で比べる(ナイターの前日 UTC)", () => {
      // 2026-07-14 の 00:30 JST 発走 = 2026-07-13T15:30:00Z。UTC の日付は 07-13 で開催日(07-14)と異なる。
      const base = input({
        raceId: NAR_RACE_ID,
        kaisaiDate: "20260714",
        raceSnapshot: snapshotWith("00:30"),
      });
      expect(classifyLookaheadSuspicion({ ...base, analyzedAt: "2026-07-13T15:29:59.000Z" })).toBe("clean");
      expect(classifyLookaheadSuspicion({ ...base, analyzedAt: "2026-07-13T15:30:00.000Z" })).toBe("suspect");
    });

    it("kaisaiDate がある行は raceId の月日より kaisaiDate を優先する(kaisaiDate ?? raceId の順)", () => {
      // raceId は 7/14 を指すが kaisaiDate は 7/15。20:50 JST 発走は 7/15 なら 2026-07-15T11:50:00Z。
      const base = input({
        raceId: NAR_RACE_ID,
        kaisaiDate: "20260715",
        raceSnapshot: snapshotWith("20:50"),
      });
      expect(classifyLookaheadSuspicion({ ...base, analyzedAt: "2026-07-14T12:00:00.000Z" })).toBe("clean");
      expect(classifyLookaheadSuspicion({ ...base, analyzedAt: "2026-07-15T11:50:00.000Z" })).toBe("suspect");
    });

    it("中央で開催日が無い行は、発走時刻があっても日付が決まらないので unknown", () => {
      expect(
        classifyLookaheadSuspicion(
          input({ kaisaiDate: null, analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshotWith("15:45") }),
        ),
      ).toBe("unknown");
    });

    it("kaisaiDate が壊れている行(実在しない日付)は、raceId に頼らず日付不明として unknown", () => {
      expect(
        classifyLookaheadSuspicion(input({ kaisaiDate: "20260230", raceSnapshot: snapshotWith("15:45") })),
      ).toBe("unknown");
    });
  });

  describe("ステップ2: 発走時刻が無い場合(開催日の 00:00 JST を境に判定する)", () => {
    const noTime = (analyzedAt: string, extra: Partial<LookaheadSuspicionInput> = {}): LookaheadSuspicionInput =>
      input({ analyzedAt, raceSnapshot: null, ...extra });

    it("当日 00:00 JST(=前日 15:00Z)より前は clean、ちょうど以降の同日は unknown、翌日 00:00 JST(=当日 15:00Z)以降は suspect", () => {
      expect(classifyLookaheadSuspicion(noTime("2026-07-04T14:59:59.999Z"))).toBe("clean");
      expect(classifyLookaheadSuspicion(noTime("2026-07-04T15:00:00.000Z"))).toBe("unknown");
      expect(classifyLookaheadSuspicion(noTime("2026-07-05T03:00:00.000Z"))).toBe("unknown");
      expect(classifyLookaheadSuspicion(noTime("2026-07-05T14:59:59.999Z"))).toBe("unknown");
      expect(classifyLookaheadSuspicion(noTime("2026-07-05T15:00:00.000Z"))).toBe("suspect");
    });

    it("開催日の前日・翌日は、時刻が無くても clean / suspect に決まる(同日だけが unknown)", () => {
      expect(classifyLookaheadSuspicion(noTime("2026-07-03T00:00:00.000Z"))).toBe("clean");
      expect(classifyLookaheadSuspicion(noTime("2026-07-06T00:00:00.000Z"))).toBe("suspect");
    });

    it("地方で開催日が無い行は raceId の月日から復元し、前日の分析は clean", () => {
      expect(
        classifyLookaheadSuspicion(
          noTime("2026-07-13T10:00:00.000Z", { raceId: NAR_RACE_ID, kaisaiDate: null }),
        ),
      ).toBe("clean");
      expect(
        classifyLookaheadSuspicion(
          noTime("2026-07-15T10:00:00.000Z", { raceId: NAR_RACE_ID, kaisaiDate: null }),
        ),
      ).toBe("suspect");
    });

    it("中央で開催日も発走時刻も無い行は unknown(Task #34 より前の旧行)", () => {
      expect(classifyLookaheadSuspicion(noTime("2026-07-05T07:00:00.000Z", { kaisaiDate: null }))).toBe("unknown");
    });

    // 発走時刻として読めない値はすべて「時刻なし」と同じ扱い(同日の分析なら unknown)にする。
    const invalidSnapshots: ReadonlyArray<{ name: string; snapshot: unknown }> = [
      { name: "スナップショット自体が無い(null)", snapshot: null },
      { name: "race が無い", snapshot: { horses: [] } },
      { name: "startTime が null", snapshot: snapshotWith(null) },
      { name: "startTime が数値", snapshot: snapshotWith(1545) },
      { name: "startTime が時刻の形でない", snapshot: snapshotWith("発走未定") },
      { name: "startTime の時が範囲外(25:00)", snapshot: snapshotWith("25:00") },
      { name: "startTime の分が範囲外(15:60)", snapshot: snapshotWith("15:60") },
      { name: "startTime の前後に余計な文字がある", snapshot: snapshotWith("15:45発走") },
    ];
    it.each(invalidSnapshots)("$name → 時刻なしとして扱い、同日の分析は unknown", ({ snapshot }) => {
      expect(
        classifyLookaheadSuspicion(
          input({ analyzedAt: "2026-07-05T07:00:00.000Z", raceSnapshot: snapshot }),
        ),
      ).toBe("unknown");
    });
  });

  describe("analyzedAt が読めない場合は unknown(NaN の比較で suspect に倒さない)", () => {
    const unreadable: ReadonlyArray<{ name: string; analyzedAt: string }> = [
      { name: "日時でない文字列", analyzedAt: "t" },
      { name: "空文字", analyzedAt: "" },
      { name: "実在しない日時", analyzedAt: "2026-13-45T00:00:00.000Z" },
      // タイムゾーンの無い日時文字列は、実行環境のタイムゾーンで解釈が変わるため読めないものとして扱う。
      { name: "タイムゾーン指定が無い", analyzedAt: "2026-07-05T07:00:00" },
    ];
    it.each(unreadable)("発走時刻あり・$name → unknown", ({ analyzedAt }) => {
      expect(classifyLookaheadSuspicion(input({ analyzedAt }))).toBe("unknown");
    });
    it.each(unreadable)("発走時刻なし・$name → unknown", ({ analyzedAt }) => {
      expect(classifyLookaheadSuspicion(input({ analyzedAt, raceSnapshot: null }))).toBe("unknown");
    });

    it("UTC オフセット付き(+09:00)の日時も読める(15:44:59+09:00 は発走の1秒前)", () => {
      expect(classifyLookaheadSuspicion(input({ analyzedAt: "2026-07-05T15:44:59+09:00" }))).toBe("clean");
      expect(classifyLookaheadSuspicion(input({ analyzedAt: "2026-07-05T15:45:00+09:00" }))).toBe("suspect");
    });
  });
});
