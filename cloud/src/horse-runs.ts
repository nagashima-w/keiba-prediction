/**
 * 各馬の戦績の蓄積(Issue #256 段階A)の純ロジック。D1 には触れない(読み書きは `horse-runs-repository.ts`)。
 *
 * 保存済みの行(`horse_runs`)と、今回の事前分析で取った戦績を突き合わせ、行を次のどれかに分ける:
 *  - **新規**: 保存済みに無い鍵 → 追加する。
 *  - **重複(一致)**: 保存済みと同じ内容 → 何も書かない(D1 の `rows_written` を食わない)。保存した JST 日が今日なら「同日の再実行」、前日以前なら「前日以前から保存済み」。
 *    手動の再実行が混ざって重複率が膨らむのを避けるため、2つに分ける。
 *  - **不一致**: 保存済みと内容が違う → netkeiba を正として上書きする(初見時刻は据え置き)。**後から埋まっただけ**(保存済みで空だった項目が埋まった。
 *    直後のレースで通過順・ペース・上がりが遅れて入る等)と、**値が変わった**(降着・繰り上がり・騎手名の改名等)を分けて数える。
 *    違ったスロットの番号と種別は、1回の保存で最大 {@link MISMATCH_SAMPLE_LIMIT} 件まで標本として残す。
 *  - **再パース**: 保存済みの版数が古い → 内容が同じでも上書きして版を上げる(不一致には数えない)。保存済みの版数が新しい(旧い Worker が動いているとき)は触らない。
 *
 * ## 判断材料(`SaveStats`。`horse_run_saves` に1回の保存ごとに1行)
 * 段階 D(結果ページから行を作る)に進めるかは、「初見でない馬の取得で、新しい行が『その時点で race_results に取り込み済みのレース』だけか」で決まる。
 * 後から数えると必ず「取り込み済み」になるので、**保存の時点で** race_results を引いて数える(`horsesNewAllInResults`・`horsesNewSomeNotInResults`)。
 * 新規 0 行の馬(`horsesZeroNew`)の取得は、保存済みの行から読めば省ける分(段階 C)。
 */

import { HORSE_RUN_PARSER_VERSION, encodeHorseRun, horseRunKey } from "../../packages/core/src/scraper/horse-run-record";
import type { HorseRaceResult } from "../../packages/core/src/scraper/types";
import { JST_OFFSET_MS } from "../../packages/core/src/common/jst";

/** 1回の保存で標本として残す不一致の件数の上限(不一致が多発しても、記録の大きさと書き込みが膨らまない)。 */
export const MISMATCH_SAMPLE_LIMIT = 5;

/** 保存済みの1行(`horse_runs`)。 */
export interface StoredRun {
  readonly horseId: string;
  readonly raceKey: string;
  readonly parserVersion: number;
  /** 初めて保存した時刻(エポックミリ秒)。 */
  readonly firstSeenAt: number;
  /** タプルの JSON 文字列。 */
  readonly data: string;
}

/** 書き込む1行(新規・上書きとも同じ形)。 */
export type PlannedRun = StoredRun;

/** 1回の保存の入力(1レースの事前分析で取った、出走馬ごとの戦績)。 */
export interface PlanInput {
  readonly raceId: string;
  /** 開催日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  /** 保存の時刻(エポックミリ秒)。 */
  readonly savedAt: number;
  readonly horses: ReadonlyArray<{ readonly horseId: string; readonly results: readonly HorseRaceResult[] }>;
}

/** 不一致の標本。`slots` は違ったタプルのスロット番号(昇順)。 */
export interface MismatchSample {
  readonly horseId: string;
  readonly raceKey: string;
  readonly kind: "filled" | "changed";
  readonly slots: readonly number[];
}

