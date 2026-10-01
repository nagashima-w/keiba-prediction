import { describe, expect, it } from "vitest";
import { parseRaceId, type RaceListEntry } from "../../packages/core/src/index.js";
import { FetchHaltedError } from "../probability-quality-41/guarded-fetcher.js";
import {
  assertPlanCommitted,
  assertPathsClean,
  DEFAULT_PLAN,
  MIN_INTERVAL_MS,
  runMeasurement,
  type RunDeps,
} from "../probability-quality-41/run.js";
import {
  OBSERVATION_SCHEMA_VERSION,
  type RaceObservation,
} from "../probability-quality-41/observation.js";
import type { MeasureTarget } from "../probability-quality-41/measure.js";

/**
 * 取得の進行(`measurement-plan.md` §2・§4)の制御を、ネットワークなしで検証する。
 * 一覧・1レースの観測・保存はすべて注入したダミー。
 */

function entry(venue: string, n: number, kind: "c" | "n", mid: string = kind === "c" ? "0305" : "0712"): RaceListEntry {
  return {
    raceId: parseRaceId(`2026${venue}${mid}${String(n).padStart(2, "0")}`),
    name: `R${n}`,
    courseType: "ダ",
    distance: 1200,
    entryCount: 10,
    raceNumber: n,
  };
}

/** 開催日が違えば別の race_id になるよう、mid(回次・日次の4桁)に開催日の月日を使う。 */
const venueRaces = (venue: string, count: number, kind: "c" | "n", mid?: string) =>
  Array.from({ length: count }, (_, i) => entry(venue, i + 1, kind, mid));

function okObs(t: MeasureTarget): RaceObservation {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    status: "excluded",
    raceId: t.entry.raceId,
    region: t.region,
    requestedDate: t.requestedDate,
    kaisaiDate: t.kaisaiDate,
    venueCode: t.entry.raceId.slice(4, 6),
    raceNumber: t.entry.raceNumber,
    raceName: t.entry.name,
    listedEntryCount: t.entry.entryCount,
    reason: "result-not-confirmed",
    detail: "テスト",
    fetchedAt: "2026-10-01T00:00:00.000Z",
  };
}

interface Harness {
  readonly deps: RunDeps;
  readonly measured: string[];
  readonly written: string[];
  readonly listCalls: string[];
  readonly store: Set<string>;
  guard: { tripped: boolean };
  manifests: unknown[];
}

function harness(over: {
  measure?: (t: MeasureTarget) => Promise<RaceObservation>;
  centralLists?: Record<string, RaceListEntry[]>;
  narLists?: Record<string, RaceListEntry[]>;
  existing?: string[];
  tripAfter?: number;
} = {}): Harness {
  const measured: string[] = [];
  const written: string[] = [];
  const listCalls: string[] = [];
  const store = new Set<string>(over.existing ?? []);
  const guard = { tripped: false };
  const h: Harness = {
    measured,
    written,
    listCalls,
    store,
    guard,
    manifests: [],
    deps: {
      fetchCentralList: async (d) => {
        listCalls.push(`central:${d}`);
        return (
          over.centralLists?.[d] ?? [
            ...venueRaces("06", 3, "c", d.slice(4, 8)),
            ...venueRaces("09", 3, "c", d.slice(4, 8)),
          ]
        );
      },
      fetchNarList: async (d) => {
        listCalls.push(`nar:${d}`);
        return (
          over.narLists?.[d] ?? [
            ...venueRaces("35", 12, "n", d.slice(4, 8)),
            ...venueRaces("30", 11, "n", d.slice(4, 8)),
          ]
        );
      },
      measure: async (t) => {
        measured.push(t.entry.raceId);
        if (over.tripAfter !== undefined && measured.length >= over.tripAfter) {
          guard.tripped = true;
        }
        return (over.measure ?? (async (x) => okObs(x)))(t);
      },
      store: {
        exists: (id) => store.has(id),
        write: (obs) => {
          written.push(obs.raceId);
          store.add(obs.raceId);
        },
      },
      guard: {
        get tripped() {
          return guard.tripped;
        },
        requestCount: 0,
        urlsWith400: [],
      },
      writeManifest: (m) => void h.manifests.push(m),
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    },
  };
  return h;
}

