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

/**
 * クリップ幅の版ID一覧(タスクD-2: ±10%↔±15%のA/B・新版並走、2026-07-21 boss着手前ゲート合意)。
 * core の analyzer/clip-variants.ts の ClipVariantId と構造一致(shared を core非依存に保つため
 * 再定義。core側 CLIP_VARIANTS のキー集合と一致させること。値の集合はこの配列が唯一の定義元)。
 * "default"=対照(±10%・絶対値0.10)、"wide15"=新版(±15%・絶対値0.15)。
 */
export const CLIP_VARIANT_IDS = ["default", "wide15"] as const;
/** クリップ幅の版ID。 */
export type ClipVariantId = (typeof CLIP_VARIANT_IDS)[number];

/**
 * 馬券配分(機能C-2)のラベル文字列(1箇所に集約。SettingsView.tsxが参照する)。
 * 後から文言を差し替えられるよう定数化する(boss着手前ゲート2026-07-30合意)。
 */
export const BET_ALLOCATION_LABELS = {
  /** 総資金入力欄のラベル。 */
  bankroll: "馬券用の総資金",
  /** 総資金入力欄の補助文(1レースの予算ではないことを明示する)。 */
  bankrollHelp: "馬券に充てている資金の総額です(1レースで使う金額ではありません)",
  /** 1レース上限入力欄のラベル。 */
  perRaceCap: "1レースの上限",
  /** ケリー係数入力欄のラベル(上級設定として区別する)。 */
  kellyFraction: "ケリー係数(上級)",
} as const;

/**
 * 組合せオッズ取得設定(機能D-2c第3段・Issue #28)の文言(1箇所に集約。SettingsView.tsxが
 * 参照する。JSXに文言を直書きしない)。
 *
 * **第4段(Issue #28)で「記録のみ」の記述を更新した(AC19)**: 取得したオッズは、
 * `includeWideInAllocation`/`includeTrioInAllocation`(下記 `ALLOCATION_BET_TYPE_LABELS`)が
 * ONの券種について実際に配分提案へ使われる(`mixed-allocation-view.ts`)。「使うかどうかは
 * 別設定に従う」という条件付きの表現にすることで、状態(このcheckboxがONで、かつ配分対象
 * checkboxがOFFのとき等)によらず文言が事実と食い違わないようにする(この欠陥クラスは
 * 本リポジトリで6回目。`c63d7b2`のレビュー観点参照)。
 * 数値(最大16リクエスト・約24秒・+約5分)は`docs/wide-trio-odds-investigation.md`§5の
 * n-2と1.5秒レート制限からの**導出値**であり、測定値の口調にしない。
 */
export const INCLUDE_COMBO_ODDS_LABELS = {
  /** 設定画面のチェックボックスのラベル。 */
  checkbox: "ワイド・三連複のオッズも取得する(上級)",
  /** チェックボックス直下の補助文。 */
  help:
    "取得に時間がかかります(地方競馬の三連複は1レースあたり最大16リクエスト・約24秒。12レース一括で+約5分)。取得したオッズを馬券配分に使うかどうかは、下記「ワイドを配分に使う」「三連複を配分に使う」の設定に従います。",
} as const;

/**
 * 一括分析画面に、設定(includeComboOdds)がONのときだけ表示する固定注記1行(機能D-2c第3段)。
 * BET_ALLOCATION_UNSET_NOTE(bet-allocation-view.ts)と同じ「画面全体で1点だけの固定注記」の
 * 前例に倣う。対象レース数・所要時間の動的な見積りは含めない(#15/第4段のスコープ)。
 *
 * **第4段でAC19により更新**: 「記録のみで配分提案にはまだ使用していません」は第3段時点の
 * 事実だったが、第4段以降は`includeWideInAllocation`/`includeTrioInAllocation`次第で実際に
 * 使われるため、その依存関係を明記する条件付きの文言に直した(INCLUDE_COMBO_ODDS_LABELS.help
 * と同じ理由)。
 */
export const INCLUDE_COMBO_ODDS_BATCH_NOTE =
  "設定でワイド・三連複のオッズ取得をONにしています。取得したオッズを馬券配分に使うかどうかは「ワイドを配分に使う」「三連複を配分に使う」の設定に従います。";

