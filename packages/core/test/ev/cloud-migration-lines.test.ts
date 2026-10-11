import { describe, expect, it } from "vitest";

import { AnalysisStore } from "../../src/ev/analysis-store.js";
import { createCloudMigrationSource } from "../../src/ev/cloud-migration-reader.js";
import {
  MigrationFormatError,
  MigrationTally,
  parseMigrationLine,
  type MigrationFooterLine,
  type MigrationRow,
} from "../../src/ev/cloud-migration-format.js";
import {
  generateMigrationLines,
  type CloudMigrationSource,
  type MigrationAnalysisPageItem,
} from "../../src/ev/cloud-migration-lines.js";
import { populateMigrationFixture } from "./cloud-migration-fixture.js";

/**
 * Issue #215(#167-A): 行の生成器(ヘッダ → 分析ページ → 結果ページ → フッタ)。
 * 純粋なソース(偽物)で並びと検証の配線を、実 DB のソースで『書き出し中に別の保存が走る』ことを固定する。
 */

const OPTIONS = { exportedAt: "2026-10-09T00:00:00.000Z", appVersion: "9.9.9" } as const;

function drain(gen: Generator<string, MigrationFooterLine>): { lines: string[]; footer: MigrationFooterLine } {
  const lines: string[] = [];
  for (;;) {
    const r = gen.next();
    if (r.done === true) return { lines, footer: r.value };
    lines.push(r.value);
  }
}

const emptySource: CloudMigrationSource = {
  readAnalysisPage: () => [],
  readResultPage: () => [],
};

function analysisRow(id: number): MigrationRow {
  return {
    id, race_id: "R", analyzed_at: "t", ev_estimated: null, prompt_version: null, additional_instruction: null,
    kaisai_date: null, model: null, raw_response: null, race_snapshot_json: null, history_cutoff_date: null,
    prompt_lookahead_guarded: null,
  };
}
function horseRow(analysisId: number, umaban: number, prior: number): MigrationRow {
  return {
    analysis_id: analysisId, umaban, prior, adjusted_prob: 0.1, place_odds_min: null, ev: null, is_positive: 0,
    contributions_json: null, mark: null, reason: null, highlights_json: null, concerns_json: null,
  };
}
const item = (id: number, prior = 0.1): MigrationAnalysisPageItem => ({
  analysis: analysisRow(id), horses: [horseRow(id, 1, prior)], bets: [], allocationMeta: null,
});

describe("行の並び", () => {
  it("空の DB でも、ヘッダとフッタの 2 行を出す(フッタは全部 0)", () => {
    const { lines, footer } = drain(generateMigrationLines(emptySource, OPTIONS));
    expect(lines).toHaveLength(2);
    const [h, f] = lines.map(parseMigrationLine);
    expect(h).toMatchObject({ type: "header", format: "keiba-cloud-migration", version: 1, exportedAt: OPTIONS.exportedAt, appVersion: "9.9.9" });
    expect(f).toEqual(footer);
    expect(Object.values(footer.counts).every((n) => n === 0)).toBe(true);
    expect([footer.analysisLines, footer.resultLines]).toEqual([0, 0]);
  });

  it("既定のページサイズは分析 50・結果 200(出馬表の写しが大きいので分析は小さめ)", () => {
    const calls: Array<[string, number | string, number]> = [];
    drain(
      generateMigrationLines(
        {
          readAnalysisPage: (after, limit) => (calls.push(["a", after, limit]), []),
          readResultPage: (after, limit) => (calls.push(["r", after, limit]), []),
        },
        OPTIONS,
      ),
    );
    expect(calls).toEqual([["a", 0, 50], ["r", "", 200]]);
  });

  it("ページを順に読み、最後のキーを次のページの起点にする", () => {
    const calls: number[] = [];
    const pages = [[item(3), item(7)], [item(9)], []];
    const { lines } = drain(
      generateMigrationLines(
        { readAnalysisPage: (after) => (calls.push(after), pages.shift() ?? []), readResultPage: () => [] },
        { ...OPTIONS, analysisPageSize: 2 },
      ),
    );
    expect(calls).toEqual([0, 7, 9]);
    expect(lines).toHaveLength(1 + 3 + 1);
  });

  it("書いた行をそのままタリーに通すと、約束(順序・件数)を満たす", () => {
    const { lines } = drain(generateMigrationLines({ ...emptySource, readAnalysisPage: (after) => (after === 0 ? [item(1), item(2)] : []) }, OPTIONS));
    const tally = new MigrationTally();
    for (const l of lines) tally.accept(parseMigrationLine(l));
    expect(() => tally.assertComplete()).not.toThrow();
  });
});

describe("書く前の検証", () => {
  it("有限でない数値は、どの表・どの id・どの列かを含むメッセージで失敗し、その行は出さず、以降のページも読まない", () => {
    let pagesRead = 0;
    const gen = generateMigrationLines(
      { readAnalysisPage: (after) => (pagesRead++, after === 0 ? [item(1), item(2, Number.POSITIVE_INFINITY)] : [item(5)]), readResultPage: () => [] },
      { ...OPTIONS, analysisPageSize: 2 },
    );
    const out: string[] = [];
    let error: unknown;
    try {
      for (;;) {
        const r = gen.next();
        if (r.done === true) break;
        out.push(r.value);
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MigrationFormatError);
    const message = (error as Error).message;
    expect(message).toContain("analysis_horses");
    expect(message).toContain("analysis_id=2");
    expect(message).toContain("umaban=1");
    expect(message).toContain("prior");
    expect(out).toHaveLength(2); // ヘッダと分析 1 だけ
    expect(pagesRead).toBe(1);
  });

  it("起点が進まないページ(同じ id を返し続けるソース)は無限ループせず失敗する", () => {
    const gen = generateMigrationLines({ readAnalysisPage: () => [item(1)], readResultPage: () => [] }, { ...OPTIONS, analysisPageSize: 1 });
    expect(() => drain(gen)).toThrow(MigrationFormatError);
  });
});

describe("書き出し中に同じ接続で別の保存が走っても『connection is busy』にならない", () => {
  it("1 行出すたびに保存しても失敗せず、書き出し中に増えた分析も続きのページに現れる", () => {
    const store = new AnalysisStore();
    populateMigrationFixture(store);
    const source = createCloudMigrationSource(store.rawDatabase);
    const gen = generateMigrationLines(source, { ...OPTIONS, analysisPageSize: 2, resultPageSize: 2 });
    let saved = 0;
    const lines: string[] = [];
    let footer: MigrationFooterLine | undefined;
    for (;;) {
      const r = gen.next();
      if (r.done === true) {
        footer = r.value;
        break;
      }
      lines.push(r.value);
      if (saved < 1) {
        saved += 1;
        store.saveAnalysis({
          raceId: "202603020299",
          analyzedAt: "2026-03-02T09:00:00.000Z",
          horses: [{ umaban: 1, prior: 0.1, adjustedProb: 0.1, placeOddsMin: null, ev: null, isPositive: false, contributions: null, mark: null }],
        });
      }
    }
    expect(saved).toBe(1);
    expect(footer.analysisLines).toBe(6);
    expect(footer.counts.analyses).toBe(6);
  });
});
