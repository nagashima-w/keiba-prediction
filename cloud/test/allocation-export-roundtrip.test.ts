import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { AllocationExportCore } from "../src/allocation-export-core";
import { D1AllocationExportStore, type AllocationExportBucket } from "../src/allocation-export-store";
import { ALLOCATION_COMBO_KINDS, type AllocationRaceRow } from "../src/allocation-export-format";
import { D1ResultStore } from "../src/result-repository";
import { runCloudAnalysis, type CloudAnalysisDeps } from "../src/pipeline";
import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types.js";
import type { RaceData } from "../../packages/core/src/scraper/scrape-race";
import { compareReplay, parseAllocationDataset, replayRace, type ReplayOutcome } from "../../scripts/allocation-dataset";
import { openLocalBindings, type LocalBindings } from "./local-bindings";
import { ALL_BETS_SETTINGS, KAISAI_DATE, RACE_ID, scrapeFixtureRace } from "./pipeline-fixtures";

/**
 * Issue #463 の中心の検査(往復): 本番の分析(`runAnalysis`)が保存した提案を、**書き出したファイルの 1 行だけから**、本番の配分の関数で計算し直すと一致すること。
 * 道筋は本物を使う: runAnalysis → D1AnalysisStore(本物のスキーマ・R2 の詳細)→ AllocationExportCore(本物のストア・形式・gzip)→ ローダ(gunzip・検証)→ replayRace(recomputeAllocationFromProbs)。
 * 偽物は、DO の kv と時計、R2 への流し込みの `FixedLengthStream`(Node に無いので長さを検査する代役)だけ。
 * ★限界: 一致を確かめたのは、このフィクスチャ(中央 16 頭・全 6 券種の組合せオッズ)と下の設定の組だけ。本番のデータでの一致率は、ダウンロードしたファイルをローダで数えて初めて分かる。
 */
let local: LocalBindings;

beforeAll(async () => {
  local = await openLocalBindings();
}, 180_000);
afterAll(async () => {
  await local?.dispose();
});
beforeEach(async () => {
  await local.reset();
  await local.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'analyses'").run();
});

const NOW = new Date("2026-10-10T12:00:00.000Z");

class FakeKv {
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

function fixedLength(length: number) {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > length) throw new Error("宣言より多い");
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== length) throw new Error("宣言と違う");
    },
  });
}

/** 分析を 1 件実行して本物の D1・R2 に保存し、結果と払戻も入れる。保存した分析の id と、保存したレコードを返す。 */
async function analyzeAndSave(
  settings: Record<string, unknown>,
  tweak: (race: RaceData) => RaceData = (r) => r,
): Promise<{ id: number; record: AnalysisRecord }> {
  const { race } = await scrapeFixtureRace();
  const store = new D1AnalysisStore({ db: local.db, bucket: local.r2, now: () => NOW });
  let saved: { id: number; record: AnalysisRecord } | undefined;
  const deps: CloudAnalysisDeps = {
    scrape: async () => tweak(race),
    analyze: null,
    saveAnalysis: async (record) => {
      const result = await store.saveAnalysis(record);
      saved = { id: result.id, record };
      return result;
    },
    allocationSettings: settings as unknown as CloudAnalysisDeps["allocationSettings"],
    llmSkipReason: "テスト: LLM なし",
    now: () => new Date("2026-06-28T00:00:00.000Z"),
  };
  await runCloudAnalysis(RACE_ID, KAISAI_DATE, deps);
  const horses = race.horses.map((h) => h.shutuba.umaban).sort((a, b) => a - b);
  await new D1ResultStore({ db: local.db }).saveResult(
    RACE_ID,
    horses.map((umaban, i) => ({ umaban, finishPosition: i + 1, placePayout: i < 3 ? 150 + i * 10 : null, winPayout: i === 0 ? 420 : null, winOdds: 4.2 + i, ninki: i + 1, scratched: false, wakuban: Math.ceil(umaban / 2) })),
    "芝",
  );
  return { id: saved!.id, record: saved!.record };
}

