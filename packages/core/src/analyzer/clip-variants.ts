/**
 * クリップ幅の版(clip variant)registry — タスクD-2(±10%↔±15%のA/B・新版並走)の単一の真実源。
 *
 * 背景(2026-07-21 boss着手前ゲート合意): 中央キャリブレーションで確認された上位帯(30-50%)の
 * 自信不足(過小評価)への対策として、adjustedProb=prior±0.10 のクリップ幅を版として切替可能にし、
 * ±0.15 の新版を既存版(対照)と並走させてA/B比較する(効果はD-1: 版別キャリブレーションで比較)。
 * ±0.15 の1新版のみ(±0.12/±0.20 は作らない)。絶対値 ±0.15(prior相対にしない)。
 *
 * 設計方針(単一の真実源。boss合意スコープ1): クリップ幅を CLIP_VARIANTS のこのレジストリ1箇所に
 * 集約し、(a) parseAnalyzerResponse へ渡す maxAdjust、(b) build-prompt.ts が組み立てる文面の
 * 「±X%(絶対値0.YY)」表記、(c) PROMPT_VERSION 文字列、をすべてここから機械導出する。
 * 各エントリが {maxAdjust, promptVersion} を同一オブジェクトから持つことで、文面とクリップ幅の
 * 食い違いが構造的に起こらない(呼び出し側が別々の値を個別にハードコードする余地を無くす)。
 *
 * 対照(default)の幅0.10 は完全不変(boss合意スコープ2、D-2。...clip010 へ改名しない)。
 * PROMPT_VERSION 文字列は build-prompt.ts の PROMPT_VERSION 定数と同一の値を保つ運用とする
 * (このファイルが唯一の定義元だが、build-prompt.ts 側からこのレジストリを参照する循環を避けるため、
 * 互いを import しない独立したリテラルとして持つ。build-prompt.ts のプロンプト文面が変わり
 * PROMPT_VERSION が更新されたら、こちらも手動で追随して同じ値に更新すること。ズレはテストで固定する
 * 〈clip-variants.test.ts・analysis-pipeline.test.ts の promptVersion 一致アサーション〉)。
 * #26-P3(芝の傷み目安)で build-prompt.ts の PROMPT_VERSION が "2026-07-19.3" → "2026-07-22.1"
 * に更新されたため、この対照(default)の値もここで追随した。
 * #27-C(当日傾向のプロンプト反映)で build-prompt.ts の PROMPT_VERSION が "2026-07-22.1" →
 * "2026-07-23.1" に更新されたため、この対照(default)の値もここで追随した。
 * #6(馬体重トレンドのプロンプト反映)で build-prompt.ts の PROMPT_VERSION が "2026-07-23.1" →
 * "2026-07-23.2" に更新されたため、この対照(default)の値もここで追随した。
 * #7(過去走の人気・オッズ乖離のプロンプト反映)で build-prompt.ts の PROMPT_VERSION が
 * "2026-07-23.2" → "2026-07-23.3" に更新されたため、この対照(default)の値もここで追随した。
 * #8(乗り替わり〈騎手の継続/変更〉のプロンプト反映)で build-prompt.ts の PROMPT_VERSION が
 * "2026-07-23.3" → "2026-07-23.4" に更新されたため、この対照(default)の値もここで追随した。
 *
 * 新版(wide15)は幅0.15(絶対値)・PROMPT_VERSION="{対照のPROMPT_VERSION}-clip015"(版文字列に幅を
 * 内包し、対照と必ず異なる値にする。DB列は追加しない: analyses.prompt_version は既存の文字列カラムの
 * まま新しい版文字列を保存でき、verify.ts の computeVerifyReportByPromptVersion は既に
 * promptVersion 文字列でグループ化する実装のため無改修で新版を別グループとして扱える)。
 *
 * 版番号運用ルール(ユーザー確定事項A、#26-P3で確定): 対照(default)のPROMPT_VERSIONを更新した場合
 * (プロンプト文面の変更全般)、新版(wide15)は必ず追随し "{対照の新しいPROMPT_VERSION}-clip015" に
 * 更新する(対照・新版とも同じ buildPrompt を経由するため、プロンプト文面自体は常に同時に変わる。
 * 版文字列だけが追随せず乖離する状態を作らない)。旧ルール(追随するかはその時点の合意による)は
 * #26-P3でこの固定ルールに置き換えた。
 */

/** クリップ幅の版ID。±0.15 の1新版のみ(±0.12/±0.20 は作らない。ユーザー確定事項)。 */
export type ClipVariantId = "default" | "wide15";

/** クリップ幅の版1件。maxAdjust・promptVersion を同一オブジェクトから持つ(食い違い防止)。 */
export interface ClipVariant {
  /** 版ID。 */
  readonly id: ClipVariantId;
  /** 補正の最大幅(prior からの絶対値)。 */
  readonly maxAdjust: number;
  /** この版で使う PROMPT_VERSION 文字列。 */
  readonly promptVersion: string;
}

/**
 * クリップ幅の版registry(唯一の真実源)。default は既存(対照)・wide15 は新版(D-2)。
 * 版を追加する場合はここに1エントリ足すだけで、buildPrompt の文面・parseAnalyzerResponse の
 * maxAdjust・保存する promptVersion のすべてに反映される。
 */
export const CLIP_VARIANTS: Readonly<Record<ClipVariantId, ClipVariant>> = {
  default: {
    id: "default",
    maxAdjust: 0.1,
    // build-prompt.ts の PROMPT_VERSION と同一の値を手動同期する(#8で追随)。
    promptVersion: "2026-07-23.4",
  },
  wide15: {
    id: "wide15",
    maxAdjust: 0.15,
    // 対照(default)のPROMPT_VERSIONに"-clip015"を付けた値。対照更新時は必ず追随する(#8で追随)。
    promptVersion: "2026-07-23.4-clip015",
  },
};

/** 既定のクリップ幅版ID(対照)。設定未選択時・不正値フォールバック先。 */
export const DEFAULT_CLIP_VARIANT_ID: ClipVariantId = "default";

/**
 * variantId から ClipVariant を解決する。未指定(undefined/null)・CLIP_VARIANTS に無い未知の値は
 * 対照(default)へフォールバックする(受け入れ条件「不正値/未設定フォールバック」)。
 * @param id 設定等から渡される版ID(型崩れ・不正な文字列である可能性を許容する)
 */
export function resolveClipVariant(
  id: ClipVariantId | string | null | undefined,
): ClipVariant {
  if (id === null || id === undefined) {
    return CLIP_VARIANTS[DEFAULT_CLIP_VARIANT_ID];
  }
  const variant = (CLIP_VARIANTS as Record<string, ClipVariant | undefined>)[id];
  return variant ?? CLIP_VARIANTS[DEFAULT_CLIP_VARIANT_ID];
}

/**
 * 許容幅の%表記(例: 0.10→"10%")。build-prompt.ts のプロンプト文面生成が使う。
 * maxAdjust は常に0.01刻みの値(0.10/0.15等)を想定するため四捨五入は境界で問題にならない。
 */
export function clipPercentLabel(maxAdjust: number): string {
  return `${Math.round(maxAdjust * 100)}%`;
}

/** 許容幅の絶対値表記(例: 0.10→"0.10")。build-prompt.ts のプロンプト文面生成が使う。 */
export function clipAbsoluteLabel(maxAdjust: number): string {
  return maxAdjust.toFixed(2);
}
