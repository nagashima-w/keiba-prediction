/**
 * 設定画面の共有型と入力検証(純関数)。
 *
 * main(永続化・マスク生成)・preload(型付き公開)・renderer(フォーム表示)の三者が参照するため、
 * analysis-types.ts と同じく core(better-sqlite3 等のネイティブ依存を含む)には依存させず、
 * この shared 層に純粋な TypeScript として置く。重みのキー集合はここを唯一の定義元とし、
 * coerce(main)・reducer/フォーム(renderer)がこの配列から項目を機械的に導出する。
 *
 * すべて IPC でシリアライズ可能なプレーンオブジェクト(関数・ブランド型を含まない)であること。
 */

/** バイアス重み7項目(core の BiasWeights と構造一致。shared を core非依存に保つため再定義)。 */
export interface BiasWeightValues {
  /** 馬場状態適性(道悪)。 */
  readonly trackCondition: number;
  /** 競馬場適性。 */
  readonly venue: number;
  /** 季節適性。 */
  readonly season: number;
  /** 枠順適性(馬個別)。 */
  readonly frame: number;
  /** 夏負けフラグ。 */
  readonly summerFatigue: number;
  /** 輸送・滞在バイアス。 */
  readonly transport: number;
  /** ローテーション適性。 */
  readonly rotation: number;
}

/** 基礎スコア重み6項目(core の BaseScoreWeights と構造一致)。 */
export interface BaseScoreWeightValues {
  /** 近走着順(重み減衰付き)。 */
  readonly recentForm: number;
  /** 上がり3F水準。 */
  readonly last3f: number;
  /** コース・距離適性。 */
  readonly courseDistance: number;
  /** 騎手の当該コース複勝率。 */
  readonly jockey: number;
  /** 斤量変化・馬体重増減。 */
  readonly weightChange: number;
  /** コースレベル枠順バイアス。 */
  readonly courseFrameBias: number;
}

/** バイアス重みのキー一覧(表示順・coerce の走査順の唯一の定義元)。 */
export const BIAS_WEIGHT_KEYS = [
  "trackCondition",
  "venue",
  "season",
  "frame",
  "summerFatigue",
  "transport",
  "rotation",
] as const satisfies readonly (keyof BiasWeightValues)[];

/** 基礎スコア重みのキー一覧。 */
export const BASE_SCORE_WEIGHT_KEYS = [
  "recentForm",
  "last3f",
  "courseDistance",
  "jockey",
  "weightChange",
  "courseFrameBias",
] as const satisfies readonly (keyof BaseScoreWeightValues)[];

/** バイアス重みキー。 */
export type BiasWeightKey = (typeof BIAS_WEIGHT_KEYS)[number];
/** 基礎スコア重みキー。 */
export type BaseScoreWeightKey = (typeof BASE_SCORE_WEIGHT_KEYS)[number];

/** バイアス重みの日本語ラベル(フォーム表示用)。 */
export const BIAS_WEIGHT_LABELS: Record<BiasWeightKey, string> = {
  trackCondition: "馬場状態適性(道悪)",
  venue: "競馬場適性",
  season: "季節適性",
  frame: "枠順適性(馬個別)",
  summerFatigue: "夏負けフラグ",
  transport: "輸送・滞在バイアス",
  rotation: "ローテーション適性",
};

/** 基礎スコア重みの日本語ラベル。 */
export const BASE_SCORE_WEIGHT_LABELS: Record<BaseScoreWeightKey, string> = {
  recentForm: "近走着順",
  last3f: "上がり3F",
  courseDistance: "コース・距離適性",
  jockey: "騎手成績",
  weightChange: "斤量・馬体重",
  courseFrameBias: "コース枠順バイアス",
};

/**
 * 永続化する設定(main 内でのみ扱う。apiKey は平文)。
 * 平文JSON保存は個人利用専用ツールの割り切り(safeStorage 暗号化は将来改善)。
 */
