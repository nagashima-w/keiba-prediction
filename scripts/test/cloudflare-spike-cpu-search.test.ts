import { describe, expect, it } from "vitest";
import {
  classifyCpuProbe,
  isValidCpuCheck,
  searchLimit,
  type ProbeOutcome,
} from "../cloudflare-spike/cpu-search.js";

/**
 * #159 CPU 上限の探索。Workers では実行中に I/O がないと時計が進まないため、コード内の時刻差では
 * CPU 時間を測れない。代わりに「処理を reps 回繰り返すリクエスト」を投げ、上限超過で落ちる点を探す。
 */

describe("classifyCpuProbe", () => {
  it("200 は ok", () => {
    expect(classifyCpuProbe(200, '{"ok":true}')).toBe("ok");
  });

  it.each([
    { status: 503, body: "error code: 1102" },
    { status: 503, body: "Worker exceeded resource limits" },
    { status: 500, body: '{"ok":false,"error":"Error: Worker exceeded CPU time limit."}' },
    { status: 500, body: '{"ok":false,"error":"Durable Object exceeded CPU time limit"}' },
    { status: 500, body: "The script will never generate a response / exceeded its cpu limit" },
  ])("CPU 超過を示す応答($status / $body)は cpu-exceeded", ({ status, body }) => {
    expect(classifyCpuProbe(status, body)).toBe("cpu-exceeded");
  });

  it.each([
    { status: 403, body: "forbidden" },
    { status: 404, body: "not found" },
    { status: 500, body: '{"ok":false,"error":"TypeError: x is not a function"}' },
    { status: 429, body: "Too many requests" },
    { status: null, body: "" },
  ])("CPU 超過と読めない失敗($status / $body)は other-error(CPU の限界と取り違えない)", ({ status, body }) => {
    expect(classifyCpuProbe(status, body)).toBe("other-error");
  });
});

/** reps が threshold 以下なら ok、超えたら cpu-exceeded を返す偽プローブ。呼び出し履歴を残す。 */
function thresholdProbe(threshold: number): {
  probe: (reps: number) => Promise<ProbeOutcome>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    probe: async (reps) => {
      calls.push(reps);
      return { kind: reps <= threshold ? "ok" : "cpu-exceeded", elapsedMs: reps };
    },
  };
}

