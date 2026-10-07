import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseRaceList } from "../../packages/core/src/scraper/parse-race-list";
import type { RaceListEntry } from "../../packages/core/src/scraper/types";
import { MIN_AUTO_RUN_LEAD_MS, jstKaisaiDate, planPreRaceDue, selectAutoRunTargets } from "../src/auto-run-plan";
import { startTimeEpochMs } from "../src/pre-race-time";

/**
 * Issue #202(#166-A): 定時の自動実行の純関数(JST の開催日・対象の絞り込み・発走前の期限・期限を過ぎたときの判定)。
 * DO・gate・D1 には触れない。入力は、実測のフィクスチャ(`fixtures/`)と、**合成**フィクスチャ(`synthetic_nar_race_list_sub_20260927_jpn3.html`。
 * 20260927 の地方に Jpn3 を1件足したもの。実在の日程ではない)。実 netkeiba には触れない。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string): string => readFileSync(path.join(ROOT, "fixtures", name), "utf-8");
const iso = (ms: number): string => new Date(ms).toISOString();
/** JST の日付・時刻の epoch ms(テスト内の期待値を、実装とは別の式〈Date.UTC − 9時間〉で作る)。 */
const jst = (date: string, time: string): number => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time}:00+09:00`);

describe("jstKaisaiDate(cron の scheduledTime → JST の開催日)", () => {
  it.each([
    ["cron 本番の時刻 UTC 0:00 = JST 9:00 は、同じ日", "2026-10-07T00:00:00.000Z", "20261007"],
    ["UTC 14:59:59.999 = JST 23:59:59.999 は、まだ同じ日(境界の1ミリ秒前)", "2026-10-06T14:59:59.999Z", "20261006"],
    ["UTC 15:00:00.000 = JST 翌日 0:00 は、翌日(境界)", "2026-10-06T15:00:00.000Z", "20261007"],
    ["UTC 23:59 = JST 翌日 8:59 は、翌日(UTC の日付とは違う)", "2026-10-06T23:59:00.000Z", "20261007"],
    ["月またぎ(UTC 2/28 15:00 = JST 3/1 0:00。平年)", "2026-02-28T15:00:00.000Z", "20260301"],
    ["うるう日の前(UTC 2024/2/29 14:59 = JST 2/29 23:59)", "2024-02-29T14:59:00.000Z", "20240229"],
    ["うるう日の後(UTC 2024/2/29 15:00 = JST 3/1 0:00)", "2024-02-29T15:00:00.000Z", "20240301"],
    ["年またぎ(UTC 2025/12/31 15:00 = JST 2026/1/1 0:00)", "2025-12-31T15:00:00.000Z", "20260101"],
  ])("%s", (_name, utc, expected) => {
    expect(jstKaisaiDate(Date.parse(utc))).toBe(expected);
  });

  it("対照: UTC の日付をそのまま使う(9時間ずれる)変異は、UTC 15:00〜23:59 の入力で違う値になる。この日付は UTC の日付と一致しない", () => {
    const utcText = "2026-10-06T23:59:00.000Z";
    const utcDate = utcText.slice(0, 10).replace(/-/g, "");
    expect(utcDate).toBe("20261006");
    expect(jstKaisaiDate(Date.parse(utcText))).not.toBe(utcDate);
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [-1e20], [1e20]])("無効な時刻 %s は RangeError", (value) => {
    expect(() => jstKaisaiDate(value)).toThrow(RangeError);
  });
});

const CENTRAL_0927 = parseRaceList(fixture("race_list_sub_20260927.html"));
const NAR_0927 = parseRaceList(fixture("nar_race_list_sub_20260927.html"));
const NAR_0927_SYNTHETIC = parseRaceList(fixture("synthetic_nar_race_list_sub_20260927_jpn3.html"));
const NAR_0624 = parseRaceList(fixture("nar_race_list_sub_20260624.html"));

describe("selectAutoRunTargets(中央は全件・地方は Jpn1/2/3 だけ)", () => {
  it("前提: フィクスチャの行数(中央 20260927=24・地方 20260927=33・合成=33・地方 20260624=48)", () => {
    expect(CENTRAL_0927).toHaveLength(24);
    expect(NAR_0927).toHaveLength(33);
    expect(NAR_0927_SYNTHETIC).toHaveLength(33);
    expect(NAR_0624).toHaveLength(48);
  });

  it("混在日(合成): 中央 24 件 + 地方の Jpn3 の1件 = 25 件。中央が先・地方が後で、venue の印が付く", () => {
    const targets = selectAutoRunTargets({ central: CENTRAL_0927, nar: NAR_0927_SYNTHETIC });
    expect(targets).toHaveLength(25);
    const central = targets.filter((t) => t.venue === "central");
    const nar = targets.filter((t) => t.venue === "nar");
    expect(central).toHaveLength(24);
    expect(nar).toHaveLength(1);
    expect(nar[0]!.entry.raceId).toBe("202636092710");
    expect(nar[0]!.entry.grade).toBe("Jpn3");
    // 並び: 中央(入力の順のまま)→ 地方
    expect(targets.slice(0, 24).map((t) => t.entry.raceId)).toEqual(CENTRAL_0927.map((e) => e.raceId));
    expect(targets[24]!.venue).toBe("nar");
    // 中央と地方の race_id は衝突しない(同じ1つの DO・同じ開催日に入るため)
    expect(new Set(targets.map((t) => t.entry.raceId)).size).toBe(25);
  });

  it("実測の地方重賞(20260927 水沢 11R=重賞。Jpn ではない)・OP・C1 など Jpn 以外の地方 33 件は、地方からは1件も入らない", () => {
    const withLocalGraded = NAR_0927.find((e) => e.raceId === "202636092711");
    expect(withLocalGraded?.grade).toBe("重賞"); // 前提: 地方の重賞が実在する(対象外であることを、実物で確かめる)
    const targets = selectAutoRunTargets({ central: CENTRAL_0927, nar: NAR_0927 });
    expect(targets).toHaveLength(24);
    expect(targets.every((t) => t.venue === "central")).toBe(true);
  });

  it("実測の Jpn1(20260624 浦和 11R さきたま杯)は、地方 48 件のうちその1件だけが対象", () => {
    const targets = selectAutoRunTargets({ central: [], nar: NAR_0624 });
    expect(targets.map((t) => t.entry.raceId)).toEqual(["202642062411"]);
    expect(targets[0]!.venue).toBe("nar");
  });

  it("中央は grade に関係なく全件(中央の grade が付いている行〈合成〉も除かない)。地方は Jpn1/2/3・ローマ数字のみ、重賞・OP・L・全角数字・未指定は除く", () => {
    const base = CENTRAL_0927[0]!;
    const withGrade = (raceId: string, grade: string | undefined): RaceListEntry => ({ ...base, raceId: raceId as RaceListEntry["raceId"], ...(grade === undefined ? {} : { grade }) });
    const centralEntries = [withGrade("202606040901", "重賞"), withGrade("202606040902", "OP"), withGrade("202606040903", undefined)];
    const narGrades: readonly (readonly [string, string | undefined, boolean])[] = [
      ["202642062401", "Jpn1", true],
      ["202642062402", "Jpn2", true],
      ["202642062403", "Jpn3", true],
      ["202642062404", "JpnⅠ", true],
      ["202642062405", " Jpn1 ", true], // 前後の空白は許容(isJpnGrade の仕様)
      ["202642062406", "重賞", false],
      ["202642062407", "OP", false],
      ["202642062408", "L", false],
      ["202642062409", "Jpn１", false], // 全角数字は不受理
      ["202642062410", "Jpn4", false],
      ["202642062411", undefined, false],
    ];
    const narEntries = narGrades.map(([id, grade]) => withGrade(id, grade));
    const targets = selectAutoRunTargets({ central: centralEntries, nar: narEntries });
    expect(targets.filter((t) => t.venue === "central")).toHaveLength(3);
    expect(targets.filter((t) => t.venue === "nar").map((t) => t.entry.raceId)).toEqual(narGrades.filter(([, , expected]) => expected).map(([id]) => id));
    expect(targets).toHaveLength(3 + 5);
  });

  it("入力の entry をそのまま運ぶ(発走時刻 startTime・レース名・会場名を落とさない)。入力は書き換えない", () => {
    const before = JSON.stringify(CENTRAL_0927);
    const targets = selectAutoRunTargets({ central: CENTRAL_0927, nar: NAR_0927_SYNTHETIC });
    expect(targets[0]!.entry).toBe(CENTRAL_0927[0]);
    expect(targets[24]!.entry.startTime).toBe("16:55");
    expect(targets[24]!.entry.venue).toBe("水沢");
    expect(JSON.stringify(CENTRAL_0927)).toBe(before);
  });

  it("どちらも空なら空(平日で地方 Jpn も無い日)。片方だけ空でも、もう片方は対象になる", () => {
    expect(selectAutoRunTargets({ central: [], nar: [] })).toEqual([]);
    expect(selectAutoRunTargets({ central: CENTRAL_0927, nar: [] })).toHaveLength(24);
    expect(selectAutoRunTargets({ central: [], nar: NAR_0927_SYNTHETIC })).toHaveLength(1);
  });
});

describe("planPreRaceDue(期限 = 発走 − offset 分と、期限を過ぎたときの判定)", () => {
  const DATE = "20260927";
  const START = "15:00";
  const startMs = jst(DATE, START);
  const base = { kaisaiDate: DATE, startTime: START, offsetMinutes: 45 };

  it("MIN_AUTO_RUN_LEAD_MS は 10 分(設定の下限 `PRE_RACE_OFFSET_MIN` と同じ)", () => {
    expect(MIN_AUTO_RUN_LEAD_MS).toBe(10 * 60_000);
  });

  it.each([
    [10, "14:50"],
    [45, "14:15"],
    [180, "12:00"],
  ])("offset=%i 分: 期限は発走(JST 15:00)の %i 分前 = JST %s(UTC 換算も合う)", (offset, jstTime) => {
    const plan = planPreRaceDue({ ...base, offsetMinutes: offset, nowMs: jst(DATE, "09:00") });
    expect(plan.kind).toBe("scheduled");
    if (plan.kind !== "scheduled") return;
    expect(plan.dueMs).toBe(jst(DATE, jstTime));
    expect(plan.startMs).toBe(startMs);
    // 9 時間ずれる変異・符号の逆(発走の後)を殺す: UTC の ISO で期限を固定する
    expect(iso(plan.dueMs)).toBe(`2026-09-27T${String(Number(jstTime.slice(0, 2)) - 9).padStart(2, "0")}:${jstTime.slice(3)}:00.000Z`);
  });

  it("offset が 10 と 180 で期限は 170 分違う(差が 0 でないことを先に固定。設定の offset が期限に効く)", () => {
    const a = planPreRaceDue({ ...base, offsetMinutes: 10, nowMs: jst(DATE, "09:00") });
    const b = planPreRaceDue({ ...base, offsetMinutes: 180, nowMs: jst(DATE, "09:00") });
    expect(a.kind).toBe("scheduled");
    expect(b.kind).toBe("scheduled");
    if (a.kind !== "scheduled" || b.kind !== "scheduled") return;
    expect(a.dueMs - b.dueMs).toBe(170 * 60_000);
  });

  describe("期限を過ぎたとき(境界値の表)", () => {
    const dueMs = startMs - 45 * 60_000;
    const cases: readonly (readonly [string, number, string, string | null])[] = [
      // [名前, 現在時刻, 期待する kind, skip の reason]
      ["期限の 1 時間前(時間が余っている)", dueMs - 3600_000, "scheduled", null],
      ["期限ちょうど(過去ではない)", dueMs, "scheduled", null],
      ["期限の 1ms 後で、発走まで 45 分弱(10 分以上)", dueMs + 1, "immediate", null],
      ["発走の 10 分前ちょうど(最低余裕ちょうど)", startMs - MIN_AUTO_RUN_LEAD_MS, "immediate", null],
      ["発走の 10 分前の 1ms 後(最低余裕に 1ms 足りない)", startMs - MIN_AUTO_RUN_LEAD_MS + 1, "skip", "too-late"],
      ["発走の 1ms 前", startMs - 1, "skip", "too-late"],
      ["発走の瞬間", startMs, "skip", "started"],
      ["発走の 1ms 後", startMs + 1, "skip", "started"],
      ["発走の 3 時間後", startMs + 3 * 3600_000, "skip", "started"],
    ];
    it.each(cases)("%s", (_name, nowMs, kind, reason) => {
      const plan = planPreRaceDue({ ...base, nowMs });
      expect(plan.kind).toBe(kind);
      if (plan.kind === "skip") {
        expect(plan.reason).toBe(reason);
      }
      if (plan.kind === "scheduled" || plan.kind === "immediate") {
        // 期限と発走は、どの kind でも同じ値で返す(呼び出し側が表に書く)
        expect(plan.dueMs).toBe(dueMs);
        expect(plan.startMs).toBe(startMs);
      }
    });

    it("前提: 表の kind が3種類とも出る(1つの kind に偏って全件が自明に通らない)", () => {
      const kinds = new Set(cases.map(([, , kind]) => kind));
      expect([...kinds].sort()).toEqual(["immediate", "scheduled", "skip"]);
      expect(new Set(cases.filter(([, , kind]) => kind === "skip").map(([, , , reason]) => reason))).toEqual(new Set(["too-late", "started"]));
    });
  });

  describe("朝 9:00 JST の計画(実測の中央 20260927。最初の発走は 9:45)", () => {
    const now = jst("20260927", "09:00");
    const plans = (offsetMinutes: number) => CENTRAL_0927.map((e) => planPreRaceDue({ kaisaiDate: "20260927", startTime: e.startTime, offsetMinutes, nowMs: now }));

    it("offset=45: 最初の発走 9:45 の期限が 9:00 ちょうど(= 計画の時刻。過去ではない)なので、24 件すべてが scheduled", () => {
      const result = plans(45);
      expect(result).toHaveLength(24);
      expect(result.every((p) => p.kind === "scheduled")).toBe(true);
      const first = result.reduce((min, p) => (p.kind === "scheduled" && p.dueMs < min ? p.dueMs : min), Number.POSITIVE_INFINITY);
      expect(first).toBe(now); // 前提: 期限の最小が計画の時刻と一致する(境界が実データに現れている)
    });

    it("offset=180: 期限が 9:00 より前になる発走 12:00 より前の 8 件は immediate(発走まで 10 分以上)、残り 16 件は scheduled。skip は 0", () => {
      const result = plans(180);
      expect(result.filter((p) => p.kind === "immediate")).toHaveLength(8);
      expect(result.filter((p) => p.kind === "scheduled")).toHaveLength(16);
      expect(result.filter((p) => p.kind === "skip")).toHaveLength(0);
    });
  });

  it("混在日(合成): 地方 Jpn3(水沢 10R 16:55)の期限は JST 16:10。中央の昼の期限とは別の時刻で、同じ関数・同じ開催日で扱える", () => {
    const nar = selectAutoRunTargets({ central: [], nar: NAR_0927_SYNTHETIC })[0]!;
    const plan = planPreRaceDue({ kaisaiDate: "20260927", startTime: nar.entry.startTime, offsetMinutes: 45, nowMs: jst("20260927", "09:00") });
    expect(plan.kind).toBe("scheduled");
    if (plan.kind !== "scheduled") return;
    expect(plan.dueMs).toBe(jst("20260927", "16:10"));
    const centralDue = CENTRAL_0927.map((e) => startTimeEpochMs("20260927", e.startTime!) - 45 * 60_000);
    expect(centralDue.every((d) => d < plan.dueMs)).toBe(true); // 中央の最終(16:30 発走 → 期限 15:45)より後
  });

  describe("発走時刻が無い・壊れている", () => {
    it.each([[undefined], [""], ["9:00"], ["25:00"], ["12:60"], ["ab:cd"], ["09:00:00"]])("startTime=%j は skip(no-start-time)で、例外にしない(1レースの欠損で計画全体を落とさない)", (startTime) => {
      const plan = planPreRaceDue({ kaisaiDate: "20260927", startTime, offsetMinutes: 45, nowMs: jst("20260927", "09:00") });
      expect(plan).toEqual({ kind: "skip", reason: "no-start-time" });
    });
  });

  describe("入力の契約違反は投げる(呼び出し側のバグ。黙って通さない)", () => {
    it.each([[-1], [1.5], [Number.NaN]])("offsetMinutes=%s は RangeError", (offsetMinutes) => {
      expect(() => planPreRaceDue({ ...base, offsetMinutes, nowMs: jst(DATE, "09:00") })).toThrow(RangeError);
    });
    it.each([["2026-09-27"], ["20260230"], [""]])("開催日 %j は RangeError", (kaisaiDate) => {
      expect(() => planPreRaceDue({ ...base, kaisaiDate, nowMs: jst(DATE, "09:00") })).toThrow(RangeError);
    });
  });
});