/** 本物のジョブを最後まで回して、書き出されたファイルをローダで読む。 */
async function exportAndLoad(): Promise<{ rows: AllocationRaceRow[]; bytes: Uint8Array }> {
  const kv = new FakeKv();
  let put: Uint8Array | null = null;
  const bucket = {
    get: (key: string) => local.r2.get(key),
    async put(_key: string, value: ReadableStream) {
      put = new Uint8Array(await new Response(value).arrayBuffer());
    },
  } as unknown as AllocationExportBucket;
  const clock = { now: NOW.getTime() };
  const alarms: number[] = [];
  const core = new AllocationExportCore({
    kv, now: () => clock.now, setAlarm: (at) => { alarms.push(at); }, getAlarm: async () => null,
    store: new D1AllocationExportStore({ db: local.db, bucket, now: () => NOW, fixedLengthStream: fixedLength }), onWarn: () => {},
  });
  await core.request("download");
  for (let tick = 0; tick < 50 && kv.get("job") !== undefined; tick += 1) {
    await core.runTick();
  }
  expect(kv.get("job")).toBeUndefined();
  expect(put).not.toBeNull();
  const bytes = put as unknown as Uint8Array;
  return { rows: parseAllocationDataset(bytes).rows, bytes };
}

function replayed(row: AllocationRaceRow): Extract<ReplayOutcome, { kind: "replayed" }> {
  const outcome = replayRace(row);
  expect(outcome.kind).toBe("replayed");
  return outcome as Extract<ReplayOutcome, { kind: "replayed" }>;
}

