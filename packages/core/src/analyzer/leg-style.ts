/**
 * 脚質分類・展開想定 — 各馬の直近走の通過順位から逃げ/先行/差し/追込を粗く分類し、
 * レース全体の展開想定(脚質分布・主導権候補・想定ペース・恵まれる/損する脚質)を
 * 組み立てる決定論的な純関数群。
 *
 * 仕様「3. analyzer」: 「レース間隔、脚質と展開想定(逃げ馬の数からペースを推定)」をプロンプトに
 * 含めるための材料を用意する。分類は「粗く」でよい(LLMが最終解釈を担う)ため、通過順を
 * 頭数で正規化した相対位置で切る単純規則とする。頭数が取れない過去走は絶対位置でフォールバックする。
 *
 * 第1コーナー通過順のみで分類する基本版(classifyRunLegStyle 系。分類規則は下記)と、
 * 全コーナーの位置取り推移(道中の平均位置・先頭〜最終コーナーの位置変化)を使う精緻化版
 * (classifyRunLegStyleFull 系)の2系統がある。精緻化版は「第1コーナーで先頭に立ったが
 * 道中で失速した」馬まで「逃げ」と誤判定してしまう基本版の弱点を補うもので、build-prompt.ts の
 * 【展開想定】強化(脚質の安定度・過去のペース傾向・buildRaceDevelopment)はすべて精緻化版を使う。
 * 基本版は他所からの参照(barrel export経由)を考慮し、挙動・テストを変更せず残置している。
 *
 * 基本版の分類規則(第1コーナー通過順 pos、頭数 field):
 *   - pos === 1                → 逃げ(先頭)
 *   - field 判明時: r = pos/field で  r<=1/3 → 先行 / r<=2/3 → 差し / それ以外 → 追込
 *   - field 不明時(絶対位置):  pos<=4 → 先行 / pos<=8 → 差し / それ以外 → 追込
 */

import type { RaceIdVenueKind } from "../scraper/ids.js";

/** 脚質(粗い4分類)。 */
export type LegStyle = "逃げ" | "先行" | "差し" | "追込";

/** 脚質分類の入力となる1走分の通過情報。 */
export interface HorseRunPassing {
  /** 通過順位(例: 2-3-4-3 → [2,3,4,3])。空配列は不明扱い。 */
  readonly passing: readonly number[];
  /** その走の出走頭数。取得できない場合は null。 */
  readonly fieldSize: number | null;
  /**
   * その走のペース(例: 29.9-37.6 = 前半3Fタイム-後半3Fタイム)。取得できない場合は null。
   * 「過去のペース傾向」(summarizePastPaceTendency)の材料。省略可(未指定は情報なし扱い)。
   */
  readonly pace?: string | null;
  /**
   * その走の上がり3F(秒)。取得できない場合は null。
   * 「過去のペース傾向」の付記情報(上がり3F平均)の材料。省略可(未指定は情報なし扱い)。
   */
  readonly last3f?: number | null;
}

/** classifyHorseLegStyle の任意設定。 */
export interface ClassifyHorseOptions {
  /** 参照する直近走数(既定3)。新しい順に最大この数だけ見る。 */
  readonly recentRuns?: number;
}

/** 相対位置の閾値(先行/差しの上限)。 */
const LEAD_RATIO = 1 / 3;
const MID_RATIO = 2 / 3;

/** 絶対位置フォールバックの閾値(先行/差しの上限)。 */
const LEAD_POS = 4;
const MID_POS = 8;

/**
 * 1走分の脚質を分類する。通過順が空なら null(不明)。
 * @param passing 通過順位(第1コーナー = passing[0] を代表位置に使う)
 * @param fieldSize その走の頭数(null なら絶対位置でフォールバック)
 */
