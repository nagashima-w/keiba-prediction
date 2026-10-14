/**
 * LLM モデルの自動選択(Issue #157)。
 *
 * 方針(ユーザー判断 2026-10-02「常に最新のモデルを使えるようにしたい」):
 *  - Models API の一覧から「最新の Sonnet」を選ぶ(pickLatestSonnet)。
 *  - Issue #158(クラウド版の設定画面でモデルを選ぶ): Opus・Haiku の最新も同じ規則で選べる(pickLatestOfFamily。
 *    selector は family を受ける。省略は sonnet で、exe の挙動は変わらない)。
 *  - 一覧の取得は分析の初回に遅延実行し、selector 単位でメモ化する(失敗もメモ化・TTLなし)。
 *    AnthropicLlmClient は1レースごとに new されるため、キャッシュはクライアントの外
 *    (createPipelineDeps が1つ作る ModelSelector)に持つ。
 *  - 一覧の取得に失敗したとき・Sonnet が0件のときは、動作確認済みの固定モデルを使う。
 *  - 選んだモデルがリクエストを拒否したときの固定モデルへの切り替え(demote)は
 *    AnthropicLlmClient が行い、降格はこの selector が覚える(deps の寿命の間だけ)。
 *
 * SDK 呼び出し(createSdkModelLister)はこのファイルに閉じ込め、選別・メモ化は注入された lister で
 * 実 API なしにテストできる。
 */

import Anthropic from "@anthropic-ai/sdk";

/** Models API の1件のうち、選別に使う最小の形。 */
export interface ModelInfoLite {
  /** モデルID(例: "claude-sonnet-5-5")。 */
  readonly id: string;
  /** 公開日時(RFC 3339)。同順位の決着にだけ使う。 */
  readonly created_at: string;
}

/** 利用可能なモデルの一覧を返す関数(注入・モック可能)。 */
export type ModelLister = () => Promise<ReadonlyArray<ModelInfoLite>>;

/** 自動選択の対象にするモデルの系統(Issue #158)。 */
export type ModelFamily = "sonnet" | "opus" | "haiku";

/** 系統の一覧(選択肢の並び)。 */
export const MODEL_FAMILIES: readonly ModelFamily[] = ["sonnet", "opus", "haiku"];

/** 警告文に出す系統名。 */
const FAMILY_LABELS: Readonly<Record<ModelFamily, string>> = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" };

/**
 * 自動選択の対象にするモデルの ID。`claude-<family>-<major>(-<minor>)?` だけを許す。
 * major・minor は1〜2桁に限る: `claude-sonnet-4-20250514` のような日付付きスナップショットは
 * minor が8桁になり、1〜2桁に限らないと「minor=20250514 の最新版」として誤って選ばれてしまう(Opus・Haiku も同じ)。
 * 日付付き(`-4-5-20250929` 等)・preview・latest などの接尾辞付きも一致しない。
 */
const FAMILY_ID_PATTERNS: Readonly<Record<ModelFamily, RegExp>> = {
  sonnet: /^claude-sonnet-(\d{1,2})(?:-(\d{1,2}))?$/,
  opus: /^claude-opus-(\d{1,2})(?:-(\d{1,2}))?$/,
  haiku: /^claude-haiku-(\d{1,2})(?:-(\d{1,2}))?$/,
};

