import type { RaceListItem } from "../shared/analysis-types.js";
import { inputToYyyymmdd, yyyymmddToInput } from "./date-input.js";
import { groupRacesByVenue } from "./group-races.js";

/** レース選択画面のプロパティ。状態と操作はすべて親(App)から受け取る。 */
export interface RaceSelectionProps {
  /** 日付(YYYYMMDD)。 */
  readonly date: string;
  /** 一覧取得中か。 */
  readonly loading: boolean;
  /** 取得済みレース一覧。 */
  readonly races: readonly RaceListItem[];
  /** 一覧取得エラー(無ければ null)。 */
  readonly error: string | null;
  /** 選択中レースID(未選択は null)。 */
  readonly selectedRaceId: string | null;
  /** 操作を無効化するか(分析実行中など)。 */
  readonly disabled?: boolean;
  /** 日付変更(YYYYMMDD)。 */
  readonly onDateChange: (yyyymmdd: string) => void;
  /** 「取得」操作。 */
  readonly onFetch: () => void;
  /** レース選択。 */
  readonly onSelect: (raceId: string) => void;
}

/**
 * レース選択画面。日付を選んで「取得」すると、会場ごとにグループ化したレース一覧を表示する。
 * レースを押すと親に選択を通知する(分析画面へ引き継ぐ)。
 */
export function RaceSelection(props: RaceSelectionProps): React.JSX.Element {
  const groups = groupRacesByVenue(props.races);

  return (
    <section>
      <h2 style={{ fontSize: "1.05rem" }}>レース選択</h2>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <label>
          開催日:{" "}
          <input
            type="date"
            value={yyyymmddToInput(props.date)}
            disabled={props.disabled}
            onChange={(e) => props.onDateChange(inputToYyyymmdd(e.target.value))}
          />
        </label>
        <button
          type="button"
          onClick={props.onFetch}
          disabled={props.loading || props.disabled}
        >
          {props.loading ? "取得中…" : "取得"}
        </button>
      </div>

      {props.error !== null && (
        <p style={{ color: "#c00" }}>一覧の取得に失敗しました: {props.error}</p>
      )}

      {!props.loading && props.error === null && props.races.length === 0 && (
        <p style={{ color: "#666" }}>
          日付を選んで「取得」を押すと、その日の開催一覧が表示されます。
        </p>
      )}

      {groups.map((group) => (
        <div key={group.venue} style={{ marginTop: "1rem" }}>
          <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.35rem" }}>
            {group.venue}
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
            {group.races.map((race) => {
              const selected = race.raceId === props.selectedRaceId;
              return (
                <button
                  type="button"
                  key={race.raceId}
                  onClick={() => props.onSelect(race.raceId)}
                  disabled={props.disabled}
                  title={`${race.name}(${race.courseType}${race.distance}m・${race.entryCount}頭)`}
                  style={{
                    padding: "0.3rem 0.6rem",
                    border: selected ? "2px solid #0a58ca" : "1px solid #bbb",
                    background: selected ? "#e7f1ff" : "#fff",
                    borderRadius: "4px",
                    cursor: props.disabled ? "not-allowed" : "pointer",
                  }}
                >
                  {race.raceNumber}R {race.courseType}
                  {race.distance}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
