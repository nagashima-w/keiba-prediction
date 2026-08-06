/**
 * 地方(NAR)ワイド・3連複オッズ(odds/index.html?type=b5|b7、および軸馬別AJAXフラグメント
 * odds_get_form.html?type=b7&jiku=N)のパーサー(機能D-2b-A・Issue #32)。
 *
 * 既存 `parse-nar-odds.ts`(単勝・複勝、`#odds_tan_block`/`#odds_fuku_block`ベースの行構造)は
 * 一切変更せず、独立モジュールとして実装する(受け入れ条件2)。組合せオッズは行構造ではなく
 * 軸馬ごとの `table.Odds_Table`(グリッド行列)に跨って `td.Odds` セルが並び、各セルの `id`
 * (例: `chk_a1-54-10_b5_c0_1_2`)に馬番の組が埋め込まれる構造のため、既存 `dataRows` ベースの
 * 行走査は流用せず、`id` パターンマッチでセルを直接走査する(#13〈機能D-1〉の
 * `wide-trio-odds-fixtures.test.ts` で実測済みの抽出方式を踏襲。詳細は `selectors.ts` の
 * `NAR_COMBO_ODDS_SELECTORS` JSDoc)。
 *
 * ## AJAXフラグメント対応について(受け入れ条件2)
 *
 * ワイド(b5)は静的ページ1回で全組合せが取得できる設計であり(`urls.ts` の
 * `narWideOddsPageUrl` にAJAXフラグメント用のURL関数自体が存在しない。実測: boss確認
 * 〈2026-08-06、実リクエスト0〉で `#list_select_horse`〈軸馬選択プルダウン〉はJS関数本体の
 * 中の文字列としてのみ出現し、DOM要素としてはb5ページに存在しない=b5はサイトのUI自体が
 * 軸馬切替を提供していない)、b5のAJAXフラグメントは本番導線で呼ばれる見込みが無い。
 * そのため本モジュールはb5専用のAJAXフラグメント実物フィクスチャを持たない。
 *
 * 一方、本パーサ自体は通常ページ/AJAXフラグメントを型として区別しない(`cheerio.load`は
 * どちらも同様に読め、「オッズ文書として正当か」の判定〈下記〉と `id` パターンマッチによる
 * セル走査はページの外枠の有無に依存しない)。したがって3連複(b7)の実物AJAXフラグメント
 * (`nar_odds_b7_jiku2_202654071210.html`)で対応を検証すれば、同一コードパスを通る
 * b5にも同様に適用できる(受け入れ条件2の「両方」は、型として共有するコードパスをb7の
 * 実物で検証することで満たす。b5独自のフラグメント実物を持たない判断根拠はIssue #32本文に
 * 記録)。
 *
 * ## 「オッズ文書として正当か」の判定根拠(受け入れ条件8)
 *
 * `selectors.ts` の `NAR_COMBO_ODDS_SELECTORS` JSDoc参照。`#odds_select`(投票カート件数)
 * と `#odds_view_form`(本文ラッパー)の**OR**判定を採用する(いずれか単独では発売前ページ
 * またはAJAXフラグメントのどちらかでthrowしてしまうため)。
 *
 * ## 数値防御カバレッジ表(受け入れ条件11。#14と同じ5列)
 *
 * | 入力 | 経路 | 防御 | 方式 | 理由・テスト所在 |
 * |---|---|---|---|---|
 * | オッズ文字列(下限・単一値。td.Oddsの直接テキストノード) | `parseNarComboOdds`(`toOddsNumber`) | あり | null化(桁区切りカンマを除去してから数値判定。非数値・"---.-"・"取消"・空文字はnull) | 実測(地方3連複55件中5件がカンマ入り)。`parse-nar-combo-odds.test.ts`「桁区切りカンマ」「値の解釈」describe |
 * | オッズ文字列(上限。"下限 - 上限"レンジのハイフン以降。ワイドのみ) | `parseNarComboOdds`(レンジ分割+`toOddsNumber`) | あり | null化(レンジとして分割できない場合は下限・上限とも null) | 同上 |
 * | 人気(このドキュメント種別に列自体が存在しない) | `parseNarComboOdds` | あり | 対象外(常にnull固定。実測でこの表示種別に人気列が無いことを確認済みのため防御ではなく仕様) | `parse-nar-combo-odds.test.ts`「値の解釈」describe |
 * | 馬番(td.Oddsのid属性由来) | `decodeCellId`(`validateComboUmabans`経由) | あり | throw(1〜18範囲外・昇順違反〈重複含む〉を検出) | `parse-nar-combo-odds.test.ts`「構造の検証」describe |
 * | td.Oddsの直接テキスト(隠しinput/labelの文字混入防止) | `directText` | あり | 除外(cheerioのcontents()でテキストノードのみを対象にし、子要素〈input/label〉のテキストを合成しない) | `parse-nar-combo-odds.test.ts`「隠しinput/labelの文字が混入しないこと」describe(合成データ。防御的不変条件) |
 */

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { NAR_COMBO_ODDS_SELECTORS as SEL } from "./selectors.js";
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

