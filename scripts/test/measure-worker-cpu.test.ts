import { describe, expect, it } from "vitest";
import {
  MODES,
  WORKER_SOURCE,
  descendantsOf,
  formatResult,
  parseProcStat,
  perCallMs,
  summarize,
} from "../measure-worker-cpu.js";

/**
 * Issue #174(#172-a): workerd 上の CPU 時間の測定スクリプト(scripts/measure-worker-cpu.ts)の純関数の検査。
 * 測定そのもの(wrangler dev の起動・workerd の CPU 時間の取得)は、機械の速度と /proc(Linux)に依存するため、テストでは固定しない。
 * 結果の値と N・繰り返し回数は docs/current-spec.md に記録してあり、`pnpm tsx scripts/measure-worker-cpu.ts` で再現できる。
 */

/** /proc/<pid>/stat の1行(52 フィールド)。comm は括弧で囲まれ、空白・括弧を含みうる。utime は14番目、stime は15番目。 */
function statLine(pid: number, comm: string, ppid: number, utime: number, stime: number): string {
  const rest = Array.from({ length: 50 }, () => "0");
  // comm の後ろのフィールド: state(3) ppid(4) ... utime(14) stime(15) ...
  rest[0] = "S"; // 3
  rest[1] = String(ppid); // 4
  rest[11] = String(utime); // 14
  rest[12] = String(stime); // 15
  return `${pid} (${comm}) ${rest.join(" ")}`;
}

describe("parseProcStat(/proc/<pid>/stat の1行から ppid と CPU 時間〈utime+stime。クロック刻み〉を取り出す)", () => {
  it("単純な comm", () => {
    expect(parseProcStat(statLine(10, "workerd", 7, 120, 30))).toEqual({ ppid: 7, cpuTicks: 150 });
  });

  it("comm に空白と括弧を含んでも、最後の ')' を境に読む(空白で単純に分割すると、フィールドがずれる)", () => {
    const line = statLine(10, "a b) (c d", 7, 1000, 234);
    // 前提: この行を空白で素朴に分割すると、14・15番目は utime・stime ではない(検出したい誤りが実在する)
    const naive = line.split(" ");
    expect(Number(naive[13]) + Number(naive[14])).not.toBe(1234);
    expect(parseProcStat(line)).toEqual({ ppid: 7, cpuTicks: 1234 });
  });

  it("utime だけ・stime だけでも、足し合わせる(片方を落とさない)", () => {
    expect(parseProcStat(statLine(1, "x", 0, 5, 0)).cpuTicks).toBe(5);
    expect(parseProcStat(statLine(1, "x", 0, 0, 7)).cpuTicks).toBe(7);
  });

  it("読めない行は例外にする(0 として黙って進めない)", () => {
    expect(() => parseProcStat("")).toThrow();
    expect(() => parseProcStat("1 (x) S")).toThrow();
  });
});

describe("descendantsOf(根のプロセスの子孫。他のプロセスは含めない)", () => {
  // 100 を根とする木: 100 → 101 → 102、100 → 103。無関係な 200 → 201(別の根の下)。ppid が 100 でも 1 でもない孤立した 300。
  const table = new Map<number, number>([
    [100, 1],
    [101, 100],
    [102, 101],
    [103, 100],
    [200, 1],
    [201, 200],
    [300, 999],
  ]);

  it("子と孫を含み、根自身と無関係なプロセスを含まない", () => {
    const d = descendantsOf(100, table);
    expect([...d].sort((a, b) => a - b)).toEqual([101, 102, 103]);
    expect(d).not.toContain(100);
    expect(d).not.toContain(200);
    expect(d).not.toContain(201);
    expect(d).not.toContain(300);
  });

  it("子の無いプロセスは空", () => {
    expect(descendantsOf(103, table)).toEqual([]);
  });
});

describe("perCallMs(CPU 時間の刻みの差 → 1回あたりのミリ秒)", () => {
  it("刻みは 1/clkTck 秒。手計算: 50 刻み・100 刻み/秒・500 回 → 500ms / 500 = 1.0ms", () => {
    expect(perCallMs(50, 100, 500)).toBeCloseTo(1.0, 10);
  });

  it("clkTck が違えば値も変わる(clkTck を無視していない): 50 刻み・1000 刻み/秒・500 回 → 0.1ms", () => {
    expect(perCallMs(50, 1000, 500)).toBeCloseTo(0.1, 10);
    expect(perCallMs(50, 1000, 500)).not.toBeCloseTo(perCallMs(50, 100, 500), 3);
  });

  it("回数で割る: 同じ刻みでも回数が2倍なら半分", () => {
    expect(perCallMs(40, 100, 200)).toBeCloseTo(2 * perCallMs(40, 100, 400), 10);
  });

  it("回数が 0 以下・刻みが負なら例外(ゼロ除算で Infinity・NaN を返さない)", () => {
    expect(() => perCallMs(10, 100, 0)).toThrow();
    expect(() => perCallMs(-1, 100, 10)).toThrow();
    expect(() => perCallMs(10, 0, 10)).toThrow();
  });
});

describe("summarize(繰り返しの最小・中央値・最大)", () => {
  it("奇数個: 中央値は真ん中", () => {
    expect(summarize([3, 1, 2])).toEqual({ min: 1, median: 2, max: 3, count: 3 });
  });

  it("偶数個: 中央値は真ん中の2つの平均。入力の並びを変えない", () => {
    const input = [4.6, 3.4, 4.2, 4.2];
    const copy = [...input];
    expect(summarize(input)).toEqual({ min: 3.4, median: 4.2, max: 4.6, count: 4 });
    expect(input).toEqual(copy);
    expect(summarize([1, 2, 3, 10]).median).toBeCloseTo(2.5, 10);
  });

  it("空は例外", () => {
    expect(() => summarize([])).toThrow();
  });
});

describe("formatResult(結果の1行。N と繰り返し回数を必ず添える)", () => {
  it("名前・中央値・最小〜最大・繰り返し回数・N を含む", () => {
    const line = formatResult("zlib1", { min: 0.72, median: 1.16, max: 1.28, count: 4 }, 500);
    expect(line).toContain("zlib1");
    expect(line).toContain("1.16");
    expect(line).toContain("0.72");
    expect(line).toContain("1.28");
    expect(line).toContain("4");
    expect(line).toContain("500");
  });
});

describe("formatResult の出力の大きさ(圧縮のモードで、圧縮後のバイト数を添える)", () => {
  it("outputBytes を渡すと、その値を含む。渡さないと『出力』の語を含まない", () => {
    const s = { min: 1, median: 2, max: 3, count: 4 };
    expect(formatResult("zlib1", s, 500, 33983)).toContain("33983");
    expect(formatResult("zlib1", s, 500, 33983)).toContain("出力");
    expect(formatResult("noop", s, 500)).not.toContain("出力");
  });
});

describe("測定する Worker のソース(MODES との整合)", () => {
  it("MODES の各名前を、Worker のソースが処理している(名前を足して処理を足し忘れると、何も測れない)", () => {
    expect(MODES.length).toBeGreaterThan(0);
    for (const mode of MODES) {
      expect(WORKER_SOURCE, `モード ${mode}`).toContain(`"${mode}"`);
    }
  });

  it("基準(noop)・JSON 化・gzip(level 1・level 6)・CompressionStream・解凍の各モードがある", () => {
    for (const mode of ["noop", "stringify", "zlib1", "zlib6", "cs", "gunzip", "ds"]) {
      expect(MODES, `モード ${mode}`).toContain(mode);
    }
  });
});