export function classifyRunLegStyle(
  passing: readonly number[],
  fieldSize: number | null,
): LegStyle | null {
  const pos = passing[0];
  if (pos === undefined) {
    return null;
  }
  if (pos === 1) {
    return "逃げ";
  }
  if (fieldSize !== null && fieldSize > 0) {
    const r = pos / fieldSize;
    if (r <= LEAD_RATIO) return "先行";
    if (r <= MID_RATIO) return "差し";
    return "追込";
  }
  // 頭数不明: 絶対位置でフォールバック。
  if (pos <= LEAD_POS) return "先行";
  if (pos <= MID_POS) return "差し";
  return "追込";
}

/**
 * 直近複数走から代表脚質を求める。通過順を持つ走が1つも無ければ null。
 * 最頻の脚質を採用し、同数のときは直近走(runs 先頭側)の脚質を優先する。
 * @param runs 過去走(新しい順を前提)
 */
export function classifyHorseLegStyle(
  runs: readonly HorseRunPassing[],
  options: ClassifyHorseOptions = {},
): LegStyle | null {
  const recentRuns = options.recentRuns ?? 3;
  // 新しい順に走を見て、脚質が取れたものだけ最大 recentRuns 件集める。
  const styles: LegStyle[] = [];
  for (const run of runs) {
    if (styles.length >= recentRuns) break;
    const s = classifyRunLegStyle(run.passing, run.fieldSize);
    if (s !== null) {
      styles.push(s);
    }
  }
  // 最頻脚質の選定(同数は直近優先)は classifyHorseLegStyleFull と共通のため
  // pickMostFrequentStyle に集約する(下部で定義。関数宣言のためホイストされ参照可能)。
  return pickMostFrequentStyle(styles);
}

/** 脚質配列から逃げ馬の数を数える(null は無視)。 */
export function countFrontRunners(styles: readonly (LegStyle | null)[]): number {
  return styles.reduce((n, s) => (s === "逃げ" ? n + 1 : n), 0);
}

/**
 * 逃げ馬の数からペース想定の文言を作る(展開想定の材料)。
 * 粗い目安であり、最終的な解釈は LLM に委ねる。
 */
export function estimatePace(frontRunnerCount: number): string {
  if (frontRunnerCount <= 0) {
    return "逃げ馬不在でスロー(前残り)想定";
  }
  if (frontRunnerCount === 1) {
    return "逃げ馬1頭で平均ペース想定";
  }
  return "逃げ馬複数でハイペース想定";
}

// ---------------------------------------------------------------------------
// ここから: 全コーナーの位置取り推移を使った脚質の精緻化(展開想定強化)。
//
// 上の classifyRunLegStyle 系は第1コーナーの通過順「だけ」で分類するため、
// 「第1コーナーで先頭に立ったが道中で失速した」馬まで「逃げ」と誤判定してしまう
// (逆に「差してくる」終いの脚も反映されない)。以下の *Full 系は全コーナーの
// 通過順を使い、道中の平均位置と先頭〜最終コーナーの位置変化(詰め寄り/後退)を
// 加味して分類する。旧関数は他モジュール(barrel export経由の後方互換)のため残置し、
// 挙動・テストは変更しない。
// ---------------------------------------------------------------------------

/** classifyRunLegStyleFull の結果(1走分)。 */
export interface RunLegStyleDetail {
  /** 全コーナーの位置取り推移から分類した脚質。判定不能(通過順なし)なら null。 */
  readonly style: LegStyle | null;
  /**
   * 道中(全コーナー)の平均位置。頭数が分かれば相対位置(0〜1、小さいほど前目)の平均、
   * 頭数不明なら絶対位置の平均。判定不能なら null。
   */
  readonly averagePosition: number | null;
  /**
   * 第1コーナー→最終コーナーの位置変化(最終コーナー通過順 − 第1コーナー通過順)。
   * 正なら後退(失速)、負なら進出(詰め寄り・終いの脚)。コーナー情報が1つ以下なら null。
   */
  readonly positionChange: number | null;
}