export type { ComboBetType, ComboOddsCell };
export { buildComboOddsKey };

/** 地方ワイド・3連複オッズのパース失敗(構造不一致・馬番範囲外等)を表す例外。 */
export class NarComboOddsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarComboOddsParseError";
  }
}

/** 券種→セルidに埋め込まれるページ内部コード("b5"=ワイド、"b7"=3連複)。 */
const ID_MARKER: Record<ComboBetType, string> = { wide: "b5", trio: "b7" };

/**
 * 地方ワイド・3連複オッズのパース結果(判別共用体)。
 * 中央(`parse-combo-odds.ts`の`ComboOddsParseResult`)と異なりunavailableに理由を持たない。
 * 理由: HTML側の封筒異常(オッズ文書と判定できない構造)はthrow側で捕捉されるため、
 * unavailableに落ちる経路は主に「文書としては正当だが組合せが0件」の1パターンに限られ、
 * 中央JSON(status/data/oddsキーの多段欠落パターン)ほど理由を区別する必要性が薄いため。
 */
export type NarComboOddsParseResult =
  | { readonly state: "available"; readonly odds: ReadonlyMap<string, ComboOddsCell> }
  | { readonly state: "unavailable" };

const PLAIN_NUMBER = /^[0-9]+(\.[0-9]+)?$/;
/** 桁区切りカンマ付き数値(例: "1,172.4")。3桁ごとの区切りのみ許容し、不正な区切りは拒否する。 */
const GROUPED_NUMBER = /^[0-9]{1,3}(,[0-9]{3})*(\.[0-9]+)?$/;

/** オッズ文字列(桁区切りカンマ許容)を数値化する。非数値・未確定("---.-"等)は null。 */
function toOddsNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (PLAIN_NUMBER.test(trimmed)) return Number(trimmed);
  if (GROUPED_NUMBER.test(trimmed)) return Number(trimmed.replace(/,/g, ""));
  return null;
}

/**
 * td.Odds要素の「直接の」テキストノードのみを連結して返す(子要素のテキストを含めない)。
 * 同一id同居の隠しinput/labelの文字混入を構造的に防ぐ(input自体はテキストノードを
 * 持たないため実害は無いが、labelは将来可視テキストを持ちうるため、子要素を辿らない
 * この抽出方式そのものが防御になる。数値防御カバレッジ表参照)。
 */
function directText($: CheerioAPI, el: ReturnType<CheerioAPI>[number]): string {
  const texts: string[] = [];
  $(el)
    .contents()
    .each((_, node) => {
      if (node.type === "text") {
        texts.push($(node).text());
      }
    });
  return texts.join("").trim();
}

/** ワイドの"下限 - 上限"形式テキストを分割して数値化する。分割できない場合は両方null。 */
function parseRangeText(text: string): { oddsMin: number | null; oddsMax: number | null } {
  const parts = text.split(/\s*-\s*/);
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return { oddsMin: null, oddsMax: null };
  }
  return { oddsMin: toOddsNumber(parts[0]!), oddsMax: toOddsNumber(parts[1]!) };
}

