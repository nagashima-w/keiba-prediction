import { describe, expect, it } from "vitest";

import { closeRowParams, UPSERT_CLOSE_SQL, type CloseSavePayload } from "../src/analysis-close";

/**
 * Issue #676: `analysis_close.odds_sources_json`(migration 0043)。再計算が使ったオッズの券種ごとの取得元(`analyses.odds_sources_json` と同じ形)。
 * UPSERT の列数・`?` の数・束縛値の数が一致していること(#658 で market_shrink_weight を足した 26 から 27 になる)。
 */
const base: CloseSavePayload = { round: 1, status: "skipped", reason: "unset", dueAtMs: 1, firedAtMs: 2, lateMs: 1, oddsOfficialDatetime: null, allocation: null };

describe("closeRowParams / UPSERT_CLOSE_SQL: odds_sources_json", () => {
  it("列の数・? の数・束縛値の数が 27 で一致し、列名の最後が odds_sources_json、束縛値の最後がその JSON", () => {
    const columns = /INSERT INTO analysis_close\s*\(([^)]*)\)/.exec(UPSERT_CLOSE_SQL)![1]!.split(",").map((c) => c.trim());
    const placeholders = /VALUES \(([^)]*)\)/.exec(UPSERT_CLOSE_SQL)![1]!.split(",").length;
    const withSources: CloseSavePayload = { ...base, oddsSources: { winPlace: { source: "jra", officialDatetime: "2026-11-08 10:37:00" } } };
    const params = closeRowParams(5, withSources);
    expect(columns).toHaveLength(27);
    expect(placeholders).toBe(27);
    expect(params).toHaveLength(27);
    expect(columns.at(-1)).toBe("odds_sources_json");
    expect(JSON.parse(params.at(-1) as string)).toEqual({ v: 1, sources: { winPlace: { source: "jra", officialDatetime: "2026-11-08 10:37:00" } } });
    // 再保存(UPSERT)で上書きされる列に含まれる
    expect(UPSERT_CLOSE_SQL).toContain("odds_sources_json = excluded.odds_sources_json");
  });

  it("取得元の記録が無い payload(JRA を使わない構成・旧い DO の結果)は NULL を束縛する", () => {
    expect(closeRowParams(5, base).at(-1)).toBeNull();
    expect(closeRowParams(5, { ...base, oddsSources: {} }).at(-1)).toBeNull();
  });
});