/** 数値配列の単純平均(空なら null)。 */
function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 全コーナーの通過順から1走分の脚質を分類する(展開想定強化の中核)。
 * 「逃げ」は第1コーナー先頭 かつ 道中平均も先頭集団(先行の閾値以内)である場合のみとし、
 * 第1コーナーで先頭でも道中に失速した馬は道中平均位置に応じて先行/差し/追込へ格下げする。
 * それ以外(第1コーナー非先頭)は道中平均位置を classifyRunLegStyle と同じ閾値で分類する。
 * @param passing 通過順位(全コーナー)
 * @param fieldSize その走の頭数(null/0なら絶対位置でフォールバック)
 */
export function classifyRunLegStyleFull(
  passing: readonly number[],
  fieldSize: number | null,
): RunLegStyleDetail {
  if (passing.length === 0) {
    return { style: null, averagePosition: null, positionChange: null };
  }
  const positionChange =
    passing.length >= 2 ? passing[passing.length - 1]! - passing[0]! : null;

  const ledFirstCorner = passing[0] === 1;
  const useRatio = fieldSize !== null && fieldSize > 0;
  const avgRaw = average(passing)!;
  const averagePosition = useRatio ? avgRaw / fieldSize! : avgRaw;

  let style: LegStyle;
  if (useRatio) {
    if (ledFirstCorner && averagePosition <= LEAD_RATIO) {
      style = "逃げ";
    } else if (averagePosition <= LEAD_RATIO) {
      style = "先行";
    } else if (averagePosition <= MID_RATIO) {
      style = "差し";
    } else {
      style = "追込";
    }
  } else {
    if (ledFirstCorner && averagePosition <= LEAD_POS) {
      style = "逃げ";
    } else if (averagePosition <= LEAD_POS) {
      style = "先行";
    } else if (averagePosition <= MID_POS) {
      style = "差し";
    } else {
      style = "追込";
    }
  }

  return { style, averagePosition, positionChange };
}

/**
 * 直近複数走から代表脚質(全コーナー版)を求める。ロジックは classifyHorseLegStyle と同じ
 * (最頻脚質・同数は直近優先)だが、各走の分類に classifyRunLegStyleFull を使う点が異なる。
 */
export function classifyHorseLegStyleFull(
  runs: readonly HorseRunPassing[],
  options: ClassifyHorseOptions = {},
): LegStyle | null {
  const recentRuns = options.recentRuns ?? 3;
  const styles: LegStyle[] = [];
  for (const run of runs) {
    if (styles.length >= recentRuns) break;
    const s = classifyRunLegStyleFull(run.passing, run.fieldSize).style;
    if (s !== null) {
      styles.push(s);
    }
  }
  return pickMostFrequentStyle(styles);
}

/** 脚質配列から最頻値を選ぶ(同数は先頭=より直近を優先)。空配列は null。 */
function pickMostFrequentStyle(styles: readonly LegStyle[]): LegStyle | null {
  if (styles.length === 0) {
    return null;
  }
  const count = new Map<LegStyle, number>();
  const firstIndex = new Map<LegStyle, number>();
  styles.forEach((s, i) => {
    count.set(s, (count.get(s) ?? 0) + 1);
    if (!firstIndex.has(s)) firstIndex.set(s, i);
  });
  let best = styles[0]!;
  for (const s of count.keys()) {
    const c = count.get(s)!;
    const bestCount = count.get(best)!;
    if (c > bestCount || (c === bestCount && firstIndex.get(s)! < firstIndex.get(best)!)) {
      best = s;
    }
  }
  return best;
}

/** 脚質の安定度(直近走でどれだけ脚質が一貫しているか)。 */
export type LegStyleStability = "安定" | "概ね安定" | "不安定" | "不明";

/** 安定度判定に必要な最小サンプル数(スコアラーの「サンプル2走未満で補正なし」慣例に合わせる)。 */
const STABILITY_MIN_SAMPLES = 2;

