/**
 * parse-nar-combo-odds(地方ワイド・3連複オッズ、odds/index.html?type=b5|b7 および
 * AJAXフラグメント odds_get_form.html)のテスト(機能D-2b-A・Issue #32)。
 *
 * 既存 parse-nar-odds.ts / parse-nar-odds.test.ts は一切変更しない(受け入れ条件2・12)。
 *
 * 合成データの線引き(boss指定): **サイトの構造を主張するテストに合成データを使わない**
 * (構造の主張は必ず実フィクスチャで検証する)。一方、**自分たちの防御的不変条件
 * (重複キー拒否・値の解釈のnull化等)を検証する合成データは正当**。本ファイルでは
 * その線引きに沿い、構造由来のテスト(件数完全性・AJAXフラグメント対応・型の取り違え)は
 * 実フィクスチャのみを使い、値の解釈・防御的不変条件は最小限の合成HTMLを使う。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildComboOddsKey } from "../../src/scraper/combo-odds-key.js";
import {
  NarComboOddsParseError,
  parseNarComboOdds,
  type NarComboOddsParseResult,
} from "../../src/scraper/parse-nar-combo-odds.js";

/** fixtures/ 配下のファイルをUTF-8テキストとして読み込む(既存テストと同じ解決方法)。 */
function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/** 「available」状態であることを前提として先に固定し、oddsマップを取り出す(空振り防止)。 */
function expectAvailable(result: NarComboOddsParseResult) {
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error("unreachable");
  return result.odds;
}

describe("parseNarComboOdds(実フィクスチャ。桁区切りカンマ。受け入れ条件3)", () => {
  it("前提固定: 地方3連複フィクスチャ(nar_odds_b7_202654071210.html)は55件中5件がカンマを含むこと(再現: 本文td.Oddsを正規表現で走査)", () => {
    const html = loadFixture("nar_odds_b7_202654071210.html");
    const cells = html.match(/<td class="Odds"[^>]*>[\s\S]*?<\/td>/g) ?? [];
    expect(cells.length).toBe(55);
    const withComma = cells.filter((c) => /class="Odds"[^>]*>[^<]*,/.test(c));
    expect(withComma.length).toBe(5);
  });

  it("地方3連複の最大オッズ(馬01-08-10: \"1,172.4\")がカンマを除去して数値化されること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b7_202654071210.html"), "trio"));
    expect(odds.get(buildComboOddsKey([1, 8, 10]))?.oddsMin).toBe(1172.4);
  });
});

describe("parseNarComboOdds(実フィクスチャ。ワイドの幅。受け入れ条件4)", () => {
  it("全組で下限<=上限であり、かつ下限<上限の組が実在すること(退化していないことの確認)", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b5_202654071210.html"), "wide"));
    expect(odds.size).toBe(66);
    let hasStrictDiff = false;
    for (const cell of odds.values()) {
      expect(cell.oddsMin).not.toBeNull();
      expect(cell.oddsMax).not.toBeNull();
      expect(cell.oddsMin!).toBeLessThanOrEqual(cell.oddsMax!);
      if (cell.oddsMax! > cell.oddsMin!) hasStrictDiff = true;
    }
    expect(hasStrictDiff).toBe(true);
  });
});

describe("parseNarComboOdds(実フィクスチャ。3連複の単一値。受け入れ条件4)", () => {
  it("3連複は全件でoddsMaxがnullであること(幅を持たない券種であることの確認)", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b7_202654071210.html"), "trio"));
    expect(odds.size).toBeGreaterThan(0);
    for (const cell of odds.values()) {
      expect(cell.oddsMax).toBeNull();
    }
  });
});

