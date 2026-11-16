/**
 * レース詳細の馬の表の「騎手・調教師の指標」の列の材料(Issue #643。指標の作り方は #642、`market-edge-calc.ts`)。
 * `GET /api/analyses/{id}` の応答に、馬ごとの `marketEdge` と分析ごとの `marketEdgeNote`(注記の文)を足す。分析(LLM・配分)には使わない。
 *
 *  - 騎手・調教師の ID は分析の記録(`analysis.raceSnapshot`)から**直接**読む(core の `toSafeRaceSnapshot` は ID を捨てる)。名前は出馬表の書き方(`toSafeRaceSnapshot` の `jockeyName`・`trainerName`)。
 *    ID の無い馬(2026-10-29・30 より前の分析)は、**名前での引き当てをしない**(値と件数は null で、名前だけ残す)。
 *  - 列を出さない(`marketEdgeNote` が null)のは、地方のレース(指標は中央だけ)・詳細が present でない・指標の記録が無い・読み出しの失敗・どの馬にも値が付かないとき。
 *  - 文はここで組み立てる(クライアントの束に日本語を置くと、`\uXXXX` で 1 文字 6 バイトになるため)。値の整形(「+3.0pt」)と「少」の判定(件数)は画面側。
 *  - D1 の読みは `readForRace`(主キーの引き。出走頭数 × 2 + 記録 1 行)。例外は握って null(`close`・`previousDiff` と同じく、本体の応答を壊さない)。
 */
import { toSafeRaceSnapshot } from "../../packages/core/src/analysis/analysis-export";
import { venueKindOfRaceIdSafe } from "./analysis-close";
import type { AnalysisView, AnalysisViewHorse } from "./analysis-view";
import type { AnalysisDetailResult } from "./analysis-repository";
import type { MarketEdgeForRace } from "./market-edge-repository";

/** 1 人分(騎手か調教師)。値と件数は、ID が無い・表に無い・値が壊れているとき null。 */
export interface MarketPersonView {
  readonly name: string | null;
  /** 指標(読み残しの合計 ÷ (件数 + 30)。0.03 = 3.0 ポイント)。 */
  readonly edge: number | null;
  readonly n: number | null;
}

export interface HorseMarketEdgeView {
  readonly jockey: MarketPersonView;
  readonly trainer: MarketPersonView;
}

/** 読み出す側(D1MarketEdgeStore の使う部分)。 */
export interface MarketEdgeReader {
  readForRace(jockeyIds: readonly string[], trainerIds: readonly string[]): Promise<MarketEdgeForRace>;
}

interface HorseIds {
  readonly umaban: number;
  readonly jockeyId: string | null;
  readonly trainerId: string | null;
  readonly jockeyName: string | null;
  readonly trainerName: string | null;
}

/** {@link loadMarketEdge} の結果(`attachMarketEdge` に渡す)。 */
export interface LoadedMarketEdge {
  readonly note: string;
  readonly byUmaban: ReadonlyMap<number, HorseMarketEdgeView>;
}

const nonEmptyString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** スナップショットの生の JSON から、馬ごとの ID と名前を読む(壊れた形は空)。 */
function horseIdsOf(raw: unknown): HorseIds[] {
  const names = toSafeRaceSnapshot(raw).horsesByUmaban;
  const rawHorses = typeof raw === "object" && raw !== null && Array.isArray((raw as { horses?: unknown }).horses) ? ((raw as { horses: unknown[] }).horses) : [];
  const out: HorseIds[] = [];
  const seen = new Set<number>();
  for (const h of rawHorses) {
    if (typeof h !== "object" || h === null) continue;
    const rec = h as Record<string, unknown>;
    const umaban = rec["umaban"];
    if (typeof umaban !== "number" || seen.has(umaban)) continue;
    seen.add(umaban);
    const named = names.get(umaban);
    out.push({
      umaban,
      jockeyId: nonEmptyString(rec["jockeyId"]),
      trainerId: nonEmptyString(rec["trainerId"]),
      jockeyName: nonEmptyString(named?.jockeyName),
      trainerName: nonEmptyString(named?.trainerName),
    });
  }
  return out;
}

