import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HttpError,
  parseRaceId,
  type RaceData,
  type RaceListEntry,
} from "../../packages/core/src/index.js";
import { FetchHaltedError, HaltOnConsecutiveBlockFetcher } from "../probability-quality-41/guarded-fetcher.js";
import { measureRace } from "../probability-quality-41/measure.js";
import type { RaceObservation } from "../probability-quality-41/observation.js";
import { runMeasurement, type RunManifest } from "../probability-quality-41/run.js";

/**
 * 取得の停止(HTTP 400 の連続)と、観測の保存の結合テスト。
 * **実物のガード(`HaltOnConsecutiveBlockFetcher`)・`measureRace`・`runMeasurement` を通す**
 * (ダミーのガードでは「停止の引き金になった呼び出しが除外として保存される」欠陥を再現できなかった。
 * 計画 §3.3: 停止は除外にしない。§3.3 追記: 取得の失敗と未知の着順文言は保存せず、再実行で取り直す)。
 * ネットワークには出ない(内側のフェッチャを URL ごとの台本で置き換える)。
 */

const FIXTURE_RACE: RaceData = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../docs/investigations/combo-odds-real-fetch/central-on.json", import.meta.url)),
    "utf-8",
  ),
) as RaceData;
const FIXTURE_RESULT_HTML = readFileSync(
  fileURLToPath(new URL("../../fixtures/result_202603020211.html", import.meta.url)),
  "utf-8",
);

const RACE_IDS = ["202606030801", "202606030802", "202606030803"] as const;

function listEntry(raceId: string, n: number): RaceListEntry {
  return {
    raceId: parseRaceId(raceId),
    name: `R${n}`,
    courseType: "芝",
    distance: 1800,
    entryCount: 16,
    raceNumber: n,
  };
}

/** URL の種別(list / result / shutuba / odds)ごとに、呼び出し回数に応じた応答の台本を持つ内側のフェッチャ。 */
type Step = "ok" | 400 | 403;
function innerFetcher(script: Partial<Record<"list" | "result" | "shutuba" | "horse" | "odds", Step[]>>) {
  const counters: Record<string, number> = {};
  const calls: string[] = [];
  return {
    calls,
    async fetchText(url: string): Promise<string> {
      const kind = url.split(":")[0]!;
      calls.push(url);
      const i = counters[kind] ?? 0;
      counters[kind] = i + 1;
      const steps = script[kind as keyof typeof script] ?? [];
      const step = steps[i] ?? steps[steps.length - 1] ?? "ok";
      if (step === "ok") {
        return "html";
      }
      throw new HttpError(`status ${step}`, { url, status: step });
    },
  };
}

interface Run {
  readonly manifest: RunManifest;
  readonly saved: RaceObservation[];
  readonly measuredRaceIds: string[];
  readonly guard: HaltOnConsecutiveBlockFetcher;
}

/** 実物のガード・measureRace・runMeasurement を組み合わせて1日分を流す。 */
async function runDay(
  script: Parameters<typeof innerFetcher>[0],
  opts: { store?: Map<string, RaceObservation>; dates?: string[]; raceCount?: number; horseCount?: number } = {},
): Promise<Run> {
  const inner = innerFetcher(script);
  const guard = new HaltOnConsecutiveBlockFetcher(inner);
  const store = opts.store ?? new Map<string, RaceObservation>();
  const saved: RaceObservation[] = [];
  const measuredRaceIds: string[] = [];
  let manifest: RunManifest | undefined;
  const dates = opts.dates ?? ["20260926"];
  await runMeasurement(
    {
      fetchCentralList: async (d) => {
        await guard.fetchText(`list:${d}`);
        return RACE_IDS.slice(0, opts.raceCount ?? RACE_IDS.length).map((id, i) =>
          listEntry(id.slice(0, 8) + d.slice(6, 8) + String(i + 1).padStart(2, "0"), i + 1),
        );
      },
      fetchNarList: async () => [],
      measure: (target) => {
        measuredRaceIds.push(target.entry.raceId);
        return measureRace(target, {
          fetchResultHtml: async (raceId) => {
            await guard.fetchText(`result:${raceId}`);
            return FIXTURE_RESULT_HTML;
          },
          // fetch.ts と同じ形: 出馬表 → 馬ごとの戦績 → オッズの順に取り、停止していたら途中のデータで
          // 観測を作らない。馬ごとの戦績の失敗は、実物の scrapeRace と同じく握りつぶして次へ進む。
          scrape: async (raceId) => {
            await guard.fetchText(`shutuba:${raceId}`);
            for (let i = 0; i < (opts.horseCount ?? 2); i++) {
              try {
                await guard.fetchText(`horse:${raceId}:${i}`);
              } catch {
                // scrapeRace は戦績の例外を警告に落として継続する。
              }
            }
            await guard.fetchText(`odds:${raceId}`);
            if (guard.tripped) {
              throw new FetchHaltedError("取得の途中で停止した");
            }
            return FIXTURE_RACE;
          },
          now: () => new Date("2026-10-01T00:00:00.000Z"),
        });
      },
      store: {
        exists: (id) => store.has(id),
        write: (obs) => {
          saved.push(obs);
          store.set(obs.raceId, obs);
        },
      },
      guard,
      writeManifest: (m) => {
        manifest = m;
      },
      gitCommit: "abc123",
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    },
    { central: dates, nar: [] },
  );
  return { manifest: manifest!, saved, measuredRaceIds, guard };
}

