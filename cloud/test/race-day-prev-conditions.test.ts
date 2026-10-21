import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import { parseHorseResults } from "../../packages/core/src/scraper/parse-horse-results";
import type { GatePostRequest, GateResult } from "../../cloud/src/gate-core";
import type { GateLike } from "../src/gate-fetch";
import { RaceDayCore, type AnalysisSink, type RaceDayDeps } from "../src/race-day-core";
import { DEFAULT_CLOUD_SETTINGS } from "../src/settings";
import { fixtureForUrl, loadFixture } from "./pipeline-fixtures";
import { openNodeSql, type NodeSql } from "./node-sql";

/**
 * Issue #421 段階 1-b: 日単位の DO の 4 経路(朝の取得・朝の計算・発走前の取得・発走前の計算)が、前走の条件(新聞形式 API)を
 * 取得ステップで 1 本だけ POST して取得キャッシュに載せ、計算ステップがキャッシュだけからスナップショット(`horses[].prevRace`)に載せる。AC:
 *  w1 取得ステップで POST がちょうど 1 本(AplNewsPaper・race_id・cacheKey 経由のキャッシュ)で、計算ステップは gate を呼ばない / 6 時間以内の別モードの取得はキャッシュに当たる(再 POST しない)
 *  w2 計算ステップがキャッシュ無し(取得ステップの POST が失敗)のとき、分析は完走し、画面に残る警告の文面に取得先の URL が出ない(朝・発走前の両方)
 *  w3 読めない応答はキャッシュから消す(次の取得で取り直せる)。通信の失敗は何も消さない
 *  w4 前走の条件の失敗で取得ステップは失敗にも再試行にもならない
 * ゲート・保存先は偽。ストレージは `node:sqlite`。実ネットワークには出ない。
 */

const DATE = "20260628";
const RACE = "202603020211";
const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  const view = encoder.encode(text);
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

/**
 * このレース(202603020211)の各馬の戦績フィクスチャ(`pipeline-fixtures.ts` の馬ごとの割り当て)の全走の raceIdRaw を行にした、新聞形式 API の応答。
 * どの馬の前走(絞った後の先頭)も表に当たる(値は走ごとに変える)。
 */
function newspaperResponseForFixtureRace(): { readonly body: string; readonly raceIds: readonly string[] } {
  const raceIds: string[] = [];
  for (const name of ["horse_results_2021105857.json", "horse_results_2023103386.json", "horse_results_2021105727.json", "horse_results_2024104976.json"]) {
    for (const run of parseHorseResults(loadFixture(name))) {
      if (run.raceIdRaw !== null && !raceIds.includes(run.raceIdRaw)) raceIds.push(run.raceIdRaw);
    }
  }
  const rows = raceIds.map((id, i) => ({
    race_id: [id, id, ""],
    kigou: ["X", i % 2 === 0 ? "(国際) 牝(指)" : "(混)[指]", ""],
    jyuryo: ["0", ["ハンデ", "別定", "定量", "馬齢"][i % 4], ""],
  }));
  const encoded = deflateSync(Buffer.from(JSON.stringify([{ horse_id: "1", race_result: rows }]), "utf-8")).toString("base64");
  const body = JSON.stringify({ status: "OK", reason: null, data: { [`nkrace_newspaper::${RACE}`]: encoded, [`nkrace_newspaper::${RACE}_last_dt`]: "2026-06-28 00:00:00" } });
  return { body, raceIds };
}

type PostBehavior = { kind: "ok"; body: string } | { kind: "status"; status: number; body: string } | { kind: "refused" };

interface FakeGate extends GateLike {
  readonly urls: string[];
  readonly posts: GatePostRequest[];
  behavior: PostBehavior;
}

