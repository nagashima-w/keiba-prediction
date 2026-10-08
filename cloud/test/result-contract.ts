/**
 * 結果の保存の golden(packages/core/test/golden/race-result-contract.json。Issue #207〈#182-A〉)の読み込み。
 * exe の AnalysisStore(core のテスト `race-result-contract.test.ts`)と、クラウド版のストア(`result-repository.test.ts`)が同じファイルを読み、
 * 同じ入力から同じ4表のダンプ・同じ復元結果になることで、両実装の保存が食い違わないことを保つ。
 *
 * 型はここで持つ(golden の生成側〈core/test/golden/race-result-scenarios.ts〉を import しない: そのファイルは better-sqlite3 を値で import しており、
 * 型だけの import でも、CI の型検査〈packages/core/node_modules が無い〉が better-sqlite3 を解決しに行って失敗する)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RaceComboPayoutsSaveInput, RaceResultDetail, RaceResultEntry } from "../../packages/core/src/ev/analysis-store-types.js";
import type { CourseType } from "../../packages/core/src/scraper/types.js";

export interface ContractStep {
  readonly raceId: string;
  readonly entries: RaceResultEntry[];
  readonly courseType?: CourseType | null;
  readonly comboPayouts?: RaceComboPayoutsSaveInput;
}
export interface RaceResultsRow {
  readonly race_id: string;
  readonly umaban: number;
  readonly finish_position: number | null;
  readonly place_payout: number | null;
  readonly win_payout: number | null;
  readonly passing_json: string | null;
  readonly last3f: number | null;
}
export interface RaceResultMetaRow {
  readonly race_id: string;
  readonly course_type: string | null;
}
export interface RaceComboPayoutsRow {
  readonly race_id: string;
  readonly bet_type: string;
  readonly combo_key: string;
  readonly payout: number;
}
export interface RaceComboPayoutImportsRow {
  readonly race_id: string;
  readonly bet_type: string;
}
export interface ResultTablesDump {
  readonly race_results: RaceResultsRow[];
  readonly race_result_meta: RaceResultMetaRow[];
  readonly race_combo_payouts: RaceComboPayoutsRow[];
  readonly race_combo_payout_imports: RaceComboPayoutImportsRow[];
}
export interface ResultContractCase {
  readonly name: string;
  readonly raw?: Pick<ResultTablesDump, "race_results" | "race_result_meta">;
  readonly steps: ContractStep[];
  readonly expected: ResultTablesDump;
  readonly expectedDetails: Record<string, RaceResultDetail | null>;
}

const FIXTURE_PATH = fileURLToPath(new URL("../../packages/core/test/golden/race-result-contract.json", import.meta.url));

export const resultContractCases: readonly ResultContractCase[] = (JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as { cases: ResultContractCase[] }).cases;
