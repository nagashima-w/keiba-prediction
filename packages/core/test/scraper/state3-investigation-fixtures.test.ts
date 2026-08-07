/**
 * 状態③(未発売)実測フィクスチャ(機能D-2b-A・Issue #32・§11)に対する構造不変条件テスト。
 *
 * 目的は「ドキュメント(docs/wide-trio-odds-investigation.md §11)に記録した実測値・実測構造が、
 * コミット済みフィクスチャの実物であること」の固定であり、汎用パースではない
 * (wide-trio-odds-fixtures.test.ts〈機能D-1〉と同じ位置づけ・同じ制約に倣う)。そのため:
 * - 新しい本番モジュール(packages/core/src/scraper/parse-*.ts)は作らない
 * - 新しいpublic API(index.tsのexport)は増やさない
 * - 判定ロジックは本ファイル内に閉じ、正規表現・cheerioを直接使う
 *
 * code-reviewer再指摘(2026-08-07)への対応: §11.1で「取得したが保存しなかった」ため
 * 検証手段が repo に無かった中央・地方の `race_list_sub`(発走予定時刻の一次データ)を
 * `fixtures/race_list_sub_20260808.html` / `fixtures/nar_race_list_sub_20260808.html` として
 * 事後保存した。本ファイルは、ドキュメントに記録した「17:50」「17:10」がこれらのフィクスチャ
 * から再現できることを固定する。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む(既存テストと同じ解決方法)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

describe("中央race_list_sub(fixtures/race_list_sub_20260808.html)の実測値の固定(§11.2)", () => {
  it("前提固定(空振り防止): race_id=202604020511の行が実際に含まれること", () => {
    const html = loadFixture("race_list_sub_20260808.html");
    expect(html).toContain("race_id=202604020511");
  });

  it("11R(3歳以上1勝クラス・芝1000m・18頭)の発走予定時刻が17:50であること(ドキュメントに記録した数値の再現)", () => {
    const html = loadFixture("race_list_sub_20260808.html");
    const idx = html.indexOf("race_id=202604020511");
    // レース1件分のブロック(次のレースIDが現れるまで)を切り出して、この中だけで検証する
    // (他レースの情報を誤って拾わないため)。
    const nextIdx = html.indexOf("race_id=202604020512");
    expect(nextIdx).toBeGreaterThan(idx);
    const block = html.slice(idx, nextIdx);

    expect(block).toContain("11R");
    expect(block).toContain("3歳以上1勝クラス");
    expect(block).toContain("芝1000m");
    expect(block).toContain("18頭");

    const m = /<span class="RaceList_Itemtime">\s*([0-9]{1,2}:[0-9]{2})/.exec(block);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("17:50");
  });
});

describe("地方race_list_sub(fixtures/nar_race_list_sub_20260808.html)の実測値の固定(§11.1)", () => {
  it("前提固定(空振り防止): race_id=202655080803の行が実際に含まれること", () => {
    const html = loadFixture("nar_race_list_sub_20260808.html");
    expect(html).toContain("race_id=202655080803");
  });

  it("3R(C2ー26組・ダ1300m・12頭)の発走予定時刻が17:10であること(nar_odds_b5/b7_presale_*.htmlの本文と独立に一致することの確認)", () => {
    const html = loadFixture("nar_race_list_sub_20260808.html");
    const idx = html.indexOf("race_id=202655080803");
    const nextIdx = html.indexOf("race_id=202655080804");
    expect(nextIdx).toBeGreaterThan(idx);
    const block = html.slice(idx, nextIdx);

    expect(block).toContain("3R");
    expect(block).toContain("C2ー26組");
    expect(block).toContain("ダ1300m");
    expect(block).toContain("12頭");

    const m = /<div class="RaceData">\s*<span>\s*([0-9]{1,2}:[0-9]{2})/.exec(block);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("17:10");
  });

  it("この17:10は、nar_odds_b5_presale_202655080803_20260806.html本文の「17:10発走」と独立ソースとして一致すること(二次証拠。取得経路が異なる2つのページ〈race_list_sub / odds/index.html〉が同じ値を報告していることの確認)", () => {
    const listHtml = loadFixture("nar_race_list_sub_20260808.html");
    const oddsHtml = loadFixture("nar_odds_b5_presale_202655080803_20260806.html");
    expect(oddsHtml).toContain("17:10発走");

    const idx = listHtml.indexOf("race_id=202655080803");
    const nextIdx = listHtml.indexOf("race_id=202655080804");
    const block = listHtml.slice(idx, nextIdx);
    const m = /<div class="RaceData">\s*<span>\s*([0-9]{1,2}:[0-9]{2})/.exec(block);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("17:10");
  });
});