describe("parseNarComboOdds(値の解釈。合成データ。受け入れ条件6)", () => {
  /** 最小限の1セルだけを持つ合成HTML(サイト構造の主張ではなく、値の解釈だけを検証する)。 */
  function synthHtml(oddsText: string, marker: "b5" | "b7"): string {
    const idSuffix = marker === "b5" ? "1_2" : "1_2_3";
    return `<div id="odds_select"></div><div id="odds_view_form">
      <table class="Odds_Table"><tr class="Graph_Odds">
        <td class="Odds" id="chk_a1_${marker}_c0_${idSuffix}">${oddsText}
          <input type="checkbox" style="display: none;" />
          <label style="display: none;"></label>
        </td>
      </tr></table>
    </div>`;
  }

  it.each(["---.-", "取消", ""])(
    "ワイドのオッズ文字列が非数値(%s)の場合はoddsMin/oddsMaxともnullであること",
    (text) => {
      const odds = expectAvailable(parseNarComboOdds(synthHtml(text, "b5"), "wide"));
      const cell = odds.get(buildComboOddsKey([1, 2]));
      expect(cell?.oddsMin).toBeNull();
      expect(cell?.oddsMax).toBeNull();
    },
  );

  it("ワイドの正常なレンジ文字列(空振り防止の対照)は下限・上限とも数値化されること", () => {
    const odds = expectAvailable(parseNarComboOdds(synthHtml("41.9 - 42.8", "b5"), "wide"));
    const cell = odds.get(buildComboOddsKey([1, 2]));
    expect(cell?.oddsMin).toBe(41.9);
    expect(cell?.oddsMax).toBe(42.8);
  });

  it.each(["---.-", "取消", ""])(
    "3連複のオッズ文字列が非数値(%s)の場合はoddsMinがnullであること",
    (text) => {
      const odds = expectAvailable(parseNarComboOdds(synthHtml(text, "b7"), "trio"));
      const cell = odds.get(buildComboOddsKey([1, 2, 3]));
      expect(cell?.oddsMin).toBeNull();
      expect(cell?.oddsMax).toBeNull();
    },
  );

  it("地方セルは人気情報を持たないため常にninki=nullであること(このドキュメント種別に人気列が存在しない実測に基づく)", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b5_202654071210.html"), "wide"));
    expect(odds.size).toBeGreaterThan(0);
    for (const cell of odds.values()) {
      expect(cell.ninki).toBeNull();
    }
  });
});

describe("parseNarComboOdds(隠しinput/labelの文字が混入しないこと。合成データ。受け入れ条件6)", () => {
  it("同一id内のlabelに可視テキストが将来入っても、オッズ値に混入しないこと(防御的不変条件)", () => {
    const html = `<div id="odds_select"></div><div id="odds_view_form">
      <table class="Odds_Table"><tr class="Graph_Odds">
        <td class="Odds" id="chk_a1_b5_c0_1_2">41.9 - 42.8
          <input type="checkbox" style="display: none;" value="a1-54-10_b5_c0_1_2" />
          <label style="display: none;">選択済み</label>
        </td>
      </tr></table>
    </div>`;
    const odds = expectAvailable(parseNarComboOdds(html, "wide"));
    const cell = odds.get(buildComboOddsKey([1, 2]));
    // labelの可視テキスト("選択済み")がオッズ文字列に混入していれば非数値になりnullに化ける。
    // 混入していなければ正しく数値化される。
    expect(cell?.oddsMin).toBe(41.9);
    expect(cell?.oddsMax).toBe(42.8);
  });
});

