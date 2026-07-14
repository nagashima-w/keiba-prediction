/**
 * 分析パイプライン(main プロセス)。
 *
 * 1レース分の分析を次の順で実行し、途中経過を進捗コールバックで通知する:
 *   スクレイピング(scrapeRace) → スコアリング(buildPriorInput × 全頭 → computeFieldPriors)
 *   → LLM分析(analyzeRace。未設定ならスキップし prior を採用) → EV計算(computeRaceEv)
 *   → 保存(AnalysisStore.saveAnalysis) → 結果を返す
 *
 * テスト容易性の設計:
 * - 実IO(scrapeRace のフェッチャ・LLM・SQLite)は AnalysisPipelineDeps として関数注入する。
 *   本番配線(fetcher/store/llm から deps を組む)は pipeline-deps.ts に分離し、この runAnalysis 自体は
 *   注入されたスタブだけで完結してユニットテストできる(実ネットワーク・実APIのテストは書かない)。
 * - core は @keiba/core バレルから import する。scraper/ev(better-sqlite3 等のネイティブ依存)を
 *   正当に使うため、main バンドルにネイティブ依存が入るのはこのファイルからが起点となる
 *   (bundle.test.ts は「external 指定の維持」を検証する方針へ更新済み)。
 *
 * 推定EV(Task#25): 発売前(race.odds.oddsStatus === "yoso")は複勝オッズが常に空
 * (scraper/parse-odds.ts・parse-nar-odds.ts の仕様により odds.place = {})になるため、
 * 通常の computeRaceEv(確定EV)では全馬 ev=null になってしまう。そこで yoso のときだけ
 * core computeEstimatedRaceEv(単勝オッズから複勝下限を概算)を使い、EVプラス判定を含めた
 * 概算EVをレース単位で計算する。結果・保存レコードには evEstimated フラグ(レース単位、
 * oddsStatus=yoso と等価)を持たせ、確定EVと明確に区別できるようにする(UI表示・verify集計の
 * 両方でこのフラグを参照する)。中央・地方(NAR)いずれも odds.win に予想単勝オッズが入るため、
 * この分岐だけで両者に対応できる。
 *
 * 会場名・開催日・開催区分(中央/地方)の扱い:
 * - 会場名は scrapeRace のレース情報に含まれないため、レースIDの場コードから導出する(venue-codes。
 *   中央10場・地方(NAR)いずれにも対応する)。
 * - 開催区分(venueKind: "central" | "nar")もレースIDの場コードから venueKindOfRaceId で導出し、
 *   buildPriorInput の race.venueKind に渡す(NARでは競馬場適性・コース枠順バイアス・輸送滞在
 *   バイアスを対象外にする。詳細は core prior.ts の TodayRaceConditions.venueKind コメント参照)。
 * - 開催日(カレンダー日付)は出馬表・レース一覧のいずれからも取得できない(NARのレースIDには
 *   月日が直接埋め込まれているが、UI側で選択済みの日付と過不足なく一致する保証がないため、
 *   中央と同様に kaisaiDate をそのまま用いる方式で統一する)。UI 側で選択済みの開催日(kaisaiDate)を
 *   受け取り、これを race.date(季節分類・休み明け走目の起点)に用いる。
 *   万一 kaisaiDate が渡らなかった場合のみ、当日日付で近似し dateApproximate=true を結果に含める。
 */

import {
  buildPriorInput,
  classifyRotationInterval,
  classifyTrackWetness,
  computeEstimatedRaceEv,
  computeFieldPriors,
  computeRaceEv,
  computeReferenceEv,
  daysBetweenDates,
  DEFAULT_ESTIMATED_PLACE_CONFIG,
  DEFAULT_EV_CONFIG,
  PROMPT_VERSION,
  venueKindOfRaceId,
  type AnalysisRecord,
  type AnalyzeRaceResult,
  type BuildPromptInput,
  type EstimatedPlaceConfig,
  type EvConfig,
  type HorsePrior,
  type HorseRaceResult,
  type KaisaiDate,
  type PredictionMark,
  type PriorInput,
  type RaceData,
  type RaceId,
  type ScorerConfig,
} from "@keiba/core";

import type {
  AnalysisProgress,
  AnalysisResult,
  AnalysisRow,
} from "../shared/analysis-types.js";
import { venueNameFromRaceId } from "./venue-codes.js";