/**
 * 直近複数走の脚質(全コーナー版)から安定度を求める。
 * 分類できた走が2走未満(サンプル不足)は「不明」。
 * 最頻脚質の占有率が 1.0 なら「安定」、0.5以上なら「概ね安定」、それ未満は「不安定」。
 */
export function computeLegStyleStability(
  runs: readonly HorseRunPassing[],
  options: ClassifyHorseOptions = {},
): LegStyleStability {
  const recentRuns = options.recentRuns ?? 3;
  const styles: LegStyle[] = [];
  for (const run of runs) {
    if (styles.length >= recentRuns) break;
    const s = classifyRunLegStyleFull(run.passing, run.fieldSize).style;
    if (s !== null) {
      styles.push(s);
    }
  }
  if (styles.length < STABILITY_MIN_SAMPLES) {
    return "不明";
  }
  const count = new Map<LegStyle, number>();
  for (const s of styles) {
    count.set(s, (count.get(s) ?? 0) + 1);
  }
  const maxCount = Math.max(...count.values());
  const ratio = maxCount / styles.length;
  if (ratio === 1) {
    return "安定";
  }
  if (ratio >= 0.5) {
    return "概ね安定";
  }
  return "不安定";
}

/**
 * 直近複数走の先行力スコア(道中平均位置の平均)を求める。小さいほど前目(先行力が高い)。
 * 頭数が分かる走の相対位置(0〜1)のみを対象にする(頭数不明の絶対位置はスケールが異なり
 * 混在させると比較不能になるため除外する)。対象となる走が1つも無ければ null。
 */
export function computeFrontRunningScore(
  runs: readonly HorseRunPassing[],
  options: ClassifyHorseOptions = {},
): number | null {
  const recentRuns = options.recentRuns ?? 3;
  const ratios: number[] = [];
  let seen = 0;
  for (const run of runs) {
    if (seen >= recentRuns) break;
    if (run.passing.length === 0) continue;
    seen += 1;
    if (run.fieldSize !== null && run.fieldSize > 0) {
      const detail = classifyRunLegStyleFull(run.passing, run.fieldSize);
      if (detail.averagePosition !== null) {
        ratios.push(detail.averagePosition);
      }
    }
  }
  return average(ratios);
}

/** analyzeHorseLegStyle の結果(脚質・安定度・先行力スコアの統合)。 */
export interface HorseLegStyleAnalysis {
  /** 脚質(全コーナー版)。判定不能なら null。 */
  readonly style: LegStyle | null;
  /** 脚質の安定度。 */
  readonly stability: LegStyleStability;
  /** 先行力スコア(小さいほど前目)。算出不能なら null。 */
  readonly frontRunningScore: number | null;
}

/**
 * 1頭分の脚質・安定度・先行力スコアをまとめて求める(展開想定〈buildRaceDevelopment〉の入力材料)。
 */
export function analyzeHorseLegStyle(
  runs: readonly HorseRunPassing[],
  options: ClassifyHorseOptions = {},
): HorseLegStyleAnalysis {
  return {
    style: classifyHorseLegStyleFull(runs, options),
    stability: computeLegStyleStability(runs, options),
    frontRunningScore: computeFrontRunningScore(runs, options),
  };
}

// ---------------------------------------------------------------------------
// 過去走のペース傾向(その馬が速い/遅い流れを経験しているか)。
// ---------------------------------------------------------------------------

/** 1走分のペース傾向(前半3F-後半3Fタイムの差から判定)。 */
type RunPaceTendency = "前傾(差し追込有利)" | "後傾(先行有利)" | "平均的";

/** 前傾/後傾/平均的を分ける前後半タイム差の閾値(秒)。 */
const PACE_TENDENCY_THRESHOLD_SEC = 0.5;

/**
 * 「29.9-37.6」形式のペース文字列(前半3Fタイム-後半3Fタイム)を解析し、
 * 前半が速ければ「前傾(差し追込有利)」、後半が速ければ「後傾(先行有利)」、
 * 差が僅かなら「平均的」と判定する。解析できなければ null。
 */
