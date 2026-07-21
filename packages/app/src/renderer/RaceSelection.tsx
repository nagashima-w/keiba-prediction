import type { RaceListItem } from "../shared/analysis-types.js";
import { CopyErrorButton } from "./CopyErrorButton.js";
import { inputToYyyymmdd, yyyymmddToInput } from "./date-input.js";
import { groupRacesByVenue } from "./group-races.js";
import type { RaceListTarget } from "./race-list-target.js";

/** レース選択画面(複数選択)のプロパティ。状態と操作はすべて親(App)から受け取る。 */
export interface RaceSelectionProps {
  /** 日付(YYYYMMDD)。 */
  readonly date: string;
  /**
   * レース一覧の取得対象(3択: 中央/地方(全て)/地方(Jpnのみ)。タスクB1)。
   * venueKind/jpnOnlyへの写像は race-list-target.ts に集約する。
   */
  readonly raceListTarget: RaceListTarget;
  /** 一覧取得中か。 */
  readonly loading: boolean;
  /** 取得済みレース一覧。 */
  readonly races: readonly RaceListItem[];
  /** 一覧取得エラー(無ければ null)。 */
  readonly error: string | null;
  /** 選択中レースID群。 */
  readonly selectedRaceIds: readonly string[];
  /** 操作を無効化するか(一括分析実行中など)。 */
  readonly disabled?: boolean;
  /** 日付変更(YYYYMMDD)。 */
  readonly onDateChange: (yyyymmdd: string) => void;
  /** レース一覧取得対象の変更(3択トグル)。 */
  readonly onRaceListTargetChange: (target: RaceListTarget) => void;
  /** 「取得」操作。 */
  readonly onFetch: () => void;
  /** レース選択のトグル。 */
  readonly onToggle: (raceId: string) => void;
  /** 会場のレースをまとめて選択に追加する。 */
  readonly onSelectVenue: (raceIds: readonly string[]) => void;
  /** 会場のレースをまとめて選択から外す。 */
  readonly onDeselectVenue: (raceIds: readonly string[]) => void;
  /** すべての選択を解除する。 */
  readonly onClearAll: () => void;
}

/**
 * レース選択画面(複数選択)。日付を選んで「取得」すると、会場ごとにグループ化した一覧を表示する。
 * 各レースはトグル式で複数選択でき、会場ごとの「全選択/全解除」と全体の「全解除」を備える。
 * 1件だけ選んで一括分析すれば、従来の単一レース分析と同じ結果になる(単一選択を包含)。
 */
export function RaceSelection(props: RaceSelectionProps): React.JSX.Element {
  const groups = groupRacesByVenue(props.races);
  const selectedSet = new Set(props.selectedRaceIds);
  const disabled = props.disabled ?? false;

  return (
    <section>
      <h2 style={{ fontSize: "1.05rem" }}>レース選択(複数選択可)</h2>

      <div
        role="group"
        aria-label="開催区分"
        style={{ display: "flex", gap: "0", marginBottom: "0.5rem" }}
      >
        {(
          [
            { key: "central", label: "中央" },
            { key: "nar-all", label: "地方(全て)" },
            { key: "nar-jpn", label: "地方(Jpnのみ)" },
          ] as const
        ).map((opt, index, all) => {
          const active = props.raceListTarget === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              aria-pressed={active}
              onClick={() => props.onRaceListTargetChange(opt.key)}
              disabled={disabled}
              style={{
                padding: "0.3rem 0.9rem",
                border: "1px solid #888",
                borderRight: index === all.length - 1 ? "1px solid #888" : "none",
                background: active ? "#0a58ca" : "#fff",
                color: active ? "#fff" : "#333",
                fontWeight: active ? 700 : 400,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <label>
          開催日:{" "}
          <input
            type="date"
            value={yyyymmddToInput(props.date)}
            disabled={disabled}
            onChange={(e) => props.onDateChange(inputToYyyymmdd(e.target.value))}
          />
        </label>
        <button
          type="button"
          onClick={props.onFetch}
          disabled={props.loading || disabled}
        >
          {props.loading ? "取得中…" : "取得"}
        </button>
        {props.races.length > 0 && (
          <>
            <span style={{ color: "#333", fontSize: "0.9rem" }}>
              選択中: {props.selectedRaceIds.length}件
            </span>
            <button
              type="button"
              onClick={props.onClearAll}
              disabled={disabled || props.selectedRaceIds.length === 0}
            >
              全解除
            </button>
          </>
        )}
      </div>

      {props.error !== null && (
        <p style={{ color: "#c00" }}>
          一覧の取得に失敗しました: {props.error}
          <CopyErrorButton
            operation="レース一覧:取得"
            message={props.error}
            context={{
              date: props.date,
              raceListTarget: props.raceListTarget,
            }}
          />
        </p>
      )}

      {!props.loading && props.error === null && props.races.length === 0 && (
        <p style={{ color: "#666" }}>
          日付を選んで「取得」を押すと、その日の開催一覧が表示されます。
        </p>
      )}

      {groups.map((group) => {
        const venueRaceIds = group.races.map((r) => r.raceId);
        const allSelected = venueRaceIds.every((id) => selectedSet.has(id));
        return (
          <div key={group.venue} style={{ marginTop: "1rem" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                margin: "0 0 0.35rem",
              }}
            >
              <h3 style={{ fontSize: "0.95rem", margin: 0 }}>{group.venue}</h3>
              <button
                type="button"
                onClick={() => props.onSelectVenue(venueRaceIds)}
                disabled={disabled || allSelected}
                style={{ fontSize: "0.8rem" }}
              >
                全選択
              </button>
              <button
                type="button"
                onClick={() => props.onDeselectVenue(venueRaceIds)}
                disabled={
                  disabled || !venueRaceIds.some((id) => selectedSet.has(id))
                }
                style={{ fontSize: "0.8rem" }}
              >
                全解除
              </button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              {group.races.map((race) => {
                const selected = selectedSet.has(race.raceId);
                return (
                  <button
                    type="button"
                    key={race.raceId}
                    onClick={() => props.onToggle(race.raceId)}
                    disabled={disabled}
                    aria-pressed={selected}
                    title={`${race.name}(${race.courseType}${race.distance}m・${race.entryCount}頭)`}
                    style={{
                      padding: "0.3rem 0.6rem",
                      border: selected ? "2px solid #0a58ca" : "1px solid #bbb",
                      background: selected ? "#e7f1ff" : "#fff",
                      fontWeight: selected ? 700 : 400,
                      borderRadius: "4px",
                      cursor: disabled ? "not-allowed" : "pointer",
                    }}
                  >
                    {selected ? "✓ " : ""}
                    {race.raceNumber}R {race.courseType}
                    {race.distance}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