/** セルid(例: "chk_a1-54-10_b5_c0_1_2")から馬番配列を抽出する(構造throw側)。 */
function decodeCellId(id: string, betType: ComboBetType): number[] {
  const marker = ID_MARKER[betType];
  const comboSize = COMBO_SIZE[betType];
  const pattern =
    comboSize === 2
      ? new RegExp(`_${marker}_c0_(\\d+)_(\\d+)$`)
      : new RegExp(`_${marker}_c0_(\\d+)_(\\d+)_(\\d+)$`);
  const m = pattern.exec(id);
  if (!m) {
    // idパターン自体が一致しない(型の取り違え・想定外の構造)場合は、この要素を
    // 「該当セルではない」として呼び出し側でスキップする(呼び出し側でnullを返す)。
    throw new NarComboOddsParseError(`セルidから馬番を抽出できませんでした(id="${id}")`);
  }
  const umabans = m.slice(1).map((s) => Number(s));
  try {
    validateComboUmabans(umabans, comboSize);
  } catch (e) {
    if (e instanceof ComboOddsKeyError) {
      throw new NarComboOddsParseError(`${e.message}(id="${id}")`);
    }
    throw e;
  }
  return umabans;
}

/**
 * 「オッズ文書として正当か」を判定する(#odds_select OR #odds_view_form。
 * モジュール冒頭JSDoc・selectors.tsのNAR_COMBO_ODDS_SELECTORS参照)。
 */
function isRecognizedOddsDocument($: CheerioAPI): boolean {
  return $(SEL.cartCount).length > 0 || $(SEL.viewFormWrapper).length > 0;
}

/**
 * 地方ワイド・3連複オッズページ(通常ページ・AJAXフラグメントとも)をパースする。
 *
 * 「構造は throw / 値は null」の線引き(受け入れ条件7): オッズ文書として正当と判定できない
 * HTML、またはセルidから馬番を復元できない(範囲外・昇順違反)場合は throw する。
 * 文書としては正当だが組合せセルが1件も見つからない場合(発売なし・未発売・型の取り違え等、
 * 区別できない事実を型で偽らない。受け入れ条件10)は `unavailable` に分類する(throwしない)。
 *
 * @param html odds/index.html?type=b5|b7 または odds_get_form.html のHTML文字列
 * @param betType "wide"(b5)または"trio"(b7)
 */
export function parseNarComboOdds(html: string, betType: ComboBetType): NarComboOddsParseResult {
  const $ = cheerio.load(html);

  if (!isRecognizedOddsDocument($)) {
    throw new NarComboOddsParseError(
      "オッズ文書として認識できませんでした(#odds_select・#odds_view_formのいずれも見つかりません)",
    );
  }

  const marker = ID_MARKER[betType];
  const idSubstring = `_${marker}_c0_`;
  const entries: ComboOddsEntry[] = [];

  $(SEL.oddsCell).each((_, el) => {
    const id = $(el).attr("id") ?? "";
    if (!id.includes(idSubstring)) {
      // 型の取り違え防止: 別券種(または単複ページ)のセルidはこの部分文字列を含まない。
      return;
    }
    const umabans = decodeCellId(id, betType);
    const text = directText($, el);
    if (betType === "wide") {
      const { oddsMin, oddsMax } = parseRangeText(text);
      entries.push({ umabans, cell: { oddsMin, oddsMax, ninki: null } });
    } else {
      const oddsMin = text === "" ? null : toOddsNumber(text);
      entries.push({ umabans, cell: { oddsMin, oddsMax: null, ninki: null } });
    }
  });

  if (entries.length === 0) {
    return { state: "unavailable" };
  }

  let cellMap: Map<string, ComboOddsCell>;
  try {
    cellMap = buildComboOddsCellMap(entries);
  } catch (e) {
    if (e instanceof ComboOddsKeyError) {
      throw new NarComboOddsParseError(e.message);
    }
    throw e;
  }

  return { state: "available", odds: cellMap };
}
