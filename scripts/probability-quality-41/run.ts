/**
 * #41 の取得の進行(`docs/investigations/probability-quality-41/measurement-plan.md` §2・§4)。
 * 一覧・1レースの観測・保存・停止の判定はすべて注入された依存で行う(ネットワークなしで検証できる)。
 *
 * - 計画の開催日(中央 2026-09-26・09-27、地方 2026-09-30)は取得前に固定した値。
 * - 保存済みのレースは飛ばす(中断・再実行で同じレースを取り直さない)。
 * - HTTP 400・403・429 の連続で取得が止まったら、以後のレースを取らずにマニフェストを書いて止める。
 *   **停止の引き金になった呼び出しのレースは保存しない**(除外ではなく、取り直す対象)。
 * - 一時的な失敗(取得の失敗)と、許可リストに無い着順文言は**保存せず**、再実行で取り直す。
 */

import type { RaceListEntry } from "../../packages/core/src/index.js";
import { FetchHaltedError } from "./guarded-fetcher.js";
import type { MeasureTarget } from "./measure.js";
import type { RaceObservation } from "./observation.js";
import { resolveCentralDay, resolveNarDay, type ResolvedDay } from "./selection.js";

/** 取得間隔(ミリ秒。`HttpClient.minIntervalMs` に渡す。2秒以上)。 */
export const MIN_INTERVAL_MS = 2000;

/** 取得前に固定した計画の開催日。 */
export const DEFAULT_PLAN = {
  central: ["20260926", "20260927"],
  nar: ["20260930"],
} as const;

/** 計画の型。 */
export interface MeasurementPlan {
  readonly central: readonly string[];
  readonly nar: readonly string[];
}

/**
 * 観測 JSON として**保存しない**除外理由(§3.3 追記)。取得の失敗は一時的でありうる。許可リストに無い
 * 着順文言は、実際の表記がリポジトリ内に根拠が無く、表記の違いで取消馬のいるレースが全部除外され
 * 二度と取り直せなくなるのを避けるため、保存せず再実行で取り直す(manifest に理由と文言を残す)。
 */
export const NOT_SAVED_REASONS: readonly string[] = [
  "result-fetch-error",
  "scrape-error",
  "unclassified-finish",
];

/** 取得に使うコードのうち、未コミットなら取得を拒否するパス(`runAnalysis` が測定の本体のため app も含む)。 */
export const CODE_PATHS_MUST_BE_CLEAN: readonly string[] = [
  "scripts/probability-quality-41",
  "packages/core/src",
  "packages/app/src",
];

/** 観測の保存先(レース単位。再実行で飛ばす判定に使う)。 */
export interface ObservationStore {
  exists(raceId: string): boolean;
  write(observation: RaceObservation): void;
}

/** 取得の安全装置の状態(`HaltOnConsecutiveBlockFetcher` が満たす)。 */
export interface GuardState {
  readonly tripped: boolean;
  readonly requestCount: number;
  readonly urlsBlocked: readonly string[];
}

/** 注入する依存。 */
export interface RunDeps {
  readonly fetchCentralList: (date: string) => Promise<readonly RaceListEntry[]>;
  readonly fetchNarList: (date: string) => Promise<readonly RaceListEntry[]>;
  readonly measure: (target: MeasureTarget) => Promise<RaceObservation>;
  readonly store: ObservationStore;
  readonly guard: GuardState;
  readonly writeManifest: (manifest: RunManifest) => void;
  /** 実行時のコミット(`git rev-parse HEAD`)。再現性のため実行記録に残す。 */
  readonly gitCommit: string;
  readonly now?: () => Date;
}

/** 実行の記録(`manifest.json`)。 */
export interface RunManifest {
  /** 実行時のコミット(`git rev-parse HEAD`)。 */
  readonly gitCommit: string;
  readonly plan: MeasurementPlan;
  readonly minIntervalMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly days: ReadonlyArray<
    Pick<ResolvedDay, "requestedDate" | "usedDate" | "attemptedDates"> & {
      readonly region: "central" | "nar";
      readonly raceIds: readonly string[];
    }
  >;
  readonly processed: ReadonlyArray<{
    readonly raceId: string;
    /** `not-saved` は保存せず再実行で取り直す対象(取得の失敗・未知の着順文言・停止の引き金)。 */
    readonly status: "ok" | "excluded" | "not-saved";
    readonly reason?: string;
    readonly detail?: string;
  }>;
  /** 保存済みのため飛ばしたレース。 */
  readonly skippedExisting: readonly string[];
  readonly halted: boolean;
  readonly haltReason: string | null;
  /** フェッチャへ渡した要求の数(止まった後の拒否は数えない)。キャッシュ命中も含む上限。 */
  readonly requestCount: number;
  readonly urlsBlocked: readonly string[];
}

