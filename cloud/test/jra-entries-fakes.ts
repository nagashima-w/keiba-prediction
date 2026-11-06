import type { JraEntriesFetcher, JraEntriesSession, JraPageFailure, JraPageResult, JraRaceEntries } from "../src/jra-entries-fetch";
import type { JraEntryHorse, JraVenueLink } from "../src/jra-entries-parse";
import type { JraEntriesFinish, JraEntriesStoreLike, SavedRace } from "../src/jra-entries-repository";

/**
 * Issue #639: JRA の出馬表の取得口・保存先の偽(段の単体のテストと、日単位の DO を通すテストが共有する)。実際の JRA にも D1 にも出ない。
 */

/** 偽の詳細の CNAME: pw01dde + 01 + 場 + 2026 + 回05 + 日目02 + R + 開催日 + 符号。 */
export const fakeCname = (date: string, venue: string, race: number): string => `pw01dde01${venue}20260502${String(race).padStart(2, "0")}${date}/AA`;

/** 偽の JRA の世界: 場 → レース数。レースごとの失敗・馬の数を差し込める。 */
export interface World {
  venues: Record<string, number>;
  failRace: Map<string, JraPageFailure[]>; // cname → 先頭から 1 回ずつ消費する失敗
  failVenueList: JraPageFailure[];
  failRaceList: Map<string, JraPageFailure[]>;
  skippedPerRace: number;
  throwOnOpen: boolean;
}
export const world = (venues: Record<string, number>): World => ({ venues, failRace: new Map(), failVenueList: [], failRaceList: new Map(), skippedPerRace: 0, throwOnOpen: false });

export interface Trace {
  sessions: { calls: string[]; requestCount: () => number }[];
  calls: string[];
}

export function horseOf(i: number): JraEntryHorse {
  return { horseId: String(2020000000 + i), name: `馬${i}`, umaban: i + 1, blinker: i === 0, reductionKg: 0, foreignMark: false, sire: "父", dam: "母", damSire: "母父", owner: "主", breeder: "産" };
}

export function fakeFetcher(w: World): { fetcher: JraEntriesFetcher; trace: Trace } {
  const trace: Trace = { sessions: [], calls: [] };
  const fetcher: JraEntriesFetcher = {
    open(): JraEntriesSession {
      if (w.throwOnOpen) throw new Error("取得口が壊れた https://jra.test.invalid/secret");
      const calls: string[] = [];
      let count = 0;
      trace.sessions.push({ calls, requestCount: () => count });
      const note = (what: string): void => {
        calls.push(what);
        trace.calls.push(what);
        count += 1;
      };
      return {
        get requestCount() {
          return count;
        },
        async listVenues(date): Promise<JraPageResult<readonly JraVenueLink[]>> {
          await Promise.resolve();
          note(`venues:${date}`);
          const f = w.failVenueList.shift();
          if (f !== undefined) return { status: f };
          return { status: "ok", value: Object.keys(w.venues).sort().map((code) => ({ venueCode: code, drlCname: `pw01drl00${code}20260502${date}/BB` })) };
        },
        async listRaces(_drl, date, venue): Promise<JraPageResult<readonly string[]>> {
          await Promise.resolve();
          note(`races:${venue}`);
          const f = w.failRaceList.get(venue)?.shift();
          if (f !== undefined) return { status: f };
          return { status: "ok", value: Array.from({ length: w.venues[venue] ?? 0 }, (_, i) => fakeCname(date, venue, i + 1)) };
        },
        async fetchRace(cname): Promise<JraPageResult<JraRaceEntries>> {
          await Promise.resolve();
          note(`race:${cname}`);
          const f = w.failRace.get(cname)?.shift();
          if (f !== undefined) return { status: f };
          const race = { venueCode: cname.slice(9, 11), year: "2026", kai: "05", day: "02", race: cname.slice(19, 21), date: cname.slice(21, 29), raceId: `2026${cname.slice(9, 11)}0502${cname.slice(19, 21)}` };
          return { status: "ok", value: { race, horses: [horseOf(0), horseOf(1)], skipped: w.skippedPerRace } };
        },
      };
    },
  };
  return { fetcher, trace };
}

export interface FakeStore extends JraEntriesStoreLike {
  claims: { venue: string; attempt: number }[];
  claimed: Set<string>;
  doneVenues: Set<string>;
  saves: { date: string; races: readonly SavedRace[] }[];
  finishes: { venue: string; attempt: number; finish: JraEntriesFinish }[];
  failClaim: number;
  failSave: number;
  failFinish: boolean;
}
export function fakeStore(): FakeStore {
  const s: FakeStore = {
    claims: [],
    claimed: new Set(),
    doneVenues: new Set(),
    saves: [],
    finishes: [],
    failClaim: 0,
    failSave: 0,
    failFinish: false,
    async claim(date, venue, attempt) {
      await Promise.resolve();
      s.claims.push({ venue, attempt });
      if (s.failClaim > 0) {
        s.failClaim -= 1;
        throw new Error("D1 が応答しません https://d1.test.invalid/secret");
      }
      if (s.doneVenues.has(venue)) return "done";
      if (s.claimed.has(`${date}:${venue}:${attempt}`)) return "exists";
      s.claimed.add(`${date}:${venue}:${attempt}`);
      return "claimed";
    },
    async saveRaces(date, races) {
      await Promise.resolve();
      if (s.failSave > 0) {
        s.failSave -= 1;
        throw new Error("D1 の保存に失敗 https://d1.test.invalid/secret");
      }
      s.saves.push({ date, races });
      return { rowsWritten: races.reduce((n, r) => n + r.horses.length * 3, 0) };
    },
    async finish(_date, venue, attempt, finish) {
      await Promise.resolve();
      if (s.failFinish) throw new Error("D1 の記録に失敗 https://d1.test.invalid/secret");
      s.finishes.push({ venue, attempt, finish });
      if (finish.complete) s.doneVenues.add(venue);
    },
  };
  return s;
}
