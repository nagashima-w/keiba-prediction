/**
 * 分析データのエクスポート(第一版・GitHub Issue#10)。
 *
 * レース単位の JSON(schemaVersion=1)+ 馬別 CSV を組み立てる純関数群。electron・IO に一切
 * 依存しないため、ユニットテストだけで完結させられる(log-export.ts と同じ流儀)。
 * 実ファイル書き込み(dialog.showSaveDialog → writeFileSync)は呼び出し側(main/ipc.ts)が担う。
 *
 * データの出どころ:
 * - meta/horses(prior・adjustedProb・ev・isPositive・mark・reason・placeOddsMin)は
 *   AnalysisStore.listAnalyses が返す StoredAnalysis(analyses・analysis_horses)から。
 *   placeOddsMinはスナップショットの生オッズではなく、実際にEV計算へ使った値(ev/isPositiveと対)を
 *   採用する。
 * - horses の出馬表項目(wakuban・name・sex・age・kinryo・jockeyName・trainerName・bodyWeight)・
 *   単勝オッズ(winOdds・popularity)・調教(oikiriCritic・oikiriRank)は
 *   StoredAnalysis.raceSnapshot(analysis-store.ts に保存したレース情報スナップショット
 *   〈race_snapshot_json〉)から。過去戦績(results[])はスナップショットに含めない(サイズ大)。
 * - results[](finishPosition・placePayout・passing・last3f)は AnalysisStore.getResult /
 *   getRaceResultDetail の2系統を umaban で突き合わせて組み立てる(AnalysisStore側では別々の
 *   メソッド・テーブルのため、ここで合流させる)。
 *
 * 防御的復元(旧レコード・破損データ):
 * StoredAnalysis.raceSnapshot は列追加前の旧レコードでは null、JSON破損時も
 * AnalysisStore側で既に null にフォールバック済み(analysis-store.ts toStoredRaceSnapshot)。
 * ここではさらに「null」「スキーマに一致しないunknown値」のいずれでも例外を投げず、
 * スナップショット由来の項目だけを null にフォールバックする(analysis_horses由来の
 * prior/adjustedProb/ev/isPositive/mark/reason は StoredAnalysisHorse から独立して取得できるため
 * 影響を受けない)。
 *
 * 秘密安全性: 入力(BuildAnalysisExportInput)は StoredAnalysis・レース結果・会場名・ツール情報のみで
 *構成され、設定(apiKey・Discord Webhook URL)やプロンプト本文を受け取る経路が無いため、
 * 出力(AnalysisExportDocument)にこれらが混入することは構造的にありえない。rawLlmResponse は
 * StoredAnalysis.rawResponse(LLMのモデル出力テキストのみ。analyze-race.ts の
 * AnalyzeRaceResult.rawResponse を分析実行時にそのまま保存したもの)をそのまま転記するだけで、
 * プロンプト本文は一切経由しない。
 */

import type {
  RaceData,
  RaceResultDetail,
  RaceResultEntry,
  StoredAnalysis,
} from "@keiba/core";

/** schemaVersion の現行値(第一版)。 */
export const ANALYSIS_EXPORT_SCHEMA_VERSION = 1 as const;

/** レース情報スナップショットの「レース」部分(Issue#10)。 */
export interface RaceSnapshotRace {
  readonly raceName: string | null;
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly weather: string | null;
  readonly trackCondition: string | null;
  readonly startTime: string | null;
  readonly fence: string | null;
  readonly oddsStatus: string | null;
  readonly officialDatetime: string | null;
}

/** レース情報スナップショットの「馬」部分(Issue#10)。過去戦績は含めない。 */
export interface RaceSnapshotHorse {
  readonly umaban: number;
  readonly wakuban: number | null;
  readonly name: string | null;
  readonly sex: string | null;
  readonly age: number | null;
  readonly kinryo: number | null;
  readonly jockeyName: string | null;
  readonly trainerName: string | null;
  readonly bodyWeight: number | null;
  readonly winOdds: number | null;
  readonly popularity: number | null;
  readonly placeOddsMin: number | null;
  readonly oikiriCritic: string | null;
  readonly oikiriRank: string | null;
}