function classifyRunPaceTendency(pace: string | null | undefined): RunPaceTendency | null {
  if (!pace) {
    return null;
  }
  const m = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(pace);
  if (!m) {
    return null;
  }
  const front = Number(m[1]);
  const back = Number(m[2]);
  if (!Number.isFinite(front) || !Number.isFinite(back)) {
    return null;
  }
  const diff = front - back;
  if (diff <= -PACE_TENDENCY_THRESHOLD_SEC) {
    return "前傾(差し追込有利)";
  }
  if (diff >= PACE_TENDENCY_THRESHOLD_SEC) {
    return "後傾(先行有利)";
  }
  return "平均的";
}

/**
 * 直近複数走のペース傾向を集計した日本語の要約テキストを返す(展開想定の各馬行に付記する材料)。
 * 「その馬がこれまで速い/遅い流れをどれだけ経験しているか」をLLMに伝える狙い。
 * ペース情報が1件も解析できなければ「データ不足」。上がり3Fの平均が取れれば括弧書きで付記する。
 *
 * 集計対象は「pace が有効(classifyRunPaceTendency が判定可能)な走」であり、passing(通過順)の
 * 有無とは無関係に判定する(passing と pace は netkeiba 上で独立に取得可否が決まるため。例:
 * 海外遠征・障害戦などで通過順欄が無く前後半ラップだけ取れる走がある)。「直近N走(recentRuns)」も
 * この基準に合わせ、pace が判定可能な走を新しい順に N 件数える(pace 無効な走はスキップして
 * より過去の走を見に行く。ただしそれによって recentRuns の計数自体が進むことはない)。
 * 上がり3F平均も、この pace 判定対象と同じ走から取れた値のみを対象にする。
 */
