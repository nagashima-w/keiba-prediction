import type {
  PeriodBatchCollectProgress,
  RaceListTarget,
} from "../shared/analysis-types.js";
import type { PeriodBatchState } from "./batch-analysis-reducer.js";
import { summarizeBatch } from "./batch-summary.js";
import { inputToYyyymmdd, yyyymmddToInput } from "./date-input.js";
import { isPeriodFormLocked } from "./period-batch-form-lock.js";

/** 期間バッチ画面のプロパティ。状態と操作はすべて親(App)から受け取る。 */
export interface PeriodBatchViewProps {
  /** 開始日(YYYYMMDD)。 */
  readonly from: string;
  /** 終了日(YYYYMMDD)。 */
  readonly to: string;
  /** 取得対象(3択: 中央/地方(全て)/地方(Jpnのみ))。 */
  readonly target: RaceListTarget;
  /** 入力検証エラー(validatePeriodInput由来。無ければ null)。 */
  readonly validationMessage: string | null;
  /** 単日一括分析が実行中などで期間バッチの操作全体を無効化すべきか(相互排他)。 */
  readonly disabled: boolean;
  /** periodBatchReducer の状態。 */
  readonly state: PeriodBatchState;
  /** 先取得(phase1)の進捗(未取得・完了後は null)。 */
  readonly collectProgress: PeriodBatchCollectProgress | null;
  /** 開始日の変更。 */
  readonly onFromChange: (yyyymmdd: string) => void;
  /** 終了日の変更。 */
  readonly onToChange: (yyyymmdd: string) => void;
  /** 取得対象の変更。 */
  readonly onTargetChange: (target: RaceListTarget) => void;
  /** 「収集」操作(phase1実行)。 */
  readonly onCollect: () => void;
  /** 先取得の中断操作。 */
  readonly onCancelCollect: () => void;
  /** 「実行確定」操作(phase2実行)。 */
  readonly onConfirmRun: () => void;
  /** 実行中の中断操作。 */
  readonly onCancelRun: () => void;
  /**
   * 「やり直す(条件を変更)」操作(タスクC2重大修正)。収集済み(collected)・完了(done)から
   * idleへ戻し、フォーム(from/to/取得対象)を再び編集可能にする。表示中の入力値と
   * collectResult(確定実行対象)が食い違う余地を無くすための唯一の再編集導線。
   */
  readonly onReset: () => void;
}

/** 全体進捗(BatchProgress)を人間向けの1行にする(BatchAnalysisViewの流儀を踏襲)。 */
function runProgressText(progress: PeriodBatchState["run"]["progress"]): string {
  if (progress === null) {
    return "";
  }
  const head = `実行 ${progress.completedRaces}/${progress.totalRaces}`;
  const race =
    progress.currentRaceName !== null
      ? ` — ${progress.currentRaceName}`
      : progress.currentRaceId !== null
        ? ` — ${progress.currentRaceId}`
        : "";
  return `${head}${race}`;
}

/**
 * 期間指定一括分析(期間バッチ)画面。
 * from/to+取得対象(3択)を指定して先取得(phase1)を行うと、3値件数(総数/既分析スキップ/
 * 実行対象)・failureDays件数・cancelled状態が確定する(確定=confirmまではphase2を呼ばない
 * 実行確定ゲート、periodBatchReducer参照)。実行対象>100件の場合は追加確認を挟む。
 * 実行(phase2)は既存の単日一括分析と同じIPC(analysis:batch-progress・cancelBatchAnalysis)を
 * 再利用する(Appが進捗イベントの振り分けを担う)。
 */