/** 取得したレース情報のスナップショット(analyses.race_snapshot_jsonに保存する形)。 */
export interface RaceSnapshot {
  readonly race: RaceSnapshotRace;
  readonly horses: readonly RaceSnapshotHorse[];
}

/**
 * scrapeRace が返した RaceData から、保存用のレース情報スナップショットを組み立てる。
 * 過去戦績(horseData.results)は意図的に含めない(サイズ大。承認済みスコープ外)。
 * @param race スクレイピング直後のレースデータ
 */
export function buildRaceSnapshot(race: RaceData): RaceSnapshot {
  return {
    race: {
      raceName: race.race.raceName,
      courseType: race.race.courseType,
      distance: race.race.distance,
      weather: race.race.weather ?? null,
      trackCondition: race.race.trackCondition ?? null,
      startTime: race.race.startTime ?? null,
      fence: race.race.fence ?? null,
      oddsStatus: race.odds.oddsStatus,
      officialDatetime: race.odds.officialDatetime,
    },
    horses: race.horses.map((h) => {
      const umaban = h.shutuba.umaban;
      return {
        umaban,
        wakuban: h.shutuba.wakuban,
        name: h.shutuba.name,
        sex: h.shutuba.sex,
        age: h.shutuba.age,
        kinryo: h.shutuba.kinryo,
        jockeyName: h.shutuba.jockeyName,
        trainerName: h.shutuba.trainerName,
        bodyWeight: h.shutuba.bodyWeight?.weight ?? null,
        winOdds: race.odds.win[umaban]?.odds ?? null,
        popularity: race.odds.win[umaban]?.ninki ?? null,
        placeOddsMin: race.odds.place[umaban]?.oddsMin ?? null,
        oikiriCritic: h.oikiri?.critic ?? null,
        oikiriRank: h.oikiri?.rank ?? null,
      };
    }),
  };
}

/** buildRaceSnapshot が組み立てた RaceSnapshotRace の既定値(スナップショット欠損・不正時)。 */
const EMPTY_SNAPSHOT_RACE: RaceSnapshotRace = {
  raceName: null,
  courseType: null,
  distance: null,
  weather: null,
  trackCondition: null,
  startTime: null,
  fence: null,
  oddsStatus: null,
  officialDatetime: null,
};

/**
 * StoredAnalysis.raceSnapshot(unknown。JSON復元済みだが型未検証)を安全に RaceSnapshot として
 * 解釈する。null・オブジェクトでない・想定した形と異なる場合は例外を投げず、
 * 「レース情報スナップショット全体が無い」ものとして扱う(防御的復元)。
 * horses は配列であれば要素ごとに umaban→馬情報のMapとして使えるようにする(不正な要素はスキップ)。
 */
function toSafeRaceSnapshot(raw: unknown): {
  readonly race: RaceSnapshotRace;
  readonly horsesByUmaban: ReadonlyMap<number, RaceSnapshotHorse>;
} {
  if (typeof raw !== "object" || raw === null) {
    return { race: EMPTY_SNAPSHOT_RACE, horsesByUmaban: new Map() };
  }
  const obj = raw as Record<string, unknown>;
  const raceRaw = obj.race;
  const race: RaceSnapshotRace =
    typeof raceRaw === "object" && raceRaw !== null
      ? { ...EMPTY_SNAPSHOT_RACE, ...(raceRaw as Partial<RaceSnapshotRace>) }
      : EMPTY_SNAPSHOT_RACE;

  const horsesByUmaban = new Map<number, RaceSnapshotHorse>();
  const horsesRaw = obj.horses;
  if (Array.isArray(horsesRaw)) {
    for (const h of horsesRaw as unknown[]) {
      if (typeof h !== "object" || h === null) {
        continue;
      }
      const horse = h as Partial<RaceSnapshotHorse>;
      if (typeof horse.umaban !== "number") {
        continue;
      }
      horsesByUmaban.set(horse.umaban, {
        umaban: horse.umaban,
        wakuban: horse.wakuban ?? null,
        name: horse.name ?? null,
        sex: horse.sex ?? null,
        age: horse.age ?? null,
        kinryo: horse.kinryo ?? null,
        jockeyName: horse.jockeyName ?? null,
        trainerName: horse.trainerName ?? null,
        bodyWeight: horse.bodyWeight ?? null,
        winOdds: horse.winOdds ?? null,
        popularity: horse.popularity ?? null,
        placeOddsMin: horse.placeOddsMin ?? null,
        oikiriCritic: horse.oikiriCritic ?? null,
        oikiriRank: horse.oikiriRank ?? null,
      });
    }
  }
  return { race, horsesByUmaban };
}

