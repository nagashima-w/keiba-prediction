import { toSnapshotColumns, type CandidateRow } from "../src/prior-export-format";
import { toAllocationSnapshot } from "../src/allocation-export-format";
import type { DetailOutcome, PriorLookups, RaceDataBatch } from "../src/prior-export-core";
import type { AllocationDetailOutcome, AllocationRaceDataBatch } from "../src/allocation-export-core";

/**
 * Issue #495: 2 つの書き出し(統計モデル用・配分用)の共通部品(`export-job-core.ts`)のテストが共有する偽物。
 * D1・R2・時計・アラームは偽物で、`cloudflare:workers` なしで Node で動く。**入力は決定的**(乱数・現在時刻を使わない)。
 * 仕上げの put は `putFileStream` の偽物(`recordPut`)で、流された塊をそのまま記録する。
 */

export const T0 = Date.parse("2026-10-10T03:00:00.000Z"); // JST 12:00
export const BEFORE_START = "2026-10-10T00:00:00.000Z";

export function cand(id: number, raceId: string, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id, raceId, analyzedAt: BEFORE_START, kaisaiDate: "20261010", promptVersion: "v9", detailKey: `analyses/${id}.json.gz`,
    evEstimated: 0, promptLookaheadGuarded: 1, historyCutoffDate: "20261009", startTime: "10:05", ...over,
  };
}

export const raceIdOf = (n: number): string => `20260603${String(n).padStart(2, "0")}01`;

export class FakeKv {
  readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  put(key: string, value: unknown): void {
    this.map.set(key, structuredClone(value));
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
}


export interface PutRecord {
  readonly key: string;
  /** 流された塊(parts)を、取り出した順に並べたもの。 */
  readonly parts: Uint8Array[];
  /** parts をつなげた全体。 */
  readonly bytes: Uint8Array;
  /** 呼び出し側が先に宣言した総バイト数。 */
  readonly totalBytes: number;
  readonly info: { generatedAt: string; rows: number; races: number };
}

/** `putFileStream` の偽物: parts を最後まで取り出して記録する。 */
export function recordPut(puts: PutRecord[]): (key: string, parts: () => Iterable<Uint8Array>, totalBytes: number, info: { generatedAt: string; rows: number; races: number }) => Promise<void> {
  return async (key, parts, totalBytes, info) => {
    const list = [...parts()];
    const bytes = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of list) {
      bytes.set(p, offset);
      offset += p.length;
    }
    puts.push({ key, parts: list, bytes, totalBytes, info });
  };
}

/** 統計モデル用の窓口の偽物。 */
export class PriorFakeStore {
  candidates: CandidateRow[] = [];
  usage = { classA: 0, classB: 0 };
  noDetail = new Set<number>();
  horsesPerRace = 3;
  readonly puts: PutRecord[] = [];
  readonly putFileStream = recordPut(this.puts);
  /** 騎手名 → 騎手 ID の対応(Issue #526 段階 1b)。既定は空(埋めない)。 */
  lookups: PriorLookups = { jockeyIds: [] };

  async readUsage() {
    return this.usage;
  }
  async readCandidates() {
    return { rows: this.candidates, rowsRead: this.candidates.length * 2 };
  }
  async readLookups() {
    return { lookups: this.lookups, rowsRead: 0 };
  }
  async readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<RaceDataBatch> {
    const horses = analysisIds.flatMap((analysisId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({ analysisId, umaban: k + 1, prior: 0.3 - k * 0.05, adjustedProb: 0.3, placeOddsMin: 2 })),
    );
    const results = raceIds.flatMap((raceId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({ raceId, umaban: k + 1, finishPosition: k + 1, winOdds: 3 + k, ninki: k + 1 })),
    );
    return { horses, results, courseTypes: raceIds.map((raceId) => ({ raceId, courseType: "芝" })), rowsRead: horses.length + results.length + raceIds.length };
  }
  async fetchDetails(items: ReadonlyArray<{ id: number; raceId: string; detailKey: string | null }>): Promise<{ outcomes: DetailOutcome[]; gets: number }> {
    return {
      outcomes: items.map((it) =>
        this.noDetail.has(it.id)
          ? { kind: "none" as const }
          : {
              kind: "ok" as const,
              snapshot: toSnapshotColumns(this.rawSnapshot(it.id)),
              contributions: Object.fromEntries(
                Array.from({ length: this.horsesPerRace }, (_, k) => [String(k + 1), [{ biasName: "a", applied: true, reason: "SECRET-REASON", weight: 0.1, correction: 0.01 * (k + 1) }]]),
              ),
            },
      ),
      gets: items.length,
    };
  }
  rawSnapshot(id: number): unknown {
    return {
      race: { raceName: `レース${id}`, grade: "G3", distance: 1600, trackCondition: "良", courseType: "芝", weightType: "別定", filliesOnly: true },
      horses: Array.from({ length: this.horsesPerRace }, (_, k) => ({
        umaban: k + 1, wakuban: k + 1, sex: "牡", age: 3 + k, kinryo: 55, bodyWeight: 480 + k, oikiriRank: "A", oikiriCritic: "動き良化",
        name: "SECRET-NAME", jockeyName: `騎手${k + 1}`, jockeyId: `0100${k + 1}`, trainerName: "SECRET-TRAINER", winOdds: 99.9, popularity: 13, placeOddsMin: 77.7, placeOddsMax: 88.8,
      })),
    };
  }
  async countReads(_gets: number) {}
}