function fakeGate(behavior: PostBehavior): FakeGate {
  const gate: FakeGate = {
    urls: [],
    posts: [],
    behavior,
    async fetchRaw(url): Promise<GateResult> {
      gate.urls.push(url);
      await Promise.resolve();
      const text = fixtureForUrl(url);
      return { kind: "response", status: 200, contentType: "text/html; charset=UTF-8", body: bytes(text), queuedMs: 0, elapsedMs: 1 };
    },
    async postRaw(request): Promise<GateResult> {
      gate.posts.push(request);
      await Promise.resolve();
      const b = gate.behavior;
      if (b.kind === "refused") {
        return { kind: "refused", reason: "post-blocked", message: "テスト: POST のブレーカー" };
      }
      const status = b.kind === "ok" ? 200 : b.status;
      return { kind: "response", status, contentType: "application/json", body: bytes(b.body), queuedMs: 0, elapsedMs: 1 };
    },
  };
  return gate;
}

function fakeSink(): AnalysisSink & { readonly saved: AnalysisRecord[] } {
  const sink = {
    saved: [] as AnalysisRecord[],
    async save(record: AnalysisRecord) {
      sink.saved.push(record);
      return { id: sink.saved.length, detail: "stored" as const };
    },
    async findByAnalyzedAt(raceId: string, analyzedAt: string) {
      const index = sink.saved.findIndex((r) => r.raceId === raceId && r.analyzedAt === analyzedAt);
      return index < 0 ? null : index + 1;
    },
    async findRecentByRace() {
      return [];
    },
    async countChildren(id: number) {
      const rec = sink.saved[id - 1]!;
      return { horses: rec.horses.length, bets: rec.allocation?.bets.length ?? 0 };
    },
  };
  return sink;
}

interface Harness {
  readonly core: RaceDayCore;
  readonly gate: FakeGate;
  readonly sql: NodeSql;
  readonly sink: ReturnType<typeof fakeSink>;
  readonly clock: { now: number };
  readonly warnings: string[];
}

const opened: NodeSql[] = [];
afterEach(() => {
  for (const sql of opened.splice(0)) sql.close();
});

function harness(behavior: PostBehavior, overrides: Partial<RaceDayDeps> = {}): Harness {
  const sql = openNodeSql();
  opened.push(sql);
  const clock = { now: Date.parse("2026-06-27T12:00:00Z") };
  const warnings: string[] = [];
  const gate = fakeGate(behavior);
  const sink = fakeSink();
  const core = new RaceDayCore({
    sql,
    now: () => clock.now,
    gate,
    setAlarm: () => undefined,
    onWarn: (message) => warnings.push(message),
    sink,
    loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS, baseScoreWeightJockey: 0, baseScoreWeightTrainer: 0 }),
    ...overrides,
  });
  return { core, gate, sql, sink, clock, warnings };
}

async function fetchStep(h: Harness, mode: "morning" | "pre_race"): Promise<void> {
  await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode });
  expect(await h.core.runNextStep()).toMatchObject({ mode, step: "fetch", result: "ok" });
}
async function computeStep(h: Harness, mode: "morning" | "pre_race"): Promise<void> {
  expect(await h.core.runNextStep()).toMatchObject({ mode, step: "compute", result: "ok" });
}

const newspaperKeys = (h: Harness): string[] =>
  (h.sql.exec("SELECT key FROM fetch_cache WHERE key LIKE ?", "race_api#AplNewsPaper#%").toArray() as { key: string }[]).map((r) => r.key);

const { body: GOOD_BODY, raceIds: FIXTURE_RUN_IDS } = newspaperResponseForFixtureRace();