/** エクスポートJSONのメタ情報(schemaVersion=1)。 */
export interface AnalysisExportMeta {
  readonly toolName: string;
  readonly toolVersion: string;
  /** エクスポート実行時刻(ISO8601)。 */
  readonly exportedAt: string;
  readonly analysisId: number;
  readonly analyzedAt: string;
  readonly kaisaiDate: string | null;
  readonly promptVersion: string | null;
  readonly additionalInstruction: string | null;
  /** 使用したLLMモデル名。LLMスキップ(prior採用)・旧レコードは null。 */
  readonly model: string | null;
  readonly evEstimated: boolean;
}

/** エクスポートJSONのレース情報(schemaVersion=1)。 */
export interface AnalysisExportRace {
  readonly raceId: string;
  readonly venueName: string;
  readonly raceName: string | null;
  readonly courseType: string | null;
  readonly distance: number | null;
  readonly weather: string | null;
  readonly trackCondition: string | null;
  readonly startTime: string | null;
  readonly fence: string | null;
  readonly oddsStatus: string | null;
  readonly officialDatetime: string | null;
}

/** エクスポートJSONの1頭分(schemaVersion=1)。 */
export interface AnalysisExportHorse {
  readonly umaban: number;
  readonly wakuban: number | null;
  readonly name: string | null;
  readonly sex: string | null;
  readonly age: number | null;
  readonly kinryo: number | null;
  readonly jockeyName: string | null;
  readonly trainerName: string | null;
  readonly bodyWeight: number | null;
  readonly winOdds: number | null;
  readonly popularity: number | null;
  readonly placeOddsMin: number | null;
  readonly oikiriCritic: string | null;
  readonly oikiriRank: string | null;
  readonly prior: number;
  readonly adjustedProb: number;
  readonly ev: number | null;
  readonly isPositive: boolean;
  readonly mark: string | null;
  readonly reason: string | null;
}

/** エクスポートJSONの実結果1頭分(schemaVersion=1)。 */
export interface AnalysisExportResult {
  readonly umaban: number;
  readonly finishPosition: number | null;
  readonly placePayout: number | null;
  readonly passing: readonly number[];
  readonly last3f: number | null;
}

/** エクスポートJSON全体(schemaVersion=1)。 */
export interface AnalysisExportDocument {
  readonly schemaVersion: 1;
  readonly meta: AnalysisExportMeta;
  readonly race: AnalysisExportRace;
  readonly horses: readonly AnalysisExportHorse[];
  readonly results: readonly AnalysisExportResult[];
  /** LLMの生応答テキスト(モデル出力のみ。プロンプト本文・apiKeyは含まない)。無ければ null。 */
  readonly rawLlmResponse: string | null;
}

/** buildAnalysisExportDocument への入力。 */
export interface BuildAnalysisExportInput {
  /** エクスポート対象の分析(通常は AnalysisStore.listAnalyses の結果から pickLatestAnalysis で選ぶ)。 */
  readonly analysis: StoredAnalysis;
  /** 会場名(レースIDの場コードから解決済みのもの。venue-codes.ts の venueNameFromRaceId)。 */
  readonly venueName: string;
  /** レース結果(AnalysisStore.getResult)。未取込なら undefined。 */
  readonly results?: readonly RaceResultEntry[];
  /** レース結果詳細(AnalysisStore.getRaceResultDetail)。未取込なら undefined。 */
  readonly resultDetail?: RaceResultDetail;
  /** ツール名(app-info.ts の APP_NAME)。 */
  readonly toolName: string;
  /** ツール版(app-info.ts の buildAppInfo().appVersion)。 */
  readonly toolVersion: string;
  /** エクスポート実行時刻(ISO8601)。呼び出し側が now().toISOString() を渡す想定。 */
  readonly exportedAt: string;
}

