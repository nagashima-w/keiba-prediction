/**
 * 出馬表(shutuba.html)の芝コース区分(柵)パーサのテスト。
 *
 * タスク#26-P1: 芝の傷み目安をLLM入力に加える機能(#26)の土台。
 * fence は ShutubaRaceInfo に非破壊optionalで追加した三状態フィールド:
 * - undefined(キー自体が無い): 芝以外(ダート・障害)。柵の概念が無いため省略。
 * - null: 芝だが柵letterを判別できなかった。
 * - 単一の大文字文字列(例: "A"): 判別できた柵。
 *
 * 既存の parse-shutuba.test.ts は一切書き換えず(既存回帰ゼロ)、
 * fence関連の観点はすべて本ファイルに集約する。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseShutuba } from "../../src/scraper/parse-shutuba.js";

/** フィクスチャHTMLを読み込む(実ネットワークは使わない)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/**
 * 出馬表ページ全体を組み立てる(RaceData01のみ可変。他要素は最小限のダミー1行)。
 * 既存 parse-shutuba.test.ts の buildPage と同じ最小構成方針に倣う。
 *
 * raceData01 は呼び出し側が実体 `&nbsp;`(HTMLソース上の文字参照)を直接書いた
 * 文字列を渡す想定(本番のnetkeiba出馬表と同じ区切り文字を再現するため)。
 */
function buildPage(raceData01: string): string {
  return `
    <div class="RaceList_Item02">
      <h1 class="RaceName">テストレース</h1>
      <div class="RaceData01">${raceData01}</div>
    </div>
    <table><tbody>
      <tr class="HorseList">
        <td class="Waku1 Txt_C"><span>1</span></td>
        <td class="Umaban1 Txt_C">1</td>
        <td class="HorseInfo"><span class="HorseName"><a href="https://db.netkeiba.com/horse/2023103386" title="テスト馬">テスト馬</a></span></td>
        <td class="Barei Txt_C">牡3</td>
        <td class="Txt_C">55.0</td>
        <td class="Jockey"><a href="https://db.netkeiba.com/jockey/result/recent/01043/" title="騎手">騎手</a></td>
        <td class="Trainer"><span class="Label1">美浦</span><a href="https://db.netkeiba.com/trainer/result/recent/01126/" title="調教師">調教師</a></td>
        <td class="Weight">464(-8)</td>
      </tr>
    </tbody></table>`;
}

describe("parseShutuba(芝コース区分〈柵〉の抽出・実フィクスチャ)", () => {
  it("芝A表記(202602010601)はfence=\"A\"になること", () => {
    const result = parseShutuba(loadFixture("shutuba_202602010601.html"));
    expect(result.race.fence).toBe("A");
  });

  it("芝A表記(202603020211)はfence=\"A\"になること", () => {
    const result = parseShutuba(loadFixture("shutuba_202603020211.html"));
    expect(result.race.fence).toBe("A");
  });

  it("ダート戦(202602010607)はfenceキー自体を持たない(undefined)こと", () => {
    const result = parseShutuba(loadFixture("shutuba_202602010607.html"));
    expect(result.race.fence).toBeUndefined();
    expect("fence" in result.race).toBe(false);
  });
});

describe("parseShutuba(芝コース区分〈柵〉の抽出・合成HTML)", () => {
  it("芝以外(ダート)はRaceData01に柵letterが含まれていてもfenceキーを持たないこと(courseType非芝ガードの回帰防止)", () => {
    // courseType判定で「芝」以外に分岐した場合、括弧内にletterがあっても抽出してはならない。
    const html = buildPage("15:45発走 / ダ1700m (右&nbsp;A)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.courseType).toBe("ダ");
    expect("fence" in result.race).toBe(false);
  });

  it("障害戦もfenceキーを持たないこと", () => {
    const html = buildPage("15:45発走 / 障2750m (右)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.courseType).toBe("障");
    expect("fence" in result.race).toBe(false);
  });

  it("RaceData01全体の他要素にある英字を誤って柵と拾わないこと(芝distance直後の括弧に限定)", () => {
    // 「芝1800m」直後の括弧ではなく離れた位置に単独のアルファベットがあっても抽出対象外。
    // 直後に括弧が無いため芝ガード内では判別不能=nullとなる(柵無し扱いのAと誤認しない)。
    const html = buildPage("15:45発走 / 芝1800m / 天候:晴 州D/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.courseType).toBe("芝");
    expect(result.race.fence).toBeNull();
  });

  it("回り方向トークン「右」のみ・柵letter無しはfence=nullになること", () => {
    const html = buildPage("15:45発走 / 芝1800m (右)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.fence).toBeNull();
  });

  it("回り方向トークン「直」(新潟芝1000m直線)・柵letter無しでも落ちずfence=nullになること", () => {
    const html = buildPage("15:00発走 / 芝1000m (直)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.courseType).toBe("芝");
    expect(result.race.distance).toBe(1000);
    expect(result.race.fence).toBeNull();
  });

  it("回り方向トークン「左」でも柵letterがあれば正しく抽出できること", () => {
    const html = buildPage("15:45発走 / 芝1200m (左&nbsp;B)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.fence).toBe("B");
  });

  it("実体&nbsp;区切りの「右 A」からfence=\"A\"を抽出できること(区切りが本物の&nbsp;であることを検証)", () => {
    const html = buildPage("15:45発走 / 芝1800m (右&nbsp;A)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.fence).toBe("A");
  });

  it("内/外複合表記「右 外」(柵letterなし)はfence=nullになること", () => {
    const html = buildPage("15:45発走 / 芝1800m (右&nbsp;外)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.fence).toBeNull();
  });

  it("内/外複合表記「右 外 A」は柵letter部分のみを安全に抽出しfence=\"A\"になること", () => {
    // 採用方針: 内外語(内/外)は「柵letterでない」ことの判別にのみ使い、複合表記でも
    // 柵letterトークン(単独の大文字1文字)が含まれていれば安全に抽出する
    // (selectors.ts PATTERNS.fenceLetterToken のコメント参照)。
    const html = buildPage("15:45発走 / 芝1800m (右&nbsp;外&nbsp;A)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.fence).toBe("A");
  });

  it("内側表記「右 内」(柵letterなし)もfence=nullになること", () => {
    const html = buildPage("15:45発走 / 芝1800m (右&nbsp;内)/ 天候:晴/ 馬場:良");
    const result = parseShutuba(html);
    expect(result.race.fence).toBeNull();
  });
});
