/**
 * 中央(race.netkeiba.com)のワイド・3連複オッズ(api_get_jra_odds、type=5/7)のパーサー
 * (機能D-2b-A・Issue #32)。
 *
 * 実装当初(#32)は既存 `parse-odds.ts`(単勝・複勝、type=1/2)を一切変更せず、独立モジュールとして
 * 実装した(受け入れ条件1)。**その後 Issue #34 で、人気(`ninki`)の数値化のみ
 * `scraper/ninki.ts` の共有実装 `toNinki` に統合した**(単勝・複勝〈`parse-odds.ts`〉/
 * ワイド・3連複(本モジュール)/地方〈`parse-nar-odds.ts`〉の3パーサ全体で契約を統一。
 * 詳細は `scraper/ninki.ts` のJSDoc参照)。オッズ(`toOddsNumber`。桁区切りカンマ対応等)を
 * 含む下記1〜3の差分は #32 当時のまま本モジュール固有であり、
 * `parse-odds.ts` とは次の3点で契約が異なる:
 *
 * 1. **桁区切りカンマ**: 中央3連複オッズの実測45%(560件中251件。再現:
 *    `python3 -c "import json;o=json.load(open('fixtures/odds_trio_202603020211.json'))['data']['odds']['7'];print(len(o),sum(1 for v in o.values() if ',' in v[0]))"` → `560 251`)が
 *    カンマ区切り("15,462.5"等)であり、`parse-odds.ts` の `toOddsNumber`
 *    (`/^[0-9]+(\.[0-9]+)?$/`)をそのまま使うと高オッズ側(妙味の源泉)に偏ってnull化する。
 *    本モジュールは桁区切りを剥がしてから数値化する。
 * 2. **3連複の2要素目はダミー**: `["260.2","0.0","103"]` の `"0.0"` を上限として拾わない。
 *    `oddsMax` は常に `null`(3連複は幅を持たない券種であることを型で表現。決定は
 *    `scraper/combo-odds-key.ts` の `ComboOddsCell` JSDoc参照)。
 * 3. **未発売・封筒異常はunavailableに分類し、throwしない**(受け入れ条件7、改訂版。
 *    boss指摘2026-08-06「未発売時の封筒が `{"status":"NG","data":"",...}` のように
 *    `data` がオブジェクトですらない形で返る可能性がある」。throwするとレース全体の
 *    スクレイプが落ちるため、**`JSON.parse` に失敗した場合のみ throw** し、それ以外
 *    (`data` が非オブジェクト・`odds` キー欠落・`odds[type]` キー欠落・未知の `status`)は
 *    すべて `unavailable` として理由(`reason`)付きで返す。「構造は throw / 値は null」の
 *    線引きに対応する第3の軸として「封筒異常は unavailable」を追加した形になる
 *    (受け入れ条件7・7b)。
 *
 * ## 数値防御カバレッジ表(受け入れ条件11。#14と同じ5列)
 *
 * | 入力 | 経路 | 防御 | 方式 | 理由・テスト所在 |
 * |---|---|---|---|---|
 * | オッズ文字列(下限・単一値。`cellAt(value,0)`) | `parseComboOdds`(`toOddsNumber`) | あり | null化(桁区切りカンマを除去してから数値判定。非数値・"---.-"・"取消"・空文字はnull) | 実測(560件中251件がカンマ入り)。`parse-combo-odds.test.ts`「桁区切りカンマ」「非数値の値の解釈」describe |
 * | オッズ文字列(上限。`cellAt(value,1)`。ワイドのみ使用) | `parseComboOdds`(`toOddsNumber`) | あり | null化(同上)。3連複はこの列を一切読まず常に`oddsMax=null`固定 | 同上。「3連複の2要素目はダミー」describe |
 * | 人気文字列(`cellAt(value,2)`) | `parseComboOdds`(共有ヘルパ `scraper/ninki.ts` の `toNinki`) | あり | null化(非数値・"0"は欠損表現としてnull。上限は課さない) | `parse-combo-odds.test.ts`「非数値の値の解釈」describe。**`toNinki` は `scraper/ninki.ts` の共有実装であり、単勝・複勝(`parse-odds.ts`)/地方(`parse-nar-odds.ts`)とも同一の契約を使う(Issue #34で統一。契約の詳細・根拠は `scraper/ninki.ts` のJSDoc参照)** |
 * | 馬番(オッズキー由来。例"0102") | `decodeRawKey`(`validateComboUmabans`経由) | あり | throw(2桁ずつ分解し1〜18範囲外・キー長不一致・昇順違反〈"0201"等〉を検出) | `parse-combo-odds.test.ts`「構造の検証」describe |
 * | 組の要素数(キー長 / 券種との不一致) | `decodeRawKey` | あり | throw(`COMBO_SIZE`との不一致) | 同上 |
 * | JSON封筒(`status`/`data`/`data.odds`/`data.odds[type]`の型・欠落) | `parseComboOdds` | あり | 分類(`unavailable`。throwしない。`JSON.parse`失敗のみthrow) | `parse-combo-odds.test.ts`「未発売・封筒異常」describe |
 */