describe("searchLimit: 倍々 → 二分探索", () => {
  it("閾値100を、許容0なら maxPassReps=100 / minFailReps=101 まで厳密に絞る", async () => {
    const { probe } = thresholdProbe(100);
    const r = await searchLimit(probe, { maxReps: 1024, trials: 2, tolerance: 0 });
    expect(r.maxPassReps).toBe(100);
    expect(r.minFailReps).toBe(101);
    expect(r.minFailReps! - r.maxPassReps!).toBe(1);
    expect(r.reachedMax).toBe(false);
    expect(r.stopReason).toBe("converged");
    expect(r.inconclusive).toBe(false);
  });

  it("倍々の列は 1,2,4,…の順で、最初の失敗点(128)の後に二分探索へ入る", async () => {
    const { probe } = thresholdProbe(100);
    const r = await searchLimit(probe, { maxReps: 1024, trials: 1, tolerance: 0 });
    const doubling = r.points.slice(0, 8).map((p) => p.reps);
    expect(doubling).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect(r.points[7]!.passed).toBe(false);
    expect(r.points.slice(8).length).toBeGreaterThan(0);
    for (const p of r.points.slice(8)) {
      expect(p.reps).toBeGreaterThan(64);
      expect(p.reps).toBeLessThan(128);
    }
  });

  it("許容(tolerance)が既定の10%なら、区間が maxPass の1.1倍以内に入った時点で止まる(厳密解までは追わない)", async () => {
    const { probe } = thresholdProbe(100);
    const r = await searchLimit(probe, { maxReps: 1024, trials: 1 });
    const lo = r.maxPassReps!;
    const hi = r.minFailReps!;
    expect(lo).toBeLessThanOrEqual(100);
    expect(hi).toBeGreaterThan(100);
    expect(hi).toBeGreaterThan(lo);
    expect(hi <= lo * 1.1 || hi - lo <= 1).toBe(true);
    // 許容0の厳密探索よりも点数が少ない(許容が実際に探索を打ち切っている)
    const strict = await searchLimit(thresholdProbe(100).probe, { maxReps: 1024, trials: 1, tolerance: 0 });
    expect(r.points.length).toBeLessThan(strict.points.length);
  });

  it("1回目(reps=1)から落ちるなら、maxPassReps=null / minFailReps=1 で、それ以上は探索しない", async () => {
    const { probe, calls } = thresholdProbe(0);
    const r = await searchLimit(probe, { maxReps: 1024, trials: 3 });
    expect(r.maxPassReps).toBeNull();
    expect(r.minFailReps).toBe(1);
    expect(calls).toEqual([1]); // 失敗した時点で同じ点の残りの試行も打ち切る
    expect(r.points).toHaveLength(1);
    expect(r.points[0]).toMatchObject({ reps: 1, trialsRun: 1, ok: 0, cpuExceeded: 1, passed: false });
  });

  it("maxReps まで全部通れば reachedMax=true、minFailReps=null(上限は見つからなかった)", async () => {
    const { probe } = thresholdProbe(10_000);
    const r = await searchLimit(probe, { maxReps: 64, trials: 1 });
    expect(r.points.map((p) => p.reps)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(r.reachedMax).toBe(true);
    expect(r.maxPassReps).toBe(64);
    expect(r.minFailReps).toBeNull();
    expect(r.stopReason).toBe("max-reps");
  });

  it("maxReps が2の冪でなくても(100)、最後の点は maxReps ちょうどで打ち止めになる", async () => {
    const { probe } = thresholdProbe(10_000);
    const r = await searchLimit(probe, { maxReps: 100, trials: 1 });
    expect(r.points.map((p) => p.reps)).toEqual([1, 2, 4, 8, 16, 32, 64, 100]);
  });

  it("通る点は trials 回すべて試し、落ちる点は最初の失敗で打ち切る(呼び出し回数で確認)", async () => {
    const { probe, calls } = thresholdProbe(2);
    const r = await searchLimit(probe, { maxReps: 8, trials: 3, tolerance: 0 });
    // reps=1 ×3(通る)、reps=2 ×3(通る)、reps=4 ×1(落ちる)、bisect: 3 ×1(落ちる)
    expect(calls).toEqual([1, 1, 1, 2, 2, 2, 4, 3]);
    const p1 = r.points.find((p) => p.reps === 1)!;
    expect(p1).toMatchObject({ trialsRun: 3, ok: 3, passed: true });
    const p4 = r.points.find((p) => p.reps === 4)!;
    expect(p4).toMatchObject({ trialsRun: 1, ok: 0, cpuExceeded: 1, passed: false });
    expect(r.maxPassReps).toBe(2);
    expect(r.minFailReps).toBe(3);
  });

  it("試行の途中で1回だけ落ちた点は、passed=false として ok と cpuExceeded の両方を残す(ばらつきの記録)", async () => {
    const callsAtReps: Record<number, number> = {};
    const probe = async (reps: number): Promise<ProbeOutcome> => {
      callsAtReps[reps] = (callsAtReps[reps] ?? 0) + 1;
      // reps=8 の2回目の試行だけ落ちる
      const failNow = reps === 8 && callsAtReps[reps] === 2;
      return { kind: failNow ? "cpu-exceeded" : "ok", elapsedMs: 1 };
    };
    const r = await searchLimit(probe, { maxReps: 8, trials: 3, tolerance: 0 });
    const p8 = r.points.find((p) => p.reps === 8)!;
    expect(p8).toMatchObject({ trialsRun: 2, ok: 1, cpuExceeded: 1, otherError: 0, passed: false });
    expect(r.minFailReps).toBe(8);
  });

  it("各試行の所要時間(elapsedMs)を点ごとに残す", async () => {
    const { probe } = thresholdProbe(100);
    const r = await searchLimit(probe, { maxReps: 4, trials: 2 });
    const p2 = r.points.find((p) => p.reps === 2)!;
    expect(p2.elapsedMs).toEqual([2, 2]);
  });

  it("other-error が出たら、そこで止めて inconclusive にする(CPU の限界として扱わない)", async () => {
    const calls: number[] = [];
    const probe = async (reps: number): Promise<ProbeOutcome> => {
      calls.push(reps);
      return reps >= 4 ? { kind: "other-error", elapsedMs: 5, detail: "HTTP 404" } : { kind: "ok", elapsedMs: 1 };
    };
    const r = await searchLimit(probe, { maxReps: 64, trials: 2 });
    expect(r.inconclusive).toBe(true);
    expect(r.stopReason).toBe("other-error");
    expect(r.maxPassReps).toBe(2);
    expect(r.minFailReps).toBeNull();
    expect(calls[calls.length - 1]).toBe(4);
    expect(r.points[r.points.length - 1]).toMatchObject({ reps: 4, otherError: 1, passed: false });
  });

  it("プローブ回数の予算(maxProbes)に達したら probe-budget で止まり、予算を超えて呼ばない", async () => {
    const { probe, calls } = thresholdProbe(10_000);
    const r = await searchLimit(probe, { maxReps: 4096, trials: 1, maxProbes: 5 });
    expect(calls).toHaveLength(5);
    expect(r.totalProbes).toBe(5);
    expect(r.stopReason).toBe("probe-budget");
    expect(r.maxPassReps).toBe(16);
  });

  it("totalProbes は全点の試行数の合計と一致する", async () => {
    const { probe, calls } = thresholdProbe(37);
    const r = await searchLimit(probe, { maxReps: 256, trials: 2 });
    expect(r.totalProbes).toBe(calls.length);
    expect(r.points.reduce((s, p) => s + p.trialsRun, 0)).toBe(calls.length);
  });
});

describe("searchLimit: 予算切れで中断された点を、失敗として扱わない", () => {
  it("真の上限100・trials=3・maxReps=4096・maxProbes=24 でも、minFailReps は実際に失敗を観測した点だけから決まる", async () => {
    const { probe } = thresholdProbe(100);
    const r = await searchLimit(probe, { maxReps: 4096, trials: 3, maxProbes: 24 });

    // 前提を無条件に固定する(予算切れで二分探索の途中の点が中断されていること)
    expect(r.stopReason).toBe("probe-budget");
    expect(r.totalProbes).toBe(24);
    const interrupted = r.points.filter((p) => p.interrupted);
    expect(interrupted.length).toBeGreaterThan(0);
    for (const p of interrupted) {
      expect(p.trialsRun).toBeLessThan(3);
      expect(p.cpuExceeded + p.otherError).toBe(0);
      expect(p.passed).toBe(false);
    }

    // 中断された点(reps=96。1〜2回しか試しておらず、失敗は一度も観測していない)は、上限にも下限にも反映しない
    const failedReps = r.points.filter((p) => p.cpuExceeded > 0).map((p) => p.reps);
    expect(failedReps.length).toBeGreaterThan(0);
    expect(r.minFailReps).toBe(Math.min(...failedReps));
    expect(r.minFailReps).toBeGreaterThan(100); // 真の閾値(100)より大きい。観測した失敗点だけ
    const passedReps = r.points.filter((p) => p.passed).map((p) => p.reps);
    expect(r.maxPassReps).toBe(Math.max(...passedReps));
  });

  it("中断された点が1つも失敗していなければ、minFailReps に含めない(予算でちょうど倍々の途中で止まる場合)", async () => {
    const { probe } = thresholdProbe(10_000);
    const r = await searchLimit(probe, { maxReps: 4096, trials: 3, maxProbes: 7 });
    // 1,2 で 6 回、4 の 1 回目で予算切れ
    expect(r.points.map((p) => p.reps)).toEqual([1, 2, 4]);
    expect(r.points[2]).toMatchObject({ trialsRun: 1, interrupted: true, passed: false });
    expect(r.maxPassReps).toBe(2);
    expect(r.minFailReps).toBeNull();
    expect(r.reachedMax).toBe(false);
  });

  it("全試行を終えた点は interrupted=false(通った点も、落ちた点も)", async () => {
    const { probe } = thresholdProbe(2);
    const r = await searchLimit(probe, { maxReps: 8, trials: 2, tolerance: 0 });
    expect(r.points.length).toBeGreaterThan(2);
    for (const p of r.points) {
      expect(p.interrupted).toBe(false);
    }
  });
});

describe("searchLimit: 外部から打ち切る(shouldStop。壁時計の上限)", () => {
  it("最初から true なら、1回もプローブせず stopReason=deadline で返す", async () => {
    const { probe, calls } = thresholdProbe(100);
    const r = await searchLimit(probe, { maxReps: 1024, trials: 2, shouldStop: () => true });
    expect(calls).toEqual([]);
    expect(r.totalProbes).toBe(0);
    expect(r.points).toEqual([]);
    expect(r.stopReason).toBe("deadline");
    expect(r.maxPassReps).toBeNull();
    expect(r.minFailReps).toBeNull();
  });

  it("途中から true になれば、それ以降は呼ばず、それまでの結果を返す。通過点は maxPassReps に反映する", async () => {
    const { probe, calls } = thresholdProbe(10_000);
    let n = 0;
    const r = await searchLimit(probe, {
      maxReps: 4096,
      trials: 1,
      shouldStop: () => {
        n += 1;
        return n > 4; // 5 回目の判定で停止
      },
    });
    expect(calls).toEqual([1, 2, 4, 8]);
    expect(r.stopReason).toBe("deadline");
    expect(r.maxPassReps).toBe(8);
    expect(r.minFailReps).toBeNull();
    expect(r.reachedMax).toBe(false);
  });

  it("二分探索の途中で止まっても、観測した失敗点を minFailReps に残す", async () => {
    const { probe, calls } = thresholdProbe(100);
    let stop = false;
    const r = await searchLimit(
      async (reps) => {
        const o = await probe(reps);
        if (reps === 128) {
          stop = true; // 128 で初めて失敗を観測した直後に打ち切る
        }
        return o;
      },
      { maxReps: 4096, trials: 1, shouldStop: () => stop },
    );
    expect(calls[calls.length - 1]).toBe(128);
    expect(r.stopReason).toBe("deadline");
    expect(r.maxPassReps).toBe(64);
    expect(r.minFailReps).toBe(128);
  });
});

describe("isValidCpuCheck(空振りした計算を『通過』と記録しない)", () => {
  it.each([
    { work: "parse", check: 16, valid: true },
    { work: "score", check: 16, valid: true },
    { work: "alloc", check: 245, valid: true },
    { work: "alloc", check: 1, valid: true },
    { work: "allocFull", check: 311, valid: true },
    { work: "alloc", check: -1, valid: false },
    { work: "allocFull", check: -1, valid: false },
    { work: "alloc", check: 0, valid: false },
    { work: "parse", check: 0, valid: false },
    { work: "parse", check: 15, valid: false },
    { work: "score", check: 17, valid: false },
    { work: "parse", check: undefined, valid: false },
    { work: "alloc", check: "245", valid: false },
    { work: "alloc", check: Number.NaN, valid: false },
    { work: "unknown", check: 16, valid: false },
  ])("$work の check=$check は valid=$valid", ({ work, check, valid }) => {
    expect(isValidCpuCheck(work, check)).toBe(valid);
  });
});