/**
 * BuildAnalysisExportInput のうち、DB(AnalysisStore)から組み立てられる部分だけを持つ型
 * (main/pipeline-deps.ts の getAnalysisExportInput が返す)。
 * toolName・toolVersion・exportedAt(electron/main固有の情報。app-info.ts の値・実行時刻)は
 * 含めない(呼び出し側〈main/ipc.ts〉が別途補って BuildAnalysisExportInput を完成させる)。
 */
export type AnalysisExportSource = Omit<
  BuildAnalysisExportInput,
  "toolName" | "toolVersion" | "exportedAt"
>;

/**
 * results[](finishPosition・placePayout・passing・last3f)を umaban で組み立てる。
 * getResult(placePayout)・getRaceResultDetail(passing・last3f)の2系統を突き合わせる。
 * どちらも未取込(undefined)なら空配列を返す(結果未取込の表現)。
 */
function buildExportResults(
  results: readonly RaceResultEntry[] | undefined,
  resultDetail: RaceResultDetail | undefined,
): AnalysisExportResult[] {
  const detailByUmaban = new Map(
    (resultDetail?.horses ?? []).map((h) => [h.umaban, h] as const),
  );
  const payoutByUmaban = new Map(
    (results ?? []).map((r) => [r.umaban, r] as const),
  );
  const umabans = new Set<number>([
    ...payoutByUmaban.keys(),
    ...detailByUmaban.keys(),
  ]);
  return [...umabans]
    .sort((a, b) => a - b)
    .map((umaban) => {
      const payoutEntry = payoutByUmaban.get(umaban);
      const detailEntry = detailByUmaban.get(umaban);
      return {
        umaban,
        finishPosition:
          detailEntry?.finishPosition ?? payoutEntry?.finishPosition ?? null,
        placePayout: payoutEntry?.placePayout ?? null,
        passing: detailEntry?.passing ?? [],
        last3f: detailEntry?.last3f ?? null,
      };
    });
}

/**
 * schemaVersion=1 のエクスポートJSONドキュメントを組み立てる。
 * @param input StoredAnalysis・レース結果・会場名・ツール情報
 */
export function buildAnalysisExportDocument(
  input: BuildAnalysisExportInput,
): AnalysisExportDocument {
  const { analysis } = input;
  const { race: snapshotRace, horsesByUmaban } = toSafeRaceSnapshot(
    analysis.raceSnapshot,
  );

  const horses: AnalysisExportHorse[] = analysis.horses.map((h) => {
    const snapshotHorse = horsesByUmaban.get(h.umaban);
    return {
      umaban: h.umaban,
      wakuban: snapshotHorse?.wakuban ?? null,
      name: snapshotHorse?.name ?? null,
      sex: snapshotHorse?.sex ?? null,
      age: snapshotHorse?.age ?? null,
      kinryo: snapshotHorse?.kinryo ?? null,
      jockeyName: snapshotHorse?.jockeyName ?? null,
      trainerName: snapshotHorse?.trainerName ?? null,
      bodyWeight: snapshotHorse?.bodyWeight ?? null,
      winOdds: snapshotHorse?.winOdds ?? null,
      popularity: snapshotHorse?.popularity ?? null,
      // placeOddsMinはスナップショットの複勝オッズ生値ではなく、analysis_horses側(EV計算に実際に
      // 使った値。ev/isPositiveと対になる)を正とする。yoso(複勝未発売)でスナップショット取得後に
      // 複勝オッズが確定した等のズレを避けるため、実際にEV計算へ使った値をそのまま出す。
      placeOddsMin: h.placeOddsMin,
      oikiriCritic: snapshotHorse?.oikiriCritic ?? null,
      oikiriRank: snapshotHorse?.oikiriRank ?? null,
      prior: h.prior,
      adjustedProb: h.adjustedProb,
      ev: h.ev,
      isPositive: h.isPositive,
      mark: h.mark,
      reason: h.reason,
    };
  });

  return {
    schemaVersion: ANALYSIS_EXPORT_SCHEMA_VERSION,
    meta: {
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      exportedAt: input.exportedAt,
      analysisId: analysis.id,
      analyzedAt: analysis.analyzedAt,
      kaisaiDate: analysis.kaisaiDate,
      promptVersion: analysis.promptVersion,
      additionalInstruction: analysis.additionalInstruction,
      model: analysis.model,
      evEstimated: analysis.evEstimated,
    },
    race: {
      raceId: analysis.raceId,
      venueName: input.venueName,
      raceName: snapshotRace.raceName,
      courseType: snapshotRace.courseType,
      distance: snapshotRace.distance,
      weather: snapshotRace.weather,
      trackCondition: snapshotRace.trackCondition,
      startTime: snapshotRace.startTime,
      fence: snapshotRace.fence,
      oddsStatus: snapshotRace.oddsStatus,
      officialDatetime: snapshotRace.officialDatetime,
    },
    horses,
    results: buildExportResults(input.results, input.resultDetail),
    rawLlmResponse: analysis.rawResponse,
  };
}