describe("w1: 取得ステップで POST を 1 本だけ出し、計算ステップはキャッシュだけから読む", () => {
  it("前提: 応答は、フィクスチャの戦績の走を多数覆う(退化していない)", () => {
    expect(FIXTURE_RUN_IDS.length).toBeGreaterThanOrEqual(10);
  });

  for (const mode of ["morning", "pre_race"] as const) {
    it(`${mode}: 取得ステップで AplNewsPaper の POST がちょうど 1 本(race_id・Referer が newspaper.html)で、キャッシュに race_id 付きのキーで残り、計算ステップは gate を 1 回も呼ばない`, async () => {
      const h = harness({ kind: "ok", body: GOOD_BODY });
      await fetchStep(h, mode);
      expect(h.gate.posts).toHaveLength(1);
      expect(h.gate.posts[0]).toEqual({
        url: "https://race.netkeiba.com/race_api/",
        referer: `https://race.netkeiba.com/race/newspaper.html?race_id=${RACE}`,
        origin: "https://race.netkeiba.com",
        body: `input=UTF-8&output=json&class=AplNewsPaper&method=get&compress=1&race_id=${RACE}`,
      });
      expect(newspaperKeys(h)).toEqual([`race_api#AplNewsPaper#${RACE}`]);
      const getsAfterFetch = h.gate.urls.length;
      expect(getsAfterFetch).toBe(19); // 前提: 取得が実際に行われている(出馬表 1・戦績 16・調教 1・オッズ 1。騎手・調教師の重みは 0)

      await computeStep(h, mode);
      expect(h.gate.posts).toHaveLength(1);
      expect(h.gate.urls).toHaveLength(getsAfterFetch);
      expect(h.warnings.filter((w) => w.includes("前走条件"))).toEqual([]);
    });
  }

  it("発走前: 計算ステップの保存レコードのスナップショットに、全馬のキー prevRace が入り、表に当たる馬は表の値と一致する", async () => {
    const h = harness({ kind: "ok", body: GOOD_BODY });
    await fetchStep(h, "pre_race");
    await computeStep(h, "pre_race");
    expect(h.sink.saved).toHaveLength(1);
    const horses = (h.sink.saved[0]!.raceSnapshot as { horses: Array<{ umaban: number; prevRace?: { raceId: string; weightType: string | null; condition: string | null; filliesOnly: boolean | null } | null }> }).horses;
    expect(horses).toHaveLength(16);
    for (const horse of horses) {
      expect("prevRace" in horse).toBe(true);
    }
    const hit = horses.filter((x) => x.prevRace !== null && x.prevRace !== undefined);
    expect(hit.length).toBeGreaterThanOrEqual(8); // 前提: 結合が実際に当たっている(全馬 null の退化ではない)
    for (const horse of hit) {
      const row = horse.prevRace!;
      expect(FIXTURE_RUN_IDS).toContain(row.raceId);
      const index = FIXTURE_RUN_IDS.indexOf(row.raceId);
      expect(row.condition).toBe(index % 2 === 0 ? "(国際)牝(指)" : "(混)[指]");
      expect(row.filliesOnly).toBe(index % 2 === 0);
      expect(row.weightType).toBe(["ハンデ", "別定", "定量", "馬齢"][index % 4]);
    }
  });

  it("取得ステップと計算ステップのあいだで時計が進んでも(6 時間を超えても)、計算ステップはキャッシュを読む(計算ステップの TTL は実質無期限)", async () => {
    const h = harness({ kind: "ok", body: GOOD_BODY });
    await fetchStep(h, "pre_race");
    h.clock.now += 7 * 60 * 60 * 1000;
    await computeStep(h, "pre_race");
    expect(h.gate.posts).toHaveLength(1); // 計算ステップは POST しない
    const horses = (h.sink.saved[0]!.raceSnapshot as { horses: Array<{ prevRace?: unknown }> }).horses;
    expect(horses.filter((x) => x.prevRace !== null && x.prevRace !== undefined).length).toBeGreaterThanOrEqual(8);
    expect(h.warnings.filter((w) => w.includes("前走条件"))).toEqual([]);
  });

  it("朝の取得のあと 6 時間以内の発走前の取得は、キャッシュに当たって再 POST しない。6 時間を超えると取り直す", async () => {
    const h = harness({ kind: "ok", body: GOOD_BODY });
    await fetchStep(h, "morning");
    await computeStep(h, "morning");
    expect(h.gate.posts).toHaveLength(1);

    h.clock.now += 5 * 60 * 60 * 1000;
    await fetchStep(h, "pre_race");
    expect(h.gate.posts).toHaveLength(1);
    await computeStep(h, "pre_race");

    h.clock.now += 7 * 60 * 60 * 1000;
    await fetchStep(h, "pre_race");
    expect(h.gate.posts).toHaveLength(2);
  });
});