import {
  buildComboOddsCellMap,
  buildComboOddsKey,
  COMBO_SIZE,
  ComboOddsKeyError,
  validateComboUmabans,
  type ComboBetType,
  type ComboOddsCell,
  type ComboOddsEntry,
} from "./combo-odds-key.js";
import { toNinki } from "./ninki.js";

export type { ComboBetType, ComboOddsCell };
export { buildComboOddsKey };

/** ワイド・3連複オッズのパース失敗(JSON構文エラー・構造不一致)を表す例外。 */
export class ComboOddsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComboOddsParseError";
  }
}

/** 券種→JSON応答上のoddsキー("5"=ワイド、"7"=3連複)。 */
const JSON_ODDS_KEY: Record<ComboBetType, string> = { wide: "5", trio: "7" };

/**
 * オッズが取得できなかった理由(受け入れ条件7b)。
 * 生の `status` 値・応答の `reason` フィールド・欠落した段のキー名を保持することで、
 * 「netkeibaがAPIを変えて全レースunavailableになった」ことを「全レース発売なしだった」と
 * 誤読しないようにする(#33でScrapeWarningへ載せる想定の申し送り)。
 */
export interface ComboOddsUnavailableReason {
  /** 応答の `status` 値(文字列として読めなかった場合は null)。 */
  readonly rawStatus: string | null;
  /** 応答ルートの `reason` フィールド(存在しない・文字列でない場合は null)。 */
  readonly rawReason: string | null;
  /**
   * 構造のどの段が欠落/不正だったか("data" | "odds" | "5" | "7" | "(root)")。
   * 組合せが0件だった場合(段は揃っているが中身が空)は null。
   */
  readonly missingKey: string | null;
}

/** ワイド・3連複オッズのパース結果(判別共用体)。 */
export type ComboOddsParseResult =
  | { readonly state: "available"; readonly odds: ReadonlyMap<string, ComboOddsCell> }
  | { readonly state: "unavailable"; readonly reason: ComboOddsUnavailableReason };

const PLAIN_NUMBER = /^[0-9]+(\.[0-9]+)?$/;
/** 桁区切りカンマ付き数値(例: "15,462.5")。3桁ごとの区切りのみ許容し、不正な区切りは拒否する。 */
const GROUPED_NUMBER = /^[0-9]{1,3}(,[0-9]{3})*(\.[0-9]+)?$/;

/** オッズ文字列(桁区切りカンマ許容)を数値化する。非数値・未確定("---.-"等)は null。 */
function toOddsNumber(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (PLAIN_NUMBER.test(trimmed)) return Number(trimmed);
  if (GROUPED_NUMBER.test(trimmed)) return Number(trimmed.replace(/,/g, ""));
  return null;
}

/** 配列セル([...])から指定インデックスの要素を安全に取り出す。 */
function cellAt(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined;
}

