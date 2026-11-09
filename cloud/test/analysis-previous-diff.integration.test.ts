import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { D1AnalysisStore } from "../src/analysis-repository";
import { contractCases } from "./fixtures-contract";
import { openLocalBindings, type LocalBindings } from "./local-bindings";

/**
 * Issue #583: `D1AnalysisStore.getPreviousForDiff`(表示中の分析の 1 つ前=同じレースで、分析日時の降順・id の降順で次に古い分析)。
 * 本物のローカル(workerd)の D1 で、並びの境界(同時刻は id で決める・別のレースを拾わない・最古は無し)を確かめる。
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
});

const store = (): D1AnalysisStore => new D1AnalysisStore({ db: local.db, bucket: local.r2 });
const BASE = contractCases[0]!.record;
const RACE = BASE.raceId;
const OTHER_RACE = RACE.slice(0, -2) + (RACE.endsWith("01") ? "02" : "01");

async function save(analyzedAt: string, raceId = RACE): Promise<{ id: number; raceId: string; analyzedAt: string }> {
  const saved = await store().saveAnalysis({ ...BASE, raceId, analyzedAt });
  return { id: saved.id, raceId, analyzedAt };
}

describe("getPreviousForDiff(Issue #583)", () => {
  it("同じレースで次に古い分析を返す(中間の分析を飛ばさない)。馬・配分・モデルも読める", async () => {
    const a = await save("2026-11-09T01:00:00.000Z");
    const b = await save("2026-11-09T02:00:00.000Z");
    const c = await save("2026-11-09T03:00:00.000Z");
    const prev = await store().getPreviousForDiff(c);
    expect(prev?.id).toBe(b.id);
    expect(prev?.analyzedAt).toBe("2026-11-09T02:00:00.000Z");
    expect((await store().getPreviousForDiff(b))?.id).toBe(a.id);
    // 前提: 馬が複数頭読めている(退化していない)
    expect(prev!.horses.length).toBeGreaterThan(1);
    expect(prev!.horses.map((h) => h.umaban)).toEqual([...prev!.horses.map((h) => h.umaban)].sort((x, y) => x - y));
    expect(prev!.horses[0]).toHaveProperty("adjustedProb");
    expect(prev!.horses[0]).toHaveProperty("mark");
  });

  it("最古の分析には前が無い(undefined)", async () => {
    const a = await save("2026-11-09T01:00:00.000Z");
    await save("2026-11-09T02:00:00.000Z");
    expect(await store().getPreviousForDiff(a)).toBeUndefined();
  });

  it("別のレースの分析は拾わない(分析日時が直前でも)", async () => {
    const a = await save("2026-11-09T01:00:00.000Z");
    await save("2026-11-09T02:00:00.000Z", OTHER_RACE);
    const c = await save("2026-11-09T03:00:00.000Z");
    expect((await store().getPreviousForDiff(c))?.id).toBe(a.id);
  });

  it("分析日時が同じときは id の小さいほうが前。自分自身は前にならない", async () => {
    const t = "2026-11-09T02:00:00.000Z";
    const a = await save(t);
    const b = await save(t);
    expect(b.id).toBeGreaterThan(a.id);
    expect((await store().getPreviousForDiff(b))?.id).toBe(a.id);
    expect(await store().getPreviousForDiff(a)).toBeUndefined();
  });

  it("id が新しくても分析日時が古い(移行した分析)なら、日時の順で決める", async () => {
    const newer = await save("2026-11-09T05:00:00.000Z");
    const olderButLaterId = await save("2026-11-09T01:00:00.000Z");
    expect(olderButLaterId.id).toBeGreaterThan(newer.id);
    expect((await store().getPreviousForDiff(newer))?.id).toBe(olderButLaterId.id);
    expect(await store().getPreviousForDiff(olderButLaterId)).toBeUndefined();
  });

  it("候補が複数あるときは、分析日時が最も新しいもの(同時刻は id が最大)を選ぶ。id の順だけでも日時の順だけでも決まらない", async () => {
    const x = await save("2026-11-09T03:00:00.000Z");
    const y = await save("2026-11-09T01:00:00.000Z");
    const z = await save("2026-11-09T02:00:00.000Z");
    const w = await save("2026-11-09T04:00:00.000Z");
    // 前提: id の順(x<y<z<w)と日時の順(y<z<x<w)が食い違っている
    expect([x.id, y.id, z.id, w.id]).toEqual([...[x.id, y.id, z.id, w.id]].sort((a, b) => a - b));
    expect((await store().getPreviousForDiff(w))?.id).toBe(x.id);
    // 同時刻が 3 件: 最後の 1 件の前は、その直前の id
    const t = "2026-11-09T09:00:00.000Z";
    const a = await save(t);
    const b = await save(t);
    const c = await save(t);
    expect((await store().getPreviousForDiff(c))?.id).toBe(b.id);
    expect((await store().getPreviousForDiff(b))?.id).toBe(a.id);
    // 日時が最も新しい同時刻の組の中で、最小の id(a)ではなく b を選ぶ(a の前は日時が 04:00 の w)
    expect((await store().getPreviousForDiff(a))?.id).toBe(w.id);
  });

  it("配分の記録があれば買い目が読める。フィクスチャに配分が無ければ undefined", async () => {
    const withAlloc = contractCases.find((c) => c.record.allocation !== undefined && c.record.allocation !== null && c.record.allocation.bets.length > 0);
    expect(withAlloc).toBeDefined();
    const first = await store().saveAnalysis({ ...withAlloc!.record, raceId: RACE, analyzedAt: "2026-11-09T01:00:00.000Z" });
    const cur = await store().saveAnalysis({ ...withAlloc!.record, raceId: RACE, analyzedAt: "2026-11-09T02:00:00.000Z" });
    const prev = await store().getPreviousForDiff({ id: cur.id, raceId: RACE, analyzedAt: "2026-11-09T02:00:00.000Z" });
    expect(prev?.id).toBe(first.id);
    expect(prev?.allocation?.bets.length).toBe(withAlloc!.record.allocation!.bets.length);
  });
});
