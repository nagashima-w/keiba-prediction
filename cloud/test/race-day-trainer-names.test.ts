import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { GateResult } from "../src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import type { JockeyNamePair, JockeyNamesStore } from "../src/jockey-names-repository";
import { D1TrainerNamesStore, type TrainerNamePair, type TrainerNamesStore } from "../src/trainer-names-repository";
import { RaceDayCore, type AnalysisSink } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS, type CloudSettings } from "../src/settings";
import { fixtureForUrl } from "./pipeline-fixtures";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #540: 出馬表の調教師名と調教師 ID の組 `trainer_names` の配線(`RaceDayCore` の `trainerNamesStore`)。
 * 発走前の計算ステップで、そのレースの全馬の (調教師名, 調教師 ID) を、中央・地方とも、LLM の有無に関係なく書く。失敗は握る(固定の語の警告。分析は止めない)。
 * 中央のフィクスチャは 202603020211(16 頭・開催日 20260628)、地方は 202654071210(12 頭・開催日 20260712)。**gate は 0 回のまま**(D1 は netkeiba に出ない)。LLM は使わない(キー未登録)。
 */

const CENTRAL = "202603020211";
const CENTRAL_DATE = "20260628";
const NAR = "202654071210";
const NAR_DATE = "20260712";
const SECRET = "sk-ant-SECRET-D1-BODY";
const SETTINGS: CloudSettings = { ...DEFAULT_CLOUD_SETTINGS, bankroll: 1_000_000, perRaceCap: 100_000, kellyFraction: 0.5, includeComboOdds: false };