/** 生のオッズキー(例: "0102")を検証し馬番配列に分解する(構造throw側)。 */
function decodeRawKey(rawKey: string, betType: ComboBetType): number[] {
  const comboSize = COMBO_SIZE[betType];
  if (rawKey.length !== comboSize * 2) {
    throw new ComboOddsParseError(
      `オッズキーの桁数が券種と一致しません(betType=${betType}, key="${rawKey}")`,
    );
  }
  const umabans: number[] = [];
  for (let i = 0; i < comboSize; i++) {
    const segment = rawKey.slice(i * 2, i * 2 + 2);
    if (!/^[0-9]{2}$/.test(segment)) {
      throw new ComboOddsParseError(`オッズキーが数字ではありません(key="${rawKey}")`);
    }
    umabans.push(Number(segment));
  }
  try {
    validateComboUmabans(umabans, comboSize);
  } catch (e) {
    if (e instanceof ComboOddsKeyError) {
      throw new ComboOddsParseError(`${e.message}(key="${rawKey}")`);
    }
    throw e;
  }
  return umabans;
}

function unavailable(
  rawStatus: string | null,
  rawReason: string | null,
  missingKey: string | null,
): ComboOddsParseResult {
  return { state: "unavailable", reason: { rawStatus, rawReason, missingKey } };
}

/**
 * 中央のワイド・3連複オッズAPI応答(api_get_jra_odds、type=5/7)をパースする。
 *
 * 「構造は throw / 値は null」の線引き(受け入れ条件7)に加え、「封筒異常は unavailable」
 * という第3の扱いを持つ(モジュール冒頭JSDoc参照)。throwするのは **JSON.parse に失敗した
 * 場合のみ**。それ以外の封筒異常(`data` 非オブジェクト・`odds` 欠落・`odds[type]` 欠落・
 * 未知の `status`)はすべて `unavailable` に分類する。ただし、封筒が最低限の構造を満たした
 * 上での**馬番キー自体の異常**(範囲外・桁数不一致・昇順違反)は throw する(データが来ている
 * のに内容が壊れている、という別種の異常であるため)。
 *
 * @param json api_get_jra_odds のJSON文字列
 * @param betType "wide"(type=5)または"trio"(type=7)
 */
export function parseComboOdds(json: string, betType: ComboBetType): ComboOddsParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ComboOddsParseError("JSONとして解釈できませんでした");
  }

  if (typeof parsed !== "object" || parsed === null) {
    return unavailable(null, null, "(root)");
  }
  const root = parsed as Record<string, unknown>;
  const rawStatus = typeof root.status === "string" ? root.status : null;
  const rawReason = typeof root.reason === "string" ? root.reason : null;

  const data = root.data;
  if (typeof data !== "object" || data === null) {
    return unavailable(rawStatus, rawReason, "data");
  }
  const dataObj = data as Record<string, unknown>;

  const odds = dataObj.odds;
  if (typeof odds !== "object" || odds === null) {
    return unavailable(rawStatus, rawReason, "odds");
  }
  const oddsObj = odds as Record<string, unknown>;

  const typeKey = JSON_ODDS_KEY[betType];
  const combo = oddsObj[typeKey];
  if (typeof combo !== "object" || combo === null) {
    return unavailable(rawStatus, rawReason, typeKey);
  }

  const entries: ComboOddsEntry[] = [];
  for (const [rawKey, value] of Object.entries(combo as Record<string, unknown>)) {
    const umabans = decodeRawKey(rawKey, betType);
    const oddsMin = toOddsNumber(cellAt(value, 0));
    const oddsMax = betType === "wide" ? toOddsNumber(cellAt(value, 1)) : null;
    const ninki = toNinki(cellAt(value, 2));
    entries.push({ umabans, cell: { oddsMin, oddsMax, ninki } });
  }

  if (entries.length === 0) {
    return unavailable(rawStatus, rawReason, null);
  }

  let cellMap: Map<string, ComboOddsCell>;
  try {
    cellMap = buildComboOddsCellMap(entries);
  } catch (e) {
    if (e instanceof ComboOddsKeyError) {
      throw new ComboOddsParseError(e.message);
    }
    throw e;
  }

  return { state: "available", odds: cellMap };
}