describe("parseNarComboOdds(構造の検証。throw側。合成データ。受け入れ条件7)", () => {
  function synthHtmlWithId(idTail: string): string {
    return `<div id="odds_select"></div><table class="Odds_Table"><tr>
      <td class="Odds" id="chk_a1_b5_c0_${idTail}">10.0 - 11.0</td>
    </tr></table>`;
  }

  it("id由来の馬番が範囲外(00・19)の場合は投げること", () => {
    expect(() => parseNarComboOdds(synthHtmlWithId("0_2"), "wide")).toThrow(NarComboOddsParseError);
    expect(() => parseNarComboOdds(synthHtmlWithId("2_19"), "wide")).toThrow(NarComboOddsParseError);
  });

  it("id由来の馬番が昇順違反(降順)の場合は投げること", () => {
    expect(() => parseNarComboOdds(synthHtmlWithId("5_2"), "wide")).toThrow(NarComboOddsParseError);
  });

  it("id由来の馬番が重複(同値)の場合は投げること", () => {
    expect(() => parseNarComboOdds(synthHtmlWithId("2_2"), "wide")).toThrow(NarComboOddsParseError);
  });

  it("セルidの数値グループ数が券種と不一致(3連複用の3グループidをワイドパーサに渡す)場合は投げること(カバレッジ表「組の要素数」の裏付け。code-reviewer指摘5)", () => {
    // idの部分文字列"_b5_c0_"は含む(idSubstringフィルタは通過する)が、末尾が
    // "1_2_3"の3グループになっており、ワイド(comboSize=2)の正規表現(2グループ固定)に
    // 一致しない。前提固定(空振り防止): 実際にidSubstringを含んでいること。
    const html = `<div id="odds_select"></div><table class="Odds_Table"><tr>
      <td class="Odds" id="chk_a1_b5_c0_1_2_3">10.0 - 11.0</td>
    </tr></table>`;
    expect(html).toContain("_b5_c0_");
    expect(() => parseNarComboOdds(html, "wide")).toThrow(NarComboOddsParseError);
  });

  it("逆方向: ワイド用の2グループidを3連複パーサに渡す場合も投げること(対称性の確認)", () => {
    const html = `<div id="odds_select"></div><table class="Odds_Table"><tr>
      <td class="Odds" id="chk_a1_b7_c0_1_2">10.0</td>
    </tr></table>`;
    expect(html).toContain("_b7_c0_");
    expect(() => parseNarComboOdds(html, "trio")).toThrow(NarComboOddsParseError);
  });

  it("同じ組が異なる値で複数回現れた場合(黙って後勝ちにしない)は投げること", () => {
    const html = `<div id="odds_select"></div>
      <table class="Odds_Table"><tr><td class="Odds" id="chk_a1_b5_c0_1_2">10.0 - 11.0</td></tr></table>
      <table class="Odds_Table"><tr><td class="Odds" id="chk_a2_b5_c0_1_2">99.0 - 99.0</td></tr></table>`;
    expect(() => parseNarComboOdds(html, "wide")).toThrow(NarComboOddsParseError);
  });

  it("オッズ文書と判定できないHTML(#odds_selectも#odds_view_formも無い)の場合は投げること", () => {
    const html = `<html><body><p>これはオッズページではありません</p></body></html>`;
    expect(() => parseNarComboOdds(html, "wide")).toThrow(NarComboOddsParseError);
  });
});

describe("parseNarComboOdds(オッズ文書として正当かの判定。受け入れ条件8)", () => {
  it("#odds_selectのみ(#odds_view_formなし。AJAXフラグメント相当)でも投げずにパースできること(合成データ。防御的不変条件)", () => {
    const html = `<div id="odds_select"></div>
      <table class="Odds_Table"><tr><td class="Odds" id="chk_a1_b5_c0_1_2">10.0 - 11.0</td></tr></table>`;
    expect(() => parseNarComboOdds(html, "wide")).not.toThrow();
  });

  it("#odds_view_formのみ(#odds_selectなし。発売前ページ相当)でも投げずにパースできること(合成データ。防御的不変条件)", () => {
    const html = `<div id="odds_view_form">
      <table class="Odds_Table"><tr><td class="Odds" id="chk_a1_b5_c0_1_2">10.0 - 11.0</td></tr></table>
    </div>`;
    expect(() => parseNarComboOdds(html, "wide")).not.toThrow();
  });
});