const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", name), "utf-8");
const bytes = (text: string): ArrayBuffer => {
  const view = new TextEncoder().encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
};
/** 中央は共通のフィクスチャ。地方は出馬表・戦績・単勝複勝のページだけ(組合せ OFF)。 */
function bodyOf(url: string): string {
  if (url.includes("nar.netkeiba.com") || url.includes("type=b1&")) {
    if (url.includes("shutuba.html")) return fixture("nar_shutuba_202654071210.html");
    if (url.includes("ajax_horse_results")) return fixture("horse_results_2021104387.json");
    if (url.includes("type=b1&")) return fixture("nar_odds_b1_202654071210.html");
    throw new Error(`未知のURL(NAR): ${url}`);
  }
  return fixtureForUrl(url);
}
interface FakeGate extends GateLike {
  readonly urls: string[];
}
function fakeGate(): FakeGate {
  const gate: FakeGate = {
    urls: [],
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(bodyOf(url)), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}
function fakeSink(): AnalysisSink & { readonly saved: AnalysisRecord[] } {
  const saved: AnalysisRecord[] = [];
  return {
    saved,
    async save(record) {
      saved.push(record);
      return { id: saved.length, detail: "stored" };
    },
    async findByAnalyzedAt() {
      return null;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id) {
      const rec = saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
}

/** 偽の保存先: 書いた引数を記録する。 */
function fakeStore(options: { fail?: boolean } = {}): TrainerNamesStore & { readonly recorded: { pairs: readonly TrainerNamePair[]; firstSeen: string }[] } {
  const store = {
    recorded: [] as { pairs: readonly TrainerNamePair[]; firstSeen: string }[],
    async record(pairs: readonly TrainerNamePair[], firstSeen: string) {
      store.recorded.push({ pairs, firstSeen });
      if (options.fail === true) {
        throw new Error(`D1_ERROR: no such table trainer_names ${SECRET}`);
      }
    },
  };
  return store;
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});
interface Harness {
  readonly core: RaceDayCore;
  readonly gate: FakeGate;
  readonly sink: ReturnType<typeof fakeSink>;
  readonly warnings: string[];
}
function harness(store: TrainerNamesStore | undefined, jockeyStore?: JockeyNamesStore): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const gate = fakeGate();
  const sink = fakeSink();
  const warnings: string[] = [];
  const core = new RaceDayCore({
    sql,
    now: () => Date.parse("2026-06-28T00:00:00Z"),
    gate,
    setAlarm: () => undefined,
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => SETTINGS,
    ...(store === undefined ? {} : { trainerNamesStore: store }),
    ...(jockeyStore === undefined ? {} : { jockeyNamesStore: jockeyStore }),
  });
  return { core, gate, sink, warnings };
}
async function runPreRace(h: Harness, raceId: string, date: string): Promise<string> {
  await h.core.schedule({ raceId, kaisaiDate: date, mode: "pre_race" });
  for (let i = 0; i < 6; i += 1) {
    const out = await h.core.runNextStep();
    if (out.kind === "ran" && out.mode === "pre_race" && out.step === "compute") {
      return out.result;
    }
  }
  throw new Error("計算ステップに到達しませんでした");
}

describe("発走前の計算ステップ: 調教師名と調教師 ID の組の書き込み(偽の保存先)", () => {
  it("中央: 出馬表の全馬の (調教師名, 調教師 ID) を、開催日とともに 1 回だけ書く。16 頭すべて。略した名前のまま(木村・斎藤誠・松永幹)", async () => {
    const store = fakeStore();
    const h = harness(store);
    expect(await runPreRace(h, CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(store.recorded).toHaveLength(1);
    const { pairs, firstSeen } = store.recorded[0]!;
    expect(firstSeen).toBe(CENTRAL_DATE);
    expect(pairs).toHaveLength(16); // 前提: フィクスチャは 16 頭で、同じ組の重複は無い
    expect(pairs).toContainEqual({ trainerName: "木村", trainerId: "01126" });
    expect(pairs).toContainEqual({ trainerName: "斎藤誠", trainerId: "01086" });
    expect(pairs).toContainEqual({ trainerName: "松永幹", trainerId: "01092" }); // 略した名前のまま(松永幹夫に直さない)
    expect(h.warnings.filter((w) => w.includes("調教師名"))).toEqual([]);
  });

  it("地方: 12 頭のうち 1 人が 2 頭を預かるので、組は 11。フルネーム・英字を含む ID も書く。開催日は地方の開催日", async () => {
    const store = fakeStore();
    const h = harness(store);
    expect(await runPreRace(h, NAR, NAR_DATE)).toBe("ok");
    expect(store.recorded).toHaveLength(1);
    const { pairs, firstSeen } = store.recorded[0]!;
    expect(firstSeen).toBe(NAR_DATE);
    expect(pairs).toHaveLength(11); // 前提: 12 頭で、同じ調教師の組が 1 つ重なる(重複は 1 つにまとめる)
    expect(pairs).toContainEqual({ trainerName: "西山裕貴", trainerId: "a030b" });
    expect(pairs).toContainEqual({ trainerName: "別府真司", trainerId: "05663" }); // 先頭の 0 を保つ
  });

  it("gate は取得ステップの分だけで、計算ステップでは増えない(D1 は netkeiba に出ない)", async () => {
    const store = fakeStore();
    const h = harness(store);
    await h.core.schedule({ raceId: CENTRAL, kaisaiDate: CENTRAL_DATE, mode: "pre_race" });
    await h.core.runNextStep(); // fetch
    const before = h.gate.urls.length;
    await h.core.runNextStep(); // compute
    expect(h.gate.urls.length).toBe(before);
    expect(store.recorded).toHaveLength(1);
  });

  it("書き込みが失敗しても分析は止めない: 保存まで完了し、警告は固定の語(例外の文面・秘密は出さない)", async () => {
    const store = fakeStore({ fail: true });
    const h = harness(store);
    expect(await runPreRace(h, CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(h.sink.saved).toHaveLength(1);
    const warn = h.warnings.filter((w) => w.includes("調教師名と調教師 ID の記録を書けなかった"));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(CENTRAL);
    expect(h.warnings.join("\n")).not.toContain(SECRET);
    expect(h.warnings.join("\n")).not.toContain("no such table");
  });

  it("保存先が無い構成は、何も書かず、警告もない", async () => {
    const h = harness(undefined);
    expect(await runPreRace(h, CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(h.sink.saved).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("調教師名"))).toEqual([]);
  });
});

/** 偽の騎手の保存先: 書いた引数を記録する。 */
function fakeJockeyStore(options: { fail?: boolean } = {}): JockeyNamesStore & { readonly recorded: { pairs: readonly JockeyNamePair[]; firstSeen: string }[] } {
  const store = {
    recorded: [] as { pairs: readonly JockeyNamePair[]; firstSeen: string }[],
    async record(pairs: readonly JockeyNamePair[], firstSeen: string) {
      store.recorded.push({ pairs, firstSeen });
      if (options.fail === true) {
        throw new Error(`D1_ERROR: no such table jockey_names ${SECRET}`);
      }
    },
  };
  return store;
}

describe("調教師の記録と騎手の記録は互いに独立(騎手の記録の挙動は変わらない)", () => {
  it("両方の保存先がある構成: 騎手は従来どおり 16 組(開催日つき)、調教師は 16 組を、それぞれ 1 回だけ書く。警告はない", async () => {
    const trainers = fakeStore();
    const jockeys = fakeJockeyStore();
    const h = harness(trainers, jockeys);
    expect(await runPreRace(h, CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(jockeys.recorded).toHaveLength(1);
    expect(jockeys.recorded[0]!.firstSeen).toBe(CENTRAL_DATE);
    expect(jockeys.recorded[0]!.pairs).toHaveLength(16);
    expect(jockeys.recorded[0]!.pairs).toContainEqual({ jockeyName: "戸崎圭", jockeyId: "05386" }); // 騎手の組は騎手のまま(調教師の組と取り違えない)
    expect(trainers.recorded).toHaveLength(1);
    expect(trainers.recorded[0]!.pairs).toHaveLength(16);
    expect(trainers.recorded[0]!.pairs).not.toContainEqual({ trainerName: "戸崎圭", trainerId: "05386" });
    expect(h.warnings.filter((w) => w.includes("騎手名") || w.includes("調教師名"))).toEqual([]);
  });

  it("調教師の書き込みが失敗しても、騎手は書かれ、分析は保存まで進む。警告は調教師のものだけ(固定の語)", async () => {
    const trainers = fakeStore({ fail: true });
    const jockeys = fakeJockeyStore();
    const h = harness(trainers, jockeys);
    expect(await runPreRace(h, CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(h.sink.saved).toHaveLength(1);
    expect(jockeys.recorded).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("調教師名と調教師 ID の記録を書けなかった"))).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("騎手名と騎手 ID の記録を書けなかった"))).toEqual([]);
    expect(h.warnings.join("\n")).not.toContain(SECRET);
  });

  it("騎手の書き込みが失敗しても、調教師は書かれ、分析は保存まで進む。警告は騎手のものだけ(固定の語)", async () => {
    const trainers = fakeStore();
    const jockeys = fakeJockeyStore({ fail: true });
    const h = harness(trainers, jockeys);
    expect(await runPreRace(h, CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(h.sink.saved).toHaveLength(1);
    expect(trainers.recorded).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("騎手名と騎手 ID の記録を書けなかった"))).toHaveLength(1);
    expect(h.warnings.filter((w) => w.includes("調教師名と調教師 ID の記録を書けなかった"))).toEqual([]);
    expect(h.warnings.join("\n")).not.toContain(SECRET);
  });

  it("調教師の保存先だけが無い構成(騎手だけ): 騎手は従来どおり書かれ、調教師の警告もない", async () => {
    const jockeys = fakeJockeyStore();
    const h = harness(undefined, jockeys);
    expect(await runPreRace(h, CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(jockeys.recorded).toHaveLength(1);
    expect(jockeys.recorded[0]!.pairs).toHaveLength(16);
    expect(h.warnings.filter((w) => w.includes("調教師名"))).toEqual([]);
  });
});

describe("本番の配線(race-day-do.ts)", () => {
  it("本番の RaceDay の DO は、本物の D1TrainerNamesStore(env.DB)を trainerNamesStore に渡している(渡し忘れると、表が空のまま書き出しが何も埋めない)", () => {
    // DO は cloudflare:workers を import するので Node のテストでは作れない。配線の 1 行を、ソースの文字列で固定する(smoke は DO の中の書き込みを直接は見ない)。
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "race-day-do.ts"), "utf-8");
    expect(source).toContain('import { D1TrainerNamesStore } from "./trainer-names-repository";');
    expect(source.match(/trainerNamesStore: new D1TrainerNamesStore\(\{ db: env\.DB \}\)/g) ?? []).toHaveLength(1);
    // 騎手の配線は従来のまま 1 つ(調教師の追加で消えない・増えない)。
    expect(source).toContain('import { D1JockeyNamesStore } from "./jockey-names-repository";');
    expect(source.match(/jockeyNamesStore: new D1JockeyNamesStore\(\{ db: env\.DB \}\)/g) ?? []).toHaveLength(1);
  });
});

describe("統合(本物の D1TrainerNamesStore。ローカルの workerd の D1)", () => {
  let local: LocalBindings;
  beforeAll(async () => {
    local = await openLocalBindings();
  }, 180_000);
  afterAll(async () => {
    await local?.dispose();
  });
  beforeEach(async () => {
    await local.reset();
  });

  it("中央 16 組と地方 11 組が D1 に入る。同じレースをもう一度分析しても行は増えない。first_seen は最初の開催日のまま", async () => {
    const store = new D1TrainerNamesStore({ db: local.db });
    // DO は開催日ごとに別なので、日ごとに別の RaceDayCore(同じ保存先)で分析する。
    expect(await runPreRace(harness(store), CENTRAL, CENTRAL_DATE)).toBe("ok");
    expect(await runPreRace(harness(store), NAR, NAR_DATE)).toBe("ok");
    const rows = (await local.db.prepare("SELECT trainer_name, trainer_id, first_seen FROM trainer_names ORDER BY trainer_name, trainer_id").all()).results;
    expect(rows).toHaveLength(27); // 16 + 11
    expect(rows).toContainEqual({ trainer_name: "木村", trainer_id: "01126", first_seen: CENTRAL_DATE });
    expect(rows).toContainEqual({ trainer_name: "西山裕貴", trainer_id: "a030b", first_seen: NAR_DATE });
    expect(await runPreRace(harness(store), CENTRAL, CENTRAL_DATE)).toBe("ok"); // 同じレースの再分析
    expect((await local.db.prepare("SELECT COUNT(*) AS n FROM trainer_names").first<{ n: number }>())!.n).toBe(27);
    // 別の日の同じ組(first_seen が後の日)を書いても、行は増えず、最初の日が残る。
    await store.record([{ trainerName: "木村", trainerId: "01126" }], "20260705");
    const after = (await local.db.prepare("SELECT trainer_name, trainer_id, first_seen FROM trainer_names ORDER BY trainer_name, trainer_id").all()).results;
    expect(after).toEqual(rows);
  });
});