/** runAnalysis に注入する依存。すべて関数注入でモック可能。 */
export interface AnalysisPipelineDeps {
  /** レースデータ取得(通常は core scrapeRace を fetcher で束縛したもの)。 */
  readonly scrape: (raceId: RaceId) => Promise<RaceData>;
  /**
   * LLM分析関数(通常は core analyzeRace を LlmClient で束縛したもの)。
   * null のときは LLM分析をスキップし、prior をそのまま補正後確率として採用する。
   */
  readonly analyze:
    | ((input: BuildPromptInput) => Promise<AnalyzeRaceResult>)
    | null;
  /** 分析結果の保存(通常は AnalysisStore.saveAnalysis)。採番IDを返す。 */
  readonly saveAnalysis: (record: AnalysisRecord) => number;
  /** 現在時刻(analyzedAt・当日近似日付に使う)。既定 () => new Date()。 */
  readonly now?: () => Date;
  /** EV設定(閾値)。省略時は既定(閾値1.0)。 */
  readonly evConfig?: EvConfig;
  /**
   * 推定複勝下限の換算係数(Task#25)。省略時は既定(coef=0.2)。
   * oddsStatus="yoso"(発売前)のときだけ使われる。
   */
  readonly estimatedPlaceConfig?: EstimatedPlaceConfig;
  /** scorer設定。省略時は core の既定。 */
  readonly scorerConfig?: ScorerConfig;
  /** LLMスキップ理由(analyze=null のとき結果メタに載せる文言)。 */
  readonly llmSkipReason?: string;
  /**
   * プロンプト追加指示(設定画面、Task#28 プロンプト改善C)。省略時・空文字・空白のみは
   * 何も注入しない(undefinedとしてBuildPromptInputへ渡す)。トリムした値を
   * BuildPromptInput.additionalInstruction に渡し、LLM使用時のみ分析レコードにも保存する
   * (LLMスキップ時はプロンプト自体を使っていないため null を保存する。promptVersionと同じ方針)。
   */
  readonly additionalInstruction?: string | null;
}

/** LLM分析後の1頭分(補正後確率と根拠)。 */
interface AdjustedHorse {
  readonly adjustedProb: number;
  readonly reason: string | null;
  /** 予想印(Task#23)。LLM未使用・分析結果に含まれない馬番は null。 */
  readonly mark: PredictionMark | null;
}