describe("parseNarComboOdds(分類側。throwしない。受け入れ条件11・12)", () => {
  it("組合せ0件(文書としては正当)の場合はunavailableになり、reasonに生信号(コンテナ有無・セル総数)を持つこと", () => {
    const html = `<div id="odds_select"></div><div id="odds_view_form"><p>該当なし</p></div>`;
    const result = parseNarComboOdds(html, "wide");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toEqual({
      cartCountFound: true,
      viewFormWrapperFound: true,
      oddsCellCount: 0,
    });
  });

  it("型の取り違え検出: 単複ページ(nar_odds_b1_202654071210.html、td.Oddsが24件だがワイド・3連複のセルid規約を持たない)をワイドパーサに渡すと0件=unavailableになること", () => {
    const html = loadFixture("nar_odds_b1_202654071210.html");
    // 前提固定(空振り防止): このフィクスチャがオッズ文書としては正当(#odds_select/#odds_view_form)であり、
    // かつtd.Odds自体は24件存在すること(型を取り違えなければ0件にはならないはずの母集団があること)。
    // 件数は「<td class="Odds"」という開始タグ完全一致で数える(見出し行のth要素を誤って
    // 混入させないため。boss要修正2の再発防止)。
    expect(html).toMatch(/id="odds_select"/);
    expect((html.match(/<td class="Odds"/g) ?? []).length).toBe(24);
    const result = parseNarComboOdds(html, "wide");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toEqual({
      cartCountFound: true,
      viewFormWrapperFound: true,
      oddsCellCount: 24,
    });
  });

  it("状態③(本当の未発売)と型の取り違えは、どちらもunavailableだがreasonの値で区別できること(boss裁定2026-08-07。区別不能な状態を固定しないための対照テスト)", () => {
    // 前提固定(空振り防止): 2件とも実際にunavailableであること(区別以前にまず両者とも
    // unavailableに分類されることを先に固定する)。新規フィクスチャ・追加リクエストは使わない
    // (既にテストファイル内で使用中の2フィクスチャを再利用する。boss指定)。
    const presale = parseNarComboOdds(
      loadFixture("nar_odds_b5_presale_202655080803_20260806.html"),
      "wide",
    );
    const typeConfusion = parseNarComboOdds(loadFixture("nar_odds_b1_202654071210.html"), "wide");
    expect(presale.state).toBe("unavailable");
    expect(typeConfusion.state).toBe("unavailable");
    if (presale.state !== "unavailable" || typeConfusion.state !== "unavailable") {
      throw new Error("unreachable");
    }

    // 本題: reasonが互いに異なること(区別可能であることの固定)。
    expect(presale.reason).not.toEqual(typeConfusion.reason);
    // 実測値そのものも固定する(導出値ではなく観測値。再現: grep -c '<td class="Odds"' <file>)。
    expect(presale.reason).toEqual({
      cartCountFound: false,
      viewFormWrapperFound: true,
      oddsCellCount: 12,
    });
    expect(typeConfusion.reason).toEqual({
      cartCountFound: true,
      viewFormWrapperFound: true,
      oddsCellCount: 24,
    });
  });
});

describe("parseNarComboOdds(件数の完全性。実フィクスチャ。TDDリスト項目15)", () => {
  it("12頭(202654071210): ワイドC(12,2)=66件と完全一致すること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b5_202654071210.html"), "wide"));
    expect(odds.size).toBe(66);
  });

  it("12頭(202654071210): 3連複(軸馬1固定)C(11,2)=55件と完全一致すること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b7_202654071210.html"), "trio"));
    expect(odds.size).toBe(55);
  });

  it("6頭(202646071203): ワイドC(6,2)=15件と完全一致すること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b5_202646071203.html"), "wide"));
    expect(odds.size).toBe(15);
  });

  it("6頭(202646071203): 3連複(軸馬1固定)C(5,2)=10件と完全一致すること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b7_202646071203.html"), "trio"));
    expect(odds.size).toBe(10);
  });

  it("7頭(202630062407): ワイドC(7,2)=21件と完全一致すること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b5_202630062407.html"), "wide"));
    expect(odds.size).toBe(21);
  });

  it("7頭(202630062407): 3連複(軸馬1固定)C(6,2)=15件と完全一致すること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b7_202630062407.html"), "trio"));
    expect(odds.size).toBe(15);
  });
});

describe("parseNarComboOdds(AJAXフラグメント対応。実フィクスチャ。受け入れ条件2)", () => {
  it("jiku=2のAJAXフラグメント(nar_odds_b7_jiku2_202654071210.html、#odds_view_formを持たない)も同じパーサで55件取得できること(通常ページと同一コードパス。ワイドのAJAXフラグメントに専用フィクスチャは無いため、b7の実物でフラグメント対応そのものを検証する)", () => {
    const html = loadFixture("nar_odds_b7_jiku2_202654071210.html");
    // 前提固定(空振り防止): このフィクスチャが実際に#odds_view_formを持たない(AJAXフラグメントである)こと。
    const cheerioCheck = html.includes('id="odds_view_form"');
    expect(cheerioCheck).toBe(false);
    expect(html).toContain('id="odds_select"');

    const odds = expectAvailable(parseNarComboOdds(html, "trio"));
    expect(odds.size).toBe(55);
    // 軸馬2の応答は「馬02を含む全トリオ」(#13実測)。全件が馬番02を含むことを確認する。
    expect([...odds.keys()].every((k) => k.includes("02"))).toBe(true);
  });
});