/** 1回の保存の集計(`horse_run_saves.stats_json`)。 */
export interface SaveStats {
  /** 集計の形の版。 */
  readonly v: 1;
  readonly raceId: string;
  readonly kaisaiDate: string;
  readonly savedAt: number;
  /** 出走馬の数。 */
  readonly horses: number;
  /** 保存済みの行が 1 件も無かった馬(初見)。 */
  readonly horsesFirstSeen: number;
  /** 初見でなく、新規の行が 0 の馬(この取得は、保存済みの行で足りていた)。 */
  readonly horsesZeroNew: number;
  /** 初見でなく、新規の行があり、**すべて**その時点で race_results に取り込み済みのレースの馬(段階 D で結果ページから作れた分)。 */
  readonly horsesNewAllInResults: number;
  /** 初見でなく、新規の行があり、一部が race_results に無いレースの馬。 */
  readonly horsesNewSomeNotInResults: number;
  /** race_results を引けたか。false のとき、取り込み済みかの内訳(上の2つと newInResults)は 0。 */
  readonly inResultsKnown: boolean;
  /** 提供された戦績の行数(= 鍵なし + 入力内の重複 + 新規 + 保存済みの内訳の和)。 */
  readonly rowsOffered: number;
  /** 鍵を作れなかった行(レース ID も日付の形も無い)。保存しない。 */
  readonly rowsNoKey: number;
  /** 同じ馬の中で鍵が重なった行(2行目以降)。 */
  readonly rowsDupInInput: number;
  readonly rowsNew: number;
  /** 新規のうち、初見の馬の行。 */
  readonly rowsNewFromFirstSeen: number;
  /** 新規の開催区分別。 */
  readonly newByKind: { readonly central: number; readonly nar: number; readonly overseas: number };
  /** 新規のうち、レース ID が race_results にある行。 */
  readonly newInResults: number;
  /** 保存済みと同じ(今日 JST に保存した = 同日の再実行)。 */
  readonly rowsDupSameDay: number;
  /** 保存済みと同じ(前日以前に保存した)。 */
  readonly rowsDupEarlier: number;
  /** 不一致のうち、保存済みで空だった項目が埋まっただけ。 */
  readonly rowsFilled: number;
  /** 不一致のうち、値が変わった。 */
  readonly rowsChanged: number;
  /** 保存済みの版が古く、上書きした。 */
  readonly rowsReparsed: number;
  /** 保存済みの版が新しく、触らなかった。 */
  readonly rowsStoredNewer: number;
  readonly mismatchSamples: readonly MismatchSample[];
  /** 行の書き込み(新規・上書き)で D1 が報告した rows_written の合計。 */
  readonly rowsWrittenRuns: number;
}

/** 保存の窓口(RaceDay が使う)。失敗は投げる(呼び出し側が握って警告にする)。 */
export interface HorseRunsStore {
  saveRace(input: PlanInput): Promise<SaveStats>;
}

type RunKind = "central" | "nar" | "overseas";

interface NewRow {
  readonly horseId: string;
  readonly key: string;
  readonly kind: RunKind;
  readonly firstSeenHorse: boolean;
}

/** {@link planHorseRunsSave} の結果。 */
export interface HorseRunsPlan {
  readonly input: PlanInput;
  readonly inserts: PlannedRun[];
  readonly updates: PlannedRun[];
  /** race_results を引く鍵(新規行のレース ID。12桁の数字だけ。重複なし)。 */
  readonly newKeys: string[];
  readonly newRows: NewRow[];
  readonly counts: {
    offered: number;
    noKey: number;
    dupInInput: number;
    dupSameDay: number;
    dupEarlier: number;
    filled: number;
    changed: number;
    reparsed: number;
    storedNewer: number;
  };
  readonly horsePlans: Array<{ readonly horseId: string; readonly firstSeen: boolean; readonly newKeys: string[] }>;
  readonly samples: MismatchSample[];
}

/** エポックミリ秒を JST の日付(YYYYMMDD)にする。 */
export function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");
}