/** 計画を実行する。異常終了でも、書けた範囲のマニフェストを書く。 */
export async function runMeasurement(
  deps: RunDeps,
  plan: MeasurementPlan,
): Promise<RunManifest> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const days: Array<RunManifest["days"][number]> = [];
  const processed: Array<RunManifest["processed"][number]> = [];
  const skippedExisting: string[] = [];
  let halted = false;
  let haltReason: string | null = null;

  const manifest = (): RunManifest => ({
    gitCommit: deps.gitCommit,
    plan,
    minIntervalMs: MIN_INTERVAL_MS,
    startedAt,
    finishedAt: now().toISOString(),
    days,
    processed,
    skippedExisting,
    halted,
    haltReason,
    requestCount: deps.guard.requestCount,
    urlsBlocked: deps.guard.urlsBlocked,
  });

  const halt = (reason: string) => {
    halted = true;
    haltReason = reason;
  };
  const HTTP_400_HALT = "HTTP 400・403・429 が連続して返ったため取得を停止した";

  const schedule: Array<{ region: "central" | "nar"; date: string }> = [
    ...plan.central.map((date) => ({ region: "central" as const, date })),
    ...plan.nar.map((date) => ({ region: "nar" as const, date })),
  ];

  try {
    for (const { region, date } of schedule) {
      if (halted) {
        break;
      }
      let day: ResolvedDay;
      try {
        day =
          region === "central"
            ? await resolveCentralDay(date, deps.fetchCentralList)
            : await resolveNarDay(date, deps.fetchNarList);
      } catch (error) {
        // 停止の引き金になった呼び出しは元の HttpError を投げる。ガードが止まっていれば停止として扱う。
        if (error instanceof FetchHaltedError || deps.guard.tripped) {
          halt(HTTP_400_HALT);
          break;
        }
        throw error;
      }
      days.push({
        region,
        requestedDate: day.requestedDate,
        usedDate: day.usedDate,
        attemptedDates: day.attemptedDates,
        raceIds: day.races.map((r) => r.raceId),
      });

      for (const entry of day.races) {
        if (deps.store.exists(entry.raceId)) {
          skippedExisting.push(entry.raceId);
          continue;
        }
        let observation: RaceObservation;
        try {
          observation = await deps.measure({
            entry,
            region,
            requestedDate: day.requestedDate,
            kaisaiDate: day.usedDate,
          });
        } catch (error) {
          if (error instanceof FetchHaltedError || deps.guard.tripped) {
            halt(HTTP_400_HALT);
            break;
          }
          throw error;
        }
        // 停止の引き金になった呼び出しのレースは保存しない(除外に変換されていても、取り直す対象)。
        if (deps.guard.tripped) {
          processed.push({
            raceId: observation.raceId,
            status: "not-saved",
            reason: "halted-in-flight",
            ...(observation.status === "excluded"
              ? { detail: `${observation.reason}: ${observation.detail}` }
              : {}),
          });
          halt(HTTP_400_HALT);
          break;
        }
        // 一時的な失敗・未知の着順文言は保存せず、理由と文言を実行記録に残す(再実行で取り直される)。
        if (observation.status === "excluded" && NOT_SAVED_REASONS.includes(observation.reason)) {
          processed.push({
            raceId: observation.raceId,
            status: "not-saved",
            reason: observation.reason,
            detail: observation.detail,
          });
          continue;
        }
        deps.store.write(observation);
        processed.push({
          raceId: observation.raceId,
          status: observation.status,
          ...(observation.status === "excluded" ? { reason: observation.reason } : {}),
        });
      }
    }
  } finally {
    deps.writeManifest(manifest());
  }
  return manifest();
}

/**
 * 計画の文書がコミット済み(追跡されていて、未コミットの変更が無い)でなければ失敗する。
 * 取得をこの文書のコミットより後に行うことを、手順ではなくコードで強制する
 * (cherry-pick 防止。コミット履歴の順序が証拠になる)。
 *
 * @param runGit git を実行して標準出力を返す関数(テストで差し替える)
 */
export function assertPlanCommitted(
  runGit: (args: readonly string[]) => string,
  planPath: string,
): void {
  const tracked = runGit(["ls-files", "--", planPath]).trim();
  if (tracked !== planPath) {
    throw new Error(
      `計画の文書(${planPath})がコミットされていません。取得より前にコミットしてください`,
    );
  }
  const dirty = runGit(["status", "--porcelain", "--", planPath]).trim();
  if (dirty !== "") {
    throw new Error(
      `計画の文書(${planPath})に未コミットの変更があります。コミットしてから取得してください(${dirty})`,
    );
  }
}

/**
 * 取得に使うコード(測定スクリプト・core)に未コミットの変更や未追跡のファイルがあれば失敗する。
 * 取得に使った版が履歴に残っていることを、手順ではなくコードで強制する。
 */
export function assertPathsClean(
  runGit: (args: readonly string[]) => string,
  paths: readonly string[],
): void {
  for (const p of paths) {
    const dirty = runGit(["status", "--porcelain", "--", p]).trim();
    if (dirty !== "") {
      throw new Error(`${p} に未コミットの変更があります。コミットしてから取得してください(${dirty})`);
    }
  }
}

/** 実行の終了コード。停止で終わった実行は非0(2)にする。 */
export function exitCodeFor(manifest: Pick<RunManifest, "halted">): number {
  return manifest.halted ? 2 : 0;
}