/** Date を YYYY/MM/DD に整形する(buildPriorInput の date 形式に合わせる)。 */
function toYmdSlash(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

/**
 * 分析に用いる開催日(YYYY/MM/DD)を解決する純関数。
 * kaisaiDate(YYYYMMDD)が渡ればそれを変換して用い、近似ではない(approximate=false)。
 * 渡らない(null / 8桁でない)場合のみ当日日付で近似する(approximate=true)。
 * @param kaisaiDate 選択済み開催日(YYYYMMDD)。渡らない場合は null。
 * @param now 現在時刻取得関数(近似フォールバック用)。
 */
export function resolveAnalysisDate(
  kaisaiDate: string | null,
  now: () => Date,
): { date: string; approximate: boolean } {
  if (kaisaiDate !== null && /^[0-9]{8}$/.test(kaisaiDate)) {
    const date = `${kaisaiDate.slice(0, 4)}/${kaisaiDate.slice(4, 6)}/${kaisaiDate.slice(6, 8)}`;
    return { date, approximate: false };
  }
  return { date: toYmdSlash(now()), approximate: true };
}

/** 直近走(戦績の先頭)から開催日までの間隔を分類テキストにする。判定不能なら null。 */
function restIntervalOf(
  results: readonly HorseRaceResult[],
  analysisDate: string,
): string | null {
  const last = results[0];
  if (last === undefined) {
    return null;
  }
  const days = daysBetweenDates(last.date, analysisDate);
  const interval = classifyRotationInterval(days);
  return interval === "不明" ? null : interval;
}

/**
 * 1レースを分析する。
 * @param raceId 対象レースID(検証済み)
 * @param kaisaiDate 選択済み開催日(YYYYMMDD)。null の場合のみ当日日付で近似する。
 * @param deps 注入依存(scrape/analyze/saveAnalysis ほか)
 * @param onProgress 進捗コールバック(省略可)
 */
export async function runAnalysis(
  raceId: RaceId,
  kaisaiDate: KaisaiDate | null,
  deps: AnalysisPipelineDeps,
  onProgress?: (progress: AnalysisProgress) => void,
): Promise<AnalysisResult> {
  const now = deps.now ?? (() => new Date());
  const notify = (progress: AnalysisProgress): void => {
    onProgress?.(progress);
  };
  // プロンプト追加指示(Task#28): 空文字・空白のみ・未指定は「注入なし」として扱う。
  const trimmedInstruction = (deps.additionalInstruction ?? "").trim();

  // (1) スクレイピング。
  notify({
    stage: "スクレイピング",
    current: null,
    total: null,
    message: "レースデータを取得しています…",
  });
  const race = await deps.scrape(raceId);
  const horseCount = race.horses.length;
  notify({
    stage: "スクレイピング",
    current: horseCount,
    total: horseCount,
    message: `レースデータを取得しました(${horseCount}頭)`,
  });

  // 会場名・開催区分(中央/地方)はレースIDの場コードから、開催日は選択済み kaisaiDate から解決する。
  const venueName = venueNameFromRaceId(raceId);
  const venueKind = venueKindOfRaceId(raceId);
  const { date: analysisDate, approximate: dateApproximate } =
    resolveAnalysisDate(kaisaiDate, now);
  const isWet =
    classifyTrackWetness(race.race.trackCondition ?? null, race.race.courseType)
      ?.isWet ?? false;

  // (2) スコアリング(各馬の PriorInput を組み立て、頭数レベルで prior を合成)。
  const priorInputs: PriorInput[] = race.horses.map((horseData, index) => {
    notify({
      stage: "スコアリング",
      current: index + 1,
      total: horseCount,
      message: `スコアリング中(${index + 1}/${horseCount}頭)`,
    });
    return buildPriorInput({
      horse: horseData.shutuba,
      raceResults: horseData.results ?? [],
      race: {
        courseType: race.race.courseType,
        distance: race.race.distance,
        venueName,
        isWet,
        date: analysisDate,
        venueKind,
      },
      fieldSize: horseCount,
      config: deps.scorerConfig,
    });
  });
  const priors = computeFieldPriors(priorInputs);
  // 馬番 → prior(寄与度ログを含む)。以降の突合に使う。
  const priorByUmaban = new Map(
    race.horses.map((h, i) => [h.shutuba.umaban, priors[i]!]),
  );

  // (3) LLM分析(未設定ならスキップして prior を採用)。
  let llmUsed = false;
  let llmSkippedReason: string | null = null;
  let fallback = false;
  const adjustedByUmaban = new Map<number, AdjustedHorse>();

  if (deps.analyze === null) {
    llmSkippedReason = deps.llmSkipReason ?? "LLM分析はスキップされました";
    notify({
      stage: "LLM分析",
      current: null,
      total: null,
      message: `LLM分析をスキップしました(${llmSkippedReason})`,
    });
    for (const h of race.horses) {
      adjustedByUmaban.set(h.shutuba.umaban, {
        adjustedProb: priorByUmaban.get(h.shutuba.umaban)!.prior,
        reason: null,
        mark: null,
      });
    }
  } else {
    notify({
      stage: "LLM分析",
      current: null,
      total: null,
      message: "LLMで複勝確率を補正しています…",
    });
    const promptInput: BuildPromptInput = {
      race: {
        raceName: race.race.raceName,
        courseType: race.race.courseType,
        distance: race.race.distance,
        venueName,
        weather: race.race.weather ?? null,
        trackCondition: race.race.trackCondition ?? null,
      },
      horses: race.horses.map((horseData) => {
        const umaban = horseData.shutuba.umaban;
        const prior = priorByUmaban.get(umaban)!.prior;
        // 市場データ(Task#22: 予想印の判断材料)。oddsStatus="yoso"(複勝未発売)では
        // race.odds.place が空になるため placeOddsMin/referenceEv は自然に null になる。
        // winOdds(単勝)は yoso でも予想オッズ値が入るためそのまま渡す。
        const winOdds = race.odds.win[umaban]?.odds ?? null;
        const popularity = race.odds.win[umaban]?.ninki ?? null;
        const placeOddsMin = race.odds.place[umaban]?.oddsMin ?? null;
        return {
          umaban,
          horseName: horseData.shutuba.name,
          prior,
          oikiri: horseData.oikiri
            ? { critic: horseData.oikiri.critic, rank: horseData.oikiri.rank }
            : null,
          runs: (horseData.results ?? []).map((r) => ({
            passing: r.passing,
            fieldSize: r.entryCount,
          })),
          // 直近走から開催日までの間隔(仕様L100「レース間隔」)。判定不能なら未指定(「不明」表記)。
          restInterval: restIntervalOf(horseData.results ?? [], analysisDate),
          winOdds,
          popularity,
          placeOddsMin,
          referenceEv: computeReferenceEv(prior, placeOddsMin),
        };
      }),
      additionalInstruction:
        trimmedInstruction === "" ? undefined : trimmedInstruction,
    };
    const analysis = await deps.analyze(promptInput);
    llmUsed = true;
    fallback = analysis.fallback;
    for (const h of analysis.horses) {
      adjustedByUmaban.set(h.umaban, {
        adjustedProb: h.adjustedProb,
        reason: h.reason,
        mark: h.mark,
      });
    }
    // 分析結果に含まれない馬番(理論上は無いが安全側)は prior を採用する。
    for (const h of race.horses) {
      if (!adjustedByUmaban.has(h.shutuba.umaban)) {
        adjustedByUmaban.set(h.shutuba.umaban, {
          adjustedProb: priorByUmaban.get(h.shutuba.umaban)!.prior,
          reason: null,
          mark: null,
        });
      }
    }
  }

  // (4) EV計算(補正後確率 × 複勝オッズ下限)。
  // 発売前(yoso)は複勝オッズが常に空のため、単勝オッズからの推定EV(computeEstimatedRaceEv)に
  // 切り替える。それ以外(result/middle)は従来どおり確定EV(computeRaceEv)。
  const evPriors: HorsePrior[] = race.horses.map((h) => ({
    umaban: h.shutuba.umaban,
    placeProb: adjustedByUmaban.get(h.shutuba.umaban)!.adjustedProb,
  }));
  const evEstimated = race.odds.oddsStatus === "yoso";
  const evResults = evEstimated
    ? computeEstimatedRaceEv(
        evPriors,
        race.odds,
        deps.evConfig ?? DEFAULT_EV_CONFIG,
        deps.estimatedPlaceConfig ?? DEFAULT_ESTIMATED_PLACE_CONFIG,
      )
    : computeRaceEv(evPriors, race.odds, deps.evConfig ?? DEFAULT_EV_CONFIG);
  const evByUmaban = new Map(evResults.map((e) => [e.umaban, e]));

  // (5) 保存。
  const analyzedAt = now().toISOString();
  notify({
    stage: "保存",
    current: null,
    total: null,
    message: "分析結果を保存しています…",
  });
  const record: AnalysisRecord = {
    raceId,
    analyzedAt,
    evEstimated,
    // プロンプト版番号(Task#27): LLMを実際に使った(プロンプトを送った)分析のみ PROMPT_VERSION を
    // 記録する。LLMスキップ(prior採用)はプロンプト自体を使っていないため null(版不明とは別の
    // 「該当なし」だが、verifyの版別集計では版不明と同じ null グループにまとめて扱う)。
    promptVersion: llmUsed ? PROMPT_VERSION : null,
    // 追加指示(Task#28): プロンプトを実際に送った(LLMを使った)分析のみ記録する。
    // LLMスキップ(prior採用)はプロンプト自体を使っていないため null(promptVersionと同じ方針)。
    additionalInstruction:
      llmUsed && trimmedInstruction !== "" ? trimmedInstruction : null,
    horses: race.horses.map((h) => {
      const umaban = h.shutuba.umaban;
      const prior = priorByUmaban.get(umaban)!;
      const adjusted = adjustedByUmaban.get(umaban)!;
      const ev = evByUmaban.get(umaban)!;
      return {
        umaban,
        prior: prior.prior,
        adjustedProb: adjusted.adjustedProb,
        placeOddsMin: ev.placeOddsMin,
        ev: ev.ev,
        isPositive: ev.isPositive,
        contributions: prior.contributions,
        mark: adjusted.mark,
      };
    }),
  };
  deps.saveAnalysis(record);

  // (6) 結果組み立て(馬番昇順)。
  const rows: AnalysisRow[] = race.horses
    .map((h) => {
      const umaban = h.shutuba.umaban;
      const prior = priorByUmaban.get(umaban)!;
      const adjusted = adjustedByUmaban.get(umaban)!;
      const ev = evByUmaban.get(umaban)!;
      return {
        umaban,
        wakuban: h.shutuba.wakuban,
        horseName: h.shutuba.name,
        prior: prior.prior,
        adjustedProb: adjusted.adjustedProb,
        placeOddsMin: ev.placeOddsMin,
        ev: ev.ev,
        isPositive: ev.isPositive,
        reason: adjusted.reason,
        // 戦績走数(低データ判定用)。戦績取得失敗(results=null)は不明として null にし、
        // 新馬(results=[] → 0走)と区別する(妙味スコアの低データ集計から除外させる)。
        careerRunCount: h.results === null ? null : h.results.length,
        mark: adjusted.mark,
        evEstimated,
      };
    })
    .sort((a, b) => a.umaban - b.umaban);

  return {
    raceId,
    venueName,
    raceName: race.race.raceName,
    courseType: race.race.courseType,
    distance: race.race.distance,
    date: analysisDate,
    dateApproximate,
    llmUsed,
    llmSkippedReason,
    fallback,
    oddsStatus: race.odds.oddsStatus,
    rows,
    warnings: race.meta.warnings.map((w) => w.message),
    analyzedAt,
  };
}
