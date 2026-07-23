/**
 * 乗り替わり(騎手の継続/変更)要約(タスク#8・未使用パラメータ活用③)。
 *
 * ShutubaHorse.jockeyName/jockeyId(今走騎手)と HorseRaceResult.jockeyName/jockeyId
 * (前走騎手、戦績の先頭=results[0])を比較し、「継続」か「乗り替わり」かをLLMプロンプト用の
 * 中立な材料として要約するプロンプト専用の配線であり、scorer/prior.ts・base-score.ts・
 * bias-*.ts には一切影響しない(scorerは騎手継続性を判定材料として使っていない〈2026-07-23
 * boss着手前ゲート合意時点で実grep 0件〉。既存の騎手スライスは「当該コース複勝率」という
 * 別概念で現状データ未供給=無補正であり、本モジュールとの二重計上も発生しない)。
 *
 * 決定論・ネットワーク/DB非依存の純関数。例外を投げず、判定材料が無ければ null を返す
 * (body-weight-trend.ts・market-gap.ts と同じ設計方針)。
 *
 * 【比較範囲(ユーザー確定)】今走 vs 前走(results[0])のみの2値判定。前走なし
 * (新馬・戦績が空・呼び出し側がnullを渡した)→ null。前走(results[0])の騎手が判定不能
 * (id/nameともに欠損)でも、さらに過去へ遡ることはしない(「前走」ラベルに忠実。
 * market-gap.ts・body-weight-trend.ts のskip-and-continue方式とは異なる設計判断)。
 *
 * 【同一性判定(ユーザー確定)】jockeyId優先: 今走・前走とも jockeyId が非null なら、
 * 表記ゆれの影響を受けない id の一致/不一致で継続/乗り替わりを判定する(判定根拠=id)。
 * どちらか一方でも jockeyId が null の場合のみ、jockeyName(トリム後・非空)の一致/不一致で
 * 代替判定する(判定根拠=name)。前走側の判定材料(id・name)がどちらも欠損/空なら null。
 * 今走 jockeyName が空/空白のみのときは、idの有無に関わらず判定不能として null を返す
 * (「今走の騎手名を確定して表示できない」ことを優先する設計)。
 *
 * 判定語彙は中立事実のみで、評価語(名手/主戦/強化/妙味等)は一切出さない
 * (LLMへの解釈は委任する。#7「人気着順乖離」と同じ非破壊optionalの流儀)。
 */

/** 継続/乗り替わりの区分。 */
export type JockeyChangeCategory = "継続" | "乗り替わり";

/** 判定根拠(テスト可視化用)。jockeyId優先、id欠損時のみnameで代替。 */
export type JockeyChangeBasis = "id" | "name";

/** summarizeJockeyChange が返す要約。常に同じキー構成の構造化オブジェクトに固定する。 */
export interface JockeyChangeSummary {
  /** 継続/乗り替わりの区分。 */
  readonly 区分: JockeyChangeCategory;
  /** 今走騎手名(トリム後)。 */
  readonly 今走騎手名: string;
  /**
   * 前走騎手名(トリム後)。判定根拠(id/name)に関わらず、前走側で取得できた場合は保持する
   * (乗り替わり時のnote併記・判定根拠の可視化に使う)。取得できない場合は null。
   */
  readonly 前走騎手名: string | null;
  /** 判定根拠。jockeyIdで判定できた場合は"id"、jockeyNameで代替した場合は"name"。 */
  readonly 判定根拠: JockeyChangeBasis;
  /** プロンプトへそのまま載せる中立の材料文(評価語・評価指示は含まない)。 */
  readonly note: string;
}

/** summarizeJockeyChange に渡す今走の騎手情報(ShutubaHorseのサブセット)。 */
export interface JockeyChangeTodayInput {
  /** 今走の騎手ID。騎手未定・リンク欠損などで抽出できない場合は null。 */
  readonly jockeyId: string | null;
  /** 今走の騎手名。 */
  readonly jockeyName: string;
}

/**
 * summarizeJockeyChange に渡す前走(戦績の先頭=results[0])の騎手情報
 * (HorseRaceResultのサブセット)。前走が存在しない(新馬・戦績が空)場合は summarizeJockeyChange
 * 呼び出し自体に null を渡す(このインターフェース自体はnon-null前提)。
 */
export interface JockeyChangePrevRunInput {
  /** 前走の騎手ID。取得できない場合は null。 */
  readonly jockeyId: string | null;
  /** 前走の騎手名。取得できない場合は null。 */
  readonly jockeyName: string | null;
}

/** 前後の空白を除去し、空文字になる場合は null を返す(判定材料なしの統一表現)。 */
function nonEmptyTrim(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 区分・判定根拠からnote文を組み立てる(評価語は一切含めない)。 */
function buildNote(
  category: JockeyChangeCategory,
  todayName: string,
  prevDisplayName: string | null,
): string {
  if (category === "継続") {
    return `騎手=${todayName}(前走から継続)`;
  }
  // 乗り替わり: 前走名を併記する。前走名が取得できない(id判定はできたがnameが欠損)場合は
  // 「不明」で埋め、例外にはしない。
  return `騎手=${todayName}(前走${prevDisplayName ?? "不明"}から乗り替わり)`;
}

/**
 * 今走・前走の騎手を比較し、継続/乗り替わりを判定する純関数。
 * 前走なし(prevRun===null)・今走騎手名が空/空白のみ・前走側の判定材料(id/name)がともに
 * 欠損/空の場合は null を返す(判定材料なし。行を出さない)。
 * @param today 今走の騎手情報(ShutubaHorse.jockeyId/jockeyNameのサブセット)
 * @param prevRun 前走(戦績の先頭、results[0])の騎手情報。前走が無ければ呼び出し側が null を渡す
 */
export function summarizeJockeyChange(
  today: JockeyChangeTodayInput,
  prevRun: JockeyChangePrevRunInput | null,
): JockeyChangeSummary | null {
  if (prevRun === null) {
    return null;
  }

  const todayName = nonEmptyTrim(today.jockeyName);
  if (todayName === null) {
    return null;
  }

  let category: JockeyChangeCategory;
  let basis: JockeyChangeBasis;

  if (today.jockeyId !== null && prevRun.jockeyId !== null) {
    category = today.jockeyId === prevRun.jockeyId ? "継続" : "乗り替わり";
    basis = "id";
  } else {
    const prevName = nonEmptyTrim(prevRun.jockeyName);
    if (prevName === null) {
      return null;
    }
    category = todayName === prevName ? "継続" : "乗り替わり";
    basis = "name";
  }

  const prevDisplayName = nonEmptyTrim(prevRun.jockeyName);

  return {
    区分: category,
    今走騎手名: todayName,
    前走騎手名: prevDisplayName,
    判定根拠: basis,
    note: buildNote(category, todayName, prevDisplayName),
  };
}