export function summarizePastPaceTendency(
  runs: readonly HorseRunPassing[],
  options: ClassifyHorseOptions = {},
): string {
  const recentRuns = options.recentRuns ?? 3;
  const tendencies: RunPaceTendency[] = [];
  const last3fs: number[] = [];
  let seen = 0;
  for (const run of runs) {
    if (seen >= recentRuns) break;
    const t = classifyRunPaceTendency(run.pace);
    if (t === null) {
      // pace が判定不能な走(未解析、または passing はあるが pace が無い/壊れている等)は
      // recentRuns の計数に含めず、次の走(より過去)を見て判定対象を探す。
      continue;
    }
    seen += 1;
    tendencies.push(t);
    if (typeof run.last3f === "number" && Number.isFinite(run.last3f)) {
      last3fs.push(run.last3f);
    }
  }

  const order: RunPaceTendency[] = ["前傾(差し追込有利)", "後傾(先行有利)", "平均的"];
  const count = new Map<RunPaceTendency, number>();
  for (const t of tendencies) {
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  const parts = order
    .filter((t) => (count.get(t) ?? 0) > 0)
    .map((t) => `${t}${count.get(t)}回`);

  const avgLast3f = average(last3fs);
  const suffix =
    avgLast3f !== null ? `(上がり3F平均${avgLast3f.toFixed(1)}秒)` : "";

  if (parts.length === 0) {
    return `データ不足${suffix}`;
  }
  return `${parts.join("・")}${suffix}`;
}

// ---------------------------------------------------------------------------
// 展開想定の構造化(buildRaceDevelopment)。
// ---------------------------------------------------------------------------

/** buildRaceDevelopment に渡す1頭分の入力(analyzeHorseLegStyle の結果 + 馬番)。 */
export interface RaceDevelopmentHorseInput {
  /** 馬番。 */
  readonly umaban: number;
  /** 脚質(全コーナー版)。判定不能なら null。 */
  readonly style: LegStyle | null;
  /** 脚質の安定度。 */
  readonly stability: LegStyleStability;
  /** 先行力スコア(小さいほど前目)。算出不能なら null。 */
  readonly frontRunningScore: number | null;
}

/** 想定ペース(3択)。 */
export type PaceEstimate = "スロー" | "平均" | "ハイ";

/** 展開想定(1レース分)。 */
export interface RaceDevelopment {
  /** 脚質分布(逃げ/先行/差し/追込それぞれの頭数。style=null の馬は含まない)。 */
  readonly styleCounts: Record<LegStyle, number>;
  /** 脚質が判定できなかった頭数。 */
  readonly unknownCount: number;
  /**
   * 主導権候補(先行力が最も高い逃げ/先行馬の馬番)。逃げ/先行タイプが1頭も居ない、
   * または先行力スコアが算出できる馬が1頭も居なければ null。
   */
  readonly paceSetterUmaban: number | null;
  /** 想定ペース(逃げ馬の頭数から推定。estimatePace と同じ閾値)。 */
  readonly pace: PaceEstimate;
  /** 想定ペースの根拠(日本語文。逃げ馬の頭数・主導権候補を明示)。 */
  readonly paceReason: string;
  /** そのペースで恵まれる(有利になりやすい)脚質。 */
  readonly favoredStyles: readonly LegStyle[];
  /** そのペースで損する(不利になりやすい)脚質。 */
  readonly disfavoredStyles: readonly LegStyle[];
}

/** 安定度の優劣(主導権候補のタイブレークに使う。値が大きいほど優先)。 */
const STABILITY_RANK: Record<LegStyleStability, number> = {
  安定: 3,
  概ね安定: 2,
  不安定: 1,
  不明: 0,
};

/** 逃げ馬の頭数から想定ペース(3択)を求める(estimatePace と同じ閾値)。 */
function paceEstimateFromFrontRunnerCount(frontRunnerCount: number): PaceEstimate {
  if (frontRunnerCount <= 0) return "スロー";
  if (frontRunnerCount === 1) return "平均";
  return "ハイ";
}

/**
 * 馬場状態が「不良」かどうかを判定する。
 * classifyTrackWetness(scorer/derive-features.ts)と同じ「先頭1文字判定」方式を踏襲するが、
 * あちらは稍重・重も含めて「道悪(isWet)」とまとめるのに対し、こちらは不良のみを対象にする
 * (地方競馬の「不良馬場限定」の脚質補正〈差しも不利へ〉のため、稍重・重は対象外とする)。
 * trackCondition が null/undefined、または先頭文字が「不」以外なら false。
 */
function isFuryoTrackCondition(trackCondition: string | null | undefined): boolean {
  if (!trackCondition) {
    return false;
  }
  return trackCondition.trim().charAt(0) === "不";
}

/**
 * 想定ペースごとに「恵まれる脚質」「損する脚質」を対応付ける(競馬の定石: スローペースは
 * 前(逃げ・先行)が残りやすく追込は届きにくい、ハイペースは前が止まりやすく差し・追込が届きやすい)。
 *
 * 地方(nar)は中央と前残り傾向の強さが異なるため、venueKind="nar" のときは専用の対応表を使う
 * (2026-07-19 boss着手前ゲート合意のタスクB):
 *   - 通常馬場(良/稍重/重、またはtrackCondition不明): スロー/平均は 有利=逃げ・先行/不利=追込、
 *     ハイは 有利=逃げ・先行・差し/不利=追込(中央と異なり、ハイでも逃げは不利に入らない)。
 *   - 馬場不良(trackCondition先頭文字が「不」): 全ペースで 有利=逃げ・先行/不利=差し・追込
 *     (通常表でハイのとき有利だった差しを不利側へ上書きする)。
 * venueKind が "central" または未指定(中央相当)のときは、このtrackConditionによる分岐は行わず
 * 従来の対応表を一切変えない(不良ルールは地方専用)。
 */
function favoredStylesForPace(
  pace: PaceEstimate,
  venueKind?: RaceIdVenueKind,
  trackCondition?: string | null,
): {
  favored: readonly LegStyle[];
  disfavored: readonly LegStyle[];
} {
  if (venueKind === "nar") {
    if (isFuryoTrackCondition(trackCondition)) {
      return { favored: ["逃げ", "先行"], disfavored: ["差し", "追込"] };
    }
    switch (pace) {
      case "ハイ":
        return { favored: ["逃げ", "先行", "差し"], disfavored: ["追込"] };
      case "スロー":
      case "平均":
      default:
        return { favored: ["逃げ", "先行"], disfavored: ["追込"] };
    }
  }
  switch (pace) {
    case "スロー":
      return { favored: ["逃げ", "先行"], disfavored: ["追込"] };
    case "ハイ":
      return { favored: ["差し", "追込"], disfavored: ["逃げ"] };
    case "平均":
    default:
      return { favored: ["先行", "差し"], disfavored: [] };
  }
}

/**
 * 出走馬全頭の脚質分析(analyzeHorseLegStyle の結果)から、展開想定を構造化して返す。
 * 脚質分布・主導権候補・想定ペースとその根拠・恵まれる/損する脚質をまとめ、
 * build-prompt.ts の【展開想定】セクションの材料として使う。
 *
 * venueKind・trackCondition は「恵まれる/損する脚質」の対応表切り替え(地方/馬場不良の補正、
 * タスクB)にのみ使う任意引数。省略時(未指定)は venueKind="central"相当として扱われ、
 * 従来の対応表のまま変わらない(後方互換)。
 * @param venueKind 現レースの開催区分(中央/地方)。省略時は中央相当。
 * @param trackCondition 当日の馬場状態。省略時は不明(不良ルール非適用)扱い。
 */
export function buildRaceDevelopment(
  horses: readonly RaceDevelopmentHorseInput[],
  venueKind?: RaceIdVenueKind,
  trackCondition?: string | null,
): RaceDevelopment {
  const styleCounts: Record<LegStyle, number> = { 逃げ: 0, 先行: 0, 差し: 0, 追込: 0 };
  let unknownCount = 0;
  for (const h of horses) {
    if (h.style === null) {
      unknownCount += 1;
    } else {
      styleCounts[h.style] += 1;
    }
  }

  // 主導権候補: 逃げ/先行タイプのうち先行力スコア(小さいほど前目)が最良の馬。
  // 同点は安定度が高い方、それも同点なら馬番が若い方を優先する(決定論的タイブレーク)。
  const candidates = horses.filter(
    (h) =>
      (h.style === "逃げ" || h.style === "先行") && h.frontRunningScore !== null,
  );
  let paceSetterUmaban: number | null = null;
  for (const c of candidates) {
    if (paceSetterUmaban === null) {
      paceSetterUmaban = c.umaban;
      continue;
    }
    const best = candidates.find((x) => x.umaban === paceSetterUmaban)!;
    const scoreDiff = c.frontRunningScore! - best.frontRunningScore!;
    if (scoreDiff < 0) {
      paceSetterUmaban = c.umaban;
    } else if (scoreDiff === 0) {
      const stabilityDiff = STABILITY_RANK[c.stability] - STABILITY_RANK[best.stability];
      if (stabilityDiff > 0 || (stabilityDiff === 0 && c.umaban < best.umaban)) {
        paceSetterUmaban = c.umaban;
      }
    }
  }

  const pace = paceEstimateFromFrontRunnerCount(styleCounts.逃げ);
  const paceReason =
    `${estimatePace(styleCounts.逃げ)}(逃げ${styleCounts.逃げ}頭` +
    (paceSetterUmaban !== null ? `・主導権候補は馬番${paceSetterUmaban}` : "") +
    `)`;
  const { favored, disfavored } = favoredStylesForPace(pace, venueKind, trackCondition);

  return {
    styleCounts,
    unknownCount,
    paceSetterUmaban,
    pace,
    paceReason,
    favoredStyles: favored,
    disfavoredStyles: disfavored,
  };
}