describe("往復: 書き出した 1 行から計算し直すと、分析時に保存した提案に一致する", () => {
  it("全券種 ON(組合せオッズ込み): 前提(多点・複数券種・組合せの買い目)を固定したうえで、買い目の券種・キー・金額・オッズ・EV と配分のコードが完全に一致する", async () => {
    const { id, record } = await analyzeAndSave(ALL_BETS_SETTINGS);
    // 前提(空振り防止): 保存された提案が、多点で、券種が 3 つ以上、組合せの券種を含む
    const bets = record.allocation!.bets;
    expect(bets.length).toBeGreaterThan(5);
    const types = new Set(bets.map((b) => b.betType));
    expect(types.size).toBeGreaterThanOrEqual(3);
    expect([...types].some((t) => t !== "place" && t !== "win")).toBe(true);
    expect(record.allocation!.meta.route).toBe("mixed");

    const { rows } = await exportAndLoad();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.analysis_id).toBe(id);
    expect(row.has_odds).toBe(true);
    expect(Object.keys(row.combos).sort()).toEqual([...ALLOCATION_COMBO_KINDS].sort());
    expect(row.allocation!.bets).toHaveLength(bets.length);
    const outcome = replayed(row);
    const cmp = compareReplay(row, outcome);
    expect(cmp.differences).toEqual([]);
    expect(cmp.same).toBe(true);
    // 計算し直した提案も、前提と同じ多点(計算し直しの側が空になって一致、という空振りでない)
    expect(outcome.result.allocation.bets).toHaveLength(bets.length);
    expect(outcome.result.allocation.bets.map((b) => b.stake)).toEqual(bets.map((b) => b.stake));
  });

  it("入力が効いている(差分): 書き出した行の組合せオッズを券種ごとに 3 倍にして計算し直すと、その券種を変えるだけで提案が分析時と食い違う(6 券種すべて)", async () => {
    await analyzeAndSave(ALL_BETS_SETTINGS);
    const row = (await exportAndLoad()).rows[0]!;
    for (const kind of ALLOCATION_COMBO_KINDS) {
      const odds = row.combos[kind]!;
      expect(Object.keys(odds).length, `${kind} のオッズが入っている`).toBeGreaterThan(0);
      const changed: AllocationRaceRow = { ...row, combos: { ...row.combos, [kind]: Object.fromEntries(Object.entries(odds).map(([k, v]) => [k, v === null ? null : v * 3])) } };
      // 分析時に保存した提案(row)と、その券種だけ変えた入力で計算し直した提案を比べる
      expect(compareReplay(row, replayed(changed)).same, `${kind} を 3 倍にすると提案が変わる`).toBe(false);
    }
  });

  it("入力が効いている(差分): 確率・単勝・複勝・枠番・設定のどれを変えても、提案が食い違う(取り違え・落としを検出できる)", async () => {
    await analyzeAndSave(ALL_BETS_SETTINGS);
    const row = (await exportAndLoad()).rows[0]!;
    const differs = (changed: AllocationRaceRow): boolean => !compareReplay(row, replayed(changed)).same;
    // 全頭の補正後の確率を 0.8 倍
    expect(differs({ ...row, horses: row.horses.map((h) => ({ ...h, adjusted_prob: h.adjusted_prob * 0.8 })) })).toBe(true);
    // 複勝の下限を 2 倍
    expect(differs({ ...row, horses: row.horses.map((h) => ({ ...h, place_min: h.place_min === null ? null : h.place_min * 2 })) })).toBe(true);
    // 単勝オッズを 3 倍
    expect(differs({ ...row, horses: row.horses.map((h) => ({ ...h, win_odds: h.win_odds === null ? null : h.win_odds * 3 })) })).toBe(true);
    // 枠番を全頭 1 枠に(枠連の的中確率が変わる)。枠連の買い目が前提で出ている
    expect(row.allocation!.bets.some((b) => b.bet_type === "bracketQuinella")).toBe(true);
    expect(differs({ ...row, horses: row.horses.map((h) => ({ ...h, wakuban: 1 })) })).toBe(true);
    // 設定: ケリー係数・EV 閾値・1 レースの上限
    const withSettings = (patch: Partial<NonNullable<AllocationRaceRow["allocation"]>["settings"]>): AllocationRaceRow => ({
      ...row,
      allocation: { ...row.allocation!, settings: { ...row.allocation!.settings, ...patch } },
    });
    expect(differs(withSettings({ kelly_fraction: 0.1 }))).toBe(true);
    expect(differs(withSettings({ ev_threshold: 1.5 }))).toBe(true);
    expect(differs(withSettings({ per_race_cap: 5000 }))).toBe(true);
    // 券種の ON/OFF(三連単を OFF にすると、三連単の買い目が消える)
    expect(row.allocation!.bets.some((b) => b.bet_type === "trifecta")).toBe(true);
    expect(differs(withSettings({ include_trifecta: false }))).toBe(true);
  });

  it("複勝のみの経路(組合せ券種がすべて OFF): 一致する", async () => {
    const { record } = await analyzeAndSave({
      ...ALL_BETS_SETTINGS,
      includeComboOdds: false,
      includeWideInAllocation: false,
      includeTrioInAllocation: false,
      includeQuinellaInAllocation: false,
      includeExactaInAllocation: false,
      includeTrifectaInAllocation: false,
      includeBracketQuinellaInAllocation: false,
    });
    expect(record.allocation!.meta.route).toBe("place-only");
    expect(record.allocation!.bets.length).toBeGreaterThan(0);
    const row = (await exportAndLoad()).rows[0]!;
    expect(compareReplay(row, replayed(row)).differences).toEqual([]);
  });

  it("的中確率の下限(minHitProb)がある設定: 下限で外れた買い目が出る前提で、一致する", async () => {
    const { record } = await analyzeAndSave({ ...ALL_BETS_SETTINGS, minHitProb: 0.03 });
    expect(record.allocation!.meta.belowFloorCount ?? 0).toBeGreaterThan(0);
    const row = (await exportAndLoad()).rows[0]!;
    expect(row.allocation!.settings.min_hit_prob).toBe(0.03);
    expect(row.allocation!.codes.below_floor_count).toBe(record.allocation!.meta.belowFloorCount);
    expect(compareReplay(row, replayed(row)).differences).toEqual([]);
    // 下限を外して計算し直すと、提案が変わる(下限が入力として効いている)
    const noFloor: AllocationRaceRow = { ...row, allocation: { ...row.allocation!, settings: { ...row.allocation!.settings, min_hit_prob: 0 } } };
    expect(compareReplay(row, replayed(noFloor)).same).toBe(false);
  });

  it("発売前(yoso。推定 EV): 単勝からの推定で EV を作り、配分は出ない経路(コードも一致)", async () => {
    const { record, id } = await analyzeAndSave(ALL_BETS_SETTINGS, (race) => ({ ...race, odds: { ...race.odds, oddsStatus: "yoso", place: {} } }));
    expect(record.allocation!.meta.route).toBe("yoso");
    // 推定 EV の分析は母集団から除かれる(検証画面と同じ)ので、書き出しの対象にするために印を外す(往復の検査のための操作)
    await local.db.prepare("UPDATE analyses SET ev_estimated = 0 WHERE id = ?").bind(id).run();
    const row = (await exportAndLoad()).rows[0]!;
    expect(row.allocation!.odds_status).toBe("yoso");
    expect(compareReplay(row, replayed(row)).differences).toEqual([]);
    expect(replayed(row).result.evEstimated).toBe(true);
  });

  it("総資金が未設定(0): 配分は出ない経路(unset)で、一致する", async () => {
    const { record } = await analyzeAndSave({ ...ALL_BETS_SETTINGS, bankroll: 0 });
    expect(record.allocation!.meta.route).toBe("unset");
    const row = (await exportAndLoad()).rows[0]!;
    expect(compareReplay(row, replayed(row)).differences).toEqual([]);
  });

  it("推定 EV の分析は母集団から除かれる(検証画面と同じ)。結果のない分析も除かれる", async () => {
    const { id } = await analyzeAndSave(ALL_BETS_SETTINGS);
    await local.db.prepare("UPDATE analyses SET ev_estimated = 1 WHERE id = ?").bind(id).run();
    expect((await exportAndLoad()).rows).toEqual([]);
    await local.db.prepare("UPDATE analyses SET ev_estimated = 0 WHERE id = ?").bind(id).run();
    await local.db.prepare("DELETE FROM race_results").run();
    expect((await exportAndLoad()).rows).toEqual([]);
  });
});