describe("parseNarComboOdds(状態③=未発売の実測。受け入れ条件9。実リクエスト実施日2026-08-06)", () => {
  /**
   * 実測記録: 2026-08-06T18:28 UTC(JST 8/7 3:28頃)、地方・佐賀(race_id=202655080803、
   * 頭数12、8/8開催)のb5(ワイド)・b7(3連複)ページを取得。翌々日開催のレースを選んだため
   * 未発売が高確率で再現した(#13の教訓「presaleは取得時点の状態」を踏まえ、フィクスチャ名に
   * 取得日20260806を含めている)。
   *
   * 判定根拠: `#odds_select`(投票カート件数)が**無く**、`#odds_view_form`(本文ラッパー)は
   * **ある**(b1発売前フィクスチャと同じ組み合わせ)。中身は「予想オッズ（単勝）」プレビュー
   * テーブル(td.Oddsは**12件**〈`<td class="Odds"`の開始タグ完全一致で計測。見出し行の
   * `<th class="Odds">`を誤って混入させる緩い一致は使わない。boss要修正2の再発防止〉あるが、
   * いずれもワイド・3連複のセルid規約〈chk_..._b5|b7_c0_...〉を持たない=このドキュメント
   * 種別に人気付き単勝プレビュー以外の内容が無い)。b5・b7とも type別の差は
   * meta/canonical URLとブロックキャッシュタグ(cg/cp)のみで、テーブル本体は完全に同一
   * だった(diffで確認: 本文差分は5箇所のURL/コメントのみ)。
   *
   * この実物により、AC8で要求された「OR判定(#odds_select OR #odds_view_form)が
   * b1からの外挿ではなく実物のb5/b7でも正しく分岐すること」を確認した
   * (throwせず`unavailable`に分類できている)。
   */
  it("地方・佐賀(202655080803、8/8開催・2026-08-06取得): b5(ワイド)は#odds_selectが無く#odds_view_formがある構造でもthrowせずunavailableになり、reasonが実測どおりであること", () => {
    const html = loadFixture("nar_odds_b5_presale_202655080803_20260806.html");
    // 前提固定(空振り防止): 判定根拠となるコンテナの組み合わせが実際にそうなっていること。
    expect(html).not.toContain('id="odds_select"');
    expect(html).toContain('id="odds_view_form"');
    expect(html).toContain("予想オッズ（単勝）");
    expect((html.match(/<td class="Odds"/g) ?? []).length).toBe(12);
    const result = parseNarComboOdds(html, "wide");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toEqual({
      cartCountFound: false,
      viewFormWrapperFound: true,
      oddsCellCount: 12,
    });
  });

  it("地方・佐賀(202655080803、8/8開催・2026-08-06取得): b7(3連複)も同じ構造でthrowせずunavailableになること(type=b5/b7で本文が同一の予想オッズ〈単勝〉プレビューに落ちることの確認)", () => {
    const html = loadFixture("nar_odds_b7_presale_202655080803_20260806.html");
    expect(html).not.toContain('id="odds_select"');
    expect(html).toContain('id="odds_view_form"');
    expect(html).toContain("予想オッズ（単勝）");
    expect((html.match(/<td class="Odds"/g) ?? []).length).toBe(12);
    const result = parseNarComboOdds(html, "trio");
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable") throw new Error("unreachable");
    expect(result.reason).toEqual({
      cartCountFound: false,
      viewFormWrapperFound: true,
      oddsCellCount: 12,
    });
  });
});

describe("parseNarComboOdds(キー正規化の一致。受け入れ条件5)", () => {
  it("パーサ由来のキー全件がbuildComboOddsKey(umabans)の再計算結果と一致すること", () => {
    const odds = expectAvailable(parseNarComboOdds(loadFixture("nar_odds_b5_202654071210.html"), "wide"));
    expect(odds.size).toBeGreaterThan(0);
    for (const key of odds.keys()) {
      const umabans = [Number(key.slice(0, 2)), Number(key.slice(2, 4))];
      expect(buildComboOddsKey(umabans)).toBe(key);
    }
  });
});