describe("DEFAULT_PLAN と取得間隔", () => {
  it("計画の開催日は 中央 2026-09-26・09-27、地方 2026-09-30(取得前に固定した値)", () => {
    expect(DEFAULT_PLAN.central).toEqual(["20260926", "20260927"]);
    expect(DEFAULT_PLAN.nar).toEqual(["20260930"]);
  });

  it("取得間隔は2秒以上", () => {
    expect(MIN_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
  });
});

describe("runMeasurement", () => {
  it("中央2日と地方1日を、選定ルールどおりに(場コード最小の会場の全レースで)観測する", async () => {
    const h = harness();
    const m = await runMeasurement(h.deps, DEFAULT_PLAN);
    // 中央: 各日 場06 の3レース(合成)、地方: 場30 の11レース(合成。場30 < 場35 で、11 ≥ 10 のため会場は足さない)。
    expect(h.measured).toHaveLength(3 + 3 + 11);
    expect(h.measured.filter((id) => id.slice(4, 6) === "09")).toEqual([]);
    expect(h.measured.filter((id) => id.slice(4, 6) === "35")).toEqual([]);
    expect(m.halted).toBe(false);
    expect(m.days.map((d) => [d.region, d.requestedDate, d.usedDate])).toEqual([
      ["central", "20260926", "20260926"],
      ["central", "20260927", "20260927"],
      ["nar", "20260930", "20260930"],
    ]);
    expect(h.written).toHaveLength(17);
  });

  it("観測したレースの結果(成功・除外)を理由つきで記録する", async () => {
    const h = harness();
    const m = await runMeasurement(h.deps, DEFAULT_PLAN);
    expect(m.processed).toHaveLength(17);
    expect(m.processed[0]).toMatchObject({ status: "excluded", reason: "result-not-confirmed" });
  });

  it("保存済みのレースは飛ばす(再実行で同じレースを取り直さない)", async () => {
    const first = harness();
    await runMeasurement(first.deps, DEFAULT_PLAN);
    const alreadyDone = first.measured.slice(0, 4);
    const second = harness({ existing: alreadyDone });
    const m = await runMeasurement(second.deps, DEFAULT_PLAN);
    expect(second.measured).toHaveLength(17 - 4);
    for (const id of alreadyDone) {
      expect(second.measured).not.toContain(id);
    }
    expect(m.skippedExisting).toEqual(alreadyDone);
  });

  it("中央に開催が無い日は1週前へ遡り、使った日をマニフェストに残す", async () => {
    const h = harness({
      centralLists: { "20260926": [], "20260919": [...venueRaces("05", 2, "c")] },
    });
    const m = await runMeasurement(h.deps, DEFAULT_PLAN);
    const day = m.days[0]!;
    expect(day.requestedDate).toBe("20260926");
    expect(day.usedDate).toBe("20260919");
    expect(day.attemptedDates).toEqual(["20260926", "20260919"]);
  });

  it("取得が停止(ガードが tripped)したら、以後のレースを取らずに止め、停止をマニフェストに残す", async () => {
    const h = harness({ tripAfter: 2 });
    const m = await runMeasurement(h.deps, DEFAULT_PLAN);
    expect(h.measured).toHaveLength(2);
    expect(m.halted).toBe(true);
    expect(m.haltReason).toContain("HTTP 400");
    expect(h.manifests).toHaveLength(1); // 停止時もマニフェストを書く
  });

  it("measure が FetchHaltedError を投げたら、除外として記録せずに止める", async () => {
    const h = harness({
      measure: async () => {
        throw new FetchHaltedError("halt");
      },
    });
    const m = await runMeasurement(h.deps, DEFAULT_PLAN);
    expect(m.halted).toBe(true);
    expect(h.written).toEqual([]);
    expect(h.measured).toHaveLength(1);
  });

  it("measure が想定外の例外を投げたら、そのレースだけ記録して続行しない(原因不明のまま進めない)", async () => {
    const h = harness({
      measure: async () => {
        throw new Error("想定外");
      },
    });
    await expect(runMeasurement(h.deps, DEFAULT_PLAN)).rejects.toThrow("想定外");
    expect(h.manifests).toHaveLength(1); // 異常終了でもマニフェストは書く
  });

  it("開催が見つからなければ NoRacesFoundError で止まる", async () => {
    // 要求日と4週前までのどの日も空にする(既定の一覧が返らないよう、全日付で空配列を返す)。
    const empty = new Proxy({}, { get: () => [] }) as Record<string, RaceListEntry[]>;
    const h2 = harness({ centralLists: empty });
    await expect(runMeasurement(h2.deps, DEFAULT_PLAN)).rejects.toThrow(/中央の開催が見つかりません/);
    expect(h2.measured).toEqual([]);
  });
});

describe("assertPlanCommitted: 計画の文書がコミット済みでなければ取得しない", () => {
  const PLAN = "docs/investigations/probability-quality-41/measurement-plan.md";

  it("追跡され、作業ツリーに未コミットの変更がなければ通る", () => {
    const calls: string[][] = [];
    expect(() =>
      assertPlanCommitted((args) => {
        calls.push([...args]);
        return args[0] === "ls-files" ? PLAN : "";
      }, PLAN),
    ).not.toThrow();
    expect(calls.map((c) => c[0])).toEqual(["ls-files", "status"]);
  });

  it("追跡されていない(未コミット)なら失敗する", () => {
    expect(() => assertPlanCommitted(() => "", PLAN)).toThrow(/コミット/);
  });

  it("追跡されていても変更が残っていれば失敗する", () => {
    expect(() =>
      assertPlanCommitted((args) => (args[0] === "ls-files" ? PLAN : ` M ${PLAN}`), PLAN),
    ).toThrow(/変更/);
  });
});

describe("assertPathsClean: 取得に使うコードに未コミットの変更があれば取得しない", () => {
  it("変更が無ければ通る", () => {
    expect(() => assertPathsClean(() => "", ["scripts/probability-quality-41", "packages/core/src"])).not.toThrow();
  });

  it("どれかに変更・未追跡のファイルがあれば、そのパスを示して失敗する", () => {
    const git = (args: readonly string[]) =>
      args.includes("packages/core/src") ? " M packages/core/src/ev/probability-quality.ts" : "";
    expect(() => assertPathsClean(git, ["scripts/probability-quality-41", "packages/core/src"])).toThrow(
      /packages\/core\/src/,
    );
  });

  it("未追跡のファイル(??)も未コミットとして扱う", () => {
    expect(() => assertPathsClean(() => "?? scripts/probability-quality-41/new.ts", ["scripts/probability-quality-41"])).toThrow();
  });
});