describe("ファイルの中身(本物の D1・R2・形式を通した結果)", () => {
  it("馬名・騎手名・調教師名・レース名・LLM の応答に当たる文字列がファイルのどこにも無い", async () => {
    const { race } = await scrapeFixtureRace();
    const names = [race.race.raceName, ...race.horses.flatMap((h) => [h.shutuba.name, h.shutuba.jockeyName, h.shutuba.trainerName])].filter((n): n is string => typeof n === "string" && n.length >= 2);
    expect(names.length).toBeGreaterThan(10);
    await analyzeAndSave(ALL_BETS_SETTINGS);
    const { bytes } = await exportAndLoad();
    const { gunzipSync } = await import("node:zlib");
    const text = new TextDecoder().decode(gunzipSync(bytes));
    for (const name of new Set(names)) {
      expect(text, `ファイルに「${name}」が無い`).not.toContain(name);
    }
  });

  it("結果と払戻: 着順・払戻・取消・枠番と、組合せ払戻・取込印が行に入る(D1 に入れた値のまま)", async () => {
    await analyzeAndSave(ALL_BETS_SETTINGS);
    await local.db.prepare("INSERT INTO race_combo_payouts (race_id, bet_type, combo_key, payout) VALUES (?, 'exacta', '0102', 1230), (?, 'wide', '0102', 220)").bind(RACE_ID, RACE_ID).run();
    await local.db.prepare("INSERT INTO race_combo_payout_imports (race_id, bet_type) VALUES (?, 'exacta'), (?, 'wide'), (?, 'trifecta')").bind(RACE_ID, RACE_ID, RACE_ID).run();
    const row = (await exportAndLoad()).rows[0]!;
    expect(row.result.horses).toHaveLength(16);
    expect(row.result.horses[0]).toMatchObject({ umaban: 1, finish_position: 1, place_payout: 150, win_payout: 420, scratched: false, wakuban: 1, win_odds: 4.2, ninki: 1 });
    expect(row.result.combo_payouts).toEqual({ exacta: [["0102", 1230]], wide: [["0102", 220]] });
    expect(row.result.payout_imports).toEqual(["exacta", "trifecta", "wide"]);
  });
});