/** エクスポートJSONを整形済み文字列にする(改行・インデント付き。人が読める形)。 */
export function serializeAnalysisExportJson(doc: AnalysisExportDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * CSVのヘッダ順(AnalysisExportHorse + 結果4列)。
 * code-reviewer提案対応: 相互運用の完全性のため、JSON側に既にある結果の passing・last3f も
 * CSVへ追加する(finishPosition・placePayoutと同じ「結果があれば結合」列)。
 */
const CSV_COLUMNS = [
  "umaban",
  "wakuban",
  "name",
  "sex",
  "age",
  "kinryo",
  "jockeyName",
  "trainerName",
  "bodyWeight",
  "winOdds",
  "popularity",
  "placeOddsMin",
  "oikiriCritic",
  "oikiriRank",
  "prior",
  "adjustedProb",
  "ev",
  "isPositive",
  "mark",
  "reason",
  "finishPosition",
  "placePayout",
  "last3f",
  "passing",
] as const;

/**
 * CSVフィールド値をRFC4180準拠にエスケープする。
 * カンマ・ダブルクオート・CR・LFのいずれかを含む場合のみダブルクオートで囲み、
 * 内部のダブルクオートは2つに二重化する。null/undefinedは空文字列(空セル)にする。
 */
function csvEscape(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * 通過順位の配列をCSV1セル向けの文字列にする(例: [2,3,4,3] → "2-3-4-3")。
 * 空配列(結果未取込・通過順未保存)は空文字列にする(csvEscapeでの空セル表現と同じ意味)。
 */
function formatPassingForCsv(passing: readonly number[]): string {
  return passing.length === 0 ? "" : passing.join("-");
}

/**
 * 馬別CSV文字列を組み立てる(RFC4180準拠。改行はCRLF、ヘッダ行付き)。
 * horses を1行1頭とし、results(umabanが一致する行があれば)の finishPosition・placePayout・
 * last3f・passing(ハイフン連結)を結合する。結果が無い馬・レース未取込は該当4列を空セルにする。
 *
 * BOM(byte order mark)について(見送り・code-reviewer提案への回答): このCSVはExcelでの閲覧より
 * 他の予想ツール(スクリプト等)での読み込みを主目的とするため、素朴なパーサを壊しうるBOMは
 * 付与しない(log-export.ts の集約テキストと同じ無BOM方針)。
 */
export function serializeAnalysisExportCsv(doc: AnalysisExportDocument): string {
  const resultByUmaban = new Map(doc.results.map((r) => [r.umaban, r] as const));
  const rows = doc.horses.map((h) => {
    const result = resultByUmaban.get(h.umaban);
    const record: Record<(typeof CSV_COLUMNS)[number], string | number | boolean | null> = {
      umaban: h.umaban,
      wakuban: h.wakuban,
      name: h.name,
      sex: h.sex,
      age: h.age,
      kinryo: h.kinryo,
      jockeyName: h.jockeyName,
      trainerName: h.trainerName,
      bodyWeight: h.bodyWeight,
      winOdds: h.winOdds,
      popularity: h.popularity,
      placeOddsMin: h.placeOddsMin,
      oikiriCritic: h.oikiriCritic,
      oikiriRank: h.oikiriRank,
      prior: h.prior,
      adjustedProb: h.adjustedProb,
      ev: h.ev,
      isPositive: h.isPositive,
      mark: h.mark,
      reason: h.reason,
      finishPosition: result?.finishPosition ?? null,
      placePayout: result?.placePayout ?? null,
      last3f: result?.last3f ?? null,
      passing: result === undefined ? null : formatPassingForCsv(result.passing),
    };
    return CSV_COLUMNS.map((col) => csvEscape(record[col])).join(",");
  });
  const header = CSV_COLUMNS.join(",");
  return [header, ...rows].map((line) => `${line}\r\n`).join("");
}

/**
 * 同一レースの複数分析(AnalysisStore.listAnalyses({raceId})の結果、ID昇順)から、
 * エクスポート対象とする最新(id最大)の分析を決定的に選ぶ。空配列なら null。
 * @param analyses 対象候補(順不同でよい)
 */
export function pickLatestAnalysis<T extends { readonly id: number }>(
  analyses: readonly T[],
): T | null {
  if (analyses.length === 0) {
    return null;
  }
  return analyses.reduce((latest, a) => (a.id > latest.id ? a : latest));
}

/**
 * エクスポートの既定ファイル名(レースID+YYYYMMDD付き。log-export.ts の
 * buildDefaultLogExportFileName と同流儀)。JSON側の既定名で、CSV側は
 * deriveCsvPathFromJsonPath で導出する(ユーザーが選んだ保存先から拡張子だけ置き換える)。
 * ローカル日時基準(既存コードと同じ流儀)。
 * @param raceId 対象レースID(12桁)
 * @param date 現在時刻
 */
export function buildDefaultAnalysisExportFileName(
  raceId: string,
  date: Date,
): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `keiba-ev-tool-analysis-${raceId}-${y}${m}${d}.json`;
}

/**
 * ユーザーが保存ダイアログで選んだJSON保存先パスから、対になるCSV保存先パスを導出する。
 *
 * code-reviewer指摘対応(JSON/CSV保存先パス衝突によるサイレントなデータ消失の防止):
 * 拡張子が(大文字小文字を問わず).jsonのときだけ.csvへ「置き換える」。それ以外
 * (.csv・拡張子なし・他拡張子)は置き換えず、常に末尾へ「.csvを付加する」。
 * これにより、戻り値(csvPath)が入力(jsonPath)と決して一致しないことを構造的に保証できる:
 * - .json → .csv へ置き換え: 拡張子自体が変わるため元の文字列とは必ず異なる。
 * - それ以外 → 元の文字列全体に ".csv" を追加するため、たとえ元が既に ".csv" で終わっていても
 *   (例: "analysis.csv" → "analysis.csv.csv")、追加後は元と異なる文字列になる。
 * 万一ユーザーが保存ダイアログでJSON保存先に ".csv" 拡張子を選んでも、この関数だけで
 * jsonPath===csvPath(CSV書き込みがJSONを無確認上書きする事故)を起こしえない設計にしている
 * (呼び出し側 main/ipc.ts の handleExportAnalysis 側にも念のための同値チェックを残す。多層防御)。
 *
 * クロスプラットフォーム対応(Windows CI障害の再発防止): node:path モジュール(path.dirname/
 * path.basename/path.join等)は区切り文字をOS依存で正規化してしまい、Windows実行時には入力の
 * "/" を "\" に変換してしまう(dialog.showSaveDialogが返す実際のパスはOS流儀のままなので
 * 本番では問題にならないが、"/"区切りのテスト入力がWindows CIでのみ失敗する事故があった)。
 * この関数は path モジュールを一切使わず、入力文字列の区切り文字をそのまま保持する
 * 純文字列操作のみで実装する(OS非依存。ipc.ts側の衝突比較〈path.resolve〉はパスの実体比較が
 * 目的のため path 使用のままで問題ない)。
 * @param jsonPath ユーザーが選んだJSON保存先の絶対パス
 */
export function deriveCsvPathFromJsonPath(jsonPath: string): string {
  const jsonSuffix = ".json";
  if (jsonPath.toLowerCase().endsWith(jsonSuffix)) {
    return jsonPath.slice(0, jsonPath.length - jsonSuffix.length) + ".csv";
  }
  return jsonPath + ".csv";
}