describe("停止の引き金になった呼び出しは、除外として保存しない(§3.3)", () => {
  const triggers: ReadonlyArray<{
    readonly name: string;
    readonly script: Parameters<typeof innerFetcher>[0];
    readonly horseCount?: number;
    readonly measured: number;
    readonly statuses: readonly string[];
    readonly lastReason?: string;
  }> = [
    {
      name: "結果ページが常に 400(1本目=連続1回目の失敗・2本目=引き金)",
      script: { result: [400] },
      measured: 2,
      statuses: ["not-saved", "not-saved"],
      lastReason: "halted-in-flight",
    },
    {
      name: "結果ページが常に 403(ブロックの兆候)",
      script: { result: [403] },
      measured: 2,
      statuses: ["not-saved", "not-saved"],
      lastReason: "halted-in-flight",
    },
    {
      // 結果ページは各レースの先頭で取るため、出馬表(の直前の成功)は連続を戻す。出馬表そのものは
      // 引き金になれず、1本目の出馬表の 400 が連続1回目となり、2本目の結果ページが引き金になる。
      name: "出馬表の 400(1本目)に続いて、次のレースの結果ページが 400(引き金)",
      script: { shutuba: [400], result: ["ok", 400] },
      measured: 2,
      statuses: ["not-saved", "not-saved"],
      lastReason: "halted-in-flight",
    },
    {
      // 馬ごとの戦績の失敗は scrapeRace が握りつぶす。同一レース内で2回続くと止まり、続くオッズの取得は
      // ネットワークを叩かず FetchHaltedError になる(除外の記録を作らず、そのまま停止として伝わる)。
      name: "馬ごとの戦績が常に 400(握りつぶされる失敗が1レース内で連続2回)",
      script: { horse: [400] },
      measured: 1,
      statuses: [],
    },
    {
      // 戦績の1回目の失敗(握りつぶし)の直後にオッズが 400 で、連続2回の引き金をオッズが引く。
      name: "オッズが引き金(直前の戦績の 400 に続いて 400)",
      script: { horse: [400], odds: [400] },
      horseCount: 1,
      measured: 1,
      statuses: ["not-saved"],
      lastReason: "halted-in-flight",
    },
  ];
  it.each(triggers)("$name: 引き金の呼び出しは保存されず、後続のレースへ進まず、halted=true", async (c) => {
    const r = await runDay(c.script, { horseCount: c.horseCount });
    expect(r.saved).toEqual([]);
    expect(r.measuredRaceIds).toHaveLength(c.measured);
    expect(r.manifest.halted).toBe(true);
    expect(r.guard.tripped).toBe(true);
    expect(r.manifest.processed.map((p) => p.status)).toEqual(c.statuses);
    if (c.lastReason !== undefined) {
      expect(r.manifest.processed[r.manifest.processed.length - 1]!.reason).toBe(c.lastReason);
    }
  });

  it("停止の手前の連続1回目の失敗も保存されない(一時的な失敗が保存済みとして固定されない)", async () => {
    const r = await runDay({ result: [400] });
    expect(r.manifest.processed[0]).toMatchObject({ status: "not-saved", reason: "result-fetch-error" });
    expect(r.saved.map((o) => o.raceId)).not.toContain(r.measuredRaceIds[0]);
  });
});

describe("一時的な失敗は保存せず、再実行で取り直される(§3.3 追記)", () => {
  it("400 が1回だけ(連続にならない)のレースは保存されず、再実行で取り直して保存される", async () => {
    const store = new Map<string, RaceObservation>();
    // 1回目: 1本目の結果ページだけ 400(次は成功)。
    const first = await runDay({ result: [400, "ok"] }, { store });
    expect(first.manifest.halted).toBe(false);
    expect(first.manifest.processed[0]).toMatchObject({ status: "not-saved", reason: "result-fetch-error" });
    expect(first.saved).toHaveLength(2); // 2・3本目は保存済み
    const firstId = first.measuredRaceIds[0]!;
    expect(store.has(firstId)).toBe(false);
    // 2回目: 同じストアで再実行 → 保存済みは飛ばし、保存されなかった1本目だけを取り直す。
    const second = await runDay({}, { store });
    expect(second.measuredRaceIds).toEqual([firstId]);
    expect(second.manifest.skippedExisting).toHaveLength(2);
    expect(store.get(firstId)!.status).toBe("ok");
  });

  it("出馬表・オッズの取得失敗(scrape-error)も保存しない", async () => {
    const r = await runDay({ shutuba: [400, "ok"] });
    expect(r.manifest.processed[0]).toMatchObject({ status: "not-saved", reason: "scrape-error" });
    expect(r.saved).toHaveLength(2);
  });
});

describe("一覧の取得で停止の引き金を引いた場合", () => {
  it("例外で落とさず、halted=true のマニフェストを書いて終わる(1日目の結果ページが400→2日目の一覧が400で連続2回)", async () => {
    // 1日目の一覧 ok → 1本だけ測る(結果ページ 400・連続1・保存しない)→ 2日目の一覧 400(連続2回で停止。
    // 引き金の呼び出しは元の HttpError を投げるが、ガードが tripped なので停止として扱う)。
    const r = await runDay(
      { result: [400], list: ["ok", 400] },
      { dates: ["20260926", "20260927"], raceCount: 1 },
    );
    expect(r.manifest.halted).toBe(true);
    expect(r.guard.tripped).toBe(true);
    expect(r.manifest.days).toHaveLength(1); // 2日目は解決できていない
    expect(r.saved).toEqual([]);
  });
});

describe("実行の記録に git の commit hash を残す(再現性)", () => {
  it("マニフェストに gitCommit が入る", async () => {
    const r = await runDay({});
    expect(r.manifest.gitCommit).toBe("abc123");
  });
});