/** 配分用の窓口の偽物。 */
export class AllocationFakeStore {
  candidates: CandidateRow[] = [];
  usage = { classA: 0, classB: 0 };
  noDetail = new Set<number>();
  noMeta = new Set<number>();
  horsesPerRace = 3;
  readonly puts: PutRecord[] = [];
  readonly putFileStream = recordPut(this.puts);

  async readUsage() {
    return this.usage;
  }
  async readCandidates() {
    return { rows: this.candidates, rowsRead: this.candidates.length * 2 };
  }
  async readRaceData(analysisIds: readonly number[], raceIds: readonly string[]): Promise<AllocationRaceDataBatch> {
    const horses = analysisIds.flatMap((analysisId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({ analysisId, umaban: k + 1, prior: 0.3 - k * 0.05, adjustedProb: 0.3, placeOddsMin: 2, ev: 1.1 })),
    );
    const results = raceIds.flatMap((raceId) =>
      Array.from({ length: this.horsesPerRace }, (_, k) => ({
        raceId, umaban: k + 1, finishPosition: k + 1, placePayout: 120, winPayout: 300, scratched: 0, wakuban: k + 1, winOdds: 3 + k, ninki: k + 1,
      })),
    );
    const metas = analysisIds
      .filter((id) => !this.noMeta.has(id))
      .map((analysisId) => ({
        analysisId, route: "mixed", unavailableReason: null, fallbackReason: null, skipReasonCode: null, comboOddsWide: "present", comboOddsTrio: "present",
        bankroll: 10000, perRaceCap: 3000, kellyFraction: 0.25, evThreshold: 1, includeComboOdds: 1, includeWide: 1, includeTrio: 1, includeQuinella: 1,
        includeExacta: 1, includeTrifecta: 1, includeBracketQuinella: 1, betUnit: 100, greedySteps: 1000, candidateCap: 2000, modelId: "plackett-luce",
        modelApproximate: 0, oddsStatus: "result", minHitProb: 0, belowFloorCount: null, missedJson: null,
      }));
    const bets = metas.map((m) => ({ analysisId: m.analysisId, betType: "place", comboKey: "01", stake: 100 + m.analysisId, odds: 2, ev: 1.1 }));
    const payouts = raceIds.map((raceId) => ({ raceId, betType: "wide", comboKey: "0102", payout: 400 + Number(raceId.slice(8, 10)) }));
    const imports = raceIds.map((raceId) => ({ raceId, betType: "wide" }));
    return { horses, results, metas, bets, payouts, imports, rowsRead: horses.length + results.length + metas.length + bets.length + payouts.length + imports.length };
  }
  async fetchDetails(items: ReadonlyArray<{ id: number; raceId: string; detailKey: string | null }>): Promise<{ outcomes: AllocationDetailOutcome[]; gets: number }> {
    return {
      outcomes: items.map((it) => (this.noDetail.has(it.id) ? { kind: "none" as const } : { kind: "ok" as const, snapshot: toAllocationSnapshot(this.rawSnapshot()) })),
      gets: items.length,
    };
  }
  rawSnapshot(): unknown {
    return {
      race: { raceName: "SECRET-RACENAME", courseType: "芝", distance: 1600, grade: "G3" },
      horses: Array.from({ length: this.horsesPerRace }, (_, k) => ({
        umaban: k + 1, wakuban: k + 1, name: "SECRET-NAME", jockeyName: "SECRET-JOCKEY", trainerName: "SECRET-TRAINER", winOdds: 3.5 + k, popularity: k + 1, placeOddsMin: 1.5, placeOddsMax: 2.5,
      })),
      wideCombo: { "0102": 8.5, "0103": null },
    };
  }
  async countReads(_gets: number) {}
}

export interface Clock {
  now: number;
}

/** 共通の駆動: 時計とアラームの偽物。`drain` は、アラームが張られている限り tick を回す。 */
export function driver(): { clock: Clock; alarms: number[]; deps: { now: () => number; setAlarm: (at: number) => void; getAlarm: () => Promise<number | null>; onWarn: () => void }; drain(core: { runTick(): Promise<void> }, max?: number): Promise<number> } {
  const clock: Clock = { now: T0 };
  const alarms: number[] = [];
  return {
    clock, alarms,
    deps: { now: () => clock.now, setAlarm: (at) => { alarms.push(at); }, getAlarm: async () => (alarms.length === 0 ? null : alarms[alarms.length - 1]!), onWarn: () => {} },
    drain: async (core, max = 200) => {
      let ticks = 0;
      while (alarms.length > 0 && ticks < max) {
        clock.now = Math.max(clock.now, alarms.pop()!);
        alarms.length = 0;
        await core.runTick();
        ticks += 1;
      }
      return ticks;
    },
  };
}
