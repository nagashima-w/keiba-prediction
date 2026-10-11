/**
 * 共有フィクスチャ(packages/core/test/fixtures/analysis-store-contract.json。#168)の読み込み。
 * exe の AnalysisStore(core のテスト)と、クラウド版のストア(このディレクトリのテスト)が同じファイルを読み、同じ期待値に一致することで、
 * 両実装の変換が食い違わないことを保つ。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnalysisRecord, StoredAllocation, StoredAnalysis } from "../../packages/core/src/ev/analysis-store-types.js";

export interface ContractCase {
  readonly name: string;
  readonly record: AnalysisRecord;
  readonly expectedAnalysis: Omit<StoredAnalysis, "id">;
  readonly expectedAllocation: StoredAllocation | null;
}

const FIXTURE_PATH = fileURLToPath(new URL("../../packages/core/test/fixtures/analysis-store-contract.json", import.meta.url));

export const contractCases: readonly ContractCase[] = (JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { cases: ContractCase[] }).cases;