describe("w2: 前走条件の警告は画面向けの警告(result.warnings)に出さず、ログ(onWarn)だけに出す。計算ステップでキャッシュに無くても分析は完走し、URL は出ない", () => {
  const failures: Array<[string, PostBehavior]> = [
    ["404 で失敗", { kind: "status", status: 404, body: "not found" }],
    ["ゲートが拒否(POST のブレーカー)", { kind: "refused" }],
  ];
  for (const [name, behavior] of failures) {
    it(`朝の計算(${name}): 朝の prior の result.warnings に前走条件の警告が入らない。ログ(onWarn)には固定の文面が 1 件出て、URL・race_api を含まない`, async () => {
      const h = harness(behavior);
      await fetchStep(h, "morning");
      expect(newspaperKeys(h)).toEqual([]); // 前提: 失敗した応答はキャッシュに無い(計算ステップはキャッシュを引けない)
      const fetchLines = h.warnings.filter((w) => w.includes("前走条件"));
      expect(fetchLines).toHaveLength(1); // 前提: 取得ステップで失敗の警告(ログ)は出ている
      await computeStep(h, "morning");
      const prior = h.core.getMorningPrior(RACE);
      expect(prior).not.toBeNull();
      expect(JSON.stringify(prior!.result.warnings)).not.toMatch(/前走|race_api|https?:|netkeiba\.com|キャッシュに無い取得先です/);
      const computeLines = h.warnings.filter((w) => w.startsWith(`朝の計算(${RACE})`) && w.includes("前走条件"));
      expect(computeLines).toHaveLength(1);
      expect(computeLines[0]).toContain("キャッシュに無いため");
      expect(computeLines[0]).not.toMatch(/https?:|race_api|キャッシュに無い取得先です/);
    });

    it(`発走前の計算(${name}): 分析は完走し、ログ(onWarn)に固定の文面が 1 件出て(取得先の URL・キャッシュ無しの定型句を含まない)、スナップショットの馬に prevRace のキーは無い`, async () => {
      const h = harness(behavior);
      await fetchStep(h, "pre_race");
      await computeStep(h, "pre_race");
      expect(h.sink.saved).toHaveLength(1);
      const record = h.sink.saved[0]!;
      const snapshot = record.raceSnapshot as { horses: Array<Record<string, unknown>> };
      expect(snapshot.horses).toHaveLength(16);
      for (const horse of snapshot.horses) {
        expect("prevRace" in horse).toBe(false);
      }
      expect(JSON.stringify(record)).not.toContain("race_api");
      const computeLines = h.warnings.filter((w) => w.startsWith(`発走前の分析(${RACE})`) && w.includes("前走条件"));
      expect(computeLines).toHaveLength(1);
      expect(computeLines[0]).toContain("キャッシュに無いため");
      expect(computeLines[0]).not.toMatch(/https?:|race_api|キャッシュに無い取得先です/);
    });
  }

  it("他の種別の警告は従来どおり result.warnings に残る(前走条件だけを外す): 騎手・調教師の成績を取る構成(既定の重み)で、取れなかった調教師の警告が朝の prior に残り、前走条件の警告は入らない", async () => {
    const h = harness({ kind: "status", status: 404, body: "not found" }, { loadSettings: async () => ({ ...DEFAULT_CLOUD_SETTINGS }) });
    await fetchStep(h, "morning");
    await computeStep(h, "morning");
    const warnings = h.core.getMorningPrior(RACE)!.result.warnings;
    // 前提: 取得の上限(40 本)で取れなかった調教師の警告が、計算ステップの警告として実際にある(空振りでない)
    expect(warnings.filter((w) => w.includes("調教師")).length).toBeGreaterThanOrEqual(1);
    expect(warnings.filter((w) => w.includes("前走"))).toEqual([]);
    expect(h.warnings.filter((w) => w.startsWith(`朝の計算(${RACE})`) && w.includes("前走条件"))).toHaveLength(1);
  });
});