/**
 * 券種横断の馬券配分(機能D-2c第4段・Issue #28)で、ワイド・三連複を配分対象に含めるかの
 * チェックボックス文言(1箇所に集約。SettingsView.tsxが参照する)。
 *
 * 必須要件3点(boss裁定・AC24):
 * 1. `includeComboOdds`(オッズ取得)がOFFの間は効果が無いことを明記する(取得したオッズが
 *    無いため、このチェックボックスをONにしても候補が0件のまま変わらない。「ONにしたのに
 *    何も変わらない」を未実装と誤認させないため。INCLUDE_COMBO_ODDS_LABELS.helpと対になる)
 * 2. 寄り先の券種を断定しない(AC12と同じ理由。資金規模・1レース上限・greedySteps〈#36〉で
 *    実際に変わりうるため、断定した瞬間に条件次第で嘘になる)
 * 3. 既定がONであることを明示する(`includeComboOdds`自体は既定OFFのオプトインなので、
 *    「この2項目は既定ON」という逆の既定値であることを書かないと誤解を招く)
 */
export const ALLOCATION_BET_TYPE_LABELS = {
  wide: {
    /** ワイドを配分対象にするチェックボックスのラベル。 */
    checkbox: "ワイドを馬券配分に使う",
    /** チェックボックス直下の補助文。 */
    help:
      "既定でONです。上記「ワイド・三連複のオッズも取得する」がOFFの間は効果がありません(取得したオッズが無いため)。ONにすると、複勝の提案額が変わることがあります(理由は一括分析画面の配分内訳に表示します)。",
  },
  /** 三連複を配分対象にするチェックボックスのラベル。 */
  trio: {
    checkbox: "三連複を馬券配分に使う",
    help:
      "既定でONです。上記「ワイド・三連複のオッズも取得する」がOFFの間は効果がありません(取得したオッズが無いため)。ONにすると、複勝の提案額が変わることがあります(理由は一括分析画面の配分内訳に表示します)。",
  },
} as const;

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
  /** Discord Webhook URL(手動送信ボタン・自動送信の両方で実際に使用する)。 */
  readonly discordWebhookUrl: string;
  /** EVプラス判定の閾値(> 0)。 */
  readonly evThreshold: number;
  /** バイアス重み7項目。 */
  readonly biasWeights: BiasWeightValues;
  /** 基礎スコア重み6項目。 */
  readonly baseScoreWeights: BaseScoreWeightValues;
  /**
   * 分析結果の自動Discord送信ON/OFF。
   * ONかつWebhook URL設定済みなら、一括分析完了時に横断EVプラスが1頭以上あれば自動で1通送信する
   * (App.tsx の一括分析完了ハンドラを参照)。
   */
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
  /**
   * クリップ幅の版ID(タスクD-2)。既定"default"(対照、±10%)。
   * analyzer/build-prompt.ts の BuildPromptInput.clipVariant・parseAnalyzerResponse へ渡す
   * maxAdjust の解決に使う(main/pipeline-deps.ts が resolveClipVariant で解決)。
   */
  readonly clipVariant: ClipVariantId;
  /**
   * 馬券用の総資金(円。機能C-2)。既定0(未設定=配分提案を出さない・opt-in)。
   * core BetAllocationConfig.bankroll にそのまま渡る(ケリー基準の元本。1レースの予算ではない)。
   */
  readonly bankroll: number;
  /**
   * 1レースの上限(円。機能C-2)。既定0(未設定=配分提案を出さない・opt-in)。
   * core BetAllocationConfig.perRaceCap にそのまま渡る(「これ以上は賭けない」歯止め)。
   */
  readonly perRaceCap: number;
  /**
   * 馬券配分のケリー係数λ(0.05〜1。機能C-2の上級設定)。既定0.5。
   * core BetAllocationConfig.kellyFraction にそのまま渡る。UI下限を0.05にし、λ=0
   * (見送り理由④)はUIから到達不能にする(settings.json手編集・core直接利用でのみ到達する)。
   */
  readonly kellyFraction: number;
  /**
   * ワイド・三連複のオッズも取得するか(機能D-2c第3段・Issue #28)。既定false(オプトイン)。
   * core `ScrapeRaceOptions.includeComboOdds` と同名にして追跡を1語で通す(main/pipeline-deps.ts が
   * `createPipelineDeps` の config 経由で scrapeRace の第3引数へそのまま渡す)。
   *
   * **第4段(Issue #28)で「記録のみ」の制約を解除した(AC19)**: 取得したオッズは、
   * `includeWideInAllocation`/`includeTrioInAllocation`(下記)がONの券種について
   * `mixed-allocation-view.ts` の馬券配分提案に実際に使われる。第3段時点の「配分提案には
   * 一切使わない」という記述は事実ではなくなったため削除した。
   */
  readonly includeComboOdds: boolean;
  /**
   * ワイドを馬券配分の対象に含めるか(機能D-2c第4段・Issue #28)。既定true。
   * `includeComboOdds`が取得の可否、この項目は**取得できたワイドオッズを配分計算に採用するか**
   * (boss裁定B-1「取得と採用を分離」)。`includeComboOdds`がfalse、またはこの項目がfalseのときは
   * `mixed-allocation-view.ts` が `MixedCandidateBuildOptions.betTypes` にワイドを含めない
   * (`buildMixedCandidates` の `not-requested` 診断値になる)。
   * 配列型ではなくboolean 2項目に分ける設計判断は `includeTrioInAllocation` と共通(D-1。
   * `coerceSettings` の防御が `typeof === "boolean"` 1行で済み、既存 `includeComboOdds` と
   * 流儀が揃う)。
   */
  readonly includeWideInAllocation: boolean;
  /**
   * 三連複を馬券配分の対象に含めるか(機能D-2c第4段・Issue #28)。既定true。
   * 意味論・設計判断は `includeWideInAllocation` と同じ(そちらのJSDoc参照)。
   */
  readonly includeTrioInAllocation: boolean;
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
  /** クリップ幅の版ID(タスクD-2)。往復編集フォームとして表示するため平文のまま返す。 */
  readonly clipVariant: ClipVariantId;
  /** 馬券用の総資金(円。機能C-2)。往復編集フォームとして表示するため平文のまま返す。 */
  readonly bankroll: number;
  /** 1レースの上限(円。機能C-2)。往復編集フォームとして表示するため平文のまま返す。 */
  readonly perRaceCap: number;
  /** 馬券配分のケリー係数λ(機能C-2)。往復編集フォームとして表示するため平文のまま返す。 */
  readonly kellyFraction: number;
  /** ワイド・三連複のオッズも取得するか(機能D-2c第3段)。往復編集フォームとして表示するためそのまま返す。 */
  readonly includeComboOdds: boolean;
  /** ワイドを馬券配分の対象に含めるか(機能D-2c第4段)。往復編集フォームとして表示するためそのまま返す。 */
  readonly includeWideInAllocation: boolean;
  /** 三連複を馬券配分の対象に含めるか(機能D-2c第4段)。往復編集フォームとして表示するためそのまま返す。 */
  readonly includeTrioInAllocation: boolean;
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
  /** クリップ幅の版ID(タスクD-2)。CLIP_VARIANT_IDS に無い値・欠損はmain側でdefaultへフォールバック。 */
  readonly clipVariant: ClipVariantId;
  /** 馬券用の総資金(円。機能C-2)。範囲外・非数値はmain側で既定(0)へフォールバック。 */
  readonly bankroll: number;
  /** 1レースの上限(円。機能C-2)。範囲外・非数値はmain側で既定(0)へフォールバック。 */
  readonly perRaceCap: number;
  /** 馬券配分のケリー係数λ(機能C-2)。範囲外・非数値はmain側で既定(0.5)へフォールバック。 */
  readonly kellyFraction: number;
  /**
   * ワイド・三連複のオッズも取得するか(機能D-2c第3段)。boolean以外(main側coerceSettings)は
   * 既定(false)へフォールバック(チェックボックス由来でUI側からは不正値が作れないため、
   * `isValid*`バリデータは設けない。`autoSendDiscord`と同じ流儀)。
   */
  readonly includeComboOdds: boolean;
  /**
   * ワイドを馬券配分の対象に含めるか(機能D-2c第4段)。boolean以外(main側coerceSettings)は
   * 既定(true)へフォールバック(`includeComboOdds`の既定falseとは逆向きだが、理由はD-1の
   * boss裁定〈ワイド・三連複とも既定ON〉参照。`isValid*`バリデータは設けない)。
   */
  readonly includeWideInAllocation: boolean;
  /**
   * 三連複を馬券配分の対象に含めるか(機能D-2c第4段)。意味論は`includeWideInAllocation`と同じ
   * (既定true・boolean以外は既定へフォールバック)。
   */
  readonly includeTrioInAllocation: boolean;
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

/**
 * 総資金の入力が妥当か(0〜100,000,000の整数。機能C-2)。
 * 0は「未設定」を表す既定値であり妥当な入力として許容する(仕様: opt-in)。
 */
export function isValidBankroll(input: string): boolean {
  const n = parseNumberInput(input);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 100_000_000;
}

/**
 * 1レースの上限の入力が妥当か(0〜10,000,000の整数。機能C-2)。
 * 0は「未設定」を表す既定値であり妥当な入力として許容する(仕様: opt-in)。
 */
export function isValidPerRaceCap(input: string): boolean {
  const n = parseNumberInput(input);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 10_000_000;
}

/**
 * ケリー係数の入力が妥当か(0.05〜1。機能C-2)。
 * 下限を0.05にすることで、UI経由ではλ=0(core見送り理由④)に到達できないようにする
 * (④はsettings.json手編集・core直接利用でのみ到達する契約上の分類。boss着手前ゲート2026-07-30)。
 */
export function isValidKellyFraction(input: string): boolean {
  const n = parseNumberInput(input);
  return n !== null && n >= 0.05 && n <= 1;
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