const finiteOrNull = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function personOf(name: string | null, found: { readonly n: number; readonly edge: number } | undefined): MarketPersonView {
  const edge = finiteOrNull(found?.edge);
  const n = finiteOrNull(found?.n);
  // 値と件数は対で扱う(片方が壊れていれば、どちらも出さない)。件数は 0 以上。
  return edge === null || n === null || n < 0 ? { name, edge: null, n: null } : { name, edge, n };
}

/** 注記の文(表の下に 1 回)。窓と計算日は記録(meta)から。 */
function noteOf(meta: { readonly computedOn: string; readonly windowFrom: string; readonly windowTo: string }): string {
  return (
    `騎手・調教師の列は参考(確かめ中)です。時期を分けて確かめた値ではなく、分析(LLM・配分)には使っていません。` +
    `値は、${meta.windowFrom}〜${meta.windowTo} の中央のレースで、その騎手が乗った馬(その調教師の馬)が、単勝オッズから見込まれる3着内の確率より何ポイント多く3着内に来たかです` +
    `(+3.0pt なら、100 回で約 3 回多い)。件数が少ない人(「少」の印)は 0 に寄せてあります。` +
    `値は ${meta.computedOn} に計算したもので、分析した時点の値ではありません。`
  );
}

/**
 * 列の材料を読む。列を出さないときと、読み出しの失敗は null(投げない)。
 * 地方・詳細が present でないときは、D1 を読まない。
 */
export async function loadMarketEdge(store: MarketEdgeReader, result: AnalysisDetailResult): Promise<LoadedMarketEdge | null> {
  try {
    if (result.detail !== "present" || venueKindOfRaceIdSafe(result.analysis.raceId) === "nar") return null;
    const horses = horseIdsOf(result.analysis.raceSnapshot);
    if (horses.length === 0) return null;
    const jockeyIds = horses.flatMap((h) => (h.jockeyId === null ? [] : [h.jockeyId]));
    const trainerIds = horses.flatMap((h) => (h.trainerId === null ? [] : [h.trainerId]));
    const data = await store.readForRace([...new Set(jockeyIds)], [...new Set(trainerIds)]);
    if (data.meta === null) return null;
    const byUmaban = new Map<number, HorseMarketEdgeView>();
    for (const h of horses) {
      byUmaban.set(h.umaban, {
        jockey: personOf(h.jockeyName, h.jockeyId === null ? undefined : data.jockeys.get(h.jockeyId)),
        trainer: personOf(h.trainerName, h.trainerId === null ? undefined : data.trainers.get(h.trainerId)),
      });
    }
    // どの馬にも値が付かないときは、「—」だけの列になるので出さない。
    if (![...byUmaban.values()].some((v) => v.jockey.edge !== null || v.trainer.edge !== null)) return null;
    return { note: noteOf(data.meta), byUmaban };
  } catch {
    // 例外の文面は返さない。
    return null;
  }
}

export type AnalysisViewWithMarketEdge = Omit<AnalysisView, "horses"> & {
  readonly horses: readonly (AnalysisViewHorse & { readonly marketEdge: HorseMarketEdgeView | null })[];
  readonly marketEdgeNote: string | null;
};

/** 応答に列の材料を足す(元の view は変えない)。null なら、全馬 null・注記 null(列を出さない)。 */
export function attachMarketEdge(view: AnalysisView, loaded: LoadedMarketEdge | null): AnalysisViewWithMarketEdge {
  return {
    ...view,
    horses: view.horses.map((h) => ({ ...h, marketEdge: loaded?.byUmaban.get(h.umaban) ?? null })),
    marketEdgeNote: loaded === null ? null : loaded.note,
  };
}