/** created_at を数値化する(解釈できなければ 0 = 最も古い扱い)。 */
function createdAtMs(createdAt: string): number {
  const t = Date.parse(createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 一覧から、指定した系統の最新のIDを選ぶ純関数(Issue #158)。該当が無ければ null。
 * 順序: ID の (major, minor) の降順(minor 省略は 0)→同順位は created_at の新しい順
 * (数値として比較する。文字列比較だと 9-9 が 10 に勝ってしまう)。
 * それでも同点なら ID の辞書順(降順)で決め、入力順に依存しない結果にする。
 */
export function pickLatestOfFamily(models: ReadonlyArray<ModelInfoLite>, family: ModelFamily): string | null {
  const pattern = FAMILY_ID_PATTERNS[family];
  const candidates: { id: string; major: number; minor: number; created: number }[] = [];
  for (const m of models) {
    const match = pattern.exec(m.id);
    if (match === null) continue;
    candidates.push({
      id: m.id,
      major: Number(match[1]),
      minor: match[2] === undefined ? 0 : Number(match[2]),
      created: createdAtMs(m.created_at),
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      b.major - a.major ||
      b.minor - a.minor ||
      b.created - a.created ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  return candidates[0]!.id;
}

/** 一覧から最新の Sonnet のIDを選ぶ(`pickLatestOfFamily(models, "sonnet")`。#157 からの互換)。 */
export function pickLatestSonnet(models: ReadonlyArray<ModelInfoLite>): string | null {
  return pickLatestOfFamily(models, "sonnet");
}

/** モデルの自動選択状態(deps 単位で1つ持つ)。 */
export interface ModelSelector {
  /** 動作確認済みの固定モデル(切り替え先)。 */
  readonly fixedModel: string;
  /**
   * 使用するモデルIDを返す。初回に lister を遅延実行してメモ化する(失敗・0件は固定モデル)。
   * demote 後は常に固定モデル。
   */
  resolve(): Promise<string>;
  /** 自動選択モデルを諦めて固定モデルに降格する(以降 resolve は固定モデルを返す)。 */
  demote(): void;
}

/** createModelSelector の引数。 */
export interface ModelSelectorOptions {
  /** 一覧取得関数(注入)。 */
  readonly lister: ModelLister;
  /** 固定モデル。 */
  readonly fixedModel: string;
  /** 選ぶ系統(Issue #158)。省略は sonnet(#157 からの挙動。exe はこれを渡さない)。固定モデル(切り替え先)は系統によらず fixedModel。 */
  readonly family?: ModelFamily;
  /** 警告の記録先(一覧取得の失敗・その系統が 0件)。省略時は何も記録しない。 */
  readonly onWarn?: (message: string) => void;
}

/** ModelSelector を作る。lister はここでは呼ばない(resolve の初回で遅延実行)。 */
export function createModelSelector(options: ModelSelectorOptions): ModelSelector {
  const { lister, fixedModel, onWarn } = options;
  const family = options.family ?? "sonnet";
  let demoted = false;
  let picked: Promise<string> | null = null;

  const pick = async (): Promise<string> => {
    try {
      const models = await lister();
      const latest = pickLatestOfFamily(models, family);
      if (latest === null) {
        onWarn?.(
          `利用可能なモデルに ${FAMILY_LABELS[family]} が見つからないため、固定モデル(${fixedModel})を使います`,
        );
        return fixedModel;
      }
      return latest;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      onWarn?.(
        `モデル一覧の取得に失敗したため、固定モデル(${fixedModel})を使います: ${detail}`,
      );
      return fixedModel;
    }
  };

  return {
    fixedModel,
    resolve(): Promise<string> {
      if (demoted) return Promise.resolve(fixedModel);
      picked ??= pick();
      return picked;
    },
    demote(): void {
      demoted = true;
    },
  };
}

/** createSdkModelLister の引数。 */
export interface SdkModelListerOptions {
  /** APIキー(省略時は環境変数 ANTHROPIC_API_KEY)。 */
  readonly apiKey?: string;
  /** fetch の差し替え(テスト用。実 API を呼ばずにリクエストを検証する)。 */
  readonly fetch?: typeof fetch;
  /** 1リクエストの上限時間(ミリ秒。Issue #193)。省略時は SDK の既定(10 分)のまま(exe は渡さない)。 */
  readonly timeout?: number;
  /** SDK が内部で行う再試行の回数(Issue #193)。省略時は SDK の既定(2 回)のまま(exe は渡さない)。 */
  readonly maxRetries?: number;
}

/**
 * 既定の lister: @anthropic-ai/sdk の `client.models.list()` で全ページを辿る。
 * SDK クライアントは呼び出し時に遅延生成する(APIキー未設定でも組み立て時にエラーにしない)。
 */
export function createSdkModelLister(options: SdkModelListerOptions = {}): ModelLister {
  let client: Anthropic | null = null;
  return async () => {
    if (client === null) {
      client = new Anthropic({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      });
    }
    const out: ModelInfoLite[] = [];
    for await (const m of client.models.list({ limit: 1000 })) {
      out.push({ id: m.id, created_at: m.created_at });
    }
    return out;
  };
}