export function PeriodBatchView(
  props: PeriodBatchViewProps,
): React.JSX.Element {
  const { state } = props;
  // フォーム(from/to/取得対象)は収集開始(idle以外)以降ロックする(タスクC2重大修正)。
  // 「表示中の入力=確定実行対象」の不変条件を構造で守り、リセットを経ないと再編集できない。
  const formLocked = isPeriodFormLocked(state.phase);
  const formDisabled = props.disabled || formLocked;
  const collectResult = state.collectResult;
  const runOutcomeCounts =
    state.phase === "done" ? summarizeBatch(state.run.outcomes) : null;

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.05rem" }}>期間指定一括分析</h2>
      <p style={{ color: "#666", marginTop: 0, fontSize: "0.85rem" }}>
        期間(最大181日)を指定して、対象開催日のレースをまとめて分析します。
        まず件数を確認してから実行するかどうかを選べます。
      </p>

      <div
        role="group"
        aria-label="期間バッチ取得対象"
        style={{ display: "flex", gap: "0", marginBottom: "0.5rem" }}
      >
        {(
          [
            { key: "central", label: "中央" },
            { key: "nar-all", label: "地方(全て)" },
            { key: "nar-jpn", label: "地方(Jpnのみ)" },
          ] as const
        ).map((opt, index, all) => {
          const active = props.target === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              aria-pressed={active}
              onClick={() => props.onTargetChange(opt.key)}
              disabled={formDisabled}
              style={{
                padding: "0.3rem 0.9rem",
                border: "1px solid #888",
                borderRight: index === all.length - 1 ? "1px solid #888" : "none",
                background: active ? "#0a58ca" : "#fff",
                color: active ? "#fff" : "#333",
                fontWeight: active ? 700 : 400,
                cursor: formDisabled ? "not-allowed" : "pointer",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <label>
          開始日:{" "}
          <input
            type="date"
            value={yyyymmddToInput(props.from)}
            disabled={formDisabled}
            onChange={(e) => props.onFromChange(inputToYyyymmdd(e.target.value))}
          />
        </label>
        <label>
          終了日:{" "}
          <input
            type="date"
            value={yyyymmddToInput(props.to)}
            disabled={formDisabled}
            onChange={(e) => props.onToChange(inputToYyyymmdd(e.target.value))}
          />
        </label>
        <button
          type="button"
          onClick={props.onCollect}
          disabled={formDisabled || props.validationMessage !== null}
        >
          {state.phase === "collecting" ? "収集中…" : "収集"}
        </button>
        {state.phase === "collecting" && (
          <button
            type="button"
            onClick={props.onCancelCollect}
            disabled={state.collectCanceling}
          >
            {state.collectCanceling ? "中断待ち(日の区切りまで)…" : "中断"}
          </button>
        )}
        {(state.phase === "collected" || state.phase === "done") && (
          <button type="button" onClick={props.onReset}>
            やり直す(条件を変更)
          </button>
        )}
      </div>
      {formLocked && (
        <p style={{ color: "#666", fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
          収集済みの内容で確定するため、条件(開始日・終了日・取得対象)は編集できません。
          変更するには「やり直す」を押してください。
        </p>
      )}

      {props.validationMessage !== null && (
        <p style={{ color: "#c00" }}>{props.validationMessage}</p>
      )}

      {state.collectError !== null && (
        <p style={{ color: "#c00" }}>
          収集に失敗しました: {state.collectError}
        </p>
      )}

      {state.phase === "collecting" && props.collectProgress !== null && (
        <p style={{ color: "#0a58ca" }}>
          収集中: {props.collectProgress.completedDays}/
          {props.collectProgress.totalDays}日
        </p>
      )}

      {collectResult !== null && (
        <div style={{ marginTop: "0.75rem" }}>
          <p style={{ margin: "0.25rem 0" }}>
            対象{collectResult.totalRaces}レース中、既分析スキップ
            {collectResult.skippedAlreadyAnalyzed}件・実行対象
            {collectResult.targetRaces.length}件
          </p>
          {collectResult.failureDays.length > 0 && (
            <p style={{ margin: "0.25rem 0", color: "#a60" }}>
              取得に失敗した日: {collectResult.failureDays.length}日
            </p>
          )}
          {(collectResult.cancelled || collectResult.failureDays.length > 0) && (
            <p style={{ margin: "0.25rem 0", color: "#c00", fontWeight: 700 }}>
              ※完全なカバレッジではありません(取りこぼした日があります)。
            </p>
          )}
          {state.needsReconfirmation && (
            <p style={{ margin: "0.25rem 0", color: "#c00", fontWeight: 700 }}>
              ※実行対象が100件を超えています。実行には追加の確認が必要です。
            </p>
          )}

          {state.phase === "collected" && (
            <button type="button" onClick={props.onConfirmRun} disabled={props.disabled}>
              この内容で実行({collectResult.targetRaces.length}件)
            </button>
          )}

          {state.phase === "running" && (
            <div>
              {state.run.progress !== null && (
                <p style={{ color: "#0a58ca" }}>
                  {runProgressText(state.run.progress)}
                </p>
              )}
              <button type="button" onClick={props.onCancelRun}>
                中断
              </button>
            </div>
          )}

          {state.phase === "done" && runOutcomeCounts !== null && (
            <p style={{ margin: "0.25rem 0" }}>
              実行結果: 成功{runOutcomeCounts.success} / 失敗
              {runOutcomeCounts.failure} / スキップ{runOutcomeCounts.skipped}
              (検証タブで詳細を確認できます)
            </p>
          )}
        </div>
      )}
    </section>
  );
}
