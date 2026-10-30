import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { createAnalysisSink } from "../src/analysis-sink";
import { D1BabaStore } from "../src/baba-repository";
import { D1HorseRunsStore } from "../src/horse-runs-repository";
import { D1JockeyNamesStore } from "../src/jockey-names-repository";
import { D1JockeyResultsStore } from "../src/jockey-results-repository";
import { D1KaisaiDaysStore } from "../src/kaisai-days-repository";
import { D1RaceConditionsStore } from "../src/race-conditions-repository";
import { D1ResultStore } from "../src/result-repository";
import { D1TrainerResultsStore } from "../src/trainer-results-repository";
import { RaceDayCore } from "../src/race-day-core";
import { loadSettings } from "../src/settings-repository";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql } from "./node-sql";
const FIXED_MODEL = "claude-sonnet-5-5";

const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name), "utf-8");
const bytes = (text: string): ArrayBuffer => { const v = new TextEncoder().encode(text); const c = new Uint8Array(v.length); c.set(v); return c.buffer; };
function bodyOf(url: string): string {
  if (url.includes("nar.netkeiba.com") || url.includes("type=b1&")) {
    if (url.includes("shutuba.html")) return fixture("nar_shutuba_202654071210.html");
    if (url.includes("ajax_horse_results")) return fixture("horse_results_2021104387.json");
    if (url.includes("type=b1&")) return fixture("nar_odds_b1_202654071210.html");
    throw new Error(`未知のURL(NAR): ${url}`);
  }
  return fixtureForUrl(url);
}

let log: string[] = [];
let counting = false;
const tick = (what: string): void => { if (counting) log.push(what); };
function wrapDb(db: D1Database): D1Database {
  const stmt = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(s, {
      get(t, p) {
        const v = (t as never)[p] as unknown;
        if (p === "bind") return (...a: unknown[]) => stmt((t.bind as (...x: unknown[]) => D1PreparedStatement)(...a), sql);
        if (p === "run" || p === "all" || p === "first" || p === "raw") return (...a: unknown[]) => { tick(`D1 ${String(p)}: ${sql.slice(0, 70).replace(/\s+/g, " ")}`); return (v as (...x: unknown[]) => unknown).apply(t, a); };
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
  return new Proxy(db, {
    get(t, p) {
      const v = (t as never)[p] as unknown;
      if (p === "prepare") return (sql: string) => stmt(t.prepare(sql), sql);
      if (p === "batch") return (xs: unknown[]) => { tick(`D1 batch(${xs.length})`); return (t.batch as (x: unknown[]) => unknown)(xs); };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
}
function wrapR2(r2: R2Bucket): R2Bucket {
  return new Proxy(r2, {
    get(t, p) {
      const v = (t as never)[p] as unknown;
      if (typeof v === "function") return (...a: unknown[]) => { tick(`R2 ${String(p)}`); return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return v;
    },
  });
}

describe("probe", () => {
  let local: LocalBindings;
  beforeAll(async () => { local = await openLocalBindings(); }, 180_000);
  afterAll(async () => { await local?.dispose(); });
  for (const [label, raceId, date] of [["中央16頭", "202603020211", "20260628"], ["地方12頭", "202654071210", "20260712"]] as const) {
    it(label, async () => {
      await local.reset();
      const db = wrapDb(local.db);
      const sql = openNodeSql();
      const urls: string[] = [];
      const warns: string[] = [];
      const horsesJson = Array.from({ length: 16 }, (_, i) => ({ number: i + 1, place_prob: 0.5, reason: `根拠${i + 1}`, mark: i === 0 ? "◎" : null }));
      const llm = {
        sender: async () => { tick("LLM messages.create"); return { content: [{ type: "text", text: JSON.stringify({ horses: horsesJson }) }], stop_reason: "end_turn", model: FIXED_MODEL }; },
        lister: async () => { tick("LLM models.list"); return [{ id: FIXED_MODEL, created_at: "2026-01-01T00:00:00Z" }]; },
      };
      const core = new RaceDayCore({
        llm,
        sql, now: () => Date.parse("2026-06-28T00:00:00Z"), setAlarm: () => undefined, onWarn: (m) => warns.push(m),
        gate: { async fetchRaw(url: string) { urls.push(url); if (counting) tick(`GATE ${url.slice(0, 50)}`); return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(bodyOf(url)), queuedMs: 0, elapsedMs: 1 }; } } as never,
        sink: createAnalysisSink(new D1AnalysisStore({ db: db as never, bucket: wrapR2(local.r2) as never })),
        resultStore: new D1ResultStore({ db: db as never }),
        jockeyStore: new D1JockeyResultsStore({ db: db as never }),
        trainerStore: new D1TrainerResultsStore({ db: db as never }),
        horseRunsStore: new D1HorseRunsStore({ db: db as never }),
        raceConditionsStore: new D1RaceConditionsStore({ db: db as never }),
        babaReader: new D1BabaStore({ db: db as never }),
        kaisaiDaysStore: new D1KaisaiDaysStore({ db: db as never }),
        jockeyNamesStore: new D1JockeyNamesStore({ db: db as never }),
        loadSettings: async () => { tick("D1 loadSettings"); return { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5, includeComboOdds: raceId.startsWith("2026030") } as never; },
      } as never);
      await core.schedule({ raceId, kaisaiDate: date, mode: "pre_race" });
      counting = true;
      log = [];
      const f = await core.runNextStep();
      const fetchLog = log; log = [];
      const c = await core.runNextStep();
      const computeLog = log; counting = false;
      writeFileSync("/tmp/claude-0/-home-user-keiba-prediction/bcf386ad-c0b3-52f4-8ff6-ff1d594cccd3/scratchpad/probe-" + raceId + ".txt", `### ${label}: step1=${JSON.stringify(f)}\nfetch: ${fetchLog.length}\n${fetchLog.join("\n")}\n### step2=${JSON.stringify(c)}\ncompute: ${computeLog.length}\n${computeLog.join("\n")}\nwarns=${warns.join("|")}`);
      expect(true).toBe(true);
    }, 120_000);
  }
});