function isEmptySlot(value: unknown): boolean {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/** 保存済みと今回のタプルで違ったスロットの番号と、その種別。JSON として読めない・形が違う保存済みは「変わった」(スロットは不明)。 */
function diffSlots(storedData: string, nextData: string): { kind: "filled" | "changed"; slots: number[] } {
  let a: unknown;
  try {
    a = JSON.parse(storedData);
  } catch {
    return { kind: "changed", slots: [] };
  }
  const b = JSON.parse(nextData) as unknown[];
  if (!Array.isArray(a) || a.length !== b.length) {
    return { kind: "changed", slots: [] };
  }
  const slots: number[] = [];
  let onlyFills = true;
  for (let i = 0; i < b.length; i += 1) {
    if (JSON.stringify(a[i]) === JSON.stringify(b[i])) {
      continue;
    }
    slots.push(i);
    if (!(isEmptySlot(a[i]) && !isEmptySlot(b[i]))) {
      onlyFills = false;
    }
  }
  return { kind: slots.length > 0 && onlyFills ? "filled" : "changed", slots };
}

function kindOf(run: HorseRaceResult): RunKind {
  return run.venueKind === "中央" ? "central" : run.venueKind === "地方" ? "nar" : "overseas";
}

/**
 * 保存済みの行と突き合わせて、書く行(新規・上書き)と集計の素を作る。副作用なし。
 * `stored` は、入力の馬の保存済みの行(他の馬の行が混ざっていてもよい)。
 */
export function planHorseRunsSave(input: PlanInput, stored: readonly StoredRun[]): HorseRunsPlan {
  const byHorse = new Map<string, Map<string, StoredRun>>();
  for (const row of stored) {
    let m = byHorse.get(row.horseId);
    if (m === undefined) {
      m = new Map();
      byHorse.set(row.horseId, m);
    }
    m.set(row.raceKey, row);
  }
  const today = jstDay(input.savedAt);
  const inserts: PlannedRun[] = [];
  const updates: PlannedRun[] = [];
  const newRows: NewRow[] = [];
  const samples: MismatchSample[] = [];
  const horsePlans: HorseRunsPlan["horsePlans"] = [];
  const counts = { offered: 0, noKey: 0, dupInInput: 0, dupSameDay: 0, dupEarlier: 0, filled: 0, changed: 0, reparsed: 0, storedNewer: 0 };

  for (const horse of input.horses) {
    const known = byHorse.get(horse.horseId) ?? new Map<string, StoredRun>();
    const firstSeen = known.size === 0;
    const seen = new Set<string>();
    const horseNewKeys: string[] = [];
    for (const run of horse.results) {
      counts.offered += 1;
      const key = horseRunKey(run);
      if (key === null) {
        counts.noKey += 1;
        continue;
      }
      if (seen.has(key)) {
        counts.dupInInput += 1;
        continue;
      }
      seen.add(key);
      const data = JSON.stringify(encodeHorseRun(run));
      const old = known.get(key);
      if (old === undefined) {
        inserts.push({ horseId: horse.horseId, raceKey: key, parserVersion: HORSE_RUN_PARSER_VERSION, firstSeenAt: input.savedAt, data });
        newRows.push({ horseId: horse.horseId, key, kind: kindOf(run), firstSeenHorse: firstSeen });
        horseNewKeys.push(key);
        continue;
      }
      if (old.parserVersion > HORSE_RUN_PARSER_VERSION) {
        counts.storedNewer += 1;
        continue;
      }
      if (old.parserVersion < HORSE_RUN_PARSER_VERSION) {
        counts.reparsed += 1;
        updates.push({ horseId: horse.horseId, raceKey: key, parserVersion: HORSE_RUN_PARSER_VERSION, firstSeenAt: old.firstSeenAt, data });
        continue;
      }
      if (old.data === data) {
        if (jstDay(old.firstSeenAt) === today) {
          counts.dupSameDay += 1;
        } else {
          counts.dupEarlier += 1;
        }
        continue;
      }
      const diff = diffSlots(old.data, data);
      if (diff.kind === "filled") {
        counts.filled += 1;
      } else {
        counts.changed += 1;
      }
      if (samples.length < MISMATCH_SAMPLE_LIMIT) {
        samples.push({ horseId: horse.horseId, raceKey: key, kind: diff.kind, slots: diff.slots });
      }
      updates.push({ horseId: horse.horseId, raceKey: key, parserVersion: HORSE_RUN_PARSER_VERSION, firstSeenAt: old.firstSeenAt, data });
    }
    horsePlans.push({ horseId: horse.horseId, firstSeen, newKeys: horseNewKeys });
  }

  const newKeys = [...new Set(newRows.map((r) => r.key).filter((k) => /^[0-9]{12}$/.test(k)))];
  return { input, inserts, updates, newKeys, newRows, counts, horsePlans, samples };
}

/**
 * 計画から集計を作る。`inResults` は newKeys のうち race_results にあるレース ID(引けなかったら null)。
 * `rowsWrittenRuns` は行の書き込みで D1 が報告した rows_written の合計。
 */
export function summarizeSave(plan: HorseRunsPlan, inResults: ReadonlySet<string> | null, rowsWrittenRuns: number): SaveStats {
  const known = inResults !== null;
  const newByKind = { central: 0, nar: 0, overseas: 0 };
  let newInResults = 0;
  let rowsNewFromFirstSeen = 0;
  for (const row of plan.newRows) {
    newByKind[row.kind] += 1;
    if (row.firstSeenHorse) {
      rowsNewFromFirstSeen += 1;
    }
    if (known && inResults.has(row.key)) {
      newInResults += 1;
    }
  }
  let horsesFirstSeen = 0;
  let horsesZeroNew = 0;
  let horsesNewAllInResults = 0;
  let horsesNewSomeNotInResults = 0;
  for (const h of plan.horsePlans) {
    if (h.firstSeen) {
      horsesFirstSeen += 1;
    } else if (h.newKeys.length === 0) {
      horsesZeroNew += 1;
    } else if (known) {
      if (h.newKeys.every((k) => inResults.has(k))) {
        horsesNewAllInResults += 1;
      } else {
        horsesNewSomeNotInResults += 1;
      }
    }
  }
  const c = plan.counts;
  return {
    v: 1,
    raceId: plan.input.raceId,
    kaisaiDate: plan.input.kaisaiDate,
    savedAt: plan.input.savedAt,
    horses: plan.input.horses.length,
    horsesFirstSeen,
    horsesZeroNew,
    horsesNewAllInResults,
    horsesNewSomeNotInResults,
    inResultsKnown: known,
    rowsOffered: c.offered,
    rowsNoKey: c.noKey,
    rowsDupInInput: c.dupInInput,
    rowsNew: plan.newRows.length,
    rowsNewFromFirstSeen,
    newByKind,
    newInResults,
    rowsDupSameDay: c.dupSameDay,
    rowsDupEarlier: c.dupEarlier,
    rowsFilled: c.filled,
    rowsChanged: c.changed,
    rowsReparsed: c.reparsed,
    rowsStoredNewer: c.storedNewer,
    mismatchSamples: plan.samples,
    rowsWrittenRuns,
  };
}