describe("w3: 読めない応答はキャッシュから消し、通信の失敗では何も消さない", () => {
  for (const mode of ["morning", "pre_race"] as const) {
    it(`対照(${mode}): 読める応答ならキャッシュに残る`, async () => {
      const h = harness({ kind: "ok", body: GOOD_BODY });
      await fetchStep(h, mode);
      expect(newspaperKeys(h)).toHaveLength(1);
    });
  }

  // 朝の取得(runFetch)と発走前の取得(runPreRaceFetch)は、それぞれ別の箇所で壊れた応答のキャッシュを消す(`dropBrokenNewspaperCache`)。両方を固定する(Issue #433)。
  for (const mode of ["morning", "pre_race"] as const) {
    for (const [name, body] of [
      ["JSON でない", "<html>壊れた</html>"],
      ["status が NG", JSON.stringify({ status: "NG", reason: "x", data: [] })],
    ] as const) {
      it(`${mode}: 読めない応答(${name}): 取得ステップは ok のまま、そのキャッシュの行が消える。次の取得ステップは(6 時間以内でも)取り直す`, async () => {
        const h = harness({ kind: "ok", body });
        await fetchStep(h, mode);
        expect(h.gate.posts).toHaveLength(1);
        expect(newspaperKeys(h)).toEqual([]);
        expect(h.warnings.some((w) => w.includes("前走条件"))).toBe(true);

        h.gate.behavior = { kind: "ok", body: GOOD_BODY };
        await computeStep(h, mode);
        h.clock.now += 60_000;
        await fetchStep(h, mode);
        expect(h.gate.posts).toHaveLength(2);
        expect(newspaperKeys(h)).toHaveLength(1);
      });
    }
  }

  it("通信の失敗では、期限切れ(6 時間超)の古い行も消さない: 取り直しが失敗しても、計算ステップは前に取れた前走の条件を使う", async () => {
    const h = harness({ kind: "ok", body: GOOD_BODY });
    await fetchStep(h, "morning");
    await computeStep(h, "morning");
    expect(newspaperKeys(h)).toHaveLength(1);

    h.clock.now += 7 * 60 * 60 * 1000; // 6 時間のキャッシュが切れる
    h.gate.behavior = { kind: "status", status: 500, body: "err" };
    await fetchStep(h, "pre_race"); // 取り直す POST が失敗する(読めない応答ではない)
    expect(h.gate.posts).toHaveLength(2);
    expect(newspaperKeys(h)).toHaveLength(1); // 古い行は残る
    await computeStep(h, "pre_race");
    const horses = (h.sink.saved[0]!.raceSnapshot as { horses: Array<{ prevRace?: unknown }> }).horses;
    expect(horses.filter((x) => x.prevRace !== null && x.prevRace !== undefined).length).toBeGreaterThanOrEqual(8);
  });

  it("通信の失敗(ゲートの拒否)では、何も消さない=ほかのキャッシュの行はそのまま", async () => {
    const h = harness({ kind: "refused" });
    await fetchStep(h, "pre_race");
    const rows = (h.sql.exec("SELECT COUNT(*) AS n FROM fetch_cache").toArray() as { n: number }[])[0]!.n;
    expect(rows).toBe(19); // 前提: 出馬表 1・戦績 16・調教 1・オッズ 1 がそのまま残っている
    expect(newspaperKeys(h)).toEqual([]);
  });
});

describe("w4: 前走の条件の失敗で、取得ステップは失敗にも再試行にもならない", () => {
  it("POST が失敗しても、取得ステップは ok・1 回目(attempts を増やさず再試行しない)で次の計算ステップへ進む", async () => {
    const h = harness({ kind: "status", status: 500, body: "err" });
    await h.core.schedule({ raceId: RACE, kaisaiDate: DATE, mode: "pre_race" });
    expect(await h.core.runNextStep()).toMatchObject({ mode: "pre_race", step: "fetch", result: "ok" });
    expect(h.gate.posts).toHaveLength(1);
  });
});