export interface AppSettings {
  /** Anthropic APIキー(平文)。空文字は未設定。 */
  readonly apiKey: string;
  /** Discord Webhook URL(Phase 5 で使用。現状は保存のみ)。 */
  readonly discordWebhookUrl: string;
  /** EVプラス判定の閾値(> 0)。 */
  readonly evThreshold: number;
  /** バイアス重み7項目。 */
  readonly biasWeights: BiasWeightValues;
  /** 基礎スコア重み6項目。 */
  readonly baseScoreWeights: BaseScoreWeightValues;
  /** 分析結果の自動Discord送信ON/OFF(Phase 5 で使用。現状は保存のみ)。 */
  readonly autoSendDiscord: boolean;
  /**
   * プロンプト追加指示(Task#28 プロンプト改善C)。設定画面の自由記述欄。
   * buildPrompt の BuildPromptInput.additionalInstruction にそのまま渡され、プロンプト末尾の
   * 指示ブロックに差し込まれる。空文字(既定)は何も注入しない。
   * 注意: ここに書いた指示はLLMにそのまま渡される。3着内率の推定を市場オッズ(人気)に
   * 近づける方向の指示は、本ツールの妙味検出(市場から独立した確率推定×市場オッズ)を
   * 損なうため避けるべき(設定画面に同旨の注意書きを表示する)。
   */
  readonly additionalInstruction: string;
}

/**
 * レンダラーへ返すマスク済み設定。平文APIキーは含めない(main から出さない)。
 */
export interface MaskedSettings {
  /** マスク済みAPIキー(例: "sk-ant-a***")。未設定なら空文字。 */
  readonly apiKeyMasked: string;
  /** 環境変数 ANTHROPIC_API_KEY が優先採用されているか(true なら保存キーは使われない)。 */
  readonly apiKeyFromEnv: boolean;
  /** Discord Webhook URL。 */
  readonly discordWebhookUrl: string;
  /** EV閾値。 */
  readonly evThreshold: number;
  /** バイアス重み7項目。 */
  readonly biasWeights: BiasWeightValues;
  /** 基礎スコア重み6項目。 */
  readonly baseScoreWeights: BaseScoreWeightValues;
  /** 自動Discord送信ON/OFF。 */
  readonly autoSendDiscord: boolean;
  /**
   * プロンプト追加指示。Discord Webhook URLと同様、機微度が低いため平文のまま返す
   * (往復編集フォームとして表示する必要があるため)。
   */
  readonly additionalInstruction: string;
}

/**
 * レンダラー→main の設定更新ペイロード。
 * apiKey は「省略(undefined)= 現在値を保持」「文字列 = 差し替え(空文字でクリア)」。
 * マスク済み値を再送しないための設計(平文はユーザーが入力したときだけ送る)。
 */
export interface SettingsUpdate {
  /** APIキー。undefined なら現在値保持、文字列なら差し替え。 */
  readonly apiKey?: string;
  /** Discord Webhook URL。 */
  readonly discordWebhookUrl: string;
  /** EV閾値。 */
  readonly evThreshold: number;
  /** バイアス重み7項目。 */
  readonly biasWeights: BiasWeightValues;
  /** 基礎スコア重み6項目。 */
  readonly baseScoreWeights: BaseScoreWeightValues;
  /** 自動Discord送信ON/OFF。 */
  readonly autoSendDiscord: boolean;
  /** プロンプト追加指示。空文字なら注入しない。 */
  readonly additionalInstruction: string;
}

/** 文字列入力を数値へ解釈する(空・空白・非数値は null)。 */
function parseNumberInput(input: string): number | null {
  if (input.trim() === "") {
    return null;
  }
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}

/** EV閾値の入力が妥当か(> 0)。 */
export function isValidThreshold(input: string): boolean {
  const n = parseNumberInput(input);
  return n !== null && n > 0;
}

/** 重みの入力が妥当か(>= 0)。 */
export function isValidWeight(input: string): boolean {
  const n = parseNumberInput(input);
  return n !== null && n >= 0;
}

/** Webhook URL の入力が妥当か(空は許容。非空なら http/https のURL形式)。 */
export function isValidWebhookUrl(input: string): boolean {
  if (input.trim() === "") {
    return true;
  }
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
